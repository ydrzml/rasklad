"""Прогон смены для API: собираем схему из плана объекта и отдаем KPI, лог и кривую парка."""

from __future__ import annotations

import math
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
from functools import lru_cache

from app.engine import plan as plan_engine
from app.engine import simulation
from app.engine.economics.fleet import peak_demand, robot_ops_per_hour
from app.engine.economics.scenarios import by_id
from app.engine.economics.staff import hours_per_day
from app.schemas import plan as plan_schema
from app.schemas import simulation as schema
from app.services import plan as plan_service
from app.services.calculation import model_with_overrides

# План живет в памяти по своему отпечатку: кривая кешируется по нему, а словарь в ключ кеша
# не положить. Плана два-три на расчет, поэтому маленького склада хватает.
_PLANS: dict[str, plan_engine.Plan] = {}
ROBOT_ZONE = plan_service.ROBOT_ZONE
ZONE_PATHS = (".active_area_m2", ".picking_zone_share")


def remember(plan: plan_engine.Plan) -> str:
    key = plan_service.digest(plan)
    _PLANS[key] = plan
    return key


def plan_for(
    facility_id: str, operation_id: str, raw: dict | None, overrides: dict[str, float] | None = None
) -> plan_engine.Plan:
    """План из запроса, а если его не прислали, сгенерированный по шаблону. Отбор на плане под
    погрузчик идет по робозоне (task_plan)."""
    return task_plan(facility_id, operation_id, plan_service.from_dict(raw) if raw else None, overrides)


def picking_on_zone(facility_id: str, operation_id: str) -> bool:
    """Штучный отбор «товар к человеку» считаем всегда по робозоне, каким бы ни был план человека:
    так такие системы и ставят, плотные стеллажи без людей и станции рядом. Остальные задачи по плану."""
    model, _ = model_with_overrides({})
    operation = by_id(by_id(model["facilities"], facility_id)["operations"], operation_id)
    return bool(operation.get("productivity_after"))


def task_plan(
    facility_id: str,
    operation_id: str,
    drawn: plan_engine.Plan | None,
    overrides: dict[str, float] | None = None,
) -> plan_engine.Plan:
    """План, по которому гоняем задачу.

    Пропуск шага плана не особый случай: расчет все равно идет по плану, просто по типовому.
    В результате мы пишем, что расположение ворот и зон на объекте нам неизвестно.
    Для схемы «товар к человеку» типовой склад это робозона со станциями, а не ряды под погрузчик:
    на фронтальных стеллажах до станции в разы дальше, и отбор не покрывается разумным парком.
    Поэтому отбор идет по робозоне и тогда, когда план человека под погрузчик: паллеты и уборка
    остаются на его плане. Робозона занимает часть склада (picking_zone_share), ее правит человек.
    """
    if not picking_on_zone(facility_id, operation_id):
        return drawn if drawn is not None else plan_service.generate(facility_id, [operation_id])
    # из правок робозоне нужны только площадь склада и ее доля под отбор: станции, как и раньше,
    # от объема по умолчанию, иначе у смешанного парка каждая часть строила бы свою робозону
    zone = {path: value for path, value in (overrides or {}).items() if path.endswith(ZONE_PATHS)}
    return plan_service.generate(facility_id, [operation_id], ROBOT_ZONE, zone)


def _station_service_s(model: dict, facility: dict, operation: dict) -> float:
    rate = operation.get("productivity_after")
    return 3600 / rate * operation.get("ops_per_trip", 1) if rate else 0.0


def _layout(
    model: dict, plan: plan_engine.Plan, facility: dict, operation: dict, with_trails: bool, slotted: bool = False
) -> simulation.Layout:
    settings = model["engine"]["simulation"]
    return simulation.build_layout(
        plan,
        plan_service.constants(),
        plan_service.measure(plan),
        robots_per_aisle=settings["robots_per_aisle"],
        station_service_s=_station_service_s(model, facility, operation),
        with_trails=with_trails,
        popularity=(facility["fast_share"], facility["fast_picks_share"]) if slotted else None,
    )


