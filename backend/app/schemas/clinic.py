"""Медучреждение: корпус по этажам и прогон смены. Контракт для чертежа и проигрывателя.

Этаж устроен как план склада (app.schemas.plan.Plan): участок width_m x length_m, секции пола
и вещи-прямоугольники в метрах, ноль в левом нижнем углу, x на восток, y на север, сетка в метр.
Чертеж склада рисует секции и прямоугольники так же, у вещей медучреждения свои виды: room, door,
lift, charge, blocked. Между этажами переключатель: этаж это отдельный план.

Отрезки лога те же, что у склада (robot, from_s, to_s, action, path), плюс этаж и лифт. Лифт
пишет свой лог: кабина между этажами, этаж дробный, пока она едет. Описание в docs/medical.md.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.engine.clinic.building import KINDS, ROLES
from app.schemas.plan import Section

# Технические границы одного запроса, а не ограничения реальных больниц.
MAX_FLOORS = 20
MAX_SIDE_M = 200
MAX_AREA_M2 = 200_000
MAX_ITEMS = 300
MAX_LIFTS = 12
MAX_WARDS = 200
MAX_CLEANERS_PER_FLOOR = 4

Kind = Literal["room", "door", "lift", "charge", "blocked"]
Role = Literal["", "pharmacy", "supplies", "ward", "other", "cleaning"]


class Item(BaseModel):
    """Вещь на этаже: прямоугольник в метрах."""

    id: str = Field(min_length=1, max_length=64)
    kind: Kind = Field(description=f"Что это: {', '.join(KINDS)}")
    x: float = Field(ge=0, le=MAX_SIDE_M)
    y: float = Field(ge=0, le=MAX_SIDE_M)
    w: float = Field(gt=0, le=MAX_SIDE_M)
    h: float = Field(gt=0, le=MAX_SIDE_M)
    name: str = Field(default="", max_length=80)
    role: Role = Field(
        default="",
        description=f"room: {', '.join(ROLES)}; charge: cleaning, если это база уборщика, иначе пусто",
    )
    width_mm: float = Field(default=0.0, ge=0, le=4000, description="door: ширина проема, мм")
    automatic: bool = Field(default=True, description="door: открывается сама; false, ручную открывает человек")
    lift: str = Field(default="", max_length=64, description="lift: id лифта из building.lifts")


class Floor(BaseModel):
    number: int = Field(ge=-2, le=40, description="Номер этажа, как в здании")
    name: str = Field(default="", max_length=40)
    width_m: float = Field(gt=0, le=MAX_SIDE_M, description="Размер участка этажа, а не здания")
    length_m: float = Field(gt=0, le=MAX_SIDE_M)
    sections: list[Section] = Field(default_factory=list, max_length=40, description="Пол этажа, как у склада")
    items: list[Item] = Field(default_factory=list, max_length=MAX_ITEMS)

    @model_validator(mode="after")
    def sections_inside_lot(self):
        if any(
            section.x < 0
            or section.y < 0
            or section.x + section.w > self.width_m
            or section.y + section.h > self.length_m
            for section in self.sections
        ):
            raise ValueError("Секция пола выходит за участок этажа: увеличьте его размеры или исправьте секцию")
        return self


class Lift(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="", max_length=80)
    cabin_w_mm: float = Field(gt=0, le=5000)
    cabin_d_mm: float = Field(gt=0, le=5000)
    door_mm: float = Field(gt=0, le=4000)
    robots: bool = Field(default=True, description="Есть интеграция: робот сам вызывает лифт")
    people_calls_per_hour: float = Field(default=0.0, ge=0, le=120, description="Сколько раз в час лифт занимают люди")


class ProcessFlow(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    source: str = Field(min_length=1, max_length=64)
    target: str = Field(min_length=1, max_length=64)
    per_day: float = Field(ge=0, le=20_000)


class DeliveryProcess(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    enabled: bool = True
    mode: Literal["per_point", "building", "routes"] = "per_point"
    per_day: float | None = Field(default=None, ge=0, le=20_000)
    urgent_share: float | None = Field(default=None, ge=0, le=1)
    picking_min: float | None = Field(default=None, ge=0, le=240)
    deadline_min: float | None = Field(default=None, gt=0, le=1440)
    urgent_deadline_min: float | None = Field(default=None, gt=0, le=1440)
    flows: list[ProcessFlow] = Field(default_factory=list, max_length=400)


class ClinicScenario(BaseModel):
    """Процессы и расписание хранятся вместе с геометрией, одинаковы во всех расчетах."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    shift_start_h: int = Field(default=7, ge=0, le=23)
    shift_hours: int = Field(default=24, ge=1, le=24)
    schedule: Literal["industry", "uniform", "custom"] = "industry"
    hourly_weights: list[float] = Field(default_factory=list, max_length=24)
    meds: DeliveryProcess = Field(default_factory=DeliveryProcess)
    supplies: DeliveryProcess = Field(default_factory=DeliveryProcess)
    point_weights: dict[str, float] = Field(default_factory=dict, max_length=MAX_WARDS)
    cleaning_passes: float = Field(default=2, ge=0, le=12)
    floor_cleaning_passes: dict[int, float] = Field(default_factory=dict, max_length=MAX_FLOORS)
    days_per_year: int | None = Field(default=None, ge=1, le=366, description="Дней работы объекта в году")

    @model_validator(mode="after")
    def valid_profile(self):
        if self.schedule == "custom" and (len(self.hourly_weights) != 24 or sum(self.hourly_weights) <= 0):
            raise ValueError("Для своего расписания нужны 24 веса часов и положительная сумма")
        if any(value < 0 or value > 1_000_000 for value in self.hourly_weights):
            raise ValueError("Веса часов должны быть неотрицательными, не больше 1000000")
        if any(value < 0 or value > 100 for value in self.point_weights.values()):
            raise ValueError("Вес поста: от 0 до 100")
        if any(value < 0 or value > 12 for value in self.floor_cleaning_passes.values()):
            raise ValueError("Уборка: от 0 до 12 проходов за прогон")
        return self


