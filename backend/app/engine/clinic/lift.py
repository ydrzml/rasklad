"""Лифт в прогоне смены: очередь к одной кабине, как очередь к зарядке у склада.

Вызов это пара этажей "откуда, куда". Кабина берет самый важный вызов (люди, потом срочные
заявки, потом плановые, внутри по времени вызова), подъезжает к этажу, открывает двери, впускает
роботов, едет, выпускает. Роботы с тем же маршрутом, которые ждут на этом этаже, едут тем же
рейсом, сколько влезет в кабину. Люди занимают кабину целиком: так лифт общий с персоналом
и посетителями, и робот ждет, пока его отвезут.

Поездку между этажами считаем по скорости и ускорению кабины (routes.flight_s), числа приходят
из config/clinic.yaml, раздел lift.
"""

from __future__ import annotations

import itertools
import random
from dataclasses import dataclass, field

import simpy

from app.engine.clinic.routes import flight_s

PEOPLE, URGENT, ROUTINE = 0, 1, 2  # кто важнее у лифта
EMPTY, BOARDING, CARRYING, LEAVING = "едет пустой", "посадка", "везет", "высадка"


@dataclass(frozen=True)
class LiftTimes:
    speed_m_s: float
    acceleration_m_s2: float
    door_open_s: float
    door_close_s: float
    board_s: float
    floor_height_m: float
    robots_per_ride: int


@dataclass
class Call:
    priority: int
    order: int
    origin: int
    target: int
    asked: float
    done: simpy.Event
    robot: int | None = None  # None: вызвали люди
    boarded: float | None = None
    aboard: simpy.Event | None = None  # кабина пришла и робот вошел


@dataclass
class LiftSegment:
    """Отрезок лога лифта для проигрывателя: кабина между этажами, дробный этаж в пути."""

    lift: str
    from_s: float
    to_s: float
    action: str
    from_floor: float
    to_floor: float
    robots: list[int] = field(default_factory=list)


class Cabin:
    def __init__(
        self,
        env: simpy.Environment,
        lift_id: str,
        stops: list[int],
        times: LiftTimes,
        people_per_hour: float,
        rng: random.Random,
        record: bool,
    ):
        self.env, self.id, self.stops, self.times = env, lift_id, stops, times
        self.position = float(stops[0])
        self.calls: list[Call] = []
        self.wake: simpy.Event = env.event()
        self.counter = itertools.count()
        self.record = record
        self.segments: list[LiftSegment] = []
        self.busy_s = 0.0
        self.robot_rides = 0
        self.people_rides = 0
        self.robot_wait_s = 0.0
        env.process(self.run())
        if people_per_hour > 0 and len(stops) > 1:
            env.process(self.people(people_per_hour, rng))

    def call(self, origin: int, target: int, priority: int, robot: int | None) -> Call:
        call = Call(priority, next(self.counter), origin, target, self.env.now, self.env.event(), robot)
        call.aboard = self.env.event()
        self.calls.append(call)
        if not self.wake.triggered:
            self.wake.succeed()
        return call

    def people(self, per_hour: float, rng: random.Random):
        """Люди вызывают лифт потоком: в среднем per_hour раз в час, между случайными этажами."""
        while True:
            yield self.env.timeout(rng.expovariate(per_hour / 3600))
            origin, target = rng.sample(self.stops, 2)
            self.call(origin, target, PEOPLE, None)

    def run(self):
        times = self.times
        while True:
            if not self.calls:
                self.wake = self.env.event()
                yield self.wake
                continue
            first = min(self.calls, key=lambda c: (c.priority, c.order))
            group = [first]
            if first.robot is not None:
                same = sorted(
                    (
                        c
                        for c in self.calls
                        if c is not first
                        and c.robot is not None
                        and (c.origin, c.target) == (first.origin, first.target)
                    ),
                    key=lambda c: (c.priority, c.order),
                )
                group += same[: max(0, times.robots_per_ride - 1)]
            for call in group:
                self.calls.remove(call)
            began = self.env.now
            yield from self.move(first.origin, EMPTY, [])
            robots = [c.robot for c in group if c.robot is not None]
            for call in group:
                call.boarded = self.env.now
                call.aboard.succeed()
                if call.robot is not None:
                    self.robot_wait_s += call.boarded - call.asked
            yield from self.stand(
                times.door_open_s + times.board_s * max(1, len(robots)) + times.door_close_s, BOARDING, robots
            )
            yield from self.move(first.target, CARRYING, robots)
            yield from self.stand(
                times.door_open_s + times.board_s * max(1, len(robots)) + times.door_close_s, LEAVING, robots
            )
            self.busy_s += self.env.now - began
            if robots:
                self.robot_rides += 1
            else:
                self.people_rides += 1
            for call in group:
                call.done.succeed()

    def move(self, floor: int, action: str, robots: list[int]):
        metres = abs(floor - self.position) * self.times.floor_height_m
        seconds = flight_s(metres, self.times.speed_m_s, self.times.acceleration_m_s2)
        if seconds <= 0:
            self.position = float(floor)
            return
        began, start = self.env.now, self.position
        yield self.env.timeout(seconds)
        self.position = float(floor)
        self.log(began, action, start, float(floor), robots)

    def stand(self, seconds: float, action: str, robots: list[int]):
        began = self.env.now
        yield self.env.timeout(seconds)
        self.log(began, action, self.position, self.position, robots)

    def log(self, began: float, action: str, start: float, finish: float, robots: list[int]) -> None:
        if self.record:
            self.segments.append(LiftSegment(self.id, began, self.env.now, action, start, finish, list(robots)))

    def cut(self, until: float) -> list[LiftSegment]:
        """Лог до конца смены: последний отрезок обрезаем, кабина в пути встает на дробный этаж."""
        kept = []
        for seg in self.segments:
            if seg.from_s >= until:
                continue
            if seg.to_s > until and seg.to_s > seg.from_s:
                share = (until - seg.from_s) / (seg.to_s - seg.from_s)
                seg = LiftSegment(
                    seg.lift,
                    seg.from_s,
                    until,
                    seg.action,
                    seg.from_floor,
                    seg.from_floor + (seg.to_floor - seg.from_floor) * share,
                    seg.robots,
                )
            kept.append(seg)
        return kept
