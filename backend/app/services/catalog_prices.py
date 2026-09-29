"""Цена робота для экономики берется из каталога: ее правит администратор.

Остальные расчетные параметры (скорость, батарея, обслуживание) живут в config/model.yaml с источниками.
Цену каталога подставляем, только если она есть и отличается от цены в модели: пока они совпадают,
в "Откуда цифры" остается источник из модели, он подробнее (диапазон производителя, интегратор).
Если разошлись, источник и дату берем из журнала правок: кто и когда поменял цену в каталоге.
"""

from __future__ import annotations

import copy

from sqlalchemy import select

from app.engine.model_config import Provenance
from app.storage.models import CatalogChange, Solution

# Цены каталога: номер решения -> (цена, откуда). Сбрасывается вместе с каталогом подбора
_prices: dict[str, tuple[float, Provenance]] | None = None
_applied: tuple[dict, tuple[dict, dict[str, Provenance]]] | None = None
TRUST = "D"  # один источник, как у цены организатора в data/catalog: подтверждения нет


def forget() -> None:
    global _prices, _applied
    _prices, _applied = None, None


def apply(model: dict, provenance: dict[str, Provenance]) -> tuple[dict, dict[str, Provenance]]:
    """Модель с ценами каталога. Базовую модель не трогаем, копию помним до следующей правки каталога."""
    global _applied
    if _applied is not None and _applied[0] is model:
        return _applied[1]
    prices = _read()
    changed = [
        (robot["id"], prices[robot["catalog_id"]])
        for robot in model["robots"]
        if robot.get("catalog_id") in prices and abs(prices[robot["catalog_id"]][0] - robot["price_rub"]) >= 1
    ]
    result = (model, provenance)
    if changed:
        priced, sources = copy.deepcopy(model), dict(provenance)
        robots = {robot["id"]: robot for robot in priced["robots"]}
        for robot_id, (price, source) in changed:
            robots[robot_id]["price_rub"] = price
            sources[f"robots.{robot_id}.price_rub"] = source
        result = (priced, sources)
    _applied = (model, result)
    return result


def _read() -> dict[str, tuple[float, Provenance]]:
    global _prices
    if _prices is None:
        from app.services import selection  # сессии каталога одни на подбор и цены, их подменяют тесты

        with selection.sessions() as session:
            _prices = _load(session)
    return _prices


def _load(session) -> dict[str, tuple[float, Provenance]]:
    found = {}
    # ноль в ячейке выгрузки или в админке значит "цена не указана": бесплатных роботов не бывает
    for solution in session.scalars(select(Solution).where(Solution.price_rub > 0)):
        found[solution.id] = (float(solution.price_rub), _source(session, solution))
    return found


def _source(session, solution: Solution) -> Provenance:
    """Кто и когда последним поменял цену: администратор руками или загрузка выгрузки."""
    changes = session.scalars(
        select(CatalogChange)
        .where(CatalogChange.solution_id == solution.id)
        .order_by(CatalogChange.at.desc(), CatalogChange.id.desc())
    )
    last = next((c for c in changes if "price_rub" in (c.changes or {})), None)
    date = (last.at if last else solution.updated_at).date().isoformat()
    if last is not None and last.action in ("update", "create") and last.user_email:
        return Provenance(f"Цена из каталога, правил администратор {last.user_email}", date, TRUST)
    return Provenance("Цена из каталога решений (выгрузка ФЦ БАС, с НДС)", date, TRUST)
