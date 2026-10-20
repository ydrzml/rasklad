"""Движок медучреждения: этаж на сетке, пути через лифт, лифт-очередь, двери, проверка плана.

Сценарии по наработкам Аркера (лифт без интеграции, узкая дверь, ручная дверь, одна кабина,
повтор по seed, лог без дыр) переписаны под наш план и наш прогон.
"""

from __future__ import annotations

import math
from dataclasses import replace

import pytest
import simpy

from app.engine.clinic.building import FREE, WALL_CELL, floor_map
from app.engine.clinic.check import ERROR, WARNING, check
from app.engine.clinic.demand import Job, hourly
from app.engine.clinic.lift import PEOPLE, ROUTINE, URGENT, Cabin, LiftTimes
from app.engine.clinic.metrics import StaffTimes, kpi
from app.engine.clinic.routes import Leg, Navigator, Ride, RobotSize, crossings, flight_s
from app.engine.clinic.shift import IN_LIFT, Shift, Times
from tests.clinic.helpers import ROBOT, SPEC, house

LIFT = LiftTimes(1.0, 0.8, 3, 3, 10, 3.3, 2)
TIMES = Times(60, 90, 5, 30, 1, LIFT)
STAFF = StaffTimes(1.0, 60, 45)
ROOMS = {"pharmacy": 1, "post": 2}


def one_job(created: float = 60.0, deadline: float = 3600.0) -> list[Job]:
    return [Job("meds-001", "meds", "pharmacy", "post", created, created + deadline, False, pick_s=0.0)]


def run(building, jobs, fleet=1, hours=1.0, seed=42, record=True):
    shift = Shift(building, SPEC, fleet, jobs, ROOMS, TIMES, hours, seed, record=record)
    return shift.run()


# --- этаж и пути -----------------------------------------------------------------------


def test_room_has_walls_and_the_door_cuts_a_passage():
    fmap = floor_map(house().floors[0], ROBOT.need_mm)
    grid = fmap.grid
    assert grid.at(0, 3) == WALL_CELL  # стена аптеки по северному краю
    assert grid.at(2, 3) == FREE  # дверь
    assert "pharmacy" in fmap.spots and "L1" in fmap.landings


def test_narrow_door_closes_the_room_for_this_robot():
    narrow = floor_map(house(door_mm=500).floors[1], ROBOT.need_mm)
    assert narrow.grid.at(16, 3) == WALL_CELL
    nav = Navigator(house(door_mm=500), ROBOT)
    start, finish = nav.spot(1, "pharmacy"), nav.spot(2, "post")
    assert nav.route(start, finish) is None


def test_route_goes_through_the_lift_between_floors():
    nav = Navigator(house(), ROBOT)
    steps = nav.route(nav.spot(1, "pharmacy"), nav.spot(2, "post"))
    assert [type(step) for step in steps] == [Leg, Ride, Leg]
    assert steps[1].lift == "L1" and (steps[1].from_floor, steps[1].to_floor) == (1, 2)
    # дверь аптеки на первом куске, дверь поста на последнем
    assert [door.id for _, door in steps[0].doors] == ["pharmacy-door"]
    assert [door.id for _, door in steps[2].doors] == ["post-door"]


def test_lift_without_integration_blocks_only_trips_between_floors():
    nav = Navigator(house(lift_robots=False), ROBOT)
    assert nav.route(nav.spot(1, "pharmacy"), nav.spot(2, "post")) is None
    charge = nav.maps[1].chargers[0][1]
    from app.engine.clinic.routes import Anchor

    assert nav.route(nav.spot(1, "pharmacy"), Anchor(1, charge)) is not None


def test_cabin_smaller_than_robot_closes_the_lift():
    nav = Navigator(house(cabin_mm=(600, 700)), ROBOT)
    assert not nav.usable("L1")


