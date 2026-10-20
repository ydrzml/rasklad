"""Прогон смены в корпусе: доставщики возят заявки из аптеки, уборщики моют коридоры.

Устроен как прогон склада (app.engine.simulation): simpy, ресурсы с очередями, отрезки лога
с ломаной для проигрывателя, те же слова действий. Что добавилось:
    этаж у каждого отрезка: проигрыватель показывает этаж, переключатель между этажами;
    лифт: очередь к кабине (lift.Cabin), робот ждет кабину и едет в ней;
    двери: автоматическая открывается, пока робот стоит перед ней, у ручной он ждет человека;
    комплектация: заявка готова, когда ее собрали в аптеке. Очередью к сборщикам ее не считаем:
    это работа аптеки, робот ее не меняет, и срок доставки идет от готовности заказа.

Чисел здесь нет: все приходят в Times, RobotSpec и Volume из config/clinic.yaml, датасета и каталога.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

import simpy

from app.engine import plan as plan_module
from app.engine.clinic.building import CLEANING_BASE, Building, Cell, Point
from app.engine.clinic.demand import Job
from app.engine.clinic.lift import ROUTINE, URGENT, Cabin, LiftSegment, LiftTimes
from app.engine.clinic.routes import Anchor, Leg, Navigator, Ride, RobotSize, Step
from app.engine.plan import Grid
from app.engine.simulation import (
    CHARGING,
    CLEANING,
    HANDLING,
    IDLE,
    MOVING,
    SWEEP_CELLS,
    WAITING,
    split,
    sweep_path,
)

IN_LIFT, LIFT_QUEUE, DOOR_QUEUE, CHARGE_QUEUE = "в лифте", "лифт", "дверь", "зарядка"
DELIVERING, CLEANER = "delivery", "cleaning"


@dataclass(frozen=True)
class RobotSpec:
    speed_m_s: float
    run_time_h: float
    charge_time_h: float
    size: RobotSize
    reserve: float  # с какой доли заряда едет заряжаться
    throughput_m2_h: float = 0.0  # уборщик: сколько метров в час моет


@dataclass(frozen=True)
class Times:
    load_s: float
    handover_s: float
    door_auto_s: float
    door_manual_s: float
    robots_per_charger: int
    lift: LiftTimes


@dataclass
class Segment:
    """Отрезок лога, как у склада, и еще этаж. В лифте этажа нет: лифт, откуда и куда."""

    robot: int
    role: str
    floor: int | None
    from_s: float
    to_s: float
    action: str
    path: list[Point]
    lift: str = ""


@dataclass
class Cleaning:
    floor: int
    area_m2: float  # сколько нужно вымыть за смену
    done_m2: float = 0.0


@dataclass
class Result:
    jobs: list[Job]
    segments: list[Segment]
    lifts: dict[str, Cabin]
    lift_segments: list[LiftSegment]
    cleaning: list[Cleaning]
    time_in: dict[str, float]
    waits: dict[str, float]
    hours: float
    fleet: int
    cleaners: int
    manual_door_assists: int = 0
    cleaner_door_assists: int = 0
    delivery_handling_s: float = 0.0


@dataclass
class Robot:
    id: int
    role: str
    at: Anchor
    battery_s: float
    home: tuple[int, int]  # индекс зарядки и ее место в общем списке
    floor: int = 0


class Shift:
    def __init__(
        self,
        building: Building,
        delivery: RobotSpec | None,
        fleet: int,
        jobs: list[Job],
        rooms: dict[str, int],  # помещение -> этаж
        times: Times,
        hours: float,
        seed: int,
        cleaner: RobotSpec | None = None,
        cleaners: dict[int, int] | None = None,  # этаж -> сколько уборщиков
        cleaning_area: dict[int, float] | None = None,  # этаж -> м2 за смену
        record: bool = True,
        nav: Navigator | None = None,
        clean_nav: Navigator | None = None,
    ):
        self.env = simpy.Environment()
        self.building, self.times, self.hours, self.record = building, times, hours, record
        self.until = hours * 3600
        self.random = random.Random(seed)
        self.seed = seed
        self.jobs, self.rooms = jobs, rooms
        self.delivery, self.cleaner = delivery, cleaner
        # Навигатор можно передать готовым: поиск парка гоняет смену десятки раз на одном плане,
        # и волны по этажам считать заново незачем
        self.nav = (nav or Navigator(building, delivery.size)) if delivery and fleet else None
        self.clean_nav = (clean_nav or Navigator(building, cleaner.size)) if cleaner and cleaners else None
        self.segments: list[Segment] = []
        self.time_in = {MOVING: 0.0, WAITING: 0.0, HANDLING: 0.0, CHARGING: 0.0, CLEANING: 0.0}
        self.waits = {LIFT_QUEUE: 0.0, DOOR_QUEUE: 0.0, CHARGE_QUEUE: 0.0}
        self.now_doing: dict[int, tuple[str, int | None, float, list[Point], str]] = {}
        self.ready = simpy.PriorityStore(self.env)
        self.manual_door_assists = 0
        self.cleaner_door_assists = 0
        self.delivery_handling_s = 0.0
        rng = random.Random(seed * 7919 + 3)
        self.cabins = {
            lift.id: Cabin(self.env, lift.id, stops, times.lift, lift.people_calls_per_hour, rng, record)
            for lift in building.lifts
            if len(stops := building.stops(lift.id)) > 0
        }
        self.robots: list[Robot] = []
        self.fleet = fleet if self.nav else 0
        self.cleaning = [Cleaning(floor, area) for floor, area in sorted((cleaning_area or {}).items())]
        self.cleaner_count = sum((cleaners or {}).get(c.floor, 0) for c in self.cleaning)
        self.chargers = self._chargers(cleaners or {})

    # --- подготовка --------------------------------------------------------------

    def _chargers(self, cleaners: dict[int, int]) -> dict[tuple[int, int], simpy.Resource]:
        """Зарядки доставщиков: роботы по очереди закреплены за зарядками плана. Мест у зарядки
        столько, сколько роботов на ней, деленных на роботов на одно место."""
        places: dict[tuple[int, int], int] = {}
        if self.nav:
            spots = self._spots(self.nav, cleaning=False)
            for number in range(self.fleet):
                home = spots[number % len(spots)] if spots else (0, -1)
                self.robots.append(Robot(number, DELIVERING, self._charge_anchor(self.nav, home), 0.0, home))
                places[home] = places.get(home, 0) + 1
        for cleaning in self.cleaning:
            nav = self.clean_nav
            spots = [spot for spot in self._spots(nav, cleaning=True) if spot[0] == cleaning.floor] if nav else []
            for number in range(cleaners.get(cleaning.floor, 0)):
                home = spots[number % len(spots)] if spots else (cleaning.floor, -1)
                robot = Robot(len(self.robots), CLEANER, self._charge_anchor(nav, home), 0.0, home, cleaning.floor)
                self.robots.append(robot)
        # Заряд на старте у всех разный, как у склада: в середине дня роботы заряжены кто как.
        # Свой генератор, чтобы поток заявок при том же seed не менялся
        groups: dict[tuple[str, int], int] = {}
        for robot in self.robots:
            spec = self.delivery if robot.role == DELIVERING else self.cleaner
            group = (robot.role, robot.floor)
            index = groups.get(group, 0)
            groups[group] = index + 1
            # Отдельные потоки: выбор доставки не меняет стартовый заряд уборщиков,
            # добавление робота не перетасовывает заряд уже проверенных машин.
            start = random.Random(f"clinic:{self.seed}:{robot.role}:{robot.floor}:{index}")
            robot.battery_s = start.uniform(spec.reserve, 1.0) * spec.run_time_h * 3600
        per = max(1, self.times.robots_per_charger)
        return {home: simpy.Resource(self.env, capacity=max(1, math.ceil(n / per))) for home, n in places.items()}

    def _spots(self, nav: Navigator, cleaning: bool) -> list[tuple[int, int]]:
        """Зарядки по этажам: базы уборщиков отдельно от зарядок доставщиков."""
        return [
            (floor.number, index)
            for floor in self.building.floors
            for index, (item, _) in enumerate(nav.maps[floor.number].chargers)
            if (item.role == CLEANING_BASE) == cleaning
        ]

    def _charge_anchor(self, nav: Navigator | None, home: tuple[int, int]) -> Anchor:
        floor, index = home
        if nav is None or index < 0 or floor not in nav.maps:
            first = self.building.floors[0].number
            return Anchor(first, (0, 0))
        return Anchor(floor, nav.maps[floor].chargers[index][1])

    # --- заявки ------------------------------------------------------------------

    def arrive(self, job: Job):
        """Заявка пришла, ее собрали, она готова к выдаче роботу."""
        ready = job.created_s + job.pick_s
        if ready > self.env.now:
            yield self.env.timeout(ready - self.env.now)
        priority = 0 if job.urgent else 1
        job.ready_s = self.env.now
        yield self.ready.put(simpy.PriorityItem((priority, job.created_s, job.id), job))

    # --- доставщик ---------------------------------------------------------------

    def deliver(self, robot: Robot):
        spec = self.delivery
        while True:
            asked = self.env.now
            self.doing(robot, IDLE, [self.point(robot.at)])
            item = yield self.ready.get()
            job: Job = item.item
            self.log(robot, IDLE, asked, [self.point(robot.at)])
            source = self.nav.spot(self.rooms.get(job.source, -1), job.source)
            target = self.nav.spot(self.rooms.get(job.target, -1), job.target)
            away = self.nav.route(source, target) if source and target else None
            if away is None:
                job.blocked = "не доехать: дверь уже прохода робота, лифт его не возит или помещение отрезано"
                continue
            there = self.nav.route(robot.at, source)
            if there is None:
                # сам робот к аптеке не доедет (зарядка отрезана): заявку отдаем другим, робот стоит
                yield self.ready.put(item)
                self.doing(robot, IDLE, [self.point(robot.at)])
                return
            job.robot = robot.id
            yield from self.travel(robot, there, spec, URGENT if job.urgent else ROUTINE)
            yield from self.stand(robot, self.times.load_s, HANDLING, spec)
            job.picked_s = self.env.now
            yield from self.travel(robot, away, spec, URGENT if job.urgent else ROUTINE)
            yield from self.stand(robot, self.times.handover_s, HANDLING, spec)
            job.done_s = self.env.now
            if robot.battery_s <= spec.reserve * spec.run_time_h * 3600:
                yield from self.charge(robot, spec, self.nav)
            elif not self.ready.items and source != robot.at:
                # ждать следующую заявку робот едет к аптеке, откуда возил: туда ее и выдадут
                back = self.nav.route(robot.at, source)
                if back is not None:
                    yield from self.travel(robot, back, spec, ROUTINE)

    def travel(self, robot: Robot, steps: list[Step], spec: RobotSpec, priority: int):
        for step in steps:
            if isinstance(step, Leg):
                yield from self.walk(robot, step, spec)
            else:
                yield from self.ride(robot, step, priority)

    def walk(self, robot: Robot, leg: Leg, spec: RobotSpec):
        """Кусок пути по этажу. У каждой двери на пути робот стоит, пока она открывается."""
        path, done = leg.path, 0.0
        for at, door in leg.doors:
            piece, path = split(path, (at - done) / (leg.metres - done) if leg.metres > done else 1.0)
            yield from self.drive(robot, leg.floor, at - done, piece, spec)
            done = at
            seconds = self.times.door_auto_s if door.automatic else self.times.door_manual_s
            if not door.automatic:
                self.manual_door_assists += 1
                self.cleaner_door_assists += int(robot.role == CLEANER)
            began = self.env.now
            self.doing(robot, WAITING, [path[0]], leg.floor)
            yield self.env.timeout(seconds)
            self.time_in[WAITING] += seconds
            self.waits[DOOR_QUEUE] += seconds
            self.log(robot, WAITING, began, [path[0]], leg.floor)
        yield from self.drive(robot, leg.floor, leg.metres - done, path, spec)
        robot.at = Anchor(leg.floor, self.nav_of(robot).maps[leg.floor].grid.cell(*leg.path[-1]))

    def ride(self, robot: Robot, ride: Ride, priority: int):
        cabin = self.cabins[ride.lift]
        landing = self.nav_of(robot).landing(ride.from_floor, ride.lift)
        point = self.point(landing) if landing else (0.0, 0.0)
        call = cabin.call(ride.from_floor, ride.to_floor, priority, robot.id)
        asked = self.env.now
        self.doing(robot, WAITING, [point], ride.from_floor)
        yield call.aboard
        boarded = self.env.now
        waited = boarded - asked
        self.time_in[WAITING] += waited
        self.waits[LIFT_QUEUE] += waited
        self.log(robot, WAITING, asked, [point], ride.from_floor)
        # смена может кончиться в кабине: тогда в логе до конца смены робот "в лифте"
        if self.record:
            self.now_doing[robot.id] = (IN_LIFT, None, boarded, [point], ride.lift)
        yield call.done
        self.now_doing.pop(robot.id, None)
        if self.record:
            self.segments.append(Segment(robot.id, robot.role, None, boarded, self.env.now, IN_LIFT, [], ride.lift))
        self.time_in[MOVING] += self.env.now - boarded
        robot.at = self.nav_of(robot).landing(ride.to_floor, ride.lift) or robot.at

    def drive(self, robot: Robot, floor: int, metres: float, path: list[Point], spec: RobotSpec):
        if metres <= 0:
            return
        seconds = metres / spec.speed_m_s
        began = self.env.now
        visible = split(path, max(0, self.until - began) / seconds)[0] if began + seconds > self.until else path
        self.doing(robot, MOVING, visible, floor)
        yield self.env.timeout(seconds)
        self.time_in[MOVING] += seconds
        robot.battery_s = max(0.0, robot.battery_s - seconds)
        self.log(robot, MOVING, began, path, floor)

    def stand(self, robot: Robot, seconds: float, action: str, spec: RobotSpec, path: list[Point] | None = None):
        began = self.env.now
        if robot.role == DELIVERING and action == HANDLING:
            self.delivery_handling_s += min(seconds, max(0, self.until - began))
        where = path or [self.point(robot.at)]
        if path and began + seconds > self.until:
            where = split(path, max(0, self.until - began) / seconds)[0]
        self.doing(robot, action, where, robot.at.floor)
        yield self.env.timeout(seconds)
        self.time_in[CLEANING if action == CLEANING else HANDLING] += seconds
        robot.battery_s = max(0.0, robot.battery_s - seconds)
        self.log(robot, action, began, where, robot.at.floor)

    def charge(self, robot: Robot, spec: RobotSpec, nav: Navigator):
        """Зарядка: доехать до своей, встать в очередь, зарядиться до полной."""
        home = self._charge_anchor(nav, robot.home)
        steps = nav.route(robot.at, home)
        if steps is None:
            return False  # до зарядки не доехать: проверка плана об этом предупредила
        yield from self.travel(robot, steps, spec, ROUTINE)
        place = self.chargers.get(robot.home)
        asked = self.env.now
        if place is not None:
            request = place.request()
            self.doing(robot, WAITING, [self.point(home)], home.floor)
            yield request
            self.waits[CHARGE_QUEUE] += self.env.now - asked
            self.time_in[WAITING] += self.env.now - asked
            self.log(robot, WAITING, asked, [self.point(home)], home.floor)
        empty = min(1.0, max(0.0, 1 - robot.battery_s / (spec.run_time_h * 3600)))
        seconds = empty * spec.charge_time_h * 3600
        began = self.env.now
        self.doing(robot, CHARGING, [self.point(home)], home.floor)
        yield self.env.timeout(seconds)
        self.time_in[CHARGING] += seconds
        self.log(robot, CHARGING, began, [self.point(home)], home.floor)
        robot.battery_s = spec.run_time_h * 3600
        if place is not None:
            place.release(request)
        return True

    # --- уборщик -----------------------------------------------------------------

    def clean(self, robot: Robot, job: Cleaning, share_m2: float, start_share: float):
        """Уборщик моет свою долю коридоров этажа выездами от базы: на сколько хватит заряда,
        столько моет, потом заряжается. Участки идут от базы волной: сначала ближние. Уборщики
        одного этажа делят коридор по порядку: start_share говорит, с какой доли начинает этот."""
        spec, nav = self.cleaner, self.clean_nav
        fmap = nav.maps[job.floor]
        corridor = fmap.corridor()
        base = self._charge_anchor(nav, robot.home)
        order = self._order(fmap.grid, base.cell, set(fmap.corridor_cells()))
        self.doing(robot, IDLE, [self.point(robot.at)])
        if not order:
            return
        # Отрезанные части коридора не становятся вымытыми от повторных проходов по доступным клеткам.
        reachable_share = len(order) / max(1, fmap.corridor_area_m2)
        left, position = share_m2 * reachable_share, int(start_share * len(order))
        while left > 1e-6:
            usable_s = robot.battery_s - spec.reserve * spec.run_time_h * 3600
            if usable_s <= 0:
                charged = yield from self.charge(robot, spec, nav)
                if not charged:
                    break
                continue
            area = min(left, usable_s / 3600 * spec.throughput_m2_h, SWEEP_CELLS)
            start = Anchor(job.floor, order[position % len(order)])
            there = nav.route(robot.at, start)
            if there is None:
                return
            yield from self.travel(robot, there, spec, ROUTINE)
            path = sweep_path(corridor, start.cell, area) if self.record else None
            # Смена может закончиться посреди прохода: выполненную часть учитываем и без лога.
            job.done_m2 += min(area, max(0, self.until - self.env.now) / 3600 * spec.throughput_m2_h)
            yield from self.stand(robot, area / spec.throughput_m2_h * 3600, CLEANING, spec, path)
            left -= area
            position += max(1, round(area))
        home = nav.route(robot.at, base)
        if home is not None:
            yield from self.travel(robot, home, spec, ROUTINE)
        self.doing(robot, IDLE, [self.point(robot.at)])  # вымыл свое: стоит на базе до конца смены

    @staticmethod
    def _order(grid: Grid, start: Cell, corridor: set[int]) -> list[Cell]:
        """Клетки коридора по удаленности от базы: база стоит в комнате, волну пускаем по всему этажу."""
        field_m = plan_module.distances(grid, [start])
        cells = [(value, i) for i, value in enumerate(field_m) if value < math.inf and i in corridor]
        return [(i % grid.cols, i // grid.cols) for _, i in sorted(cells)]

    # --- учет --------------------------------------------------------------------

    def nav_of(self, robot: Robot) -> Navigator:
        return self.nav if robot.role == DELIVERING else self.clean_nav

    def point(self, anchor: Anchor) -> Point:
        nav = self.nav or self.clean_nav
        return nav.point(anchor) if nav and anchor.floor in nav.maps else (0.0, 0.0)

    def doing(self, robot: Robot, action: str, path: list[Point], floor: int | None = None) -> None:
        if self.record:
            self.now_doing[robot.id] = (action, floor if floor is not None else robot.at.floor, self.env.now, path, "")

    def log(self, robot: Robot, action: str, began: float, path: list[Point], floor: int | None = None) -> None:
        if self.record:
            self.now_doing.pop(robot.id, None)
            if self.env.now > began:
                where = floor if floor is not None else robot.at.floor
                self.segments.append(Segment(robot.id, robot.role, where, began, self.env.now, action, path))

    def run(self) -> Result:
        for job in self.jobs:
            self.env.process(self.arrive(job))
        cleaners_left = {c.floor: c for c in self.cleaning}
        per_floor: dict[int, list[Robot]] = {}
        for robot in self.robots:
            if robot.role == DELIVERING:
                self.env.process(self.deliver(robot))
            else:
                per_floor.setdefault(robot.floor, []).append(robot)
        for floor, robots in per_floor.items():
            job = cleaners_left[floor]
            for number, robot in enumerate(robots):
                self.env.process(self.clean(robot, job, job.area_m2 / len(robots), number / len(robots)))
        self.env.run(until=self.until)
        for robot_id, (action, floor, began, path, lift) in sorted(self.now_doing.items()):
            if path and began < self.until:
                role = self.robots[robot_id].role
                self.segments.append(Segment(robot_id, role, floor, began, self.until, action, path, lift))
        lift_segments = [seg for cabin in self.cabins.values() for seg in cabin.cut(self.until)]
        return Result(
            self.jobs,
            self.segments,
            self.cabins,
            lift_segments,
            self.cleaning,
            self.time_in,
            self.waits,
            self.hours,
            self.fleet,
            self.cleaner_count,
            self.manual_door_assists,
            self.cleaner_door_assists,
            self.delivery_handling_s,
        )
