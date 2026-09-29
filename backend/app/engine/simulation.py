"""Прогон смены: роботы возят грузы по плану объекта, стоят в очередях и заряжаются.

Здесь только модель, без чтения файлов и без базы. Зачем она нужна: аналитический расчет считает
чистый цикл по маршруту и не видит очередей у ворот, заторов в проходах и ожидания зарядки.
Из-за этого производительность робота получается завышенной (docs/calculation.md, раздел
«Проверка на реальных внедрениях»). Симуляция дает кривую «сколько роботов - столько операций в час»,
и расчет экономики берет парк уже по ней (ТЗ, п. 3.6).

Объект внутри симуляции не квадрат со стороной из корня площади, где расстояние считается
по сумме координат и объезжать нечего. Роботы едут по плану: расстояния посчитаны
волной по сетке в метр, клетки под стеллажами непроезжие, задания рождаются у торцов рядов.
"""

from __future__ import annotations

import bisect
import itertools
import math
import random
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

import simpy

from app.engine import plan as plan_module
from app.engine.plan import INF, Measures, Plan

EPS = 1e-9

DOCK_TARGET, STATION_TARGET = "dock", "station"

Point = tuple[float, float]
Trail = Callable[[int, str, bool], list[Point]]
GateTrail = Callable[[int, int, bool], list[Point]]
ChargeRoute = Callable[[Point, bool], tuple[float, list[Point]]]
Sweep = Callable[[int, float], list[Point]]


@dataclass
class Gate:
    """Буфер у ворот со своими местами для разгрузки.

    Места у ворот не один пул на склад, и робот разгружается не в первой клетке первого буфера:
    при воротах на двух стенах у каждой стены своя очередь, и робот встает в ту клетку буфера,
    куда приехал. Списки идут по местам у стеллажей, как task_points.
    """

    slots: int  # сколько роботов разгружаются здесь одновременно: столько ворот у буфера
    from_m: list[float]  # путь от буфера до места
    inside_m: list[float]  # кусок этого пути по проезду между рядами
    arrival: list[Point]  # клетка буфера, куда приходит путь от места
    # Пандус на пути от буфера до места: через сколько метров от буфера он начинается и сколько
    # по нему ехать. Ноль, если место на том же уровне пола, что и буфер.
    ramp_at_m: list[float] = field(default_factory=list)
    ramp_m: list[float] = field(default_factory=list)
    # Путь от буфера к месту, если он не такой, как обратно: по линии движения в одну сторону
    # робот едет к месту одной дорогой, а назад другой. Пусто значит пути одинаковые.
    out_m: list[float] = field(default_factory=list)
    out_inside_m: list[float] = field(default_factory=list)
    out_start: list[Point] = field(default_factory=list)  # клетка буфера, откуда путь к месту короче
    out_ramp_at_m: list[float] = field(default_factory=list)

    def ramp(self, index: int, out: bool = False) -> tuple[float, float]:
        at = self.out_ramp_at_m if out and self.out_ramp_at_m else self.ramp_at_m
        if index < len(self.ramp_m) and self.ramp_m[index] > 0:
            return at[index], self.ramp_m[index]
        return 0.0, 0.0

    def leg(self, index: int, out: bool) -> tuple[float, float, Point]:
        """Путь между буфером и местом: сколько всего, сколько по проезду и клетка буфера."""
        if out and self.out_m:
            return self.out_m[index], self.out_inside_m[index], self.out_start[index]
        return self.from_m[index], self.inside_m[index], self.arrival[index]


@dataclass
class Layout:
    """Схема объекта для прогона смены: расстояния по плану уже посчитаны волной.

    Точка задания это проезжая клетка у торца стеллажа, а не случайная точка квадрата.
    Расстояние до ворот и до станции лежит готовым: волна считается один раз на план,
    а не на каждый рейс.
    """

    task_points: list[Point]
    to_dock_m: list[float]
    to_station_m: list[float] = field(default_factory=list)
    out_station_m: list[float] = field(default_factory=list)  # от станции к месту, если не как обратно
    out_inside_station_m: list[float] = field(default_factory=list)
    dock_point: Point = (0.0, 0.0)
    station_point: Point = (0.0, 0.0)
    station_arrival: list[Point] = field(default_factory=list)  # клетка у станции, куда приходит путь от места
    charge_point: Point = (0.0, 0.0)
    dock_to_charge_m: float = 0.0
    # Проезд между рядами у каждого места, -1 значит вне проезда. Мест в проезде aisle_slots:
    # роботов больше не впустим, остальные ждут у въезда. inside это сколько метров от места
    # до выхода из проезда в сторону ворот или станции.
    aisle_of: list[int] = field(default_factory=list)
    inside_dock_m: list[float] = field(default_factory=list)
    inside_station_m: list[float] = field(default_factory=list)
    aisle_slots: int = 1
    ramps: int = 0  # пандусов на плане: по каждому едут по одному, разъехаться на нем негде
    dock_points: int = 1
    stations: int = 0
    station_service_s: float = 0.0
    trail: Trail | None = None  # ломаная маршрута, нужна только когда пишем лог
    # Буферы у ворот и какой из них ближе к каждому месту. Без них весь склад один буфер
    # с dock_points мест в точке dock_point: так собраны схемы в тестах без плана.
    gates: list[Gate] = field(default_factory=list)
    gate_of: list[int] = field(default_factory=list)
    gate_trail: GateTrail | None = None  # ломаная от места до своей клетки буфера
    charge_route: ChargeRoute | None = None  # путь от точки до зарядки: метры и ломаная по проездам
    # Как часто берут из места: доля всех заданий. Пусто значит все места поровну.
    weights: list[float] = field(default_factory=list)
    # Путь уборщика по участку, пока он моет: от места змейкой по проездам и обратно к месту.
    # Нужен только когда пишем лог, время мойки от него не меняется
    sweep: Sweep | None = None

    def __post_init__(self) -> None:
        if not self.gates:
            count = len(self.task_points)
            inside = [self.inside_dock_m[i] if i < len(self.inside_dock_m) else 0.0 for i in range(count)]
            self.gates = [Gate(self.dock_points, list(self.to_dock_m), inside, [self.dock_point] * count)]
            self.gate_of = [0] * count

    @property
    def with_stations(self) -> bool:
        return self.stations > 0 and self.station_service_s > 0

    def distance(self, index: int, target: str, out: bool = False) -> float:
        field_m = self.to_station_m if target == STATION_TARGET else self.to_dock_m
        if out and target == STATION_TARGET and self.out_station_m:
            field_m = self.out_station_m
        return field_m[index] if index < len(field_m) and field_m[index] < INF else 0.0

    def aisle(self, index: int) -> int:
        return self.aisle_of[index] if index < len(self.aisle_of) else -1

    def inside(self, index: int, target: str, out: bool = False) -> float:
        field_m = self.inside_station_m if target == STATION_TARGET else self.inside_dock_m
        if out and target == STATION_TARGET and self.out_inside_station_m:
            field_m = self.out_inside_station_m
        return min(field_m[index], self.distance(index, target, out)) if index < len(field_m) else 0.0

    def to_charge(self, point: Point, back: bool = False) -> tuple[float, list[Point]]:
        """Путь от точки, где стоит робот, до зарядки, а при back путь обратно, тоже от точки
        к зарядке: робот едет по нему в обратную сторону. Без плана остается крюк по прямой,
        а если и крюка нет, потому что зарядку на плане поставить некуда, робот заряжается на месте."""
        if self.charge_route:
            return self.charge_route(point, back)
        if self.dock_to_charge_m <= 0:
            return 0.0, [point]
        return self.dock_to_charge_m, [point, self.charge_point]

    def gate_path(self, gate: int, index: int, out: bool = False) -> list[Point]:
        """Ломаная от места до клетки буфера. При out это путь от буфера к месту, записанный
        от места: робот едет по нему в обратную сторону."""
        if self.gate_trail:
            return self.gate_trail(gate, index, out)
        return [self.task_points[index], self.gates[gate].leg(index, out)[2]]

    def path(self, index: int, target: str, back: bool = False, out: bool = False) -> list[Point]:
        """Ломаная от точки задания до ворот или станции. back разворачивает ее обратно.

        Без сетки остаются два конца отрезка: этого хватает, чтобы понять, куда едет робот,
        но объезд рядов в такой ломаной не виден.
        """
        finish = self.station_point if target == STATION_TARGET else self.dock_point
        if target == STATION_TARGET and index < len(self.station_arrival):
            finish = self.station_arrival[index]
        points = self.trail(index, target, out) if self.trail else [self.task_points[index], finish]
        return list(reversed(points)) if back else points


