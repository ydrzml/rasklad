"""Упаковка у станций отбора: ставки по норме, одни и те же до роботов и после, места и конвейер на плане."""

import math

import pytest

from app.engine import plan as plan_engine
from app.engine.economics import evaluate
from app.services import calculation
from app.services import plan as plan_service


def _picking(overrides: dict | None = None):
    model, _ = calculation.model_with_overrides(overrides or {})
    return evaluate(model, "warehouse", "piece_picking", "ronavi-m")


def test_packers_by_the_norm_on_the_demo():
    """10 500 штучных строк * 1,5 штуки = 15 750 штук в сутки при 300 штуках в час на упаковщика:
    15 750 * 365 / (300 * 1972) * 1,25 = 12,15 ставки, на пост 22 * 365 / 1972 * 1,25 = 5,09 ставки,
    12,15 / 5,09 = 2,39 человека в смену. Мест под пик: спрос с резервом 10 500 / 22 * 1,5 * 1,15 = 823,3
    строки в час * 1,5 / 300 = 4,12, вверх 5."""
    sizing = _picking().sizing
    assert sizing.packing_fte == pytest.approx(12.15, abs=0.01)
    assert sizing.packing_per_shift == pytest.approx(2.39, abs=0.01)
    assert sizing.packing_places == 5
    # ставка по (25) с окладом 103 000: 1 236 000 + 30% + 0,6%
    assert sizing.packing_cost == pytest.approx(1_614_216)


def test_packers_cost_the_same_with_and_without_robots():
    """Упаковщики входят и в базу, и в покупку одинаково: эффект и окупаемость от них не зависят."""
    result = _picking()
    # упаковщик в тысячу раз быстрее: упаковщиков почти нет, верхняя граница правки 300 000
    off = _picking({"facilities.warehouse.operations.piece_picking.packing.productivity": 300_000})
    # (12,147 - 0,012) * 1 614 216 = 19,59 млн в первый год против почти нуля (у быстрого упаковщика 0,012 ставки)
    first = (result.sizing.packing_fte - off.sizing.packing_fte) * result.sizing.packing_cost
    assert first == pytest.approx(19_587_700, rel=0.001)
    for scenario in ("baseline", "purchase"):
        gap = result.scenarios[scenario].years[0].staff_cost - off.scenarios[scenario].years[0].staff_cost
        assert gap == pytest.approx(first, rel=0.001)
    assert result.scenarios["purchase"].payback_cumulative == pytest.approx(
        off.scenarios["purchase"].payback_cumulative
    )


def test_pallets_have_no_packing():
    model, _ = calculation.model_with_overrides({})
    sizing = evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500").sizing
    assert (sizing.packing_fte, sizing.packing_places) == (0.0, 0)


def test_robot_zone_draws_packing_places_and_a_conveyor():
    """На робозоне 1 000 м2 4 станции, места упаковки в промежутках полосы станций и лента к доковой зоне.
    По норме мест 5, и на полосу станций встают все 5. Места и лента не наезжают ни друг на друга, ни на станции."""
    plan = plan_service.generate("warehouse", ["piece_picking"], "robot_zone")
    stations = plan.of(plan_engine.STATION)
    packing = [one for one in plan.of(plan_engine.BLOCKED) if one.role == plan_engine.PACKING]
    conveyor = [one for one in plan.of(plan_engine.BLOCKED) if one.role == plan_engine.CONVEYOR]
    assert len(stations) == 4
    assert len(packing) == 5
    assert len(conveyor) == 1
    things = [*stations, *packing, *conveyor]
    for index, one in enumerate(things):
        for other in things[index + 1 :]:
            apart = one.x + one.w <= other.x or other.x + other.w <= one.x
            apart = apart or one.y + one.h <= other.y or other.y + other.h <= one.y
            assert apart, (one.id, other.id)
    # лента идет от полосы станций вниз к доковой зоне, вдоль восточной стены
    [belt] = conveyor
    hall = plan.sections[0]
    assert belt.x + belt.w == hall.x + hall.w
    assert belt.h > belt.w


def test_places_follow_the_packer_rate():
    """Вдвое быстрее упаковщик: вдвое меньше мест, ceil(823,3 * 1,5 / 600) = 3."""
    fast = {"facilities.warehouse.operations.piece_picking.packing.productivity": 600}
    plan = plan_service.generate("warehouse", ["piece_picking"], "robot_zone", fast)
    packing = [one for one in plan.of(plan_engine.BLOCKED) if one.role == plan_engine.PACKING]
    assert len(packing) == math.ceil(823.3 * 1.5 / 600)


def test_forklift_plan_for_pallets_has_no_packing():
    plan = plan_service.generate("warehouse", ["pallet_transport"], "one_side")
    assert not [one for one in plan.of(plan_engine.BLOCKED) if one.role in (plan_engine.PACKING, plan_engine.CONVEYOR)]