class Building(BaseModel):
    version: Literal[1] = 1
    floor_height_m: float = Field(gt=2, le=8)
    floors: list[Floor] = Field(min_length=1, max_length=MAX_FLOORS)
    lifts: list[Lift] = Field(default_factory=list, max_length=MAX_LIFTS)
    scenario: ClinicScenario | None = None

    @model_validator(mode="after")
    def _limits(self) -> Building:
        numbers = [floor.number for floor in self.floors]
        if len(set(numbers)) != len(numbers):
            raise ValueError("Номера этажей повторяются")
        ids = [lift.id for lift in self.lifts]
        if len(set(ids)) != len(ids):
            raise ValueError("Номера лифтов повторяются")
        items = [item.id for floor in self.floors for item in floor.items]
        if len(set(items)) != len(items):
            raise ValueError("Номера вещей корпуса повторяются: у каждого помещения, двери и шахты свой id")
        wards = sum(1 for floor in self.floors for item in floor.items if item.kind == "room" and item.role == "ward")
        if wards > MAX_WARDS:
            raise ValueError(f"Технический предел расчета: {MAX_WARDS} постов на корпус")
        if sum(floor.width_m * floor.length_m for floor in self.floors) > MAX_AREA_M2:
            raise ValueError(f"Технический предел расчета: {MAX_AREA_M2} м² суммарных участков этажей")
        return self


class CheckOut(BaseModel):
    level: Literal["error", "warning", "info"]
    code: str
    text: str
    floor: int | None = None
    target: str = ""


