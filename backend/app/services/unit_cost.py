"""Стоимость одной операции в каждом сценарии: рублей за перевозку паллеты, строку отбора, м2 уборки.

Берем расходы сценария за горизонт (вложения, люди, операторы, обслуживание, энергию) и делим на
число операций за тот же горизонт. Так три сценария сравнимы между собой в рублях за единицу
работы, а не только в миллионах за пять лет. Общие на объект затраты раскладываем по задачам
пропорционально их собственной стоимости в этом сценарии.
"""

from __future__ import annotations

from app.schemas.economics import SharedPart, TaskPart, UnitCost, UnitCostScenario

# Что считаем одной операцией: в винительном падеже, после "за"
UNIT_WORDS = {
    "pallet_transport": "перевозку паллеты",
    "piece_picking": "строку отбора",
    "cleaning": "м2 уборки",
}
DEFAULT_UNIT = "операцию"


def compute(tasks: list[TaskPart], shared: SharedPart | None, facility: dict, horizon_years: int) -> list[UnitCost]:
    """Стоимость операции по каждой задаче объекта. Пусто, если объем или стоимость не определены."""
    operations = {one["id"]: one for one in facility.get("operations", [])}
    days = facility.get("schedule", {}).get("days_per_year", 365)
    shared_by_id = {one.id: one.tco_rub for one in (shared.scenarios if shared else [])}

    # задача могла попасть в расчет двумя решениями (смешанный парк): их стоимость складываем
    own: dict[str, dict[str, float]] = {}
    for part in tasks:
        into = own.setdefault(part.operation_id, {})
        for scenario in part.scenarios:
            into[scenario.id] = into.get(scenario.id, 0.0) + scenario.tco_rub
    totals = {sid: sum(by_id.get(sid, 0.0) for by_id in own.values()) for sid in shared_by_id}
    names = {part.operation_id: part.operation_name for part in tasks}

    out: list[UnitCost] = []
    for operation_id, by_scenario in own.items():
        operation = operations.get(operation_id)
        if not operation:
            continue
        volume = operation["volume_per_day"] * days * horizon_years
        if volume <= 0:
            continue
        growth = operation.get("volume_growth", 1.0)
        rows = []
        for scenario_id, tco in by_scenario.items():
            extra = shared_by_id.get(scenario_id, 0.0)
            total = totals.get(scenario_id, 0.0)
            cost = tco + (extra * tco / total if total > 0 else 0.0)
            # после роботизации объем может вырасти: тогда и операций за те же деньги больше
            done = volume if scenario_id == "baseline" else volume * growth
            rows.append(UnitCostScenario(id=scenario_id, rub_per_unit=cost / done))
        out.append(
            UnitCost(
                operation_id=operation_id,
                operation_name=names[operation_id],
                per=UNIT_WORDS.get(operation_id, DEFAULT_UNIT),
                operations_horizon=volume,
                scenarios=rows,
            )
        )
    return out
