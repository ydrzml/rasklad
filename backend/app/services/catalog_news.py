"""Новости каталога для главной: что поменялось в каталоге роботов, словами для пользователя.

Берем из журнала правок каталога: новое решение, загрузка выгрузки, новая цена, обновленные
характеристики (руками, файлом или принятые со страницы производителя), решение пошло в подбор
на новой задаче. Почту администратора не показываем, пишем "поправил администратор".
Служебные записи (первый запуск, фото, отклоненные предложения, удаление) в новости не идут.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.services import catalog_admin, catalog_uses
from app.storage.models import CatalogChange, Solution

LABELS = {field.id: field.label.lower() for field in catalog_admin.FIELDS}
UNITS = {field.id: field.unit for field in catalog_admin.FIELDS}
SPEC_ACTIONS = {"spec_add", "spec_edit", "update_accept", "file_edit"}


@dataclass
class News:
    at: datetime
    kind: str  # new, spec, price, task
    title: str
    text: str
    solution_id: str | None
    photo_url: str | None


def news(session: Session, limit: int = 8) -> list[News]:
    rows = session.scalars(
        select(CatalogChange).order_by(CatalogChange.at.desc(), CatalogChange.id.desc()).limit(limit * 6)
    ).all()
    ids = {row.solution_id for row in rows if row.solution_id}
    solutions = {
        s.id: s
        for s in session.scalars(select(Solution).where(Solution.id.in_(ids)).options(selectinload(Solution.photo)))
    }
    found: list[News] = []
    for row in rows:
        item = _item(row, solutions.get(row.solution_id or ""))
        if item is not None:
            found.append(item)
        if len(found) == limit:
            break
    return found


def _item(row: CatalogChange, solution: Solution | None) -> News | None:
    changes = row.changes or {}
    title = solution.name if solution else row.solution_name
    photo = catalog_admin.photo_url(solution) if solution else None

    def make(kind: str, text: str) -> News:
        return News(row.at, kind, title, text, row.solution_id, photo)

    if row.action == "import":
        added = len(changes.get("added") or [])
        if not added:
            return None
        return News(
            row.at, "new", "Каталог ФЦ БАС", f"Загружена выгрузка организатора: новых позиций {added}", None, None
        )
    if row.action == "create":
        return make("new", "Новое решение в каталоге")
    if row.action == "update" and "price_rub" in changes:
        old, new = changes["price_rub"]
        return make("price", f"Цена {_money(old)} → {_money(new)}, поправил администратор")
    if row.action in SPEC_ACTIONS:
        fields = [
            key.split(".")[0] for key, pair in changes.items() if key.endswith(".value") and isinstance(pair, list)
        ]
        if not fields:
            return None
        if len(fields) == 1:
            old, new = changes[f"{fields[0]}.value"]
            unit = UNITS.get(fields[0], "")
            text = f"{LABELS.get(fields[0], fields[0]).capitalize()} {old or 'не было'} → {new}{' ' + unit if unit else ''}"
        else:
            text = "Обновлены характеристики: " + ", ".join(LABELS.get(f, f) for f in fields[:4])
        if row.action == "update_accept":
            text += ", сверено со страницей производителя"
        return make("spec", text)
    if row.action == "use_set":
        confirmed = [key for key, pair in changes.items() if isinstance(pair, list) and pair[-1] == "confirmed"]
        if not confirmed:
            return None
        facility, operation = confirmed[0].split("/", 1)
        op = catalog_uses.BY_KEY.get((facility, operation))
        where = f"{catalog_uses.FACILITIES.get(facility, facility)}, {(op.label if op else operation).lower()}"
        return make("task", f"Теперь в подборе: {where}")
    return None


def _money(raw: object) -> str:
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, ValueError):
        return "не было"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}".rstrip("0").rstrip(".").replace(".", ",") + " млн ₽"
    return f"{value:,.0f}".replace(",", " ") + " ₽"