class GenerateRequest(BaseModel):
    layout: Literal["linear", "mixed"] = "linear"
    width_m: int = Field(default=60, ge=10, le=MAX_SIDE_M)
    length_m: int = Field(default=24, ge=10, le=MAX_SIDE_M)
    floors: int = Field(default=4, ge=1, le=MAX_FLOORS)
    wards_per_floor: int = Field(default=3, ge=1, le=8)
    lifts: int = Field(default=1, ge=0, le=MAX_LIFTS)
    furnished: bool = True
    floor_height_m: float = Field(default=3.3, gt=2, le=8)

    @model_validator(mode="after")
    def _room_size(self) -> GenerateRequest:
        if self.width_m * self.length_m * self.floors > MAX_AREA_M2:
            raise ValueError(f"Суммарная площадь участков этажей не больше {MAX_AREA_M2} м²")
        if self.floors * self.wards_per_floor > MAX_WARDS:
            raise ValueError(f"Технический предел: {MAX_WARDS} постов на корпус")
        if self.furnished and self.lifts > 2 and self.length_m < 8 + 3 * self.lifts:
            raise ValueError("Для такого числа лифтов увеличьте глубину этажа: нужно 8 + 3 × число лифтов, м")
        if self.furnished and (self.width_m < 36 or self.length_m < 18):
            raise ValueError("Для готовой расстановки нужен этаж от 36 × 18 м. Для меньшего этажа выберите чистый лист")
        if self.furnished and self.floors > 1 and self.lifts == 0:
            raise ValueError("Для готового многоэтажного корпуса нужен хотя бы один лифт")
        return self


class CheckRequest(BaseModel):
    building: Building
    operation_ids: list[str] = Field(default_factory=lambda: list(TASKS), min_length=1, max_length=10)
    robot_id: str = Field(default="ext-pudu-flashbot-max", description="Доставщик из решений медучреждения")
    cleaner_id: str | None = Field(default="f31223c1-44c8-4410-8381-6356e2158b61", description="Уборщик или null")


class CheckResult(BaseModel):
    valid: bool = Field(description="Ошибок нет: смену можно считать")
    checks: list[CheckOut]
    corridor_m2: dict[int, float] = Field(description="Коридоры этажа, м2: их моет уборщик")


class FitRequest(BaseModel):
    building: Building


class FitResult(BaseModel):
    """Кто на этом корпусе не работает совсем: id робота и причина словами. Остальные подходят."""

    delivery: dict[str, str]
    cleaning: dict[str, str]


class WorkloadRequest(BaseModel):
    building: Building
    overrides: dict[str, float] = Field(default_factory=dict)
    operation_ids: list[str] = Field(default_factory=lambda: ["floor_delivery", "cleaning"])


class ProcessWorkload(BaseModel):
    kind: str
    per_day: float
    in_window: float
    routes: int


class WorkloadResult(BaseModel):
    floors: int
    area_m2: float
    points: int
    effective_points: float
    reference_points: float
    shift_start_h: int
    shift_hours: int
    daily_share: float
    demand_per_hour: list[float]
    processes: list[ProcessWorkload]
    cleaning_m2: dict[int, float]
    warnings: list[str]


class RunRequest(BaseModel):
    operation_ids: list[str] = Field(default_factory=lambda: list(TASKS), min_length=1, max_length=10)
    building: Building | None = Field(default=None, description="Корпус. Нет: берем типовой")
    robot_id: str = "ext-pudu-flashbot-max"
    fleet: int | None = Field(default=None, ge=0, le=30, description="Доставщиков. Нет: ищем самый маленький парк")
    cleaner_id: str | None = "f31223c1-44c8-4410-8381-6356e2158b61"
    cleaners: dict[int, int] | None = Field(
        default=None, max_length=MAX_FLOORS, description="Уборщиков на этаж. Нет: по одному на этаж"
    )
    seed: int = Field(default=42, ge=0, le=2**31 - 1)
    with_events: bool = Field(default=True, description="Вернуть лог отрезками для проигрывателя")
    overrides: dict[str, float] = Field(
        default_factory=dict, description="Правки параметров датасета, как на шаге параметров: clinic.<ключ>"
    )

    @model_validator(mode="after")
    def _cleaners(self) -> RunRequest:
        if self.cleaners and any(
            not -2 <= floor <= 40 or not 0 <= n <= MAX_CLEANERS_PER_FLOOR for floor, n in self.cleaners.items()
        ):
            raise ValueError(f"Уборщиков на этаже от 0 до {MAX_CLEANERS_PER_FLOOR}")
        if self.building and self.cleaners and set(self.cleaners) - {f.number for f in self.building.floors}:
            raise ValueError("Распределение уборщиков ссылается на отсутствующий этаж")
        return self


class SpecOut(BaseModel):
    field: str
    value: float
    text: str = Field(description="Как в источнике, с диапазоном")
    trust: str = Field(description="Оценка S-F из data/specs/specs.csv")
    note: str


