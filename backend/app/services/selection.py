"""Подбор решений для объекта: читаем каталог, применяем правила, отдаем объяснение.

Каталог (решения, характеристики, цены, задачи) берем из базы, его правит администратор.
Расчетные параметры робота (скорость, батарея, цена для экономики) лежат в config/model.yaml
с источниками: решение без них в подборе видно, но экономику по нему не посчитать."""

from __future__ import annotations

import re
from collections.abc import Callable
from functools import lru_cache

from sqlalchemy import event, func, select
from sqlalchemy.orm import Session, selectinload

from app.db import SessionLocal
from app.engine import selection
from app.engine.economics.scenarios import by_id
from app.schemas.catalog import Check, Factor, Solution, Spec
from app.services import catalog_admin, catalog_prices
from app.services.calculation import model_with_overrides
from app.services.catalog_photos import EXTENSIONS
from app.services.catalog_uses import BY_KEY
from app.settings import settings
from app.storage.models import CatalogChange, SolutionPhoto, SolutionSpec, SolutionUse
from app.storage.models import Solution as SolutionRow

SPEC_LABELS = {
    "payload_kg": "Грузоподъемность, кг",
    "min_aisle_width_mm": "Минимальный проход, мм",
    "lift_height_mm": "Высота подъема, мм",
    "max_speed_m_s": "Скорость, м/с",
    "runtime_h": "Время работы, ч",
    "charge_time_h": "Зарядка, ч",
    "navigation_type": "Навигация",
    "throughput": "Производительность",
}

SUMMARIES = {
    "ronavi-h1500": "Возит паллеты и стеллажи между зонами, забирает перевозку у операторов погрузчиков",
    "ronavi-m": "Подвозит стеллажи к станции комплектации, отборщик перестает ходить по складу",
}


# Сессии, из которых читаем каталог. Тесты подменяют на базу в памяти
sessions: Callable[[], Session] = SessionLocal
# Каталог, прочитанный из базы: объект -> решения. Сбрасывается после любой записи в каталог
_snapshot: dict[str, list[dict]] | None = None
_stamp: str | None = None
CATALOG_TABLES = (SolutionRow, SolutionSpec, SolutionUse, SolutionPhoto, CatalogChange)


def catalog(facility_id: str = "warehouse") -> list[dict]:
    """Решения объекта из каталога в базе: те, у кого есть подтвержденная задача этого объекта.

    Решение, которое администратор только добавил или загрузил выгрузкой, попадает сюда, когда
    ему подтвердят задачу. Характеристики и цена те, что сейчас стоят в карточке админки.
    """
    global _snapshot
    if _snapshot is None:
        with sessions() as session:
            _snapshot = _read(session)
    return _snapshot.get(facility_id, [])


def catalog_stamp() -> str:
    """Отпечаток каталога в базе для версии данных: сколько решений и номер последней правки в журнале.
    Каждая правка в админке и каждая загрузка пишется в журнал, поэтому номер растет с любой из них."""
    global _stamp
    if _stamp is None:
        with sessions() as session:
            count = session.scalar(select(func.count()).select_from(SolutionRow))
            last = session.scalar(select(func.max(CatalogChange.id)))
            _stamp = f"{count}:{last or 0}"
    return _stamp


def forget() -> None:
    global _snapshot, _stamp
    _snapshot, _stamp = None, None
    catalog_prices.forget()


def _read(session: Session) -> dict[str, list[dict]]:
    rows = session.scalars(
        select(SolutionRow)
        .options(selectinload(SolutionRow.specs), selectinload(SolutionRow.uses), selectinload(SolutionRow.photo))
        .order_by(SolutionRow.name, SolutionRow.id)
    ).all()
    found: dict[str, list[dict]] = {}
    for row in rows:
        confirmed: dict[str, dict[str, str]] = {}
        for use in row.uses:
            if use.status == "confirmed":
                confirmed.setdefault(use.facility, {})[use.operation] = use.note
        if not confirmed:
            continue
        item = _item(row)
        for facility_id, operations in confirmed.items():
            found.setdefault(facility_id, []).append(item | {"uses": operations})
    return found


def _item(row: SolutionRow) -> dict:
    """Решение в том виде, в каком его читают правила подбора: значения строкой, оценка рядом."""
    item = {
        "id": row.id,
        "product": row.name,
        "vendor": row.company,
        "type": row.type,
        "subtype": row.subtype,
        "process": row.process,
        "status": row.status,
        "tested_fcbas": "1" if row.tested_fcbas else "0",
        "registry_719": "1" if row.registry_719 else "0",
        "price_rub": "" if row.price_rub is None else str(row.price_rub),
        "photo_url": catalog_admin.photo_url(row),
    }
    for spec in row.specs:
        item[spec.field] = spec.value
        item[f"{spec.field}_trust"] = spec.rating
        item[f"{spec.field}_unit"] = spec.unit
    return item


@event.listens_for(Session, "after_flush")
def _mark_catalog(session: Session, _context: object) -> None:
    if any(isinstance(obj, CATALOG_TABLES) for obj in (*session.new, *session.dirty, *session.deleted)):
        session.info["catalog_changed"] = True


@event.listens_for(Session, "after_commit")
def _forget_after_commit(session: Session) -> None:
    """Правка в админке, загрузка выгрузки, новое фото: подбор перечитает каталог при следующем запросе."""
    if session.info.pop("catalog_changed", False):
        forget()


def operations_of(solution_id: str, facility_id: str) -> dict[str, str]:
    """Подтвержденные задачи решения на объекте с человеческими названиями, как в карточке каталога."""
    item = next((item for item in catalog(facility_id) if item["id"] == solution_id), {})
    return _labels(item.get("uses", {}), facility_id)


