"""Ходовой товар: 20% мест дают 75% заданий, и ставят его туда, куда быстрее доехать.

Доля мест у организатора (A-класс 20%), доля отборов у Bartholdi и Hackman (рис. 14.1: 20% позиций
дают больше 75% отборов). По умолчанию выключено: это выбор клиента, галочка в параметрах.
"""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.engine import plan as P
from app.engine import simulation as sim
from app.main import app
from app.schemas.economics import CalculationRequest
from app.services.calculation import calculate
from scripts import run_shift_bench as bench

client = TestClient(app)


def test_shares_match_the_hand_example():
    """Руками: k около 6.92, первые 5% мест дают около 29%, дальняя половина около 3%."""
    weights = sim.popularity_weights(1000, 0.2, 0.75)
    assert sum(weights) == pytest.approx(1)
    assert sum(weights[:200]) == pytest.approx(0.75, abs=1e-6)
    assert sum(weights[:50]) == pytest.approx(0.293, abs=0.001)
    assert sum(weights[500:]) == pytest.approx(0.031, abs=0.001)
    assert weights == sorted(weights, reverse=True)
    assert sim.popularity_weights(4, 0.5, 0.5) == [0.25] * 4  # точка без перекоса: поровну


@pytest.fixture(scope="module")
def warehouse():
    return next(item for item in bench.CASES if item.name == "С одной стороны, 10 тыс. м2")


def test_fast_goods_stand_close_to_the_gates(warehouse):
    layout = bench.setup(warehouse, slotted=True).layout
    by_share = sorted(range(len(layout.weights)), key=lambda i: -layout.weights[i])
    top, tail = by_share[: len(by_share) // 5], by_share[-len(by_share) // 5 :]
    mean = lambda places: sum(layout.to_dock_m[i] for i in places) / len(places)  # noqa: E731
    assert mean(top) < mean(tail) / 2
    assert not bench.setup(warehouse).layout.weights  # без галочки все места поровну


def test_zone_marked_by_hand_goes_first(warehouse):
    """Человек пометил дальнюю зону ходовой: ее места встают в начало очереди, хоть и далеко."""
    plan = warehouse.build()
    racks = plan.of(P.RACKS)[0]
    far = P.Item(**{**vars(racks), "id": "far", "x": racks.x + racks.w / 2, "w": racks.w / 2, "turnover": P.FAST})
    near = P.Item(**{**vars(racks), "id": "near", "w": racks.w / 2})
    marked = replace(plan, items=[item for item in plan.items if item is not racks] + [near, far])
    s = bench.setup(replace(warehouse, build=lambda: marked), slotted=True)
    fast = [i for i, point in enumerate(s.layout.task_points) if point[0] > far.x]
    assert sum(s.layout.weights[i] for i in fast) >= 0.75


def test_visits_gather_at_fast_places(warehouse):
    s = bench.setup(warehouse, slotted=True)
    result = sim.run_shift(s.layout, s.spec, 8, 5000, 8, 42, record=False)
    by_share = sorted(range(len(s.layout.weights)), key=lambda i: -s.layout.weights[i])
    top = by_share[: len(by_share) // 5]
    assert sum(result.visits[i] for i in top) / sum(result.visits) == pytest.approx(0.75, abs=0.05)


def test_checkbox_cuts_the_fleet():
    """С галочкой ходовое у ворот, робот ездит ближе, и парк по прогону меньше."""
    usual = calculate(CalculationRequest(use_simulation=True)).sizing.fleet
    slotted = calculate(
        CalculationRequest(use_simulation=True, overrides={"facilities.warehouse.slotted_by_turnover": 1})
    ).sizing.fleet
    assert slotted < usual


def test_api_gives_places_for_the_heat_map():
    body = client.post("/api/simulation/runs", json={"fleet": 6, "slotted_by_turnover": True}).json()
    places = body["places"]
    assert places and all({"x", "y", "share", "visits"} <= set(place) for place in places)
    assert sum(place["share"] for place in places) == pytest.approx(1)
    assert sum(place["visits"] for place in places) == body["kpi"]["done"]
    assert max(place["share"] for place in places) > 5 * min(place["share"] for place in places)
