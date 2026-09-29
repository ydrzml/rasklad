"""Инварианты прогона смены: что должно быть верно на любом складе, а не на одной схеме.

Склады и проверки лога берем со стенда (scripts/run_shift_bench.py), чтобы тесты и таблица
в docs/simulation-check.md мерили одно и то же.

Часть проверок пока падает: движок упрощает, и стенд это нашел. Такие тесты помечены xfail
с этапом, на котором чиним. strict значит, что после починки тест сам скажет снять пометку.
"""

import random
import time
from dataclasses import replace

import pytest

from app.engine import plan as P
from app.engine import simulation as sim
from scripts import run_shift_bench as bench

PLENTY = 5_000  # заданий больше, чем парк вытянет: меряем потолок, а не поток
HOURS = 8
LIMIT_S = 60  # ТЗ: расчет не дольше минуты


def case(name: str) -> bench.Case:
    return next(item for item in bench.CASES if item.name == name)


@pytest.fixture(scope="module")
def typical():
    return bench.setup(case("С одной стороны, 10 тыс. м2"))


@pytest.fixture(scope="module")
def tight():
    return bench.setup(case("Узкий склад, один проезд"))


@pytest.fixture(scope="module")
def picking():
    return bench.setup(case("Робозона со станциями, 3 тыс. м2"))


@pytest.fixture(scope="module")
def two_walls():
    return bench.setup(case("Свой склад, ворота на двух стенах"))


def logged(s: bench.Setup, fleet: int, demand: float = PLENTY, seed: int = 42) -> sim.Result:
    return sim.run_shift(s.traced, s.spec, fleet, demand, HOURS, seed, record=True)


def test_curve_does_not_fall_and_levels_off_in_a_tight_warehouse(tight):
    values = bench.curve(tight, 42)
    # между соседними замерами шум случайности, поэтому допускаем три процента вниз
    assert all(after >= before * 0.97 for before, after in zip(values, values[1:], strict=False))
    assert bench._flat(values, tight.max_fleet, float("inf"))  # одни ворота: дальше парк не растет
    assert len(values) < 60  # на полке кривая останавливается сама, до предела парка не идет


