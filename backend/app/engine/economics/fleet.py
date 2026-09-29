"""Парк: пиковый спрос, производительность робота и сколько роботов нужно."""

from __future__ import annotations

import math

from app.engine.economics.staff import hours_per_day, robot_volume_per_day

EPS = 1e-9


def route_length_m(operation: dict, facility: dict, geometry: dict, plan_route_m: float | None = None) -> float:
    """Средняя длина маршрута в одну сторону.

    Если человек нарисовал план, берем маршрут из него: волна по сетке в метр от ворот до мест
    у стеллажей, с объездом рядов. Это самое конкретное, что мы знаем про объект.

    Без плана остается прежняя оценка по площади: зона квадратная, ворота посередине одной стороны,
    робот едет по проходам под прямым углом, среднее расстояние до случайной точки = 0.75 * сторона.
    Она грубее, и в результате мы об этом пишем.
    """
    if plan_route_m:
        return plan_route_m
    if operation.get("route_m"):
        return operation["route_m"]
    return geometry["route_factor"] * math.sqrt(facility["active_area_m2"])


def robot_ops_per_hour(robot: dict, route_m: float, ops_per_trip: float = 1.0) -> float:
    """Операций в час у одного робота в работе, без зарядки и ожидания.

    Если у робота задан номинал рейсов в час (например, подач стеллажа к станции), берем его.
    Иначе считаем от цикла: туда и обратно по маршруту плюс погрузка и выгрузка.
    За один рейс робот может закрыть несколько операций, например несколько строк заказа со стеллажа.
    """
    if robot.get("nominal_trips_per_hour"):
        return robot["nominal_trips_per_hour"] * ops_per_trip
    cycle_s = 2 * route_m / robot["avg_speed_m_s"] + robot["handling_s"]
    return 3600 / cycle_s * ops_per_trip


def peak_demand(operation: dict, facility: dict) -> float:
    """Операций в пиковый час, которые отдаем роботам.

    У ровных задач (steady, уборка) пикового часа нет: площадь смены известна с утра и моется
    за смену, поэтому парк берем под средний час. Пиковый коэффициент датасета описывает поток
    паллет и строк, а не мойку пола: с ним уборка получала три робота там, где хватает одного.
    """
    per_hour = robot_volume_per_day(operation) / hours_per_day(facility["schedule"])
    if operation.get("steady"):
        return per_hour
    return per_hour * facility["peak_factor"]


def linear_throughput_curve(effective_rate: float, max_fleet: int) -> list[float]:
    """Пропускная способность парка из N роботов (индекс = N) без взаимных помех.

    Заглушка до симуляции: симуляция вернет кривую той же формы, но с плато на узком месте.
    """
    return [n * effective_rate for n in range(max_fleet + 1)]


def required_fleet(demand: float, curve: list[float]) -> int | None:
    """Минимальное N, при котором парк покрывает спрос. None: не покрывает ни при каком N."""
    for n, capacity in enumerate(curve):
        if capacity + EPS >= demand:
            return n
    return None