def _robot(robot: dict) -> simulation.RobotSpec:
    return simulation.RobotSpec(
        speed_m_s=robot["avg_speed_m_s"],
        handling_s=robot["handling_s"],
        run_time_h=robot["run_time_h"],
        charge_time_h=robot["charge_time_h"],
        per_charger=robot["robots_per_charger"],
        refill_s=robot.get("refill_s"),
        area_m2=robot.get("area_per_trip_m2") or 0.0,
    )


def per_trip(robot: dict, operation: dict) -> float:
    """Сколько единиц задачи закрывает один рейс прогона.

    Прогон считает рейсы: доехал, взял, отвез. У паллет рейс это одна паллета, у отбора
    столько строк, сколько человек снимает с одного привезенного стеллажа (ops_per_trip).
    Уборщик возит не груз, а воду: выезжает с базы, моет зону, если хватает бака и заряда,
    и возвращается слить и налить воду. Поэтому его рейс это участок в квадратных метрах,
    размер участка записан у робота (config/model.yaml, area_per_trip_m2). Спрос прогону
    отдаем в рейсах, а итоги и кривую переводим обратно в единицы задачи.
    """
    return robot.get("area_per_trip_m2") or operation.get("ops_per_trip") or 1.0


def _parts(
    facility_id: str, operation_id: str, robot_id: str, overrides: dict[str, float] | None = None
) -> tuple[dict, dict, dict, dict]:
    model, _ = model_with_overrides(overrides or {})
    facility = by_id(model["facilities"], facility_id)
    return model, facility, by_id(facility["operations"], operation_id), by_id(model["robots"], robot_id)


# Правки, которые прогон смены не читает: деньги, оплата, меры поддержки, штат и внедрение.
# Поиск парка держит ответы в памяти по правкам, и срок лизинга в ключе заставлял на каждое
# нажатие заново искать парк по всем решениям: у трех решений это дольше минуты, и nginx
# отвечал 504. Прогону от этих чисел ни холодно ни жарко, поэтому в ключ их не берем.
MONEY_ROOTS = ("financing.", "subsidies.", "ramp_up.", "roles.")
MONEY_TAILS = (
    "price_rub",
    "maintenance_share_year",
    "license_rub_year",
    "software_rub",
    "battery_price_rub",
    "battery_life_years",
    "charger_price_rub",
    "commissioning_share",
    "service_life_years",
    "station_price_rub",
    "operator_attention_min_per_hour",
    "avg_power_kw",
    "operator_salary_premium",
    "staff_loss_share",
    "min_operator_posts",
)
MONEY_PARTS = (".raas.", ".implementation.", ".staff.")
# из денег прогон читает только запас парка на пик: от него спрос смены
SHIFT_ECONOMICS = ("economics.peak_reserve_share",)


def for_shift(overrides: dict[str, float] | None) -> dict[str, float]:
    """Только те правки, от которых зависит прогон смены."""
    return {
        path: value
        for path, value in (overrides or {}).items()
        if (not path.startswith("economics.") or path in SHIFT_ECONOMICS)
        and not path.startswith(MONEY_ROOTS)
        and not path.endswith(MONEY_TAILS)
        and not any(part in f"{path}." for part in MONEY_PARTS)
    }


def with_share(
    overrides: dict[str, float] | None, facility_id: str, operation_id: str, share: float
) -> dict[str, float]:
    """Правки с долей объема у решения: смешанный парк гоняет каждую часть задачи отдельно.

    Доля записывается как правка доли работы, посильной роботам: от нее считаются и спрос смены,
    и парк, и правку прогон уже умеет держать в ключе кеша. Правку человека на эту же долю
    берем за основу и умножаем."""
    overrides = dict(overrides or {})
    if share >= 1:
        return overrides
    path = f"facilities.{facility_id}.operations.{operation_id}.automatable_share"
    model, _ = model_with_overrides(overrides)
    base = by_id(by_id(model["facilities"], facility_id)["operations"], operation_id)["automatable_share"]
    overrides[path] = base * share
    return overrides


