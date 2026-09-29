"""Линия движения: по полосе едут только в одну сторону, поперек переезжать можно.

Путь от ворот к месту и обратно становится разным, поэтому волну считаем в обе стороны.
Змейка кладет полосы на все проезды зоны разом, в соседних проездах в разные стороны.
"""

from dataclasses import replace

import pytest

from app.engine import plan as P
from app.engine import simulation as sim
from app.services import plan as plan_service
from scripts import run_shift_bench as bench


@pytest.fixture(scope="module")
def constants():
    return plan_service.constants()


def _hall(*items) -> P.Plan:
    """Зал 20 на 5 метров, ворота и буфер у западной стены."""
    hall = P.Section("hall", 0, 0, 20, 5, 0.0, 8.0)
    dock = P.Item(id="dock", kind=P.DOCK, x=0, y=1, w=1, h=3, role=P.BOTH)
    buffer = P.Item(id="buffer", kind=P.BUFFER, x=1, y=1, w=2, h=3, role=P.BOTH)
    return P.Plan(width_m=20, length_m=5, template="custom", items=[dock, buffer, *items], sections=[hall])


def test_lane_forbids_going_back_but_not_across(constants):
    """Полоса на восток во всю ширину зала: от ворот на восток доедем, обратно к воротам нет."""
    lane = P.Item(id="lane", kind=P.FLOW, x=4, y=0, w=16, h=5, direction="east")
    grid = P.rasterize(_hall(lane), constants)
    buffer = P.sources_of(grid, [P.Item(id="b", kind=P.BUFFER, x=1, y=1, w=2, h=3)])
    far = 2 * grid.cols + 15
    assert P.distances(grid, buffer, toward=False)[far] < P.INF  # от ворот до дальней клетки
    assert P.distances(grid, buffer)[far] == P.INF  # обратно против стрелки нельзя
    assert grid.allows(far, far + grid.cols, 0, 1)  # поперек полосы можно


def test_narrow_lane_leaves_a_way_back(constants):
    """Полоса только по середине зала: обратно робот едет рядом с ней, путь длиннее не станет."""
    lane = P.Item(id="lane", kind=P.FLOW, x=4, y=2, w=16, h=1, direction="east")
    grid = P.rasterize(_hall(lane), constants)
    buffer = P.sources_of(grid, [P.Item(id="b", kind=P.BUFFER, x=1, y=1, w=2, h=3)])
    back = P.distances(grid, buffer)
    assert back[2 * grid.cols + 15] < P.INF
    path = P.trace(grid, back, (15, 2))
    assert not bench._against(grid, path)  # ломаная назад не идет по полосе против стрелки


def test_serpentine_alternates_the_aisles(constants):
    """Старая зона на много рядов: змейка по проездам внутри нее, как раньше."""
    plan = P.generate(plan_service.template("one_side"), constants, 10_000, margin_m=16)
    zone = plan.of(P.RACKS)[0]
    lanes = P.serpentine(zone, constants)
    assert len(lanes) == P.rack_cut(zone, constants).blocks - 1
    assert [lane.direction for lane in lanes[:4]] == ["north", "south", "north", "south"]
    assert P.serpentine(zone, constants, first="south")[0].direction == "south"
    grid = P.rasterize(replace(plan, items=[*plan.items, *lanes]), constants)
    assert all(grid.free(*cell) for lane in lanes for cell in grid.cells_of(lane) if grid.at(*cell) != P.RACK_CELL)


def test_serpentine_on_rows_matches_the_zone(constants):
    """Та же зона, разложенная на ряды: полосы ложатся в те же проезды и в те же стороны."""
    plan = P.generate(plan_service.template("one_side"), constants, 10_000, margin_m=16)
    zone = plan.of(P.RACKS)[0]
    rows = P.rows_of(plan, constants)
    snake = plan_service.serpentine(rows, zone.id)
    lanes = [item for item in snake.items if item.kind == P.FLOW]
    old = P.serpentine(zone, constants)
    assert [lane.direction for lane in lanes] == [lane.direction for lane in old]
    for lane, before in zip(lanes, old, strict=True):
        assert (lane.x, lane.w) == (pytest.approx(before.x), pytest.approx(before.w))
    # змейку можно попросить и с одного ряда: ляжет на всю группу, а не вдвое
    again = plan_service.serpentine(snake, rows.of(P.RACKS)[3].id)
    assert len([item for item in again.items if item.kind == P.FLOW]) == len(lanes)


def test_snake_makes_the_route_longer_but_keeps_every_place(constants):
    plan = plan_service.generate("warehouse", ["pallet_transport"])
    snake = plan
    for group in {item.group for item in plan.of(P.RACKS)}:
        snake = plan_service.serpentine(snake, group)
    plain = P.measure(plan, constants)
    snaked = P.measure(snake, constants)
    assert snaked.unreachable_points == 0
    assert snaked.route_m > plain.route_m  # объезд по змейке длиннее, чем напрямую


def test_robots_never_drive_against_the_arrows():
    case = next(item for item in bench.CASES if item.name.endswith("змейка"))
    s = bench.setup(case)
    result = sim.run_shift(s.traced, s.spec, 8, 5000, 8, 42, record=True)
    found = bench.check_log(result.segments, s.grid, 8, 8)
    assert found.against == [] and found.jumps == [] and found.through == []
    plain = bench.setup(next(item for item in bench.CASES if item.name == "С одной стороны, 10 тыс. м2"))
    alone = sim.run_shift(s.layout, s.spec, 1, 5000, 8, 42, record=False).kpi.avg_cycle_s
    assert alone > sim.run_shift(plain.layout, plain.spec, 1, 5000, 8, 42, record=False).kpi.avg_cycle_s


def test_api_lays_a_snake_on_a_zone():
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    plan = client.post("/api/plan/generate", json={}).json()["plan"]
    zone = next(item for item in plan["items"] if item["kind"] == "racks")
    once = client.post("/api/plan/serpentine", json={"plan": plan, "zone_id": zone["id"]}).json()
    lanes = [item for item in once["plan"]["items"] if item["kind"] == "flow"]
    assert lanes and {lane["direction"] for lane in lanes} == {"north", "south"}
    twice = client.post("/api/plan/serpentine", json={"plan": once["plan"], "zone_id": zone["id"]}).json()
    assert len([item for item in twice["plan"]["items"] if item["kind"] == "flow"]) == len(lanes)  # не вдвое
    assert once["measures"]["route_m"] > client.post("/api/plan/measure", json=plan).json()["measures"]["route_m"]
    missing = client.post("/api/plan/serpentine", json={"plan": plan, "zone_id": "nope"})
    assert missing.status_code == 404