class RobotOut(BaseModel):
    id: str
    product: str
    operation: str
    availability: str
    lift: str | None = Field(description="Как ездит на лифте, словами источника; null: про лифт не пишут")
    specs: list[SpecOut]
    missing: list[str] = Field(description="Каких характеристик нет: такого робота не считаем")
    speed_m_s: float | None = Field(description="Скорость в прогоне: доставщик 2/3 максимальной, как у склада")


class Robots(BaseModel):
    delivery: list[RobotOut]
    cleaning: list[RobotOut]


class Assumption(BaseModel):
    path: str
    value: float | list[float]
    source: str
    date: str | None
    trust: str


class Segment(BaseModel):
    """Отрезок лога робота. Как у склада, плюс этаж; в лифте этажа нет, есть лифт."""

    robot: int
    role: Literal["delivery", "cleaning"]
    floor: int | None
    from_s: float
    to_s: float
    action: str
    path: list[tuple[float, float]]
    lift: str = ""


class LiftSegment(BaseModel):
    lift: str
    from_s: float
    to_s: float
    action: str
    from_floor: float
    to_floor: float
    robots: list[int]


class JobOut(BaseModel):
    id: str
    kind: Literal["meds", "supplies"]
    source: str
    target: str
    urgent: bool
    created_s: float
    ready_s: float | None
    picked_s: float | None
    done_s: float | None
    deadline_s: float
    robot: int | None
    blocked: str


class KindKpi(BaseModel):
    kind: str
    created: int
    done: int
    due: int
    on_time: int
    blocked: int


class LiftKpi(BaseModel):
    lift: str
    busy_share: float
    robot_rides: int
    people_rides: int
    avg_robot_wait_s: float


class CleaningKpi(BaseModel):
    floor: int
    area_m2: float
    done_m2: float


class Kpi(BaseModel):
    created: int
    done: int
    due: int = Field(description="Фиксированная когорта: заявки со сроком внутри смены, от них считаем вовремя")
    on_time: int
    on_time_share: float | None
    blocked: int
    avg_delivery_min: float | None = Field(description="От заявки до передачи на посту, с комплектацией")
    p95_delivery_min: float | None
    shares: dict[str, float] = Field(description="Доля времени парка: едет, ждет, грузит, заряжается, моет")
    waits: dict[str, float] = Field(description="Доля времени парка в очереди: лифт, дверь, зарядка")
    bottleneck: str
    staff_hours: float
    cleaned_m2: float
    kinds: list[KindKpi]
    lifts: list[LiftKpi]
    cleaning: list[CleaningKpi]


class Effect(BaseModel):
    """Эффект в часах персонала. В рубли его переводит POST /api/clinic/economics по цене часа."""

    staff_hours_per_shift: float
    cleaned_m2_per_shift: float
    note: str


class Search(BaseModel):
    needed: int | None
    target: float
    curve: list[tuple[int, float]] = Field(description="Парк и худшая по seed доля вовремя")
    stopped: str


class RunResult(BaseModel):
    fleet: int
    cleaners: dict[int, int]
    hours: float
    shift_start_h: int
    robot: RobotOut
    cleaner: RobotOut | None
    demand_per_hour: list[float] = Field(description="Заявок в час по часам смены на этот корпус")
    kpi: Kpi
    effect: Effect
    search: Search | None
    checks: list[CheckOut]
    jobs: list[JobOut]
    segments: list[Segment]
    lift_segments: list[LiftSegment]


# --- деньги: итог для мастера --------------------------------------------------------------

TASKS = ("floor_delivery", "cleaning")