def slotted(facility: dict) -> bool:
    """Разложен ли товар по ходовости: выбор клиента, по умолчанию нет.

    Если да, ходовое стоит ближе к воротам и станциям, и задания чаще выпадают на ближние места.
    Роботов при этом нужно на 30-50% меньше. По умолчанию выключено: как товар стоит на складе
    клиента, мы не знаем, а на Восток-Сервисе роботов и так вышло вдвое больше нашей формулы.
    """
    return bool(facility.get("slotted_by_turnover"))


def run(
    facility_id: str,
    operation_id: str,
    robot_id: str,
    fleet: int,
    plan: plan_engine.Plan,
    with_events: bool = True,
    by_turnover: bool = False,
    overrides: dict[str, float] | None = None,
    share: float = 1.0,
) -> simulation.Result:
    overrides = with_share(overrides, facility_id, operation_id, share)
    model, facility, operation, robot = _parts(facility_id, operation_id, robot_id, overrides)
    settings = model["engine"]["simulation"]
    demand = [value / per_trip(robot, operation) for value in shift_demand(model, facility, operation)]
    layout = _layout(model, plan, facility, operation, with_trails=with_events, slotted=by_turnover)
    return simulation.run_shift(
        layout, _robot(robot), fleet, demand, settings["hours"], settings["seed"], record=with_events
    )


def shift_demand(model: dict, facility: dict, operation: dict) -> list[float]:
    """Спрос по часам моделируемой смены.

    Проигрыватель показывает смену с пиком: два часа пиковой нагрузки, остальное ровно.
    Если весь день держать пиковый спрос, склад выглядит загруженнее, чем есть.
    """
    settings = model["engine"]["simulation"]
    # у ровной задачи (уборка) пика нет: peak_demand уже средний час, профиль ровный
    peak_factor = 1.0 if operation.get("steady") else facility["peak_factor"]
    return simulation.demand_profile(
        peak_demand(operation, facility) / peak_factor,
        peak_factor,
        settings["peak_hours"],
        hours_per_day(facility["schedule"]),
        settings["hours"],
    )


def availability_of(model: dict, operation: dict) -> float:
    """Готовность парка в поиске. У потоковых задач парк это исправные роботы с запасом на
    простой: 8 исправных это парк из 9 при готовности 0,9. У ровной задачи (уборка) запас
    на простой сидит во времени, а не в роботах: робот должен домыть площадь смены за смену с
    учетом простоя, поэтому спрос поиска делим на готовность, а парк не округляем вверх."""
    return 1.0 if operation.get("steady") else model["engine"]["simulation"]["availability"]


def search_demand(model: dict, facility: dict, operation: dict) -> float:
    """Спрос, который должен вытянуть парк в поиске: пик с резервом, у ровной задачи еще и
    с запасом на простой роботов."""
    demand = design_demand(model, facility, operation)
    if operation.get("steady"):
        demand /= model["engine"]["simulation"]["availability"]
    return demand


# --- Поиск парка ------------------------------------------------------------------------
#
# Замеры поиска гоняем параллельно в процессах-помощниках: прогоны друг от друга не зависят.
# Схему склада между процессами не передать, в ней функции, поэтому помощник собирает ее сам по
# плану один раз и держит в памяти. Если процессы поднять нельзя, считаем в этом же процессе.

_POOL: ProcessPoolExecutor | None = None
_HELD: dict[str, tuple[simulation.Layout, simulation.RobotSpec, float, float]] = {}


def _own_connections() -> None:
    """Помощник прогона берет из базы нормативы и цены. На Linux он появляется через fork и получает
    открытые соединения основного процесса: два процесса писали в одно соединение, и Postgres
    ругался "there is already a transaction in progress". Забываем чужие соединения, не закрывая
    их (закрыл бы их и у основного процесса), и открываем свои (так советует SQLAlchemy)."""
    from app.db import engine  # noqa: PLC0415

    engine.dispose(close=False)


def _pool(workers: int) -> ProcessPoolExecutor | None:
    global _POOL
    if workers <= 1:
        return None
    if _POOL is None:
        try:
            _POOL = ProcessPoolExecutor(max_workers=workers, initializer=_own_connections)
        except (OSError, NotImplementedError):
            return None
    return _POOL


