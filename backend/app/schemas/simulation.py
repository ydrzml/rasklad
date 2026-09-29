"""Прогон смены: что отдаем интерфейсу для KPI, проигрывателя и выгрузки."""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.plan import GeneratedPlan, Plan


class SimulationRequest(BaseModel):
    facility_id: str = "warehouse"
    operation_id: str = "pallet_transport"
    robot_id: str = "ronavi-h1500"
    fleet: int = Field(default=10, ge=1, le=250)
    plan: Plan | None = Field(default=None, description="План объекта. Если его нет, берем типовой по шаблону")
    with_events: bool = Field(default=True, description="Вернуть лог отрезками для проигрывателя на плане")
    overrides: dict[str, float] = Field(
        default_factory=dict, description="Правки параметров, как в расчете: от них зависят спрос и схема"
    )
    slotted_by_turnover: bool = Field(
        default=False, description="Товар разложен по ходовости: ходовое ближе к воротам, задания чаще там"
    )
    share: float = Field(
        default=1.0,
        gt=0,
        le=1,
        description="Доля объема задачи у этого решения при смешанном парке: прогон гоняет только ее",
    )


class Place(BaseModel):
    """Место у стеллажа для тепловой карты: как часто сюда должны ездить и сколько заездов вышло."""

    x: float
    y: float
    share: float = Field(description="Доля заданий, которая приходится на это место")
    visits: int = Field(description="Сколько заданий сделано здесь за смену")


class Segment(BaseModel):
    """Отрезок лога: кто, с какой секунды по какую, что делал и по какой ломаной ехал.

    Точки на момент времени в логе мало: по ней нельзя плавно двигать робота, непонятно,
    куда он едет. Ломаная нужна потому, что прямая от ворот до стеллажа прошла бы
    сквозь ряды. У стоячих действий в ломаной одна точка.
    """

    robot: int
    from_s: float
    to_s: float
    action: str
    path: list[tuple[float, float]]


class Kpi(BaseModel):
    done: int
    ops_per_hour: float
    busy_share: float = Field(description="Доля времени, когда робот едет или грузит")
    waiting_share: float = Field(description="Доля времени в очередях: проезды и ворота")
    charging_share: float
    avg_cycle_s: float
    avg_wait_s: float
    bottleneck: str
    waits: dict[str, float] = Field(
        default_factory=dict, description="Доля времени парка в очереди у каждого места: ворота, проезд, пандус"
    )


class Layout(BaseModel):
    """Что в плане оказалось важным для этого прогона."""

    width_m: float
    length_m: float
    docks: int
    aisles: int
    stations: int = 0
    route_m: float


class SimulationResult(BaseModel):
    fleet: int
    hours: float
    plan_edited: bool = Field(default=False, description="План нарисовал человек или мы взяли типовой")
    zone_plan: GeneratedPlan | None = Field(
        default=None,
        description=(
            "Робозона, по которой шел прогон вместо присланного плана: отбор «товар к человеку» на плане "
            "под погрузчик считаем по робозоне. Пусто: прогон шел по присланному плану"
        ),
    )
    layout: Layout
    demand_per_hour: list[float] = Field(
        default_factory=list, description="Спрос по часам смены, операций в час: шкала проигрывателя, пик внутри смены"
    )
    design_demand: float = Field(
        default=0.0, description="Спрос, на который подбирали парк: пик с резервом, линия на кривой парка"
    )
    kpi: Kpi
    segments: list[Segment] = Field(default_factory=list)
    curve_ops_per_hour: list[float] = Field(
        default_factory=list, description="Сколько операций в час вытягивает парк из N роботов, индекс это N"
    )
    curve_points: list[tuple[float, float]] = Field(
        default_factory=list,
        description="Замеры поиска парка: парк и худший по seed потолок, операций в час. Только замеры, без нуля",
    )
    fleet_needed: int | None = Field(
        default=None, description="Самый маленький парк, который вытянул спрос на всех seed; None: не вытянет и 250"
    )
    places: list[Place] = Field(default_factory=list, description="Места у стеллажей: тепловая карта")