class MoneyAssumptions(BaseModel):
    """Проверяемые сценарные условия. None: значение config/clinic.yaml, а не факт объекта."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    delivery_hour_rub: float | None = Field(default=None, gt=0, le=100_000)
    manual_delivery_min_per_job: float | None = Field(default=None, gt=0, le=1440)
    manual_cleaning_m2_per_hour: float | None = Field(default=None, gt=0, le=100_000)
    delivery_staff_per_shift: float | None = Field(default=None, ge=0, le=100_000)
    cleaning_staff_per_shift: float | None = Field(default=None, ge=0, le=100_000)
    cash_saving_cap_rub_year: float | None = Field(default=None, ge=0, le=10_000_000_000)
    annual_work_hours: float | None = Field(default=None, gt=0, le=8784)
    paid_leave_hours: float | None = Field(default=None, ge=0, le=2000)
    wage_growth: float | None = Field(default=None, ge=-0.5, le=1)
    inflation: float | None = Field(default=None, ge=-0.5, le=1)
    discount_rate: float | None = Field(default=None, ge=0, le=1)
    cash_realization_share: float | None = Field(default=None, ge=0, le=1)
    cleaning_time_saving_share: float | None = Field(default=None, ge=0, le=1)
    delivery_support_min_per_job: float | None = Field(default=None, ge=0, le=120)
    cleaner_support_min_per_shift: float | None = Field(default=None, ge=0, le=480)
    manual_door_assist_s: float | None = Field(default=None, ge=0, le=300)
    integration_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    extra_annual_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    days_per_year: int | None = Field(default=None, ge=1, le=366)
    cleaner_hour_rub: float | None = Field(default=None, gt=0, le=100_000)
    rent_service_included: int | None = Field(default=None, ge=0, le=1)
    loan_enabled: int | None = Field(default=None, ge=0, le=1)
    loan_rate: float | None = Field(default=None, ge=0, le=1)
    loan_months: int | None = Field(default=None, ge=1, le=360)
    loan_own_share: float | None = Field(default=None, ge=0, le=1)
    loan_insurance_share: float | None = Field(default=None, ge=0, le=0.2)


class RobotQuote(BaseModel):
    """Предложение привязано к конкретной модели, ноль отличается от неизвестного тарифа."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    source: str = Field(default="", max_length=1000)
    price_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    maintenance_rub_year: float | None = Field(default=None, ge=0, le=1_000_000_000)
    commissioning_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    life_years: int | None = Field(default=None, ge=1, le=30)
    rent_month_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    rent_first_month_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    rent_year_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    rent_first_year_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    rent_service_included: int | None = Field(default=None, ge=0, le=1)


class MoneyRequest(BaseModel):
    """Итог медучреждения: задачи с шага объекта, правки шага параметров и корпус с шага плана."""

    operation_ids: list[str] = Field(min_length=1, max_length=10, description="Задачи с шага объекта")
    robot_id: str = Field(default="ext-pudu-flashbot-max", max_length=64, description="Доставщик")
    cleaner_id: str = Field(default="f31223c1-44c8-4410-8381-6356e2158b61", max_length=64, description="Уборщик")
    overrides: dict[str, float] = Field(default_factory=dict, description="clinic.<ключ датасета>")
    building: Building | None = Field(default=None, description="Корпус с шага плана. Нет: типовой")
    assumptions: MoneyAssumptions = Field(default_factory=MoneyAssumptions)
    quotes: dict[str, RobotQuote] = Field(default_factory=dict, max_length=30)
    fleet: int | None = Field(default=None, ge=0, le=30)
    cleaners: dict[int, int] | None = Field(default=None, max_length=MAX_FLOORS)

    @model_validator(mode="after")
    def valid_sizing(self):
        if self.cleaners is not None and any(
            n < -2 or n > 40 or count < 0 or count > MAX_CLEANERS_PER_FLOOR for n, count in self.cleaners.items()
        ):
            raise ValueError("Уборщики: номер этажа от −2 до 40, от 0 до 4 роботов на этаж")
        if self.building and self.cleaners and set(self.cleaners) - {f.number for f in self.building.floors}:
            raise ValueError("Распределение уборщиков ссылается на отсутствующий этаж")
        return self


class LoanOut(BaseModel):
    principal_rub: float
    rate: float
    term_months: int
    first_month_rub: float
    last_month_rub: float
    payments_rub: list[float]
    debt_left_rub: list[float]
    interest_rub: float
    insurance_rub: list[float]
    equity_payback_years: float | None


