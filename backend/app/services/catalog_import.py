"""Загрузка каталога в базу.

Два источника. Наши 31 складское решение с характеристиками лежат в репозитории и попадают в базу
при первом запуске сами. Выгрузку организатора (catalog_export, 223 позиции) мы в репозиторий не кладем,
ее загружает администратор файлом: мы проверяем каждую строку и отчитываемся, что добавили,
что обновили и что отбросили. Повторная загрузка того же файла ничего не ломает."""

import csv
import io
import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.services import catalog_photos, catalog_uses
from app.settings import settings
from app.storage.models import CatalogChange, Solution, SolutionSpec, User

MAX_FILE_BYTES = 5 * 1024 * 1024

# Колонки выгрузки организатора и поля решения, куда они ложатся
ORGANIZER_COLUMNS = {
    "id": "id",
    "Название": "name",
    "тип": "kind",
    "статус": "status",
    "компания": "company",
    "описание": "description",
    "Тип": "type",
    "Подтип": "subtype",
    "Сценарий": "scenario",
    "Кейсы": "cases",
    "УГТ": "trl",
    "Рын Потенциал": "market_potential",
    "Регион": "region",
    "Отрасль": "industry",
    "Цена изделия": "price_rub",
}
# Поля решения, которые приходят от организатора. Их администратор может поправить руками
ORGANIZER_FIELDS = [attr for attr in ORGANIZER_COLUMNS.values() if attr != "id"]
KINDS = {"brs", "bas", "software"}
STATUSES = {"operation", "piloting", "rnd"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


@dataclass
class ImportReport:
    rows: int = 0
    added: list[str] = field(default_factory=list)
    updated: dict[str, list[str]] = field(default_factory=dict)
    unchanged: int = 0
    merged: int = 0  # строк, склеенных с соседними: тот же номер и та же цена
    kept: dict[str, list[str]] = field(default_factory=dict)  # ручные правки, которые загрузка не тронула
    errors: list[tuple[int, str]] = field(default_factory=list)
    confirmed: int = 0  # привязок из data/catalog/uses.csv к решениям, пришедшим с выгрузкой
    suggested: int = 0  # новых предложений правила «сценарий -> объект и операция»
    ours: int = 0  # значений из наших колонок: характеристики, отметки, объекты и задачи


class ImportRejected(Exception):
    """Файл целиком не подходит: не та кодировка, нет нужных колонок, слишком большой."""


def parse_price(raw: str) -> Decimal | None:
    """«2 700 000,00» -> 2700000.00. Пустая цена это «не указана», а не ноль."""
    text = raw.replace(" ", "").replace(" ", "").replace(",", ".").strip()
    if not text:
        return None
    try:
        price = Decimal(text)
    except InvalidOperation as error:
        raise ValueError(f"цена «{raw}» не число") from error
    if price < 0:
        raise ValueError(f"цена «{raw}» меньше нуля")
    return price


def parse_trl(raw: str) -> int | None:
    text = raw.strip()
    if not text:
        return None
    if not text.isdigit() or not 1 <= int(text) <= 9:
        raise ValueError(f"УГТ «{raw}» должен быть числом от 1 до 9")
    return int(text)


def read_organizer_file(content: bytes) -> tuple[list[dict[str, str]], int]:
    if len(content) > MAX_FILE_BYTES:
        raise ImportRejected("Файл больше 5 МБ, это не похоже на выгрузку каталога")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ImportRejected("Файл не в кодировке UTF-8. Сохраните выгрузку как CSV UTF-8") from error
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    missing = [column for column in ORGANIZER_COLUMNS if column not in (reader.fieldnames or [])]
    if missing:
        raise ImportRejected(
            "В файле нет колонок: " + ", ".join(missing) + ". Нужна выгрузка каталога с разделителем «;»"
        )
    rows = list(reader)
    return rows, len(rows)


def plain(value: object) -> object:
    """Значение для JSON: Decimal пишем строкой, остальное как есть."""
    return str(value) if isinstance(value, Decimal) else value


def _row_values(row: dict[str, str], ours_file: bool = False) -> dict[str, object]:
    values: dict[str, object] = {}
    for column, attr in ORGANIZER_COLUMNS.items():
        raw = (row.get(column) or "").strip()
        if attr == "price_rub":
            values[attr] = parse_price(raw)
        elif attr == "trl":
            values[attr] = parse_trl(raw)
        else:
            values[attr] = raw
    if not UUID.match(str(values["id"])):
        raise ValueError(f"идентификатор «{values['id']}» не похож на идентификатор каталога")
    if not values["name"]:
        raise ValueError("нет названия")
    # в нашей выгрузке бывают решения, добавленные вручную без типа и статуса
    if values["kind"] not in KINDS and not (ours_file and not values["kind"]):
        raise ValueError(f"тип «{values['kind']}» не из списка: brs, bas, software")
    if values["status"] not in STATUSES and not (ours_file and not values["status"]):
        raise ValueError(f"статус «{values['status']}» не из списка: operation, piloting, rnd")
    return values


def _glue(group: list[dict[str, object]]) -> dict[str, object]:
    """Строки с одним номером и ценой: берем первую, отрасли и сценарии собираем списком без повторов."""
    glued = dict(group[0])
    for attr in ("industry", "scenario"):
        glued[attr] = "; ".join(dict.fromkeys(str(v[attr]) for v in group if v[attr]))
    return glued


def _positions(valid: list[dict[str, object]], existing: dict[str, Solution]) -> list[dict[str, object]]:
    """Склейка по журналу решений, «Дубли каталога склеиваем по номеру и цене». Одинаковые номер
    и цена дают одну позицию. Один номер с разной ценой это разные комплектации: исходный номер
    остается у той, чья цена уже стоит в базе; если цены нет, у той, чей сценарий совпадает с нашим
    процессом склада; иначе у первой в файле. Остальные получают номер,
    выведенный из номера и цены, поэтому повторная загрузка попадает в те же позиции."""
    groups: dict[tuple[str, object], list[dict[str, object]]] = {}
    for values in valid:
        groups.setdefault((str(values["id"]), values["price_rub"]), []).append(values)

    by_number: dict[str, list[dict[str, object]]] = {}
    for group in groups.values():
        by_number.setdefault(str(group[0]["id"]), []).append(_glue(group))

    positions = []
    for number, variants in by_number.items():
        known = existing.get(number)
        main = next((v for v in variants if known and v["price_rub"] == known.price_rub), None)
        if main is None and known and known.process:
            main = next((v for v in variants if known.process in str(v["scenario"])), None)
        main = main or variants[0]
        for variant in variants:
            position = dict(variant, organizer_id=number)
            if variant is not main:
                position["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{number}:{variant['price_rub']}"))
            positions.append(position)
    return positions


