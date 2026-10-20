"""Отбор «товар к человеку» по робозоне на части склада, остальные задачи по плану человека."""

import json
import math
import re
from dataclasses import replace
from pathlib import Path

import pytest

from app.engine import plan as plan_engine
from app.engine.economics import evaluate
from app.schemas.economics import CalculationRequest
from app.services import calculation, simulation
from app.services import plan as plan_service

ROOT = Path(__file__).resolve().parents[2]
PICKING = {"operation_id": "piece_picking", "robot_id": "ronavi-m", "share": 1}
PALLETS = {"operation_id": "pallet_transport", "robot_id": "ronavi-h1500", "share": 1}


def _plan(template: str, operations: list[str]) -> plan_engine.Plan:
    return plan_service.generate("warehouse", operations, template)


def test_zone_aisle_is_the_same_on_front_and_server():
    """Порог проезда робозоны один: ZONE_AISLE_M в peak.ts и в plan.py."""
    peak = (ROOT / "frontend/src/app/steps/peak.ts").read_text(encoding="utf-8")
    front = float(re.search(r"export const ZONE_AISLE_M = ([\d.]+);", peak).group(1))
    assert front == plan_service.ZONE_AISLE_M


def test_plan_fits_picking_same_examples_as_front():
    """Те же случаи, что в frontend/tests/peak.test.ts (planFitsPicking): годится только шаблон робозоны."""
    zone = _plan("robot_zone", ["piece_picking"])
    assert plan_service.fits_picking(zone)
    assert not plan_service.fits_picking(_plan("one_side", ["pallet_transport", "piece_picking"]))
    assert not plan_service.fits_picking(replace(zone, template="custom"))


def test_default_zone_share_is_formula_fleet_times_market_density():
    """10% склада по умолчанию: парк по формуле 20 Ronavi M на 50 м2 на робота = 1 000 м2, кратно 100 м2."""
    model, _ = calculation.model_with_overrides({})
    facility = next(f for f in model["facilities"] if f["id"] == "warehouse")
    fleet = evaluate(model, "warehouse", "piece_picking", "ronavi-m").sizing.fleet
    density = model["engine"]["geometry"]["picking_m2_per_robot"]
    area = min(facility["active_area_m2"], math.ceil(fleet * density / 100) * 100)
    assert fleet == 20
    assert area == 1000
    assert facility["picking_zone_share"] == pytest.approx(area / facility["active_area_m2"])
    assert plan_service.picking_zone_m2(facility) == 1000


def test_robot_zone_is_built_on_the_picking_part_and_follows_the_share():
    zone = plan_service.measure(_plan("robot_zone", ["piece_picking"]))
    assert 900 <= zone.area_m2 <= 1100
    wider = plan_service.generate(
        "warehouse", ["piece_picking"], "robot_zone", {"facilities.warehouse.picking_zone_share": 0.5}
    )
    assert 4900 <= plan_service.measure(wider).area_m2 <= 5100
    # у паллет схемы под погрузчик на весь склад, как раньше
    assert plan_service.measure(_plan("one_side", ["pallet_transport"])).area_m2 >= 10000


def test_zone_share_out_of_bounds_is_refused():
    with pytest.raises(calculation.Impossible):
        calculation.model_with_overrides({"facilities.warehouse.picking_zone_share": 0.01})
    with pytest.raises(calculation.Impossible):
        calculation.model_with_overrides({"facilities.warehouse.picking_zone_share": 1.5})


def test_only_picking_leaves_a_forklift_plan():
    corner = _plan("corner", ["pallet_transport", "piece_picking"])
    assert simulation.picking_on_zone("warehouse", "piece_picking")
    assert not simulation.picking_on_zone("warehouse", "pallet_transport")
    assert simulation.task_plan("warehouse", "pallet_transport", corner) is corner
    assert simulation.task_plan("warehouse", "piece_picking", corner).template == "robot_zone"
    zone = _plan("robot_zone", ["pallet_transport", "piece_picking"])
    # отбор идет по робозоне с ползунка, а не по плану человека, даже если это тоже робозона
    assert simulation.task_plan("warehouse", "piece_picking", zone) is not zone


