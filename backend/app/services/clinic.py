"""Медучреждение: собираем прогон смены из config/clinic.yaml, датасета организатора и каталога.

Движок (app.engine.clinic) файлов не читает: числа сюда, в одно место, приходят из трех источников.
    config/clinic.yaml     время лифта и дверей, сроки, правила: у каждого числа источник и оценка
    data/facilities        объемы заявок, доля срочных, комплектация: датасет организатора, как шаг 2
    каталог                роботы из списка решений медучреждения и их характеристики с оценками S-F

Своих роботов мы не заводим: доставщик и уборщик это решения из того же списка, что показывает
шаг решений медучреждения (data/facilities/solutions.csv), с характеристиками из data/specs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from functools import lru_cache

from app.engine.clinic import demand, metrics, processes, template
from app.engine.clinic.building import ROOM, Building, floor_map
from app.engine.clinic.check import ERROR, Check, check, check_cleaner
from app.engine.clinic.fleet import FleetSearch, Quality, search
from app.engine.clinic.lift import LiftTimes
from app.engine.clinic.optimization import service
from app.engine.clinic.routes import Navigator, RobotSize, StaffNavigator
from app.engine.clinic.shift import Result, RobotSpec, Shift, Times
from app.engine.model_config import Provenance, load_model
from app.errors import NotFound
from app.services import facility_catalog
from app.settings import settings

FACILITY = "clinic"
DELIVERY, CLEANING = "floor_delivery", "cleaning"
# Кого берем по умолчанию: доставщик, который сам ездит на лифте и продается в России, и уборщик
# с док-станцией из каталога организатора. Человек выбирает другого из того же списка
DEFAULT_DELIVERY = "ext-pudu-flashbot-max"
DEFAULT_CLEANER = "f31223c1-44c8-4410-8381-6356e2158b61"
NEEDED = {
    DELIVERY: ("max_speed_m_s", "runtime_h", "charge_time_h", "dimensions_mm", "min_aisle_width_mm"),
    CLEANING: ("runtime_h", "charge_time_h", "dimensions_mm", "min_aisle_width_mm", "throughput"),
}
NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
# Технический предел окна прогона, без усечения потока при превышении.
MAX_JOBS = 5000
PEAK = re.compile(r"(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}")


class BadInput(ValueError):
    """Запрос не посчитать: правка вне границ датасета, план с ошибками, слишком много заявок. Ответ 422."""


@dataclass
class Spec:
    """Характеристика робота для прогона: число, откуда и насколько ей верить."""

    field: str
    value: float
    text: str
    trust: str
    note: str


@dataclass
class CatalogRobot:
    id: str
    product: str
    operation: str
    availability: str
    lift: str | None  # как ездит на лифте, словами источника
    specs: list[Spec] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)  # каких характеристик нет: такого не считаем
    spec: RobotSpec | None = None


@dataclass
class Outcome:
    building: Building
    robot: CatalogRobot
    cleaner: CatalogRobot | None
    fleet: int
    cleaners: dict[int, int]
    result: Result
    kpi: metrics.Kpi
    search: FleetSearch | None
    checks: list[Check]
    demand_per_hour: list[float]


@lru_cache(maxsize=1)
def model() -> tuple[dict, dict[str, Provenance]]:
    return load_model(settings.config_dir / "clinic.yaml")


def config() -> dict:
    return model()[0]


# --- роботы из каталога -------------------------------------------------------------


def robots(operation: str) -> list[CatalogRobot]:
    """Решения медучреждения под задачу, кроме тех, что купить нельзя (прототип, не та версия)."""
    found = facility_catalog.solutions(FACILITY, [operation], {}).solutions
    return [_robot(item.id, item.product, operation, item.availability) for item in found if item.status != "excluded"]


def robot(robot_id: str, operation: str) -> CatalogRobot:
    picked = next((item for item in robots(operation) if item.id == robot_id), None)
    if picked is None:
        raise NotFound(f"В решениях медучреждения нет робота {robot_id} для этой задачи")
    return picked


def _robot(robot_id: str, product: str, operation: str, availability: str) -> CatalogRobot:
    cfg = config()
    out = CatalogRobot(robot_id, product, operation, availability, facility_catalog.rides_lift(robot_id))
    values: dict[str, float] = {}
    for name in dict.fromkeys((*NEEDED[operation], "max_speed_m_s")):
        row = facility_catalog.spec_row(robot_id, name)
        numbers = _numbers(row["value"]) if row else []
        if not numbers or row["rating"] == "F":
            if name in NEEDED[operation]:
                out.missing.append(name)
            continue
        # скорость паспорт дает диапазоном: берем верх, потом 2/3 от него по правилу config;
        # моет уборщик по нижней, практической цифре производительности
        value = max(numbers) if name == "max_speed_m_s" else min(numbers) if name == "throughput" else numbers[0]
        values[name] = value
        out.specs.append(Spec(name, value, row["value"], row["rating"], row["reason"]))
    if out.missing:
        return out
    length, width = _numbers(facility_catalog.spec_row(robot_id, "dimensions_mm")["value"])[:2]
    size = RobotSize(values["min_aisle_width_mm"], length, width, out.lift is not None and operation == DELIVERY)
    if operation == DELIVERY:
        speed = values["max_speed_m_s"] * cfg["delivery"]["speed_share"]
        reserve, throughput = cfg["delivery"]["battery_reserve"], 0.0
    else:
        speed = cfg["cleaning"]["travel_speed_m_s"]
        reserve, throughput = cfg["cleaning"]["battery_reserve"], values["throughput"]
    out.spec = RobotSpec(speed, values["runtime_h"], values["charge_time_h"], size, reserve, throughput)
    return out


def _numbers(text: str) -> list[float]:
    return [float(item.replace(",", ".")) for item in NUMBER.findall(text or "")]


# --- корпус и параметры ------------------------------------------------------------------


def demo() -> Building:
    """Типовой корпус: чертеж наш, числа дверей и кабины из config."""
    cfg = config()
    house, lift = cfg["building"], cfg["lift"]
    doors = template.Doors(house["ward_door_mm"], house["office_door_mm"], house["lab_door_mm"])
    cabin = template.Cabin(lift["cabin_w_mm"], lift["cabin_d_mm"], lift["door_mm"], lift["people_calls_per_hour"])
    return template.building(doors, cabin, house["floor_height_m"])


def dataset(overrides: dict[str, float]) -> dict[str, float]:
    """Числа листа «Медучреждение» с правками шага параметров (clinic.<ключ>)."""
    values = {}
    for row in facility_catalog.fields(FACILITY):
        try:
            values[row["key"]] = float(row["value"])
        except ValueError:
            continue
    prefix = f"{FACILITY}."
    return values | {path[len(prefix) :]: value for path, value in overrides.items() if path.startswith(prefix)}


def peaks() -> list[tuple[int, int]]:
    """Часы пиков словами датасета: "07:00-10:00 и 15:00-17:00"."""
    row = next(row for row in facility_catalog.fields(FACILITY) if row["key"] == "logistics_peak_hours")
    return [(int(a), int(b)) for a, b in PEAK.findall(row["value"])]


def lift_times() -> LiftTimes:
    lift, house = config()["lift"], config()["building"]
    return LiftTimes(
        lift["speed_m_s"],
        lift["acceleration_m_s2"],
        lift["door_open_s"],
        lift["door_close_s"],
        lift["board_s"],
        house["floor_height_m"],
        int(lift["robots_per_ride"]),
    )


def times() -> Times:
    cfg = config()
    delivery, doors = cfg["delivery"], cfg["doors"]
    return Times(
        delivery["load_s"],
        delivery["handover_s"],
        doors["auto_open_s"],
        doors["manual_wait_s"],
        int(delivery["robots_per_charger"]),
        lift_times(),
    )


def staff_times() -> metrics.StaffTimes:
    staff = config()["staff"]
    return metrics.StaffTimes(
        staff["walk_speed_m_s"], staff["handover_s"], staff["lift_wait_s"], config()["delivery"]["load_s"]
    )


def hours(building: Building | None = None) -> int:
    default = int(config()["demand"]["shift_hours"])
    return processes.window(building, hours=default)[1] if building else default


def profile(building: Building | None = None) -> list[float]:
    """Доля суточных заявок в каждом часе смены."""
    cfg = config()["demand"]
    if building is None:
        return demand.hourly(1.0, peaks(), cfg["peak_share"], int(cfg["shift_start_h"]), hours())
    start, length = processes.window(building, int(cfg["shift_start_h"]), int(cfg["shift_hours"]))
    day = processes.profile(building, demand.hourly(1.0, peaks(), cfg["peak_share"], 0, 24))
    return [day[(start + hour) % 24] for hour in range(length)]


def jobs(
    building: Building, data: dict[str, float], seed: int, demand_factor=1.0, arrival_spread=1.0
) -> list[demand.Job]:
    """Заявки смены на этот корпус: объем датасета на одну точку доставки, умноженный на посты плана."""
    streams = processes.plan(building, data, config()["delivery"])
    share = profile(building)
    expected = sum(stream.volume.per_day for stream in streams) * sum(share) * demand_factor
    if expected > MAX_JOBS:
        raise BadInput(
            f"В окне прогона ожидается {expected:.0f} заявок: технический предел {MAX_JOBS}. Сократите окно или разделите объект на зоны"
        )
    found = [
        job
        for stream in streams
        for job in demand.jobs(
            stream.kind,
            replace(stream.volume, per_day=stream.volume.per_day * demand_factor),
            share,
            stream.sources,
            stream.targets,
            seed,
            stream.flows,
            arrival_spread,
        )
    ]
    return sorted(found, key=lambda job: job.created_s)


def corridor_areas(building: Building, cleaner: CatalogRobot) -> dict[int, float]:
    """Сколько метров коридоров моем за смену на каждом этаже: клетки коридора, раз в смену по норме."""
    passes = config()["cleaning"]["passes_per_shift"]
    need = cleaner.spec.size.need_mm if cleaner.spec else 0.0
    return {
        floor.number: floor_map(floor, need).corridor_area_m2
        * processes.cleaning_passes(building, floor.number, passes)
        for floor in building.floors
    }


# --- прогон ------------------------------------------------------------------------------


class Prepared:
    """Один план и характеристики, много честно сопоставимых прогонов.

    Маршрутизаторы и исходные заявки переиспользуются; изменяемые заявки клонируются.
    Разные парки получают одинаковый поток и независимые потоки заряда по роботам.
    """

    def __init__(
        self, building, robot_id=DEFAULT_DELIVERY, cleaner_id=DEFAULT_CLEANER, overrides=None, operation_ids=None
    ):
        self.building = building
        try:
            processes.validate(building)
        except ValueError as error:
            raise BadInput(str(error)) from error
        self.data = dataset(overrides or {})
        self.delivering = operation_ids is None or DELIVERY in operation_ids
        cleaning_requested = operation_ids is None or CLEANING in operation_ids
        if not self.delivering and not cleaning_requested:
            raise BadInput("Для прогона выберите доставку по этажам или уборку")
        self.robot = robot(robot_id if self.delivering else DEFAULT_DELIVERY, DELIVERY)
        if self.delivering and self.robot.spec is None:
            raise NotFound(
                f"У робота {self.robot.product} нет характеристик для прогона: {', '.join(self.robot.missing)}"
            )
        self.cleaner = robot(cleaner_id, CLEANING) if cleaner_id and cleaning_requested else None
        if self.cleaner and self.cleaner.spec is None:
            raise BadInput(
                f"У робота {self.cleaner.product} нет характеристик для прогона: {', '.join(self.cleaner.missing)}"
            )
        self.cleaning = self.cleaner is not None
        self.checks = check(
            building,
            self.robot.spec.size if self.delivering else None,
            cleaning=self.cleaning,
            delivery=self.delivering,
        )
        if self.cleaning and not any(c.level == ERROR for c in self.checks):
            self.checks += check_cleaner(building, self.cleaner.spec.size)
        # одна и та же причина на каждом этаже (дверь базы уборщика) в ответе один раз
        errors = list(dict.fromkeys(c.text for c in self.checks if c.level == ERROR))
        if errors:
            raise BadInput("План не посчитать: " + "; ".join(errors))
        self.has_demand = self.delivering and per_day(building, self.data) > 0
        self.nav = Navigator(building, self.robot.spec.size) if self.delivering else None
        self.staff_nav = StaffNavigator(building, config()["staff"]["min_aisle_width_mm"]) if self.delivering else None
        self.clean_nav = Navigator(building, self.cleaner.spec.size) if self.cleaning else None
        self.rooms = {room.id: floor.number for floor in building.floors for room in floor.of(ROOM)}
        self.areas = corridor_areas(building, self.cleaner) if self.cleaning else {}
        self.run_times, self.staff, self.lift = times(), staff_times(), lift_times()
        self._jobs: dict[int, list[demand.Job]] = {}
        self.condition_id = "nominal"
        self.demand_factor = 1.0
        self.arrival_spread = 1.0

    def run(self, fleet: int, cleaners=None, seed=42, record=False, effects=True) -> Outcome:
        if seed not in self._jobs:
            self._jobs[seed] = (
                jobs(self.building, self.data, seed, self.demand_factor, self.arrival_spread) if self.delivering else []
            )
        if len(self._jobs[seed]) > MAX_JOBS:
            raise BadInput(
                f"За смену {len(self._jobs[seed])} заявок, считаем не больше {MAX_JOBS}: уменьшите объем или число постов"
            )
        per_floor = {
            n: k
            for n, k in (cleaners if cleaners is not None else {n: 1 for n in self.areas}).items()
            if n in self.areas
            and self.areas[n] > 0
            and k > 0
            and any(
                item.role == "cleaning"
                for floor in self.building.floors
                if floor.number == n
                for item in floor.of("charge")
            )
        }
        chosen = fleet if self.has_demand else 0
        shift = Shift(
            self.building,
            self.robot.spec if self.delivering else None,
            chosen,
            [replace(job) for job in self._jobs[seed]],
            self.rooms,
            self.run_times,
            hours(self.building),
            seed,
            self.cleaner.spec if self.cleaning else None,
            per_floor,
            self.areas,
            record=record,
            nav=self.nav,
            clean_nav=self.clean_nav,
        )
        result = shift.run()
        return Outcome(
            self.building,
            self.robot,
            self.cleaner,
            chosen,
            per_floor,
            result,
            metrics.kpi(result, self.staff_nav if effects else None, self.staff, self.lift),
            None,
            self.checks,
            [
                share * per_day(self.building, self.data) * self.demand_factor if self.delivering else 0.0
                for share in profile(self.building)
            ],
        )


def simulate(
    building: Building,
    robot_id: str = DEFAULT_DELIVERY,
    fleet: int | None = None,
    cleaner_id: str | None = DEFAULT_CLEANER,
    cleaners: dict[int, int] | None = None,
    seed: int = 42,
    overrides: dict[str, float] | None = None,
    record: bool = True,
    operation_ids: list[str] | None = None,
) -> Outcome:
    """Прогон смены. Парк не задан: ищем самый маленький, при котором вовремя не меньше цели."""
    cfg = config()
    prepared = Prepared(building, robot_id, cleaner_id, overrides, operation_ids)
    found: FleetSearch | None = None
    if prepared.has_demand and fleet is None:

        def measure(size: int, number: int) -> Quality:
            score = service(prepared.run(size, cleaners={}, seed=number, effects=False))
            return Quality(
                score.on_time_share,
                (score.completion_share is None or score.completion_share >= 1 - 1e-9)
                and (score.urgent_on_time_share is None or score.urgent_on_time_share >= 1 - 1e-9),
            )

        engine = cfg["engine"]
        found = search(
            measure,
            tuple(engine["seeds"]),
            cfg["delivery"]["on_time_target"],
            int(engine["max_fleet"]),
            engine["search_budget_s"],
        )
    chosen = (fleet if fleet is not None else _chosen(found)) if prepared.has_demand else 0
    return replace(prepared.run(chosen, cleaners, seed, record), search=found)


def per_day(building: Building, data: dict[str, float]) -> float:
    """Заявок в сутки на этот корпус: лекарства и расходники на одну точку доставки, умноженные на посты."""
    return sum(stream.volume.per_day for stream in processes.plan(building, data, config()["delivery"]))


def _chosen(found: FleetSearch | None) -> int:
    """Найденный парк, иначе минимальный из показавших лучшую проверенную долю вовремя."""
    if found is None or not found.curve:
        return 1
    return found.needed or max(found.curve, key=lambda pair: (pair[1], -pair[0]))[0]