def _labels(uses: dict[str, str], facility_id: str) -> dict[str, str]:
    return {
        operation: BY_KEY[(facility_id, operation)].label if (facility_id, operation) in BY_KEY else operation
        for operation in uses
    }


@lru_cache(maxsize=1)
def robots_by_catalog_id() -> dict[str, str]:
    """Номер решения в каталоге -> робот в расчетной модели. Связь по номеру, а не по названию:
    название в выгрузке организатора может поменяться, номер нет."""
    model, _ = model_with_overrides({})
    return {robot["catalog_id"]: robot["id"] for robot in model["robots"] if robot.get("catalog_id")}


def photo_url(solution_id: str) -> str | None:
    """Адрес фото, если снимок лежит в data/catalog/photos. Оттуда он попадает в базу при запуске,
    а отдает его /api/catalog/photos/<номер>."""
    folder = settings.data_dir / "catalog" / "photos"
    if any((folder / f"{solution_id}{extension}").is_file() for extension in EXTENSIONS):
        return f"/api/catalog/photos/{solution_id}"
    return None


def solutions(
    facility_id: str, operation_id: str, plan: dict | None = None, load_kg: float | None = None
) -> list[Solution]:
    """Подбор под задачу. Если есть план объекта, ширина проезда, верхний ярус и пандусы берутся
    из него, а не из датасета: это самое конкретное, что мы знаем про объект. Массу груза
    человек вводит на шаге параметров, без нее берем среднюю из датасета."""
    model, _ = model_with_overrides({})
    facility = by_id(model["facilities"], facility_id)
    operation = by_id(facility["operations"], operation_id)
    rules = model["engine"]["selection"]
    requirements = {
        "operation": operation_id,
        "processes": tuple(operation["processes"]),
        # у уборки груза нет, правило не применяется, даже если масса пришла
        "load_kg": load_kg if load_kg and operation.get("load_kg") else operation.get("load_kg"),
        "aisle_mm": facility["constraints"]["aisle_width_mm"],
        "stacking_lift_mm": rules["stacking_lift_mm"],
        # «товар к человеку»: робот везет стеллаж к станции, где человек работает быстрее
        "to_station": bool(operation.get("productivity_after")),
    }
    if plan:
        requirements.update(plan)
    items = [
        item | {"operations": _labels(item["uses"], facility_id), "use_notes": item["uses"]}
        for item in catalog(facility_id)
    ]
    matches = selection.rank(items, requirements, tuple(rules["fields"]), rules["weights"])
    robots = {robot["id"]: robot for robot in model["robots"]}
    sources = {item["id"]: item for item in items}
    return [_to_schema(match, sources[match.solution_id], robots, operation_id) for match in matches]


def _to_schema(match: selection.Match, source: dict, robots: dict, operation_id: str) -> Solution:
    robot = robots.get(robots_by_catalog_id().get(source["id"], ""))
    raas = (robot or {}).get("raas") or {}
    return Solution(
        id=match.solution_id,
        product=source["product"],
        vendor=source["vendor"],
        type=source["type"],
        subtype=source["subtype"],
        process=source["process"],
        maturity=source["status"],
        tested_fcbas=source["tested_fcbas"] == "1",
        registry_719=source["registry_719"] == "1",
        status=match.status,
        score=match.score,
        checks=[Check(label=c.label, outcome=c.outcome, detail=c.detail) for c in match.checks],
        factors=[Factor(label=f.label, contribution=f.contribution, detail=f.detail) for f in match.factors],
        missing=match.missing,
        specs=[
            Spec(
                field=name,
                label=label,
                value=source[name],
                trust=source.get(f"{name}_trust", "F"),
                unit=source.get(f"{name}_unit", ""),
            )
            for name, label in SPEC_LABELS.items()
            if source.get(name)
        ],
        throughput_per_hour=per_hour(source.get("throughput", ""), source.get("throughput_unit", "")),
        can_calculate=robot is not None,
        robot_id=robot["id"] if robot else None,
        # цена из каталога, ее правит администратор; экономика берет ее же
        price_rub=_price(source),
        # цена аренды есть не у каждого робота: без нее расчет показывает только покупку
        raas_fee_rub_month=raas.get("fee_rub_month"),
        calc_note=_calc_note(robot),
        summary=SUMMARIES.get(robot["id"] if robot else "", "") or source["uses"].get(operation_id, ""),
        photo_url=source["photo_url"],
    )


_NUMBER = re.compile(r"\d{1,3}(?: \d{3})+|\d+(?:[.,]\d+)?")


def per_hour(value: str, unit: str) -> float | None:
    """Производительность из каталога числом, чтобы отсортировать карточки. Записи в каталоге
    свободные: "80-100", "до 1000", "30 (средняя), до 40", "от 12 600". Берем большее число
    записи, если она в час. Запись в месяц или без единицы времени не переводим: пересчет
    выдумал бы число, которого нет в источнике."""
    if "/ч" not in f"{value} {unit}" or "месяц" in value:
        return None
    numbers = [float(one.replace(" ", "").replace(",", ".")) for one in _NUMBER.findall(value)]
    return max(numbers) if numbers else None


def _calc_note(robot: dict | None) -> str:
    if robot is None:
        return "Не считается: нет расчетных параметров робота (потребление, обслуживание, срок службы)"
    return ""


def _price(source: dict) -> float | None:
    """Цена изделия из каталога. С НДС, без доставки, пусконаладки и интеграции."""
    raw = source.get("price_rub") or ""
    return float(raw) if raw else None
