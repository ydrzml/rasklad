"""Типовая планировка не ломается на малой площади и большом числе станций: зоны не налезают друг на друга,
а стеллажи помещаются в здание."""

import itertools

import pytest

from app.engine import plan as P
from app.services import plan as service

# у сквозного склада станции встают на вторые ворота: станций в нем шаблон не предусматривает
TEMPLATES = ("robot_zone", "one_side")
AREAS = (609, 800, 1000, 1500, 3000, 10_000, 30_000)
STATIONS = (0, 1, 5, 6, 9, 14)


@pytest.fixture(scope="module")
def constants():
    return service.constants()


def overlap(a: P.Item, b: P.Item) -> bool:
    return min(a.x + a.w, b.x + b.w) - max(a.x, b.x) > 1e-9 and min(a.y + a.h, b.y + b.h) - max(a.y, b.y) > 1e-9


def inside(item: P.Item, hall: P.Section) -> bool:
    return (
        item.x >= hall.x - 1e-9
        and item.y >= hall.y - 1e-9
        and item.x + item.w <= hall.x + hall.w + 1e-9
        and item.y + item.h <= hall.y + hall.h + 1e-9
    )


def clashes(plan: P.Plan) -> list[str]:
    """Пары вещей плана, стоящие друг на друге, и вещи за стенами здания. Ворота стоят в стене."""
    hall = plan.sections[0]
    found = [f"{a.id} x {b.id}" for a, b in itertools.combinations(plan.items, 2) if overlap(a, b)]
    return found + [f"{one.id} вне здания" for one in plan.items if one.kind != P.DOCK and not inside(one, hall)]


def build(constants: dict, template_id: str, area: float, stations: int, **kwargs) -> P.Plan:
    plan = P.generate(
        service.template(template_id), constants, area, stations, ceiling_m=10, margin_m=service.LOT_MARGIN_M, **kwargs
    )
    return P.rows_of(plan, constants)


@pytest.mark.parametrize("template_id", TEMPLATES)
@pytest.mark.parametrize("area", AREAS)
@pytest.mark.parametrize("stations", STATIONS)
def test_zones_do_not_overlap_and_racks_fit(constants, template_id, area, stations):
    # площадь 609 это наименьшая робозона (storage_minimum): 21 на 29 м
    plan = build(constants, template_id, area, stations)
    assert clashes(plan) == []
    # у малого одностороннего склада стеллажи не влезают и без станций: это прежнее ограничение
    if template_id == "robot_zone" or area >= 3000:
        assert len(plan.of(P.RACKS)) >= 2, "в здании нет места под стеллажи"
    assert len(plan.of(P.STATION)) == stations


def test_stations_stretch_the_wall_instead_of_piling_up(constants):
    # 9 станций по 3 м не встают в стену 17 м: здание вытягивается вдоль станционной стены
    plan = build(constants, "robot_zone", 609, 9)
    assert plan.sections[0].w >= 9 * 3 + 2
    assert len({(one.x, one.y) for one in plan.of(P.STATION)}) == 9


def test_own_size_keeps_stations_apart_in_second_row(constants):
    # габариты назвал человек, их не растягиваем: лишние станции встают вторым рядом, а не друг на друга
    plan = build(constants, "robot_zone", 17 * 29, 9, fit=False)
    stations = plan.of(P.STATION)
    assert len(stations) == 9
    assert not [a.id for a, b in itertools.combinations(stations, 2) if overlap(a, b)]
    assert len({one.y for one in stations}) == 2


def test_charge_keeps_a_gap_from_gate_buffer_and_stations(constants):
    plan = build(constants, "robot_zone", 609, 5)
    charge = plan.of(P.CHARGE)[0]
    near = [one for one in plan.items if one.kind in (P.DOCK, P.BUFFER, P.STATION)]
    grown = P.Item(id="gap", kind=P.BLOCKED, x=charge.x - 1, y=charge.y - 1, w=charge.w + 2, h=charge.h + 2)
    assert not [one.id for one in near if overlap(grown, one)]


@pytest.mark.parametrize("area", [800, 2000])
def test_small_facility_gets_a_full_robot_zone(area):
    # малый склад получает робозону не меньше минимума: станции вдоль стены, стеллажи сеткой, ничего поверх друг друга
    overrides = {"facilities.warehouse.active_area_m2": area}
    plan = service.generate("warehouse", ["piece_picking"], "robot_zone", overrides)
    assert clashes(plan) == []
    assert len(plan.of(P.STATION)) >= 1
    assert len(plan.of(P.RACKS)) >= 6
    assert service.measure(plan).area_m2 >= service.zone_minimum_m2()