def test_lift_entrance_uses_connected_hall_instead_of_an_isolated_nearest_pocket():
    from app.engine.clinic.building import BLOCKED, Item
    from app.engine.clinic.routes import Anchor

    building = house()
    for floor in building.floors:
        floor.items += [
            Item(f"f{floor.number}-pocket-bottom", BLOCKED, 7, 6, 2, 1),
            Item(f"f{floor.number}-pocket-left", BLOCKED, 7, 7, 1, 3),
        ]
    nav = Navigator(building, ROBOT)
    # Прежний выбор (8, 8) был ближе, но зажат между шахтой и преградами.
    assert nav.landing(1, "L1").cell == (11, 8)
    start, target = nav.spot(1, "pharmacy"), nav.spot(2, "post")
    assert nav.route(start, target) is not None
    assert "ward_unreachable" not in codes(check(building, ROBOT))
    # Шахта не превращается в проход из изолированного кармана.
    assert nav.route(Anchor(1, (8, 8)), target) is None
    result = run(building, one_job())
    assert result.jobs[0].done_s is not None and result.jobs[0].on_time
    assert any(segment.action == IN_LIFT for segment in result.segments)


@pytest.mark.parametrize(
    "building, robot, reason",
    [
        (house(), replace(ROBOT, rides_lift=False), "для выбранной модели не подтверждена работа с лифтом"),
        (house(lift_robots=False), ROBOT, "нет лифта с интеграцией"),
        (house(cabin_mm=(600, 700)), ROBOT, "ни один лифт с интеграцией не вмещает робота"),
        (house(door_mm=500), ROBOT, "на маршруте есть дверь уже 600 мм"),
    ],
)
def test_unreachable_room_explains_the_actual_route_constraint(building, robot, reason):
    found = [item for item in check(building, robot) if item.code == "ward_unreachable"]
    assert len(found) == 1
    assert reason in found[0].text
    assert found[0].floor == 2 and found[0].target == "post"


def test_accessible_pharmacy_does_not_mask_blocked_active_supplies_source():
    from app.engine.clinic.building import DOOR, ROOM, SUPPLIES, Item

    building = house()
    building.floors[0].items += [
        Item("supplies", ROOM, 14, 0, 6, 4, name="Склад расходников", role=SUPPLIES),
        Item("supplies-door", DOOR, 16, 3, 1, 1, width_mm=500),
    ]
    found = [item for item in check(building, ROBOT) if item.code == "ward_unreachable"]
    assert len(found) == 1 and "Склад расходников" in found[0].text
    assert "дверь уже 600 мм" in found[0].text
    building.scenario = {"supplies": {"enabled": False}}
    assert "ward_unreachable" not in codes(check(building, ROBOT))


def test_disabled_zero_volume_delivery_does_not_require_routes_to_unused_posts():
    building = house(lift_robots=False)
    building.scenario = {"meds": {"per_day": 0}, "supplies": {"enabled": False}}
    assert "ward_unreachable" not in codes(check(building, ROBOT))


def test_explicit_route_also_explains_unsupported_lift():
    building = house()
    building.scenario = {
        "meds": {"mode": "routes", "flows": [{"source": "pharmacy", "target": "post", "per_day": 10}]},
        "supplies": {"enabled": False},
    }
    found = [item for item in check(building, replace(ROBOT, rides_lift=False)) if item.code == "process_unreachable"]
    assert len(found) == 1 and "не подтверждена работа с лифтом" in found[0].text


def test_crossings_find_door_on_a_straight_segment():
    from app.engine.clinic.building import DOOR, Item

    door = Item("d", DOOR, 4, 0, 1, 2, width_mm=900)
    assert crossings([(0.5, 1.5), (9.5, 1.5)], [door]) == [(4.0, door)]
    assert crossings([(0.5, 5.5), (9.5, 5.5)], [door]) == []


def test_flight_time_is_not_a_sum_of_one_floor_trips():
    one = flight_s(3.3, 1.0, 0.8)
    two = flight_s(6.6, 1.0, 0.8)
    assert one == pytest.approx(3.3 + 1.25)
    assert two < 2 * one
    # до скорости не разогнаться: треугольник
    assert flight_s(0.4, 1.0, 0.8) == pytest.approx(2 * math.sqrt(0.5))


# --- лифт ------------------------------------------------------------------------------


def cabin(robots_per_ride: int) -> tuple[simpy.Environment, Cabin]:
    env = simpy.Environment()
    times = LiftTimes(1.0, 0.8, 3, 3, 10, 3.3, robots_per_ride)
    import random

    return env, Cabin(env, "L1", [1, 2, 3], times, 0.0, random.Random(1), True)


def test_two_robots_on_one_route_share_a_ride():
    env, lift = cabin(2)
    calls = [lift.call(1, 3, ROUTINE, 0), lift.call(1, 3, ROUTINE, 1)]
    env.run(until=600)
    assert all(call.done.triggered for call in calls)
    assert lift.robot_rides == 1