def import_organizer(session: Session, content: bytes, user: User | None, dry_run: bool = False) -> ImportReport:
    """Проверяет выгрузку и обновляет каталог. Характеристики, отметки и процесс склада,
    которые собрали мы, не трогаем: у организатора их нет."""
    from app.services import catalog_export  # экспорт знает поля админки, а админка знает импорт

    rows, count = read_organizer_file(content)
    report = ImportReport(rows=count)
    # Наша выгрузка: те же колонки организатора и справа наши характеристики, отметки, объекты и задачи
    ours_file = catalog_export.has_our_columns(list(rows[0].keys()) if rows else [])
    if ours_file:  # наша выгрузка пишет текст с = + - @ в начале через апостроф, снимаем его
        rows = [{key: catalog_export.uncell(value) for key, value in row.items()} for row in rows]
    existing = {solution.id: solution for solution in session.scalars(select(Solution))}

    valid: list[dict[str, object]] = []
    for number, row in enumerate(rows, start=2):
        try:
            values = _row_values(row, ours_file)
            if ours_file:
                values["_ours"] = catalog_export.read_row(row)
            valid.append(values)
        except ValueError as error:
            report.errors.append((number, str(error)))

    positions = _positions(valid, existing)
    report.merged = len(valid) - len(positions)

    for values in positions:
        ours = values.pop("_ours", None)
        solution = existing.get(str(values["id"]))
        snapshot = {attr: plain(values[attr]) for attr in ORGANIZER_FIELDS}
        if solution is None:
            report.added.append(str(values["id"]))
            if not dry_run:
                solution = Solution(origin="organizer", organizer_values=snapshot, **values)
                session.add(solution)
                existing[solution.id] = solution
                if ours:
                    report.ours += catalog_export.apply(session, user, solution, ours)
            continue
        if ours and not dry_run:
            report.ours += catalog_export.apply(session, user, solution, ours)
        manual = set(solution.manual_fields or [])
        differs = [attr for attr, value in values.items() if attr != "id" and getattr(solution, attr) != value]
        changed = [attr for attr in differs if attr not in manual]
        if ours_file:  # в нашем файле пустая ячейка значит "не менять", как и в наших колонках
            changed = [attr for attr in changed if values[attr] not in ("", None)]
        kept = [attr for attr in differs if attr in manual]
        if kept:
            report.kept[solution.id] = kept
        # в нашей выгрузке значения могли быть поправлены руками: снимком организатора их не считаем
        if not dry_run and not ours_file and solution.organizer_values != snapshot:
            solution.organizer_values = snapshot
        if not changed:
            report.unchanged += 1
            continue
        report.updated[solution.id] = changed
        if not dry_run:
            for attr in changed:
                setattr(solution, attr, values[attr])
            solution.updated_at = datetime.now(UTC)

    if not dry_run:
        session.flush()
        report.confirmed, report.suggested = catalog_uses.bind(session, list(existing.values()))
        session.add(
            CatalogChange(
                user_id=user.id if user else None,
                user_email=user.email if user else "",
                action="import",
                changes={
                    "added": report.added,
                    "updated": report.updated,
                    "merged": report.merged,
                    "kept": report.kept,
                    "confirmed": report.confirmed,
                    "suggested": report.suggested,
                    "ours": report.ours,
                },
                note=(
                    f"Выгрузка организатора: строк {report.rows}, добавлено {len(report.added)}, "
                    f"обновлено {len(report.updated)}, без изменений {report.unchanged}, "
                    f"склеено строк {report.merged}, ручных правок сохранено {len(report.kept)}, "
                    f"привязано к объектам по нашему списку {report.confirmed}, предложено правилом {report.suggested}, "
                    f"из наших колонок {report.ours}, отброшено с ошибками {len(report.errors)}"
                ),
            )
        )
        session.commit()
        # Новым решениям сразу достаются снимки из data/, не дожидаясь перезапуска сервера
        catalog_photos.seed_photos(session)
    return report


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file, delimiter=";"))