class MoneyScenario(BaseModel):
    id: Literal["baseline", "purchase", "raas", "loan"]
    available: bool
    why_not: str
    start_rub: float
    years_rub: list[float]
    tco_rub: float
    saving_rub: float
    effect_year1_rub: float
    payback_years: float | None
    month_rub: float | None
    first_payment_rub: float | None
    robot_cost_rub: float
    rent_period: Literal["month", "year"]
    rental_options_rub: dict[str, float]
    financing: LoanOut | None = None
    cash_share_for_break_even: float | None = None
    minimum_cash_saving_year_rub: float = 0
    annual_gap_rub: float = 0
    npv_rub: float = 0
    discounted_payback_years: float | None = None
    residual_rub: float = Field(
        default=0, description="Остаток срока службы парка на конец горизонта: вычтен из итога, не поступление денег"
    )


class MoneyFleet(BaseModel):
    operation_id: str
    robot_id: str
    task: str
    name: str
    count: int
    price_rub: float
    price_source: str


class MoneyPeople(BaseModel):
    hours_per_shift: float = Field(description="Часы санитаров и уборщиц за прогнанную смену, которые забирают роботы")
    hours_per_year: float
    hour_rub: float = Field(description="Час санитара с начислениями")
    fte: float = Field(description="Те же часы в полных ставках")
    orderlies: float | None = Field(
        description="Общая численность из ввода заказчика, null если неизвестна; не штат в смене"
    )
    manual_hours_per_shift: float
    manual_delivery_hours_per_shift: float
    manual_cleaning_hours_per_shift: float
    remaining_hours_per_shift: float
    delivery_hours_per_shift: float
    cleaning_hours_per_shift: float
    support_hours_per_shift: float
    extra_hours_per_shift: float
    cleaner_hour_rub: float
    released_value_year_rub: float = Field(description="Стоимость чистого времени, не экономия бюджета")
    cash_saving_year_rub: float
    positions_released: float = Field(
        default=0,
        description="Целых ставок, которые сокращают бюджет по правилу целых ставок; 0 при доле, заданной вручную",
    )


class ServiceScore(BaseModel):
    on_time_share: float | None
    urgent_on_time_share: float | None = None
    completion_share: float | None
    cleaning_coverage: float | None
    overdue_unfinished: int
    carryover_jobs: int


class MoneyShift(BaseModel):
    service: ServiceScore
    hours: float
    shift_start_h: int
    expected_jobs: float
    checks: list[CheckOut]
    fleet: int
    cleaners: dict[int, int]
    search: Search | None
    floors: int
    wards: int
    lifts: int
    jobs: int
    on_time_share: float | None
    avg_delivery_min: float | None
    bottleneck: str
    lift_busy_share: float | None
    cleaned_m2: float
    done: int
    due: int
    cleaning_required_m2: float
    cleaning_coverage: float | None


class MoneySource(BaseModel):
    group: Literal["Объект", "Роботы", "Смена", "Деньги"] = Field(description='Раздел в "Откуда цифры"')
    name: str
    value: str
    source: str = Field(description="Откуда; у допущения без источника так и написано")
    date: str | None = Field(default=None, description="Когда проверили, ГГГГ-ММ; null: дата не указана")
    trust: str = Field(description="Оценка S-F, F: источника нет")


class MoneyResult(BaseModel):
    horizon_years: int
    tasks: list[str] = Field(description="Что посчитали: доставка по этажам, уборка коридоров")
    skipped: list[str] = Field(description="Отмеченные задачи без расчета")
    fleets: list[MoneyFleet]
    people: MoneyPeople
    shift: MoneyShift
    scenarios: list[MoneyScenario]
    not_counted: list[str] = Field(description="Чего в деньгах нет: так и пишем")
    sources: list[MoneySource]
    assumptions: dict[str, float]
    warnings: list[str]
    readiness: list[str] = Field(default_factory=list, description="Неизвестные исходные данные и ограничения решения")


class OfferRequest(MoneyRequest):
    robot_ids: list[str] = Field(min_length=1, max_length=8)


class Offers(BaseModel):
    offers: dict[str, MoneyResult]
    errors: dict[str, str]