def test_one_robot_per_ride_makes_two_rides():
    env, lift = cabin(1)
    calls = [lift.call(1, 3, ROUTINE, 0), lift.call(1, 3, ROUTINE, 1)]
    env.run(until=600)
    assert all(call.done.triggered for call in calls)
    assert lift.robot_rides == 2


def test_people_and_urgent_go_first():
    env, lift = cabin(1)
    env.run(until=1)  # кабина стоит, очередь пустая
    routine = lift.call(2, 3, ROUTINE, 0)
    urgent = lift.call(2, 3, URGENT, 1)
    people = lift.call(3, 1, PEOPLE, None)
    env.run(until=900)
    assert people.boarded < urgent.boarded < routine.boarded
    assert lift.people_rides == 1 and lift.robot_rides == 2


def test_lift_is_one_cabin_its_log_does_not_overlap():
    env, lift = cabin(1)
    for robot in range(4):
        lift.call(1 + robot % 3, 3 - robot % 2, ROUTINE, robot)
    env.run(until=1200)
    segments = sorted(lift.segments, key=lambda seg: seg.from_s)
    for before, after in zip(segments, segments[1:], strict=False):
        assert before.to_s <= after.from_s + 1e-9


# --- прогон смены ----------------------------------------------------------------------


def test_delivery_through_lift_is_done_and_logged():
    result = run(house(), one_job())
    job = result.jobs[0]
    assert job.done_s is not None and job.on_time
    actions = {seg.action for seg in result.segments}
    assert IN_LIFT in actions
    assert any(seg.robots for seg in result.lift_segments)


def test_disabled_lift_leaves_the_job_blocked_with_a_reason():
    result = run(house(lift_robots=False), one_job())
    job = result.jobs[0]
    assert job.done_s is None and "не доехать" in job.blocked
    assert kpi(result, None, STAFF, LIFT).blocked == 1


def test_manual_door_adds_its_wait():
    auto = run(house(automatic=True), one_job()).jobs[0]
    manual = run(house(automatic=False), one_job()).jobs[0]
    assert manual.done_s - auto.done_s == pytest.approx(TIMES.door_manual_s - TIMES.door_auto_s, abs=1e-6)


def test_people_on_the_lift_slow_robots_down():
    quiet = run(house(people=0), one_job() * 1).jobs[0]
    busy = run(house(people=60), one_job() * 1).jobs[0]
    assert busy.done_s >= quiet.done_s


def test_same_seed_repeats_the_shift():
    first = run(house(people=12), one_job() + one_job(900), hours=1)
    second = run(house(people=12), one_job() + one_job(900), hours=1)
    assert [(s.robot, s.from_s, s.action) for s in first.segments] == [
        (s.robot, s.from_s, s.action) for s in second.segments
    ]


def test_robot_log_covers_the_shift_without_gaps_or_overlaps():
    jobs = [Job(f"m-{i}", "meds", "pharmacy", "post", 120.0 * i, 120.0 * i + 3600, False) for i in range(1, 12)]
    result = run(house(people=12), jobs, fleet=2, hours=1)
    until = 3600.0
    for robot in (0, 1):
        own = sorted((s for s in result.segments if s.robot == robot), key=lambda s: s.from_s)
        assert own[0].from_s == pytest.approx(0.0)
        assert own[-1].to_s == pytest.approx(until)
        for before, after in zip(own, own[1:], strict=False):
            assert before.to_s == pytest.approx(after.from_s, abs=1e-6), (robot, before, after)


def test_late_jobs_stay_in_the_on_time_denominator():
    # срок 1 секунда: доставка не успевает, но заявка в знаменателе
    result = run(house(), one_job(deadline=1.0))
    summary = kpi(result, None, STAFF, LIFT)
    assert summary.due == 1 and summary.on_time == 0 and summary.on_time_share == 0.0


def test_shift_end_clips_the_lift_log():
    result = run(house(people=30), one_job(created=3500), hours=1)
    assert all(seg.to_s <= 3600 + 1e-9 for seg in result.lift_segments)
    assert all(seg.to_s <= 3600 + 1e-9 for seg in result.segments)