def _latest(dates: Iterable[str]) -> date | None:
    parsed = [date.fromisoformat(value) for value in dates if value]
    return max(parsed) if parsed else None


def organizer_file() -> Path:
    return settings.data_dir / "organizer" / "catalog_export_v4.csv"


def seed_organizer_catalog(session: Session) -> int:
    """Первый запуск, после нашего каталога: каталог организатора загружается администратором в админке
    той же загрузкой, что кнопка "Загрузить выгрузку". Наши решения склеиваются с ней по номеру, остальные
    получают предложения объектов и задач и ждут администратора. Если выгрузку уже загружали (в журнале
    есть загрузка) или файла нет, ничего не делаем. Возвращает, сколько позиций добавилось."""
    path = organizer_file()
    if not path.exists():
        return 0
    if session.scalar(select(CatalogChange.id).where(CatalogChange.action == "import").limit(1)) is not None:
        return 0
    return len(import_organizer(session, path.read_bytes(), None).added)


def seed_team_catalog(session: Session) -> int:
    """Первый запуск: кладем в базу наши складские решения с характеристиками из data/.
    Если в каталоге уже что-то есть, ничего не делаем: правки администратора не затираем."""
    if session.scalar(select(func.count()).select_from(Solution)):
        return 0
    catalog = _read_csv(settings.data_dir / "catalog" / "warehouse.csv")
    specs = _read_csv(settings.data_dir / "specs" / "specs.csv")
    sources = _read_csv(settings.data_dir / "specs" / "sources.csv")

    for row in catalog:
        price = row.get("price_rub", "")
        session.add(
            Solution(
                id=row["id"],
                organizer_id=row["id"],
                name=row["product"],
                company=row.get("vendor", ""),
                type=row.get("type", ""),
                subtype=row.get("subtype", ""),
                process=row.get("process", ""),
                status=row.get("status", ""),
                tested_fcbas=row.get("tested_fcbas") == "1",
                registry_719=row.get("registry_719") == "1",
                price_rub=parse_price(price) if price else None,
                origin="organizer",
            )
        )
    session.flush()

    known = {row["id"] for row in catalog}
    for spec in specs:
        if spec["catalog_id"] not in known:
            continue
        found = [s for s in sources if s["catalog_id"] == spec["catalog_id"] and s["field"] == spec["field"]]
        session.add(
            SolutionSpec(
                solution_id=spec["catalog_id"],
                field=spec["field"],
                value=spec.get("value", ""),
                unit=spec.get("unit", ""),
                rating=spec.get("rating") or "F",
                source="\n".join(dict.fromkeys(s["source"] for s in found if s["source"])),
                source_type=spec.get("source_types", ""),
                quote=found[0]["quote"] if found else "",
                retrieved=_latest(s["retrieved"] for s in found),
                note=spec.get("reason", ""),
            )
        )
    session.add(
        CatalogChange(
            action="seed",
            changes={"solutions": len(catalog)},
            note=f"Первый запуск: {len(catalog)} складских решений с характеристиками из data/",
        )
    )
    session.commit()
    return len(catalog)