class StressProfile(BaseModel):
    """Проверяемое условие, а не оценка вероятности или измеренный отраслевой диапазон."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=32, pattern=r"^[a-z][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=80)
    demand_factor: float = Field(default=1, ge=1, le=4)
    speed_factor: float = Field(default=1, ge=0.2, le=1)
    runtime_factor: float = Field(default=1, ge=0.2, le=1)
    cleaning_factor: float = Field(default=1, ge=0.2, le=1)
    handling_factor: float = Field(default=1, ge=1, le=4)
    lift_traffic_factor: float = Field(default=1, ge=1, le=4)
    door_wait_factor: float = Field(default=1, ge=1, le=4)
    support_factor: float = Field(default=1, ge=1, le=4)
    arrival_spread: float = Field(default=1, ge=0.1, le=1)


class OptimizationRequest(MoneyRequest):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    delivery_ids: list[str] | None = Field(default=None, max_length=6)
    cleaner_ids: list[str] | None = Field(default=None, max_length=8)
    objective: Literal["min_cost", "max_time"] = "min_cost"
    payment_ids: list[Literal["purchase", "raas", "loan"]] = Field(
        default_factory=lambda: ["purchase", "raas", "loan"], min_length=1, max_length=3
    )
    max_delivery_fleet: int = Field(default=12, ge=1, le=30)
    max_cleaners_per_floor: int = Field(default=4, ge=1, le=MAX_CLEANERS_PER_FLOOR)
    on_time_target: float = Field(default=0.95, ge=0.5, le=1)
    urgent_on_time_target: float = Field(default=1, ge=0.5, le=1)
    stress_profiles: list[StressProfile] = Field(default_factory=list, max_length=3)
    completion_target: float = Field(default=1, ge=1, le=1)
    cleaning_target: float = Field(default=1, ge=1, le=1)
    max_upfront_rub: float | None = Field(default=None, ge=0, le=1_000_000_000)
    time_budget_s: float = Field(default=12, ge=2, le=30)

    @model_validator(mode="after")
    def unique_profiles(self):
        ids = [profile.id for profile in self.stress_profiles]
        if "nominal" in ids or len(set(ids)) != len(ids):
            raise ValueError("Условия должны иметь разные id; nominal зарезервирован для исходного сценария")
        return self


class CaseAssessment(BaseModel):
    profile: StressProfile
    training: ServiceScore
    validation: ServiceScore | None = None
    incremental_cost_range_rub: tuple[float, float]
    labour_balance_range_hours: tuple[float, float]
    payback_years: float | None = Field(
        default=None, description="Худший устойчивый срок; null, если хотя бы один прогон не окупается"
    )
    payback_met: bool = Field(
        default=False, description="Положительная денежная экономия и окупаемость на всех подборочных и новых прогонах"
    )
    runs: int


class OptimizationCandidate(BaseModel):
    id: str
    robot_id: str
    cleaner_id: str
    robot_name: str
    cleaner_name: str
    fleet: int
    cleaners: dict[int, int]
    payment_id: Literal["purchase", "raas", "loan"]
    upfront_rub: float
    incremental_cost_rub: float = Field(
        description="Худшие дополнительные расходы против ручного эквивалента за горизонт"
    )
    incremental_npv_cost_rub: float | None = None
    incremental_cost_range_rub: tuple[float, float]
    released_hours_year: float = Field(
        description="Минимальный чистый баланс: высвобождение минус дополнительная нагрузка, ч/год"
    )
    training: ServiceScore
    validation: ServiceScore | None = None
    validated: bool = False
    payback_years: float | None = None
    payback_met: bool = False
    payback_why_not: list[str] = Field(default_factory=list)
    why_not: list[str] = Field(default_factory=list)
    conditions: list[str] = Field(default_factory=list)
    assessments: list[CaseAssessment] = Field(default_factory=list)


class OptimizationResult(BaseModel):
    objective: Literal["min_cost", "max_time"]
    horizon_years: int
    training_seeds: list[int]
    validation_seeds: list[int]
    targets: dict[str, float]
    candidates: list[OptimizationCandidate]
    recommended_id: str | None
    configurations_checked: int
    simulations: int
    fully_enumerated: bool
    stopped: str
    elapsed_s: float
    excluded: list[str]
    notes: list[str]
    stress_profiles: list[StressProfile] = Field(default_factory=list)
