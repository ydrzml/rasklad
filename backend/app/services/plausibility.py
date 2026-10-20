"""Проверка правдоподобия итога (шаг 5, аудит Б2): окупаемость покупки и сокращение людей против
диапазонов опубликованных внедрений.

Диапазоны и их источники лежат в config/model.yaml, economics.plausibility, как остальные числа модели.
Расчет от проверки не меняется: это строка рядом с итогом "в диапазоне реальных внедрений" или "выше
обычного, проверьте". Где кейсов нет, строки нет: окупаемость только у покупки (у аренды один кейс),
сокращение людей собрано по отбору "стеллаж к человеку", поэтому у объекта без отбора остается одна
окупаемость."""

from __future__ import annotations

from app.engine.economics import PURCHASE
from app.engine.model_config import Provenance
from app.schemas.economics import CalculationResult, PlausibilityCheck

ROOT = "economics.plausibility"


def check(answer: CalculationResult, model: dict, provenance: dict[str, Provenance]) -> list[PlausibilityCheck]:
    bands = model["economics"].get("plausibility") or {}
    if not answer.feasible or not bands:
        return []
    facility = next(one for one in model["facilities"] if one["id"] == answer.facility_id)
    picking = {one["id"] for one in facility["operations"] if one.get("productivity_after")}
    parts = [part for part in answer.tasks if part.operation_id in picking]
    found: list[PlausibilityCheck] = []

    def add(key: str, value: float | None, scenario_id: str | None = None) -> None:
        if key not in bands:
            return
        low, high = bands[key]
        # окупаемости за горизонт нет: срок длиннее любого из кейсов, это выше диапазона
        status = "above" if value is None or value > high else "below" if value < low else "inside"
        meta = provenance[f"{ROOT}.{key}"]
        found.append(
            PlausibilityCheck(
                id=key,
                scenario_id=scenario_id,
                value=value,
                low=low,
                high=high,
                status=status,
                source=meta.source,
                date=meta.date,
                trust=meta.trust,
            )
        )

    for scenario in answer.scenarios:
        if scenario.id == PURCHASE:
            add("payback_years", scenario.payback_cumulative_years, scenario.id)

    before = sum(part.sizing.people_per_shift_before for part in parts)
    after = sum(part.sizing.people_per_shift_after for part in parts)
    if before > 0:
        add("staff_cut_share", 1 - after / before)
    return found