def test_pallet_demo_with_shift_does_not_change():
    """docs/example/request.json: 9 роботов, 33,04 млн на старте без НДС, покупка окупается за 1,06 года
    (режим датасета 2 смены по 11 ч, 365 дней; на пятидневке 2 смены по 8 ч, 250 дней было 13 роботов,
    45,01 млн и 2,38 года). Роботы 9 * 2,7 / 1,22 = 19,92 млн, интеграция 5 * 0,9 / 1,22 = 3,69 млн."""
    body = json.loads((ROOT / "docs/example/request.json").read_text(encoding="utf-8"))
    result = calculation.calculate(CalculationRequest(**body))
    purchase = next(s for s in result.scenarios if s.id == "purchase")
    assert result.sizing.fleet == 9
    assert round(purchase.capex_total_rub / 1e6, 2) == 33.04
    assert round(purchase.payback_cumulative_years, 2) == 1.06
    assert result.picking_zones == []


def test_picking_on_forklift_plan_is_sized_on_the_robot_zone():
    """Отбор и паллеты на Г-образном плане под погрузчик: отбор по робозоне 1 000 м2, паллеты по плану.
    При 100 000 строк прогон давал 108 Ronavi M на этом плане и 119 на робозоне во весь склад."""
    corner = plan_service.to_dict(_plan("corner", ["pallet_transport", "piece_picking"]))
    both = calculation.calculate(CalculationRequest(tasks=[PALLETS, PICKING], plan=corner, use_simulation=True))
    alone = calculation.calculate(CalculationRequest(tasks=[PALLETS], plan=corner, use_simulation=True))
    fleets = {part.operation_id: part.sizing.fleet for part in both.tasks}
    # паллеты считаются по плану человека, как и без отбора
    assert fleets["pallet_transport"] == alone.sizing.fleet
    # отбор на 4 станции: на малой робозоне 3-7 роботов на станцию, у Amazon с Kiva 6-9
    assert 12 <= fleets["piece_picking"] <= 28
    [zone] = both.picking_zones
    assert zone.operation_id == "piece_picking"
    assert zone.area_m2 == 1000
    # без плана отбор идет по той же робозоне
    bare = calculation.calculate(CalculationRequest(tasks=[PICKING], use_simulation=True))
    assert bare.sizing.fleet == fleets["piece_picking"]


def test_picking_with_stations_at_far_wall_is_sized_like_the_robot_zone():
    """Нарисованный план со станциями у дальней стены и узкими проездами не меняет отбор:
    парк тот же, что на робозоне, а строка на шаге 5 есть, потому что план не робозона."""
    zone = _plan("robot_zone", ["piece_picking"])
    far = replace(zone, template="custom")
    request = {"tasks": [PICKING], "use_simulation": True}
    on_zone = calculation.calculate(CalculationRequest(**request, plan=plan_service.to_dict(zone)))
    on_far = calculation.calculate(CalculationRequest(**request, plan=plan_service.to_dict(far)))
    assert on_far.sizing.fleet == on_zone.sizing.fleet
    assert on_zone.picking_zones == []
    assert [one.operation_id for one in on_far.picking_zones] == ["piece_picking"]


def test_picking_robot_without_station_data_is_not_calculated(monkeypatch):
    """Если в config у робота нет станции отбора, экономику отбора не считаем, говорим почему.
    У всех роботов, которых подбор не исключает, станция теперь есть, поэтому убираем ее у Ronavi H1500."""
    model, provenance = calculation.load_full_model(calculation.settings.config_dir)
    next(r for r in model["robots"] if r["id"] == "ronavi-h1500")["station_price_rub"] = 0
    monkeypatch.setattr(calculation, "_model", lambda: (model, provenance))
    result = calculation.calculate(
        CalculationRequest(tasks=[{"operation_id": "piece_picking", "robot_id": "ronavi-h1500", "share": 1}])
    )
    assert not result.feasible
    assert result.cause == "solution"
    assert result.message == calculation.NO_STATION_DATA
    assert result.scenarios == []