def _scheme(case: tuple) -> tuple[simulation.Layout, simulation.RobotSpec, float, float]:
    """Схема для замеров: из кеша процесса, а если ее нет, собираем по плану."""
    plan_key, raw, facility_id, operation_id, robot_id, overrides, by_turnover = case
    # схема зависит не только от плана: ходовость и правки параметров меняют ее тоже
    key = repr((plan_key, facility_id, operation_id, robot_id, overrides, by_turnover))
    if key not in _HELD:
        if len(_HELD) > 4:
            _HELD.clear()
        model, facility, operation, robot = _parts(facility_id, operation_id, robot_id, dict(overrides))
        plan = plan_service.from_dict(raw)
        layout = _layout(model, plan, facility, operation, with_trails=False, slotted=by_turnover)
        _HELD[key] = (layout, _robot(robot), model["engine"]["simulation"]["hours"], per_trip(robot, operation))
    return _HELD[key]


def _ceiling(job: tuple) -> tuple[tuple[int, int], float]:
    """Потолок смены при W исправных роботах и seed: спрос заведомо больше, чем парк вытянет."""
    case, working, seed = job
    layout, spec, hours, size = _scheme(case)
    top = simulation.plenty(layout, spec, working)
    shift = simulation.run_shift(layout, spec, working, top, hours, seed, record=False)
    return (working, seed), shift.kpi.ops_per_hour * size


@lru_cache(maxsize=32)
def fleet_search(
    facility_id: str,
    operation_id: str,
    robot_id: str,
    plan_key: str,
    by_turnover: bool = False,
    overrides: tuple[tuple[str, float], ...] = (),
) -> simulation.FleetSearch:
    """Самый маленький парк, который вытягивает спрос на всех seed. Считается долго, поэтому
    держим в памяти. План входит в ключ отпечатком, правки параметров тоже: от них зависят
    спрос и схема. Стартуем с формулы: она ошибается, но показывает, где искать."""
    model, facility, operation, robot = _parts(facility_id, operation_id, robot_id, dict(overrides))
    settings = model["engine"]["simulation"]
    plan = _PLANS[plan_key]
    demand = search_demand(model, facility, operation)
    availability = availability_of(model, operation)
    route = plan_service.measure(plan).route_m
    rate = robot_ops_per_hour(robot, route, operation.get("ops_per_trip", 1)) * robot["utilization"]
    guess = math.ceil(demand / max(rate, 1e-9) * availability)
    top = math.floor(model["engine"]["max_fleet_simulated"] * availability)
    case = (plan_key, plan_service.to_dict(plan), facility_id, operation_id, robot_id, overrides, by_turnover)
    pool = _pool(min(settings["workers"], os.cpu_count() or 1))

    def measure(jobs: list[tuple[int, int]]) -> dict[tuple[int, int], float]:
        tasks = [(case, working, seed) for working, seed in jobs]
        if pool is not None:
            try:
                return dict(pool.map(_ceiling, tasks))
            except Exception:  # noqa: BLE001 - помощник упал: досчитаем здесь же, ответ тот же
                pass
        return dict(map(_ceiling, tasks))

    return simulation.search_fleet(measure, demand, top, guess, tuple(settings["seeds"]))


def fleet_for(
    facility_id: str,
    operation_id: str,
    robot_id: str,
    plan: plan_engine.Plan,
    by_turnover: bool = False,
    overrides: dict[str, float] | None = None,
    share: float = 1.0,
) -> simulation.FleetSearch:
    return fleet_search(
        facility_id,
        operation_id,
        robot_id,
        remember(plan),
        by_turnover,
        tuple(sorted(with_share(for_shift(overrides), facility_id, operation_id, share).items())),
    )


def curve_for(
    facility_id: str,
    operation_id: str,
    robot_id: str,
    plan: plan_engine.Plan,
    by_turnover: bool = False,
    overrides: dict[str, float] | None = None,
    share: float = 1.0,
) -> list[float]:
    """Кривая для расчета парка: ступенькой по замерам поиска, индекс это парк."""
    model, _, operation, _ = _parts(facility_id, operation_id, robot_id, overrides)
    search = fleet_for(facility_id, operation_id, robot_id, plan, by_turnover, overrides, share)
    return simulation.search_curve(search, availability_of(model, operation), model["engine"]["max_fleet_simulated"])