def test_curve_does_not_fall_in_a_roomy_warehouse(typical):
    values = bench.curve(typical, 42, until=300)
    assert all(after >= before * 0.97 for before, after in zip(values, values[1:], strict=False))
    assert values[-1] > values[len(values) // 2]


def test_one_robot_matches_the_cycle_formula_on_the_plan(typical):
    """Один робот без очередей: цикл = туда и обратно по среднему маршруту плана, погрузка и
    переезд по буферу. Робот разгрузился у своего ряда, а следующая паллета стоит у другого,
    поэтому к началу пути он едет по буферу. Средний переезд считаем по случайным парам мест."""
    kpi = logged(typical, 1).kpi
    gate = typical.layout.gates[0]
    draw = random.Random(1)
    pairs = [(draw.randrange(len(gate.arrival)), draw.randrange(len(gate.arrival))) for _ in range(20_000)]
    shuffle_m = sum(
        abs(gate.arrival[a][0] - gate.arrival[b][0]) + abs(gate.arrival[a][1] - gate.arrival[b][1]) for a, b in pairs
    ) / len(pairs)
    formula = (2 * typical.measures.route_m + shuffle_m) / typical.spec.speed_m_s + typical.spec.handling_s
    assert len(typical.layout.gates) == 1  # на складе с одной стороны буфер один
    assert kpi.waiting_share == 0
    assert kpi.avg_cycle_s == pytest.approx(formula, rel=0.05)


@pytest.mark.parametrize("fixture", ["typical", "picking"])
def test_segments_of_a_robot_do_not_overlap(fixture, request):
    s = request.getfixturevalue(fixture)
    found = bench.check_log(logged(s, 6).segments, s.grid, 6, HOURS)
    assert found.overlaps == 0


@pytest.mark.parametrize("fixture", ["typical", "picking"])
def test_segments_of_a_robot_have_no_time_gaps(fixture, request):
    """Проигрыватель двигает робота по отрезкам: дыра по времени значит, что робот пропал с экрана.
    Простой без задания тоже отрезок, и то, что не кончилось к концу смены, дописано до конца."""
    s = request.getfixturevalue(fixture)
    assert bench.check_log(logged(s, 6, demand=60).segments, s.grid, 6, HOURS).gaps_s == 0


@pytest.mark.parametrize(
    "fixture",
    [
        "typical",
        "two_walls",
        "picking",
    ],
)
def test_segments_of_a_robot_do_not_jump(fixture, request):
    """Следующий отрезок начинается там, где кончился предыдущий: робот не телепортируется."""
    s = request.getfixturevalue(fixture)
    assert bench.check_log(logged(s, 6, demand=60).segments, s.grid, 6, HOURS).jumps == []


@pytest.mark.parametrize("fixture", ["typical", "tight"])
def test_polylines_do_not_pass_through_racks_or_walls(fixture, request):
    s = request.getfixturevalue(fixture)
    found = bench.check_log(logged(s, 6).segments, s.grid, 6, HOURS)
    assert found.through == []


def test_reachable_plans_issue_only_reachable_places(typical, picking, tight):
    assert bench.unreachable_issued(typical.layout) == 0
    assert bench.unreachable_issued(picking.layout) == 0
    assert bench.unreachable_issued(tight.layout) == 0


def test_places_cut_off_from_the_stations_are_not_issued():
    """Стенка перед станциями: до ворот доехать можно, до станций нельзя."""
    base = case("Робозона со станциями, 3 тыс. м2")
    plan = base.build()
    station = plan.of(P.STATION)[0]
    hall = plan.sections[0]
    wall = P.Item(id="wall", kind=P.BLOCKED, x=hall.x, y=station.y - 2, w=hall.w, h=1)
    s = bench.setup(replace(base, build=lambda: replace(plan, items=[*plan.items, wall])))
    assert bench.unreachable_issued(s.layout) == 0
    assert not s.layout.task_points  # стенка поперек всего зала: в отбор выдать нечего
    assert sim.run_shift(s.layout, s.spec, 3, PLENTY, 1, 42).kpi.done == 0


def test_each_wall_has_its_own_queue_and_robots_unload_there(two_walls):
    """Ворота на двух стенах: у каждого буфера свои места, и роботы разгружаются у обоих."""
    assert [gate.slots for gate in two_walls.layout.gates] == [4, 4]
    result = logged(two_walls, 8)
    ys = {round(part.path[0][1]) for part in result.segments if part.action == sim.HANDLING}
    hall = two_walls.plan.sections[0]
    assert any(y < hall.y + 15 for y in ys) and any(y > hall.y + hall.h - 15 for y in ys)


@pytest.mark.parametrize("fixture", ["typical", "picking", "tight"])
def test_time_of_a_robot_fits_into_the_shift(fixture, request):
    s = request.getfixturevalue(fixture)
    result = logged(s, 8)
    kpi = result.kpi
    assert kpi.busy_share + kpi.waiting_share + kpi.charging_share <= 1 + 1e-9
    assert bench.check_log(result.segments, s.grid, 8, HOURS).over_shift == []


def test_same_seed_gives_the_same_log(picking):
    first, second = logged(picking, 5), logged(picking, 5)
    assert first.kpi == second.kpi
    assert [(p.robot, p.from_s, p.to_s, p.action, p.path) for p in first.segments] == [
        (p.robot, p.from_s, p.to_s, p.action, p.path) for p in second.segments
    ]


def test_curve_for_thirty_robots_fits_the_time_limit():
    s = bench.setup(case("С одной стороны, 30 тыс. м2"))
    began = time.perf_counter()
    bench.curve(s, 42, max_fleet=30)
    assert time.perf_counter() - began < LIMIT_S


@pytest.mark.parametrize("fixture", ["picking", "tight"])
def test_curve_measures_the_warehouse_not_the_task_flow(fixture, request):
    """Кривая считается при избыточном спросе. Если вдвое больше заданий меняет потолок, значит
    кривая упиралась в поток заданий, а не в склад: так было у робозоны, пока спрос брали от номинала."""
    s = request.getfixturevalue(fixture)
    top = 20
    enough = sim.plenty(s.layout, s.spec, top)
    first = sim.run_shift(s.layout, s.spec, top, enough, HOURS, 42, record=False).kpi.ops_per_hour
    double = sim.run_shift(s.layout, s.spec, top, 2 * enough, HOURS, 42, record=False).kpi.ops_per_hour
    assert first == pytest.approx(double, rel=0.02)