def build_layout(
    plan: Plan,
    constants: dict,
    measures: Measures,
    robots_per_aisle: int,
    station_service_s: float = 0.0,
    with_trails: bool = False,
    popularity: tuple[float, float] | None = None,
) -> Layout:
    """Схему для прогона собираем из плана: расстояния волной, точки заданий у торцов рядов.

    Ломаные маршрутов считаем только когда пишем лог: кривая парка гоняет смену два десятка раз,
    и восстанавливать пути для выброшенного лога незачем.
    """
    grid = plan_module.rasterize(plan, constants)
    gate_items = plan_module.targets(plan)
    docks = plan_module.sources_of(grid, gate_items)
    stations = plan_module.sources_of(grid, plan.of(plan_module.STATION))
    charge = plan_module.sources_of(grid, plan.of(plan_module.CHARGE))

    to_dock = plan_module.distances(grid, docks)
    to_station, station_origin = plan_module.reach(grid, stations) if stations else ([], [])
    waves = [plan_module.reach(grid, plan_module.sources_of(grid, [item])) for item in gate_items]
    to_charge = plan_module.distances(grid, charge) if charge else []
    # Линия движения делает путь туда и путь обратно разными: считаем вторую волну от целей
    # к местам. Без линии движения она совпадает с первой, и второй раз не считаем.
    oneway = bool(grid.oneway)
    out_dock = plan_module.distances(grid, docks, toward=False) if oneway else to_dock
    out_station = plan_module.distances(grid, stations, toward=False) if oneway and stations else to_station
    out_waves = (
        [plan_module.reach(grid, plan_module.sources_of(grid, [item]), toward=False) for item in gate_items]
        if oneway
        else waves
    )
    from_charge = plan_module.distances(grid, charge, toward=False) if oneway and charge else to_charge

    def read(field_m: list[float], cell: tuple[int, int]) -> float:
        return field_m[cell[1] * grid.cols + cell[0]] if field_m else INF

    # Место выдаем, только если от него доедем до цели: до ворот, а в схеме со станциями и до
    # станции. Путь до недоступной станции не считаем нулем, иначе задание выходило бы бесплатным.
    with_stations = bool(stations) and station_service_s > 0
    cells = [
        cell
        for cell in plan_module.task_cells(grid)
        if read(to_dock, cell) < INF
        and read(out_dock, cell) < INF
        and (not with_stations or (read(to_station, cell) < INF and read(out_station, cell) < INF))
    ]
    corridors = [plan_module.corridor_of(plan, constants, grid, cell) for cell in cells]
    keys: dict[tuple[int, int, int], int] = {}

    def inside(field_m: list[float]) -> list[float]:
        # если выход не нашелся, место в проезде робот все равно держит, пока грузит
        return [
            (plan_module.inside_m(grid, field_m, cell, corridor) or 0.0) if corridor else 0.0
            for cell, corridor in zip(cells, corridors, strict=True)
        ]

    def arrival(origin: list[int], cell: tuple[int, int]) -> Point:
        source = origin[cell[1] * grid.cols + cell[0]]
        return grid.point(source % grid.cols, source // grid.cols) if source >= 0 else grid.point(*cell)

    ramp_items = plan.of(plan_module.RAMP)

    def over_ramp(wave: list[float], origin: list[int]) -> tuple[list[float], list[float]]:
        # Место на другой отметке пола, чем буфер: путь идет через пандус, другого пути между
        # уровнями нет. Где пандус начинается, берем по волне: ближайшая к буферу клетка пандуса.
        # Если пандусов несколько, берем ближний, это упрощение: робот мог бы ехать и по другому.
        feet = [(wave[index], index) for index in grid.ramps if wave[index] < INF]
        if not feet:
            return [], []
        at, foot = min(feet)
        col, row = foot % grid.cols, foot // grid.cols
        ramp = next((item for item in ramp_items if (col, row) in grid.cells_of(item)), None)
        length = max(ramp.w, ramp.h) if ramp else 0.0
        at_list, len_list = [], []
        for cell in cells:
            source = origin[cell[1] * grid.cols + cell[0]]
            other = source >= 0 and grid.height(source) != grid.height(cell[1] * grid.cols + cell[0])
            at_list.append(at if other else 0.0)
            len_list.append(length if other else 0.0)
        return at_list, len_list

    gates = []
    for (wave, origin), (out_wave, out_origin), slots in zip(waves, out_waves, _slots(plan, gate_items), strict=True):
        at, length = over_ramp(wave, origin)
        gate = Gate(
            slots, [read(wave, cell) for cell in cells], inside(wave), [arrival(origin, cell) for cell in cells]
        )
        gate.ramp_at_m, gate.ramp_m = at, length
        if oneway:
            gate.out_m = [read(out_wave, cell) for cell in cells]
            gate.out_inside_m = inside(out_wave)
            gate.out_start = [arrival(out_origin, cell) for cell in cells]
            gate.out_ramp_at_m = over_ramp(out_wave, out_origin)[0]
        gates.append(gate)

    def trail(index: int, target: str, out: bool = False) -> list[Point]:
        field_m = (out_station if out else to_station) if target == STATION_TARGET else (out_dock if out else to_dock)
        points = (
            plan_module.trace(grid, field_m, cells[index], toward=not out) if field_m else [grid.point(*cells[index])]
        )
        if target == STATION_TARGET and to_station and not out:
            # как у буфера: доезжаем до той клетки у станции, которую запомнила волна
            return points[:-1] + inner_leg(points[-1], arrival(station_origin, cells[index]))
        return points

    def gate_trail(gate: int, index: int, out: bool = False) -> list[Point]:
        # Спуск по волне приходит в клетку буфера на том же расстоянии, но не обязательно в ту,
        # которую запомнила волна. Тогда доезжаем по буферу: он открытый пол, стен в нем нет.
        wave = out_waves[gate][0] if out else waves[gate][0]
        points = plan_module.trace(grid, wave, cells[index], toward=not out)
        return points[:-1] + inner_leg(points[-1], gates[gate].leg(index, out)[2])

    # Ходовое ставят туда, куда быстрее доехать: ближе к воротам, а в робозоне к станциям.
    # Если человек пометил зону ходовой или редкой, ее места встают в начало или в конец очереди.
    weights: list[float] = []
    if popularity and cells:
        base = to_station if with_stations else to_dock
        tier = {plan_module.FAST: 0, plan_module.SLOW: 2}
        zones = [plan_module.rack_of(plan, grid, cell) for cell in cells]
        order = sorted(
            range(len(cells)),
            key=lambda i: (tier.get(zones[i].turnover if zones[i] else "", 1), read(base, cells[i]), i),
        )
        by_rank = popularity_weights(len(cells), *popularity)
        weights = [0.0] * len(cells)
        for rank, index in enumerate(order):
            weights[index] = by_rank[rank]

    def charge_route(point: Point, back: bool = False) -> tuple[float, list[Point]]:
        # к зарядке робот едет по проездам, как и к грузу: по прямой он прошел бы сквозь ряды
        cell = grid.cell(*point)
        wave = from_charge if back else to_charge
        metres = read(wave, cell)
        if metres == INF:
            return measures.charge_detour_m, [point, grid.point(*charge[0])]
        return metres, plan_module.trace(grid, wave, cell, toward=not back)

    swept: dict[tuple[int, int], list[Point]] = {}

    def sweep(index: int, area_m2: float) -> list[Point]:
        # у одного места участок один и тот же, а заездов к нему за смену бывает много
        key = (index, round(area_m2 / grid.step_m**2))
        if key not in swept:
            swept[key] = sweep_path(grid, cells[index], area_m2)
        return swept[key]

    return Layout(
        task_points=[grid.point(*cell) for cell in cells],
        to_dock_m=[read(to_dock, cell) for cell in cells],
        to_station_m=[read(to_station, cell) for cell in cells] if to_station else [],
        out_station_m=[read(out_station, cell) for cell in cells] if oneway and to_station else [],
        out_inside_station_m=inside(out_station) if oneway and to_station else [],
        dock_point=grid.point(*docks[0]) if docks else (0.0, 0.0),
        station_point=grid.point(*stations[0]) if stations else (0.0, 0.0),
        station_arrival=[arrival(station_origin, cell) for cell in cells] if to_station else [],
        charge_point=grid.point(*charge[0]) if charge else (0.0, 0.0),
        dock_to_charge_m=measures.charge_detour_m,
        aisle_of=[keys.setdefault(corridor.key, len(keys)) if corridor else -1 for corridor in corridors],
        inside_dock_m=inside(to_dock),
        inside_station_m=inside(to_station) if to_station else [],
        aisle_slots=max(1, robots_per_aisle),
        ramps=len(ramp_items),
        dock_points=max(1, sum(gate.slots for gate in gates)),
        stations=len(plan.of(plan_module.STATION)),
        station_service_s=station_service_s,
        trail=trail if with_trails else None,
        gates=gates,
        gate_of=[
            min(range(len(gates)), key=lambda number, i=i: gates[number].from_m[i]) if gates else 0
            for i in range(len(cells))
        ],
        gate_trail=gate_trail if with_trails and gates else None,
        charge_route=charge_route if to_charge else None,
        weights=weights,
        sweep=sweep if with_trails else None,
    )


SWEEP_CELLS = 2500  # больше клеток на один участок не берем: столько проездов за один выезд не моют


def sweep_path(grid: plan_module.Grid, start: tuple[int, int], area_m2: float) -> list[Point]:
    """Путь уборщика, пока он моет участок: змейкой по проездам и обратно к месту, откуда начал.

    Участок это area_m2 проезжего пола вокруг места, ближнего по проездам, а не по прямой: волна
    от места по свободным клеткам. Моет он его полосами в клетку шириной, соседние полосы в разные
    стороны, как моют пол. Полосы кладем вдоль того направления, где их меньше: в проезде между
    рядами это вдоль ряда. Между полосами, которые не стоят рядом, едет по участку же.

    Мойка не одна точка: иначе робот час с лишним стоит у места, и на плане кажется, что
    уборщики не работают. Время мойки и итоги смены от пути не зависят, путь нужен проигрывателю.
    """
    col, row = start
    if not grid.free(col, row):
        return [grid.point(col, row)]
    want = max(1, min(SWEEP_CELLS, round(area_m2 / grid.step_m**2)))
    region = _near(grid, start, want)
    runs = min(_strips(region, along_x=True), _strips(region, along_x=False), key=len)
    route = [start]
    for strip in runs:
        route += _hop(grid, region, route[-1], strip[0])[1:]
        route += strip[1:]
    route += _hop(grid, region, route[-1], start)[1:]
    return plan_module.simplify([grid.point(*cell) for cell in route])


def _steps(grid: plan_module.Grid, cell: tuple[int, int]):
    """Соседние клетки, куда можно съехать: свободно и тот же пол или пандус. Линию движения
    уборщик на своем участке не соблюдает: моет он и против стрелки, медленно и один."""
    col, row = cell
    here = row * grid.cols + col
    for dc, dr in plan_module.NEIGHBOURS:
        if grid.free(col + dc, row + dr) and grid.joins(here, (row + dr) * grid.cols + col + dc):
            yield col + dc, row + dr


def _near(grid: plan_module.Grid, start: tuple[int, int], count: int) -> set[tuple[int, int]]:
    """count проезжих клеток, ближайших к месту по проездам: волна от места."""
    found = {start}
    queue = deque([start])
    while queue and len(found) < count:
        for cell in _steps(grid, queue.popleft()):
            if cell not in found:
                found.add(cell)
                queue.append(cell)
                if len(found) >= count:
                    break
    return found


def _strips(region: set[tuple[int, int]], along_x: bool) -> list[list[tuple[int, int]]]:
    """Полосы участка вдоль x или вдоль y: подряд идущие клетки одной линии. Соседние линии
    в разные стороны, змейкой."""
    lines: dict[int, list[int]] = {}
    for col, row in region:
        line, at = (row, col) if along_x else (col, row)
        lines.setdefault(line, []).append(at)
    strips = []
    for number, line in enumerate(sorted(lines)):
        spots = sorted(lines[line])
        pieces: list[list[int]] = [[spots[0]]]
        for at in spots[1:]:
            if at == pieces[-1][-1] + 1:
                pieces[-1].append(at)
            else:
                pieces.append([at])
        if number % 2:
            pieces = [piece[::-1] for piece in reversed(pieces)]
        strips += [[(at, line) if along_x else (line, at) for at in piece] for piece in pieces]
    return strips


def _hop(
    grid: plan_module.Grid, region: set[tuple[int, int]], a: tuple[int, int], b: tuple[int, int]
) -> list[tuple[int, int]]:
    """Переезд по участку от клетки a к клетке b: кратчайший путь по его клеткам."""
    if a == b:
        return [a]
    if abs(a[0] - b[0]) + abs(a[1] - b[1]) == 1:
        return [a, b]
    came: dict[tuple[int, int], tuple[int, int]] = {a: a}
    queue = deque([a])
    while queue:
        cell = queue.popleft()
        if cell == b:
            break
        for other in _steps(grid, cell):
            if other in region and other not in came:
                came[other] = cell
                queue.append(other)
    if b not in came:
        return [a, b]  # участок собран волной и связен, сюда не попадаем
    path = [b]
    while path[-1] != a:
        path.append(came[path[-1]])
    return path[::-1]


def popularity_weights(count: int, share: float, picks: float) -> list[float]:
    """Доля заданий у каждого места по его номеру в очереди ходовости, первое самое ходовое.

    Источник дает одну точку: share самых ходовых мест дают picks всех отборов (у организатора
    A-класс 20% позиций, у Bartholdi и Hackman 20% позиций дают больше 75% отборов). Форму кривой
    между точками не дает никто, это наше допущение: доля отборов у первых x мест равна
    (1 - e^(-k x)) / (1 - e^(-k)), и k подбираем так, чтобы кривая прошла через точку.

    Проверка руками: для 0.2 и 0.75 k около 6.92. Тогда первые 5% мест дают около 29% отборов,
    а дальняя половина мест около 3%: длинный хвост редких позиций, как в источнике.
    """
    if count <= 0:
        return []
    if picks <= share or not 0 < share < 1:
        return [1 / count] * count  # точка не говорит о перекосе: все места поровну
    low, high = 1e-6, 500.0
    for _ in range(100):
        k = (low + high) / 2
        if _cumulative(share, k) < picks:
            low = k
        else:
            high = k
    k = (low + high) / 2
    return [_cumulative((i + 1) / count, k) - _cumulative(i / count, k) for i in range(count)]


def _cumulative(x: float, k: float) -> float:
    return (1 - math.exp(-k * x)) / (1 - math.exp(-k))


def _slots(plan: Plan, gate_items: list) -> list[int]:
    """Сколько роботов разгружаются у буфера одновременно: по одному на ворота этого буфера.

    Ворота относим к ближайшему буферу. Если буферов нет, робот везет груз прямо к воротам,
    и у каждых ворот одно место.
    """
    if not plan.of(plan_module.BUFFER):
        return [1] * len(gate_items)
    counts = [0] * len(gate_items)
    for dock in plan.of(plan_module.DOCK):
        x, y = dock.center
        nearest = min(
            range(len(gate_items)),
            key=lambda number: abs(gate_items[number].center[0] - x) + abs(gate_items[number].center[1] - y),
        )
        counts[nearest] += 1
    return [max(1, count) for count in counts]


def inner_leg(start: Point, finish: Point) -> list[Point]:
    """Переезд внутри буфера уголком: сначала вдоль x, потом вдоль y. Буфер прямоугольный,
    поэтому уголок из него не выходит."""
    return _distinct([start, (finish[0], start[1]), finish])


@dataclass
class RobotSpec:
    speed_m_s: float
    handling_s: float
    run_time_h: float
    charge_time_h: float
    per_charger: int = 0  # роботов на одно зарядное место, как в экономике; 0 значит мест хватает всем
    # Сколько из handling_s робот стоит на своей базе, а не у места. Задано у уборщика: моет он
    # на участке, а на базе только сливает и наливает воду. База у каждого своя, очереди к ней нет.
    # Не задано у тех, кто возит груз: половина у стеллажа, половина у ворот, где бывает очередь.
    refill_s: float | None = None
    # Участок уборщика за один выезд, м2: по нему он ездит змейкой, пока моет. Только для лога
    area_m2: float = 0.0


@dataclass
class Segment:
    """Отрезок лога: кто, с какой секунды по какую, что делал и по какой ломаной ехал.

    Точки на момент времени ("робот 3, секунда 812, едет, точка X Y") в логе мало: по ней
    плавно двигать робота нельзя, непонятно, куда он едет. Отрезок это говорит,
    а ломаная нужна потому, что прямая от ворот до стеллажа прошла бы сквозь ряды.
    Для стоячих действий в ломаной одна точка.
    """

    robot: int
    from_s: float
    to_s: float
    action: str
    path: list[Point]


@dataclass
class Kpi:
    done: float  # у перевозки целые рейсы, у уборки участки, недомытый к концу смены участок долей
    ops_per_hour: float
    busy_share: float
    waiting_share: float
    charging_share: float
    avg_cycle_s: float
    avg_wait_s: float
    bottleneck: str
    waits: dict[str, float] = field(default_factory=dict)  # доля времени парка в очереди у каждого места


@dataclass
class Result:
    kpi: Kpi
    segments: list[Segment] = field(default_factory=list)
    visits: list[int] = field(default_factory=list)  # сколько заданий сделано у каждого места: тепловая карта


MOVING, WAITING, HANDLING, CHARGING, IDLE = "едет", "ждет", "грузит", "заряжается", "без задания"
# где робот стоял в очереди: по этому подпись узкого места говорит, что именно тесно
# уборщик груза не возит: у места он моет, а на базе сливает грязную воду и наливает чистую.
# Время считаем как погрузку, другое только слово в журнале
CLEANING, REFILLING = "моет", "меняет воду"
AISLE_QUEUE, GATE_QUEUE, STATION_QUEUE, CHARGE_QUEUE, RAMP_QUEUE = "проезд", "ворота", "станция", "зарядка", "пандус"


class Shift:
    """Одна смена: задания приходят потоком, роботы их разбирают."""

    def __init__(
        self,
        layout: Layout,
        robot: RobotSpec,
        fleet: int,
        demand_per_hour: float | list[float],
        hours: float,
        seed: int,
        record: bool = True,
    ):
        self.env = simpy.Environment()
        self.layout = layout
        self.robot = robot
        self.fleet = fleet
        self.demand_per_hour = demand_per_hour
        self.hours = hours
        self.random = random.Random(seed)
        self.record = record
        self.tasks = simpy.Store(self.env)
        self.corridors: dict[int, simpy.Resource] = {}
        self.gates = [simpy.Resource(self.env, capacity=max(1, gate.slots)) for gate in layout.gates]
        self.where: dict[int, tuple[int, Point]] = {}  # у какого буфера и в какой его клетке стоит робот
        self.stations = simpy.Resource(self.env, capacity=max(1, layout.stations))
        places = math.ceil(fleet / robot.per_charger) if robot.per_charger else fleet
        self.chargers = simpy.Resource(self.env, capacity=max(1, places))
        # Заряд на старте у всех разный: в середине дня роботы заряжены кто как. Если бы все
        # начинали с полной батареей, первые часы смены никто бы не заряжался, а потом все разом.
        # Свой генератор, чтобы поток заданий при том же seed не менялся.
        start = random.Random(seed * 7919 + 1)
        self.battery_s = [start.uniform(0.0, robot.run_time_h * 3600) for _ in range(fleet)]
        self.segments: list[Segment] = []
        self.visits = [0] * len(layout.task_points)  # сколько заданий сделано у каждого места
        self.cumulative = list(itertools.accumulate(layout.weights)) if layout.weights else []
        self.done = 0.0
        # Что уборщик моет прямо сейчас: доля участка, когда начал и сколько мыть. Недомытый
        # к концу смены участок засчитываем долей, вымытые метры никуда не деваются
        self.washing: dict[int, tuple[float, float, float]] = {}
        self.time_in = {MOVING: 0.0, WAITING: 0.0, HANDLING: 0.0, CHARGING: 0.0}
        self.waited_at = {AISLE_QUEUE: 0.0, GATE_QUEUE: 0.0, STATION_QUEUE: 0.0, CHARGE_QUEUE: 0.0, RAMP_QUEUE: 0.0}
        self.ramps = simpy.Resource(self.env, capacity=layout.ramps) if layout.ramps else None
        # Что робот делает сейчас и с какой секунды. Отрезок пишется, когда действие кончилось,
        # и то, что не успело кончиться к концу смены, иначе пропало бы из лога.
        self.now_doing: dict[int, tuple[str, float, list[Point]]] = {}
        self.cycle_times: list[float] = []
        self.wait_times: list[float] = []

    # --- части смены ------------------------------------------------------------

    def generate(self):
        """Задания приходят равномерно внутри часа: одно каждые 3600 / спрос секунд. Спрос бывает
        числом на всю смену или по часам: так в смену попадает пик.

        Уборщик работает иначе: площадь на смену известна с утра, и он не ждет, пока «накапает»
        на целый участок. Участки смены раскладываем по смене ровно: первый с начала, последний
        так, чтобы его домыть к концу смены, последний неполный, на остаток площади. Так парк,
        взятый под площадь смены, моет почти всю смену, а не всю площадь в первые часы, после
        чего стоит. Когда участков больше, чем смена вмещает (замер потолка), они ложатся
        в очередь почти сразу, и робот моет без пауз."""
        last = len(self.layout.task_points) - 1
        if last < 0:
            return  # мест, до которых можно доехать, нет: заданий не будет
        if self.robot.refill_s is not None:
            total = sum(self.rate(hour * 3600) for hour in range(math.ceil(self.hours)))
            shares = []
            while total > 1e-9:
                shares.append(min(1.0, total))
                total -= shares[-1]
            span = max(0.0, self.hours * 3600 - self.robot.handling_s)
            step = span / (len(shares) - 1) if len(shares) > 1 else 0.0
            for number, share in enumerate(shares):
                at = number * step
                if at > self.env.now:
                    yield self.env.timeout(at - self.env.now)
                yield self.tasks.put((self.pick(last), share))
            return
        while True:
            rate = self.rate(self.env.now)
            if rate <= 0:
                yield self.env.timeout(3600 - self.env.now % 3600)
                continue
            yield self.env.timeout(3600 / rate)
            yield self.tasks.put((self.pick(last), 1.0))

    def pick(self, last: int) -> int:
        """Место для задания: чаще ходовое, если веса мест заданы, иначе любое поровну."""
        if not self.cumulative:
            return self.random.randint(0, last)
        return min(last, bisect.bisect_left(self.cumulative, self.random.random() * self.cumulative[-1]))

    def rate(self, now: float) -> float:
        if isinstance(self.demand_per_hour, list):
            hours = self.demand_per_hour
            return hours[min(int(now // 3600), len(hours) - 1)] if hours else 0.0
        return self.demand_per_hour

    def work(self, robot_id: int):
        """Робот берет задание, возит, а когда батарея села, едет заряжаться.

        Батарея тратится на езду и погрузку. Пока робот стоит в очереди или ждет задание,
        мы считаем, что он почти не тратит заряд.
        """
        while True:
            asked = self.env.now
            self.doing(robot_id, IDLE, [self.where[robot_id][1]] if robot_id in self.where else [])
            index, share = yield self.tasks.get()
            self.now_doing.pop(robot_id, None)
            if self.env.now > asked:
                self.log(robot_id, IDLE, asked, [self.spot(robot_id, index)])
            started = self.env.now
            if self.layout.with_stations:
                yield from self.to_station(robot_id, index)
            else:
                yield from self.to_dock(robot_id, index, share)

            # у перевозки рейс засчитан, когда груз выгружен у ворот; вымытый участок уборщик
            # засчитал уже у места, в visit: домыл, а смена кончилась на пути к базе, метры не пропали
            if self.robot.refill_s is None:
                self.done += share
            self.visits[index] += 1
            self.cycle_times.append(self.env.now - started)
            if self.battery_s[robot_id] <= 0:
                yield from self.charge(robot_id)

    def spot(self, robot_id: int, index: int) -> Point:
        """Где робот стоит перед заданием: там, где кончил прошлое, а в начале смены там,
        откуда начнет это."""
        if robot_id in self.where:
            return self.where[robot_id][1]
        if self.layout.with_stations:
            return self.layout.path(index, STATION_TARGET, out=True)[-1]
        return self.layout.gates[self.layout.gate_of[index]].leg(index, out=True)[2]

    def to_dock(self, robot_id: int, index: int, share: float = 1.0):
        """Перевозка: от буфера, где робот стоит, к месту у стеллажа, погрузка, к ближайшему
        буферу, разгрузка в той его клетке, куда приехал.

        share: доля участка у уборщика. Последний участок смены бывает неполным, мойка и смена
        воды у него короче в ту же долю. У перевозки всегда целый рейс."""
        home = self.layout.gate_of[index]
        gate, spot = self.where.get(robot_id, (home, None))
        if self.layout.gates[gate].leg(index, out=True)[0] == INF:
            gate, spot = home, None  # с этого буфера до места не доехать: план разрезан на части
        start = self.layout.gates[gate].leg(index, out=True)[2]
        if spot:
            yield from self.drive(robot_id, _manhattan(spot, start), inner_leg(spot, start))
        inner_in, outer_in, near_in, far_in = self.gate_legs(gate, index, out=True)
        inner_out, outer_out, near_out, far_out = self.gate_legs(home, index)
        ramp_at, ramp_m = self.layout.gates[gate].ramp(index, out=True)
        yield from self.cross(robot_id, outer_in, far_in[::-1], ramp_at, ramp_m)
        yield from self.visit(robot_id, index, inner_in, near_in, inner_out, near_out, self.at_place_s() * share, share)
        ramp_at, ramp_m = self.layout.gates[home].ramp(index)
        yield from self.cross(robot_id, outer_out, far_out, outer_out - ramp_at - ramp_m, ramp_m)
        finish = self.layout.gates[home].arrival[index]
        if self.robot.refill_s is None:
            yield from self.unload(robot_id, home, finish)
        else:
            yield from self.handle(robot_id, finish, self.robot.refill_s * share, REFILLING)
        self.where[robot_id] = (home, finish)

    def cross(self, robot_id: int, metres: float, path: list[Point], ramp_from: float, ramp_m: float):
        """Едем по куску пути, а если на нем пандус, на пандусе держим место.

        Скорость на пандусе та же, что по ровному полу: подъем небольшой, и сильно робот на нем
        не замедляется. Но пандус узкий, разъехаться на нем негде, поэтому по нему едут по одному,
        а остальные ждут у подножия. Это логика, а не данные: чисел тут нет.
        """
        if ramp_m <= 0 or not self.ramps or metres <= 0:
            yield from self.drive(robot_id, metres, path)
            return
        ramp_from = min(max(0.0, ramp_from), max(0.0, metres - ramp_m))
        ramp_m = min(ramp_m, metres - ramp_from)
        before, rest = split(path, ramp_from / metres)
        on, after = split(rest, ramp_m / (metres - ramp_from) if metres > ramp_from else 0.0)
        yield from self.drive(robot_id, ramp_from, before)
        asked = self.env.now
        with self.ramps.request() as lane:
            self.doing(robot_id, WAITING, [before[-1]])
            yield lane
            self.wait(robot_id, asked, before[-1], RAMP_QUEUE)
            yield from self.drive(robot_id, ramp_m, on)
        yield from self.drive(robot_id, metres - ramp_from - ramp_m, after)

    def gate_legs(self, gate: int, index: int, out: bool = False) -> tuple[float, float, list[Point], list[Point]]:
        """Путь между местом и буфером делится на кусок по проезду между рядами и остальное.
        Ломаная записана от места; при out робот едет по ней от буфера к месту."""
        total, inside, _ = self.layout.gates[gate].leg(index, out)
        inner = min(inside, total)
        near, far = split(self.layout.gate_path(gate, index, out), inner / total if total else 0.0)
        return inner, total - inner, near, far

    def to_station(self, robot_id: int, index: int):
        """Товар к человеку: от станции к стеллажу, стеллаж к станции, отбор, стеллаж обратно
        на место и снова к станциям за следующим заданием.

        Последний переезд это оценка сверху: на самом деле робот может ехать от одного стеллажа
        прямо к другому, и так короче. Но путь между двумя стеллажами для каждой пары мест мы
        не считаем, а без переезда робот телепортировался к станции, и цикл выходил короче
        настоящего. На Восток-Сервисе настоящий цикл оказался в 2,4 раза длиннее нашей формулы,
        так что запас в эту сторону не страшен.
        """
        inner, outer, near, far = self.legs(index, STATION_TARGET)
        in_inner, in_outer, in_near, in_far = self.legs(index, STATION_TARGET, out=True)
        start = far[-1]
        spot = self.where.get(robot_id, (0, None))[1]
        if spot:
            yield from self.drive(robot_id, _manhattan(spot, in_far[-1]), inner_leg(spot, in_far[-1]))
        yield from self.drive(robot_id, in_outer, in_far[::-1])
        yield from self.visit(robot_id, index, in_inner, in_near, inner, near, self.robot.handling_s / 2)
        yield from self.drive(robot_id, outer, far)
        yield from self.serve(robot_id, start)
        if in_far[-1] != start:
            yield from self.drive(robot_id, _manhattan(start, in_far[-1]), inner_leg(start, in_far[-1]))
        yield from self.drive(robot_id, in_outer, in_far[::-1])
        yield from self.visit(robot_id, index, in_inner, in_near, inner, near, self.robot.handling_s / 2)
        yield from self.drive(robot_id, outer, far)
        self.where[robot_id] = (0, start)

    def legs(self, index: int, target: str, out: bool = False) -> tuple[float, float, list[Point], list[Point]]:
        """Путь от места до цели делится на кусок по проезду между рядами и остальное.

        near идет от места до выхода из проезда, far от выхода до цели. Если места нет в проезде,
        near из одной точки. При out это путь от цели к месту, тоже записанный от места.
        """
        total = self.layout.distance(index, target, out)
        inner = self.layout.inside(index, target, out)
        near, far = split(self.layout.path(index, target, out=out), inner / total if total else 0.0)
        return inner, total - inner, near, far

    def visit(
        self,
        robot_id: int,
        index: int,
        inner_in: float,
        near_in: list[Point],
        inner_out: float,
        near_out: list[Point],
        seconds: float,
        share: float = 1.0,
    ):
        """Въезд в проезд, погрузка у стеллажа, выезд. Место в проезде держим все это время:
        пока робот грузит, он стоит в проезде, и объехать его негде. Въезжает и выезжает робот
        с разных концов, если приехал от одного буфера, а везет к другому."""
        corridor = self.corridor(index)
        request = corridor.request() if corridor else None
        asked = self.env.now
        if request:
            self.doing(robot_id, WAITING, [near_in[-1]])
            yield request
        self.wait(robot_id, asked, near_in[-1], AISLE_QUEUE)
        yield from self.drive(robot_id, inner_in, near_in[::-1])
        action = HANDLING if self.robot.refill_s is None else CLEANING
        path = None
        if action == CLEANING:
            self.washing[robot_id] = (share, self.env.now, seconds)
            if self.record and self.layout.sweep and self.robot.area_m2 > 0:
                path = self.layout.sweep(index, self.robot.area_m2 * share)
        yield from self.handle(robot_id, near_in[0], seconds, action, path)
        if action == CLEANING:
            self.washing.pop(robot_id, None)
            self.done += share
        yield from self.drive(robot_id, inner_out, near_out)
        if request:
            corridor.release(request)

    def corridor(self, index: int) -> simpy.Resource | None:
        aisle = self.layout.aisle(index)
        if aisle < 0:
            return None
        if aisle not in self.corridors:
            self.corridors[aisle] = simpy.Resource(self.env, capacity=self.layout.aisle_slots)
        return self.corridors[aisle]

    def drive(self, robot_id: int, metres: float, path: list[Point]):
        """Едем по куску пути. Нулевой кусок в лог не пишем."""
        if metres <= 0:
            return 0.0
        seconds = metres / self.robot.speed_m_s
        began = self.env.now
        self.doing(robot_id, MOVING, path)
        yield self.env.timeout(seconds)
        self.time_in[MOVING] += seconds
        self.battery_s[robot_id] -= seconds
        self.log(robot_id, MOVING, began, path)
        return seconds

    def serve(self, robot_id: int, point: Point):
        """Очередь к станции: человек отбирает позиции, робот ждет рядом. Станции одним пулом:
        робот встает к любой свободной, как если бы система раздавала задания по станциям ровно."""
        asked = self.env.now
        with self.stations.request() as slot:
            self.doing(robot_id, WAITING, [point])
            yield slot
            self.wait(robot_id, asked, point, STATION_QUEUE)
            began = self.env.now
            self.doing(robot_id, HANDLING, [point])
            yield self.env.timeout(self.layout.station_service_s)
            self.time_in[HANDLING] += self.layout.station_service_s
            self.log(robot_id, HANDLING, began, [point])

    def at_place_s(self) -> float:
        """Сколько робот стоит у места: у перевозки половина погрузки, у уборщика вся мойка."""
        if self.robot.refill_s is None:
            return self.robot.handling_s / 2
        return max(0.0, self.robot.handling_s - self.robot.refill_s)

    def handle(
        self, robot_id: int, point: Point, seconds: float, action: str = HANDLING, path: list[Point] | None = None
    ):
        """Стоячее действие у точки. Уборщик моет не стоя: path это его змейка по участку."""
        began = self.env.now
        self.doing(robot_id, action, path or [point])
        yield self.env.timeout(seconds)
        self.time_in[HANDLING] += seconds
        self.battery_s[robot_id] -= seconds
        self.log(robot_id, action, began, path or [point])

    def unload(self, robot_id: int, gate: int, point: Point):
        """У буфера мест столько, сколько у него ворот: если все заняты, робот ждет."""
        asked = self.env.now
        with self.gates[gate].request() as slot:
            self.doing(robot_id, WAITING, [point])
            yield slot
            self.wait(robot_id, asked, point, GATE_QUEUE)
            yield from self.handle(robot_id, point, self.robot.handling_s / 2)

    def charge(self, robot_id: int):
        """Зарядка: доехать по проездам, встать в очередь, если места заняты, зарядиться
        и вернуться туда, где робот стоял.

        Мест столько, сколько зарядок покупает экономика: парк, деленный на число роботов
        на одно место. Иначе прогон считал бы склад, за который никто не платил.
        """
        spot = self.where.get(robot_id, (0, self.layout.dock_point))[1]
        metres, path = self.layout.to_charge(spot)
        back_m, back = self.layout.to_charge(spot, back=True)
        yield from self.drive(robot_id, metres, path)
        point = path[-1]  # заряжается там, куда приехал, а не в первой клетке зоны
        asked = self.env.now
        with self.chargers.request() as place:
            self.doing(robot_id, WAITING, [point])
            yield place
            self.wait(robot_id, asked, point, CHARGE_QUEUE)
            seconds = self.robot.charge_time_h * 3600
            began = self.env.now
            self.doing(robot_id, CHARGING, [point])
            yield self.env.timeout(seconds)
            self.time_in[CHARGING] += seconds
            self.log(robot_id, CHARGING, began, [point])
        self.battery_s[robot_id] = self.robot.run_time_h * 3600
        if back[-1] != point:
            yield from self.drive(robot_id, _manhattan(point, back[-1]), inner_leg(point, back[-1]))
        yield from self.drive(robot_id, back_m, back[::-1])

    # --- учет -------------------------------------------------------------------

    def doing(self, robot_id: int, action: str, path: list[Point]) -> None:
        if self.record:
            self.now_doing[robot_id] = (action, self.env.now, path)

    def wait(self, robot_id: int, asked: float, point: Point, place: str) -> None:
        self.now_doing.pop(robot_id, None)
        waited = self.env.now - asked
        if waited > 0:
            self.time_in[WAITING] += waited
            self.waited_at[place] += waited
            self.wait_times.append(waited)
            self.log(robot_id, WAITING, asked, [point])

    def log(self, robot_id: int, action: str, from_s: float, path: list[Point]) -> None:
        if self.record:
            self.now_doing.pop(robot_id, None)
            self.segments.append(Segment(robot_id, from_s, self.env.now, action, path))

    def run(self) -> Result:
        self.env.process(self.generate())
        for robot_id in range(self.fleet):
            self.env.process(self.work(robot_id))
        self.env.run(until=self.hours * 3600)
        # недомытый к концу смены участок засчитываем в той доле, в какой он вымыт
        for share, began, seconds in self.washing.values():
            if seconds > 0:
                self.done += share * min(1.0, (self.env.now - began) / seconds)
        for robot_id, (action, began, path) in sorted(self.now_doing.items()):
            if action == CLEANING and robot_id in self.washing and len(path) > 1:
                # смена кончилась посреди мойки: змейка пройдена в той же доле, что и участок
                _, _, seconds = self.washing[robot_id]
                path = split(path, (self.env.now - began) / seconds if seconds > 0 else 1.0)[0]
            if path and began < self.env.now:
                self.segments.append(Segment(robot_id, began, self.env.now, action, path))
        return Result(kpi=self.kpi(), segments=self.segments, visits=self.visits)

    def kpi(self) -> Kpi:
        total = self.hours * 3600 * self.fleet
        shares = {name: seconds / total for name, seconds in self.time_in.items()}
        idle = 1 - sum(shares.values())
        return Kpi(
            done=self.done,
            ops_per_hour=self.done / self.hours,
            busy_share=shares[MOVING] + shares[HANDLING],
            waiting_share=shares[WAITING],
            charging_share=shares[CHARGING],
            avg_cycle_s=sum(self.cycle_times) / len(self.cycle_times) if self.cycle_times else 0.0,
            avg_wait_s=sum(self.wait_times) / len(self.wait_times) if self.wait_times else 0.0,
            bottleneck=self.bottleneck(shares, idle),
            waits={place: seconds / total for place, seconds in self.waited_at.items()},
        )

    def bottleneck(self, shares: dict[str, float], idle: float) -> str:
        """Очереди проверяем раньше простоя: роботы бывают и в очереди, и без заданий сразу,
        и тогда тесно все равно, просто не всегда. Иначе подпись в таком случае говорила бы
        "парк с запасом"."""
        if shares[WAITING] > 0.2:
            where = max(self.waited_at, key=self.waited_at.get)
            return f"очереди, больше всего у места «{where}»: роботы мешают друг другу"
        if shares[CHARGING] > 0.15:
            return "зарядка: роботы подолгу стоят в зоне зарядки"
        if idle > 0.3 and self.robot.refill_s is not None:
            # у уборки пика нет: парк взят под площадь смены, остаток времени это запас на простой и объем
            return "площадь смены вымыта: парк взят под площадь за смену, а не под пиковый час, остаток времени запас"
        if idle > 0.3:
            # доля словами из тех же цифр, что в итогах, а не всегда "треть"
            part = "большую часть" if idle > 0.6 else "половину" if idle > 0.42 else "треть"
            return f"парк взят под пик спроса: вне пика {part} времени роботы стоят без задания"
        return "узкого места нет, парк работает ровно"


def split(path: list[Point], share: float) -> tuple[list[Point], list[Point]]:
    """Режет ломаную на первую долю пути и остаток. Точка разреза входит в обе части.

    Режем по доле, а не по метрам: без сетки от пути остается прямая, и она короче настоящего.
    """
    if len(path) < 2 or share <= 0:
        return [path[0]], list(path)
    metres = share * sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(path, path[1:], strict=False))
    walked = 0.0
    for number, (a, b) in enumerate(zip(path, path[1:], strict=False)):
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if walked + length >= metres - 1e-9:
            share = (metres - walked) / length if length else 0.0
            cut = (a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share)
            return _distinct([*path[: number + 1], cut]), _distinct([cut, *path[number + 1 :]])
        walked += length
    return list(path), [path[-1]]


def _manhattan(a: Point, b: Point) -> float:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def _distinct(points: list[Point]) -> list[Point]:
    """Убирает точку, повторяющую соседнюю: разрез бывает ровно на повороте."""
    return [point for number, point in enumerate(points) if number == 0 or point != points[number - 1]]


def run_shift(
    layout: Layout,
    robot: RobotSpec,
    fleet: int,
    demand_per_hour: float | list[float],
    hours: float = 8,
    seed: int = 42,
    record: bool = True,
) -> Result:
    return Shift(layout, robot, fleet, demand_per_hour, hours, seed, record).run()


def demand_profile(average: float, peak_factor: float, peak_hours: int, day_hours: float, hours: float) -> list[float]:
    """Спрос по часам смены: peak_hours часов пика, остальные часы ровно, за сутки тот же объем.

    Пиковый коэффициент это отношение самого загруженного часа к среднему, его дает датасет.
    Сколько длится пик и когда он, не публикует никто, поэтому длина пика это допущение в конфиге.
    Пик ставим в середину моделируемой смены: смену мы и берем ту, где пик.

    Пример на складе датасета: 1900 паллет за 22 часа это 86,4 в час, пик 129,5. Два часа пика
    забирают 259 паллет, остальные 1641 делятся на 20 часов, это 82,1 в час.
    """
    peak = average * peak_factor
    off = max(0.0, (average * day_hours - peak * peak_hours) / max(1e-9, day_hours - peak_hours))
    count = math.ceil(hours)
    start = max(0, (count - peak_hours) // 2)
    return [peak if start <= hour < start + peak_hours else off for hour in range(count)]


def plenty(layout: Layout, robot: RobotSpec, fleet: int) -> float:
    """Спрос, которого парк заведомо не вытянет: кривая мерит потолок парка, а не поток заданий.

    Берем чистый цикл по среднему пути до цели, без очередей, и запас в полтора раза. Номинал
    робота не подходит: на коротком маршруте робот в прогоне делает больше номинала, и кривая
    упиралась бы в поток заданий, а не в склад.
    """
    field_m = layout.to_station_m if layout.with_stations else layout.to_dock_m
    reachable = [value for value in field_m if value < INF]
    mean = sum(reachable) / len(reachable) if reachable else 0.0
    cycle = 2 * mean / robot.speed_m_s + robot.handling_s
    return 1.5 * fleet * 3600 / max(cycle, 1.0)


FLAT_FROM = 20  # с какого парка ищем полку: на малом парке шум больше прироста
FLAT_GAIN = 0.02  # полка: два последних замера добавили меньше 2%


def throughput_curve(
    layout: Layout,
    robot: RobotSpec,
    max_fleet: int,
    demand_per_hour: float | list[float],
    hours: float = 8,
    seed: int = 42,
    every: int = 2,
    availability: float = 1.0,
    until: float | None = None,
) -> list[float]:
    """Сколько операций в час вытягивает парк из N роботов. Индекс это число роботов.

    Спрос задаем заведомо избыточным, чтобы измерить именно потолок парка, а не поток заданий.
    Кривая уходит в расчет экономики: evaluate(..., curve=curve).

    Готовность это доля исправных роботов: плановое ТО и мелкие простои выводят из строя роботов,
    а не людей на станциях. Поэтому парк из N роботов работает как N * готовность исправных,
    и кривая сдвигается по оси роботов, а не умножается целиком. Если умножить всю кривую,
    потолок станций комплектации, где работают люди, упадет на те же 10%: станций на спрос
    ровно хватает, а после умножения отбор не покрывается никаким парком.

    Гоняем смену не на каждом размере парка. До двадцати роботов через every, дальше шаг растет
    с парком, около десятой части: кривая там почти прямая, а каждый прогон дольше. Между
    замерами достраиваем линейно. Останавливаемся раньше max_fleet, если кривая дошла до until
    или вышла на полку: дальше считать незачем, а ТЗ дает на весь расчет шестьдесят секунд.
    Поэтому кривая бывает короче max_fleet + 1.
    """
    measured = {0: 0.0}
    fleet = 0
    while fleet < max_fleet:
        fleet = min(max_fleet, fleet + (1 if fleet == 0 else max(every, round(fleet / 10))))
        measured[fleet] = run_shift(layout, robot, fleet, demand_per_hour, hours, seed, record=False).kpi.ops_per_hour
        if until is not None and measured[fleet] >= until:
            break
        if _flat(measured):
            break
    points = sorted(measured)
    share = max(availability, 1e-9)
    # Округляем вверх: последний шаг с учетом готовности заходит чуть дальше замера, и там берем
    # последний замер. Это чуть меньше настоящего, то есть осторожнее, зато кривая доходит до спроса.
    length = min(max_fleet, math.ceil(points[-1] / share - 1e-9))
    return [_between(fleet * share, points, measured) for fleet in range(length + 1)]


# --- Поиск парка ------------------------------------------------------------------------
#
# Парку нужен не вся кривая, а одно число: самый маленький парк, который вытягивает спрос.
# Кривая подряд гоняет смену на каждом размере парка, и на отборе с сотней роботов это до минуты.
# Здесь прицел по секущей и подтверждение на нескольких seed. Способы сравнивали на стенде
# scripts/fleet_search_bench.py, итог в docs/simulation-check.md, раздел «Поиск парка».

Measure = Callable[[list[tuple[int, int]]], dict[tuple[int, int], float]]


@dataclass
class FleetSearch:
    """Итог поиска. working это исправных роботов, None значит, что спрос не вытянуть и полным
    парком. seen это все замеры: потолок смены при W исправных роботах на каждом seed."""

    working: int | None
    seen: dict[tuple[int, int], float]
    seeds: tuple[int, ...]

    def worst(self, working: int) -> float:
        """Худший из seed потолок при W исправных роботах: по нему и решаем, справился ли парк."""
        return min(self.seen[(working, seed)] for seed in self.seeds)

    def points(self) -> list[tuple[int, float]]:
        """Размеры парка, где потолок измерен на всех seed, с худшим значением: точки кривой."""
        done = sorted({w for w, _ in self.seen if all((w, seed) in self.seen for seed in self.seeds)})
        return [(0, 0.0)] + [(w, self.worst(w)) for w in done]


def search_fleet(measure: Measure, demand: float, top: int, guess: int, seeds: tuple[int, ...]) -> FleetSearch:
    """Самое маленькое число исправных роботов, при котором потолок смены не ниже спроса на
    каждом seed. На каждом, а не в среднем: парк, который справился все разы, мы показываем
    одним числом без оговорок.

    Сначала прицел по секущей на первом seed: до полки кривая почти прямая, и по двум замерам
    видно, где она пересечет спрос. Потом ответ подтверждаем на всех seed вместе с парком на
    единицу меньше: ответ справился, а на единицу меньше нет. Не подтвердился, шагаем в нужную
    сторону шагом, растущим вдвое, и делим вилку пополам. measure получает сразу пачку замеров:
    сервис может гонять их параллельно."""
    seen: dict[tuple[int, int], float] = {}

    def many(jobs: list[tuple[int, int]]) -> None:
        wanted = [job for job in dict.fromkeys(jobs) if job not in seen and job[0] > 0]
        if wanted:
            seen.update(measure(wanted))

    def covers(working: int) -> bool:
        if working <= 0:
            return False
        many([(working, seed) for seed in seeds])
        return all(seen[(working, seed)] + EPS >= demand for seed in seeds)

    def bisect_between(low: int, high: int) -> int:
        while high - low > 1:
            middle = (low + high) // 2
            if covers(middle):
                high = middle
            else:
                low = middle
        return high

    def result(working: int | None) -> FleetSearch:
        return FleetSearch(working, seen, seeds)

    first = seeds[0]
    points: list[tuple[int, float]] = [(0, 0.0)]
    working = min(top, max(1, guess))
    for _ in range(6):
        many([(working, first)])
        points.append((working, seen[(working, first)]))
        (w1, v1), (w2, v2) = sorted(points, key=lambda one: abs(one[1] - demand))[:2]
        if v1 == v2:
            break
        aim = min(top, max(1, math.ceil(w1 + (demand - v1) * (w2 - w1) / (v2 - v1) - EPS)))
        if aim == top and not covers(top):
            return result(None)  # полка: и полный парк не тянет спрос
        if any(aim == w for w, _ in points):
            working = aim
            break
        working = aim

    many([(working, seed) for seed in seeds] + [(working - 1, seed) for seed in seeds])
    if covers(working):
        if not covers(working - 1):
            return result(working)
        high, step = working - 1, 2
        while True:
            low = max(0, high - step)
            if not covers(low):
                return result(bisect_between(low, high))
            high, step = low, step * 2
    low, step = working, 1
    while True:
        high = min(top, low + step)
        if covers(high):
            return result(bisect_between(low, high))
        if high >= top:
            return result(None)
        low, step = high, step * 2


def search_curve(search: FleetSearch, availability: float, max_fleet: int) -> list[float]:
    """Кривая для расчета парка из замеров поиска. Индекс это парк, значение это худший потолок
    при исправных роботах парк * готовность, вниз до измеренного размера. Ступенькой, а не
    линией: так расчет возьмет ровно найденный парк, а не парк на робота меньше, который между
    замерами дотянулся бы до спроса только на бумаге."""
    points = search.points()
    sizes = [w for w, _ in points]
    values = dict(points)
    found = search.working
    length = max_fleet if found is None else min(max_fleet, math.ceil(found / availability - EPS))
    curve = []
    for fleet in range(length + 1):
        working = math.floor(fleet * availability + EPS)
        below = max(w for w in sizes if w <= working)
        curve.append(values[below])
    return curve


def _flat(measured: dict[int, float]) -> bool:
    points = sorted(measured)
    if len(points) < 4 or points[-1] < FLAT_FROM:
        return False
    top, before = measured[points[-1]], measured[points[-3]]
    return top > 0 and (top - before) / top < FLAT_GAIN


def _between(fleet: float, points: list[int], measured: dict[int, float]) -> float:
    """Значение кривой в любой точке, в том числе дробной: парк с учетом готовности бывает дробным."""
    if fleet in measured:
        return measured[fleet]
    left = max(point for point in points if point <= fleet)
    right = min((point for point in points if point >= fleet), default=left)
    if right == left:
        return measured[left]
    share = (fleet - left) / (right - left)
    return measured[left] + (measured[right] - measured[left]) * share
