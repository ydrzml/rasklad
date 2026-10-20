"""Итоги смены медучреждения: доля вовремя, время доставки, очереди, лифты, уборка, часы персонала.

Вовремя считаем от фиксированного набора заявок, у которых срок наступил внутри смены.
Раннее выполнение заявки со сроком после смены не меняет знаменатель.

Эффект считаем в часах персонала, а не в ставках: те же рейсы санитар прошел бы пешком
по тому же пути, с ожиданием лифта и передачей на посту. Рубли по цене часа считает следующий
этап (экономика), здесь только часы.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.engine.clinic.lift import LiftTimes
from app.engine.clinic.routes import Leg, Navigator, Ride, flight_s
from app.engine.clinic.shift import CHARGE_QUEUE, DOOR_QUEUE, LIFT_QUEUE, Result
from app.engine.simulation import CHARGING, HANDLING, MOVING

QUEUE_SHARE = 0.15  # очередь становится узким местом, если в ней парк проводит больше этой доли смены


@dataclass(frozen=True)
class StaffTimes:
    walk_speed_m_s: float
    handover_s: float
    lift_wait_s: float
    load_s: float = 0.0


@dataclass
class KindKpi:
    kind: str
    created: int
    done: int
    due: int
    on_time: int
    blocked: int


@dataclass
class LiftKpi:
    lift: str
    busy_share: float
    robot_rides: int
    people_rides: int
    avg_robot_wait_s: float


@dataclass
class CleaningKpi:
    floor: int
    area_m2: float
    done_m2: float


@dataclass
class Kpi:
    created: int
    done: int
    due: int
    on_time: int
    on_time_share: float | None
    blocked: int
    avg_delivery_min: float | None
    p95_delivery_min: float | None
    shares: dict[str, float]
    waits: dict[str, float]
    bottleneck: str
    staff_hours: float  # сколько часов персонала заняли бы выполненные рейсы
    cleaned_m2: float
    kinds: list[KindKpi] = field(default_factory=list)
    lifts: list[LiftKpi] = field(default_factory=list)
    cleaning: list[CleaningKpi] = field(default_factory=list)


def kpi(result: Result, nav: Navigator | None, staff: StaffTimes, lift: LiftTimes) -> Kpi:
    until = result.hours * 3600
    jobs = result.jobs
    done = [job for job in jobs if job.done_s is not None]
    due = [job for job in jobs if job.deadline_s <= until]
    on_time = [job for job in due if job.on_time]
    minutes = sorted((job.done_s - job.created_s) / 60 for job in done)
    robots = max(1, result.fleet + result.cleaners)
    total = until * robots
    shares = {name: seconds / total for name, seconds in result.time_in.items()}
    waits = {name: seconds / total for name, seconds in result.waits.items()}
    kinds = sorted({job.kind for job in jobs})
    return Kpi(
        created=len(jobs),
        done=len(done),
        due=len(due),
        on_time=len(on_time),
        on_time_share=len(on_time) / len(due) if due else None,
        blocked=sum(1 for job in jobs if job.blocked),
        avg_delivery_min=sum(minutes) / len(minutes) if minutes else None,
        p95_delivery_min=minutes[max(0, math.ceil(0.95 * len(minutes)) - 1)] if minutes else None,
        shares=shares,
        waits=waits,
        bottleneck=bottleneck(
            waits,
            shares,
            len(due),
            len(on_time),
            sum(1 for job in jobs if job.blocked),
            [c.floor for c in result.cleaning if c.area_m2 > 0 and c.done_m2 <= 0],
        ),
        staff_hours=staff_hours(result, nav, staff, lift) if nav else 0.0,
        cleaned_m2=sum(c.done_m2 for c in result.cleaning),
        kinds=[
            KindKpi(
                kind,
                sum(1 for j in jobs if j.kind == kind),
                sum(1 for j in done if j.kind == kind),
                sum(1 for j in due if j.kind == kind),
                sum(1 for j in on_time if j.kind == kind),
                sum(1 for j in jobs if j.kind == kind and j.blocked),
            )
            for kind in kinds
        ],
        lifts=[
            LiftKpi(
                cabin.id,
                min(1.0, cabin.busy_s / until),
                cabin.robot_rides,
                cabin.people_rides,
                cabin.robot_wait_s / cabin.robot_rides if cabin.robot_rides else 0.0,
            )
            for cabin in result.lifts.values()
        ],
        cleaning=[CleaningKpi(c.floor, c.area_m2, c.done_m2) for c in result.cleaning],
    )


def bottleneck(
    waits: dict[str, float],
    shares: dict[str, float],
    due: int,
    on_time: int,
    blocked: int = 0,
    unclean: list[int] | None = None,
) -> str:
    """Что мешает словами: недоступные посты, невымытые этажи, очередь, где парк стоит дольше всего, или запас."""
    if blocked:
        return f"план: {blocked} заявок не довезти, робот не попадает на пост (дверь, лифт или стена)"
    if unclean:
        floors = ", ".join(str(number) for number in sorted(unclean))
        return f"уборка: на этажах {floors} уборщик не выехал с базы, коридоры не вымыты"
    place, share = max(waits.items(), key=lambda pair: pair[1], default=("", 0.0))
    if share > QUEUE_SHARE:
        words = {
            LIFT_QUEUE: "лифт: роботы подолгу ждут кабину, она общая с людьми",
            DOOR_QUEUE: "двери: на пути много дверей, у ручных робот ждет человека",
            CHARGE_QUEUE: "зарядка: роботы ждут свободное место на зарядке",
        }
        return words.get(place, f'очередь у места "{place}"')
    if shares.get(CHARGING, 0.0) > QUEUE_SHARE:
        return "зарядка: роботы подолгу стоят на зарядке"
    if due and on_time < due and shares.get(MOVING, 0.0) + shares.get(HANDLING, 0.0) > 0.7:
        return "парк загружен полностью: роботов не хватает на пик"
    return "узкого места нет, парк работает ровно"


def staff_hours(result: Result, nav: Navigator, staff: StaffTimes, lift: LiftTimes) -> float:
    """Часы санитара на те же выполненные рейсы: дойти от аптеки до поста и обратно, подождать
    и проехать лифт, отдать заказ. Сервис передает отдельный маршрутизатор персонала,
    чтобы ручной эквивалент не зависел от габаритов и интеграции выбранного робота."""
    seconds = 0.0
    for job in result.jobs:
        if job.done_s is None:
            continue
        source = nav.spot(_floor(nav, job.source), job.source)
        target = nav.spot(_floor(nav, job.target), job.target)
        if source is None or target is None:
            continue
        for start, finish in ((source, target), (target, source)):
            for step in nav.route(start, finish) or []:
                if isinstance(step, Leg):
                    seconds += step.metres / staff.walk_speed_m_s
                elif isinstance(step, Ride):
                    metres = abs(step.to_floor - step.from_floor) * lift.floor_height_m
                    doors = 2 * (lift.door_open_s + lift.door_close_s)
                    seconds += staff.lift_wait_s + flight_s(metres, lift.speed_m_s, lift.acceleration_m_s2) + doors
        seconds += staff.load_s + staff.handover_s
    return seconds / 3600


def _floor(nav: Navigator, room_id: str) -> int:
    return next((floor for floor, fmap in nav.maps.items() if room_id in fmap.spots), -1)