def test_staff_hours_count_only_done_jobs():
    building = house()
    result = run(building, one_job())
    hours = kpi(result, Navigator(building, ROBOT), STAFF, LIFT).staff_hours
    assert 0 < hours < 0.5
    blocked = run(house(lift_robots=False), one_job())
    assert kpi(blocked, Navigator(house(lift_robots=False), ROBOT), STAFF, LIFT).staff_hours == 0


# --- спрос -----------------------------------------------------------------------------


def test_hourly_profile_keeps_the_day_and_puts_share_into_peaks():
    day = hourly(240, [(7, 10), (15, 17)], 0.5, 0, 24)
    assert sum(day) == pytest.approx(240)
    assert sum(day[7:10]) + sum(day[15:17]) == pytest.approx(120)


# --- проверка плана --------------------------------------------------------------------


def codes(found) -> set[str]:
    return {item.code for item in found}


def test_plan_without_pharmacy_or_wards_is_an_error():
    building = house()
    building.floors[0].items = [item for item in building.floors[0].items if item.id != "pharmacy"]
    found = check(building, ROBOT)
    assert "no_pharmacy" in codes(found)
    assert any(item.level == ERROR for item in found)


def test_room_without_door_is_an_error():
    building = house()
    building.floors[1].items = [item for item in building.floors[1].items if item.id != "post-door"]
    assert "no_door" in codes(check(building))


@pytest.mark.parametrize("offset", [0, 0.5])
def test_overlapping_saved_doors_are_reported_on_both_openings(offset):
    building = house()
    floor = building.floors[0]
    door = floor.of("door")[0]
    floor.items.append(replace(door, id="duplicate-door", x=door.x + offset))
    found = [item for item in check(building) if item.code == "doors_overlap"]
    assert {item.target for item in found} == {door.id, "duplicate-door"}
    assert all(item.floor == floor.number and item.level == ERROR for item in found)


def test_doors_may_touch_but_different_floors_do_not_conflict():
    building = house()
    floor = building.floors[0]
    door = floor.of("door")[0]
    floor.items.append(replace(door, id="adjacent-door", x=door.x + door.w))
    building.floors[1].items.append(replace(door, id="same-position-other-floor"))
    assert "doors_overlap" not in codes(check(building))


def test_narrow_door_and_unreachable_post_are_warnings():
    found = check(house(door_mm=500), ROBOT)
    assert {"door_narrow", "ward_unreachable"} <= codes(found)
    assert all(item.level != ERROR for item in found)
    assert any(item.level == WARNING for item in found)


def test_lift_shaft_with_unknown_lift_is_an_error():
    building = house()
    building.floors[1].items[2].lift = "L9"
    assert "lift_unknown" in codes(check(building))


def test_good_plan_reaches_every_post():
    found = check(house(), ROBOT)
    assert not any(item.level == ERROR for item in found)
    assert "Робот доезжает до 1 постов из 1" in [item.text for item in found]


def test_robot_size_rule_uses_catalog_aisle_not_body_width():
    wide = RobotSize(need_mm=1300, length_mm=860, width_mm=610, rides_lift=False)
    assert "door_narrow" in codes(check(house(), wide))


def test_narrow_door_off_the_metre_grid_still_costs_time():
    # проем 0,9 м с краем не на целом метре: вырезана одна клетка, и дверь на пути находится
    from app.engine.clinic.building import DOOR, Item, floor_map

    building = house()
    door = Item("post-door", DOOR, 16.55, 3, 0.9, 1, name="Дверь поста", width_mm=900)
    building.floors[1].items[1] = door
    nav = Navigator(building, ROBOT)
    steps = nav.route(nav.spot(1, "pharmacy"), nav.spot(2, "post"))
    assert steps is not None
    assert [d.id for _, d in steps[-1].doors] == ["post-door"]
    assert floor_map(building.floors[1], ROBOT.need_mm).grid.at(16, 3) == FREE


def test_shift_ending_in_the_cabin_logs_the_robot_in_the_lift():
    # смена кончается, пока робот едет в кабине: последний отрезок "в лифте", без дыр
    result = run(house(), one_job(created=0.0), hours=1)
    rides = [s for s in result.segments if s.action == IN_LIFT]
    assert rides
    cut = rides[0].from_s + 1.0
    short = run(house(), one_job(created=0.0), hours=cut / 3600)
    last = max((s for s in short.segments if s.robot == 0), key=lambda s: s.to_s)
    assert last.action == IN_LIFT and last.to_s == pytest.approx(cut)