def design_demand(model: dict, facility: dict, operation: dict) -> float:
    """Спрос, на который подбираем парк: пик с резервом, как в расчете экономики."""
    return peak_demand(operation, facility) * (1 + model["economics"]["peak_reserve_share"])


def to_schema(request: schema.SimulationRequest) -> schema.SimulationResult:
    """Собирает ответ API: KPI, числа плана, лог отрезками и кривую парка."""
    # при смешанном парке прогон гоняет долю задачи, которая досталась этому решению
    overrides = with_share(for_shift(request.overrides), request.facility_id, request.operation_id, request.share)
    model, facility, operation, robot = _parts(request.facility_id, request.operation_id, request.robot_id, overrides)
    # в запросе план приходит моделью API, а собирается план из словаря, как в расчете
    drawn = plan_service.from_dict(request.plan.model_dump()) if request.plan else None
    plan = task_plan(request.facility_id, request.operation_id, drawn, overrides)
    measures = plan_service.measure(plan)
    # отбор на плане под погрузчик гоняем по робозоне: ее и отдаем, чтобы смену рисовать на ней
    zone = drawn is not None and plan is not drawn
    result = run(
        request.facility_id,
        request.operation_id,
        request.robot_id,
        request.fleet,
        plan,
        request.with_events,
        request.slotted_by_turnover,
        overrides,
    )
    search = fleet_for(
        request.facility_id, request.operation_id, request.robot_id, plan, request.slotted_by_turnover, overrides
    )
    availability = availability_of(model, operation)
    layout = _layout(model, plan, facility, operation, with_trails=False, slotted=request.slotted_by_turnover)
    kpi = result.kpi
    size = per_trip(robot, operation)
    return schema.SimulationResult(
        fleet=request.fleet,
        hours=model["engine"]["simulation"]["hours"],
        plan_edited=plan.known,
        zone_plan=(
            plan_schema.GeneratedPlan(
                plan=plan_schema.Plan(**plan_service.to_dict(plan)), measures=plan_schema.Measures(**asdict(measures))
            )
            if zone
            else None
        ),
        demand_per_hour=shift_demand(model, facility, operation),
        design_demand=design_demand(model, facility, operation),
        layout=schema.Layout(
            width_m=measures.width_m,
            length_m=measures.length_m,
            docks=measures.docks,
            aisles=measures.aisles,
            stations=measures.stations,
            route_m=measures.route_m,
        ),
        kpi=schema.Kpi(
            done=round(kpi.done * size),
            ops_per_hour=kpi.ops_per_hour * size,
            busy_share=kpi.busy_share,
            waiting_share=kpi.waiting_share,
            charging_share=kpi.charging_share,
            avg_cycle_s=kpi.avg_cycle_s,
            avg_wait_s=kpi.avg_wait_s,
            bottleneck=kpi.bottleneck,
            waits=kpi.waits,
        ),
        segments=[
            # Для проигрывателя время до десятой секунды, точки до 10 см: на экране это меньше точки.
            # KPI и парк посчитаны выше, до округления
            schema.Segment(
                robot=part.robot,
                from_s=round(part.from_s, 1),
                to_s=round(part.to_s, 1),
                action=part.action,
                path=[(round(x, 1), round(y, 1)) for x, y in part.path],
            )
            for part in result.segments
        ],
        curve_ops_per_hour=simulation.search_curve(search, availability, model["engine"]["max_fleet_simulated"]),
        # точки для графика: парк, при котором исправных столько, сколько мерили, и худший потолок.
        # Ноль роботов движку нужен нижней ступенькой, но это не замер, и на графике его нет
        # Парк целым числом, тем же правилом, что fleet_needed: 7 исправных это парк из 8 при готовности 0.9
        curve_points=[
            (math.ceil(working / availability - 1e-9), value) for working, value in search.points() if working > 0
        ],
        fleet_needed=None if search.working is None else math.ceil(search.working / availability - 1e-9),
        places=[
            schema.Place(
                x=point[0],
                y=point[1],
                share=layout.weights[index] if layout.weights else 1 / len(layout.task_points),
                visits=result.visits[index],
            )
            for index, point in enumerate(layout.task_points)
        ],
    )
