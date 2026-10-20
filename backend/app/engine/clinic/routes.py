"""Пути по корпусу: по этажу волной по сетке, между этажами на лифте.

Волна та же, что у склада (app.engine.plan.distances и trace): обход по клеткам в метр, стены
помещений и шахты непроезжие. Поле расстояний считаем один раз на точку (точку передачи
помещения, посадку в лифт, зарядку) и берем из кэша: за смену робот ездит между одними и теми же
точками десятки раз.

Путь между этажами: от точки до посадки в лифт, лифт, от посадки на другом этаже до точки.
Лифт выбираем тот, где выходит короче по метрам: ожидание кабины заранее не знаем.
Робот едет на лифте, только если у лифта есть интеграция, кабина вмещает робота и двери кабины
шире прохода, нужного роботу. Иначе межэтажный путь закрыт, и заявка остается невыполненной
с причиной.
"""

from __future__ import annotations

import heapq
import itertools
from dataclasses import dataclass, field

from app.engine import plan as plan_module
from app.engine.clinic.building import Building, Cell, FloorMap, Item, Point, floor_map
from app.engine.plan import INF

LIFT_MARGIN_MM = 200  # по 100 мм с каждой стороны робота в кабине: правило, а не данные


@dataclass(frozen=True)
class Anchor:
    floor: int
    cell: Cell


@dataclass
class Leg:
    """Кусок пути по одному этажу: метры, ломаная и двери, которые на нем проходит робот."""

    floor: int
    metres: float
    path: list[Point]
    doors: list[tuple[float, Item]] = field(default_factory=list)  # через сколько метров дверь и какая


@dataclass
class Ride:
    lift: str
    from_floor: int
    to_floor: int


Step = Leg | Ride


@dataclass(frozen=True)
class RobotSize:
    """Что важно о роботе для пути: проход и габарит в плане, едет ли он на лифте."""

    need_mm: float  # проход, нужный роботу: с ним сравниваем двери
    length_mm: float
    width_mm: float
    rides_lift: bool


class Navigator:
    def __init__(self, building: Building, robot: RobotSize):
        self.building = building
        self.robot = robot
        self.maps: dict[int, FloorMap] = {floor.number: floor_map(floor, robot.need_mm) for floor in building.floors}
        self.fields: dict[Anchor, list[float]] = {}
        self.cache: dict[tuple[Anchor, Anchor], list[Step] | None] = {}

    # --- точки -------------------------------------------------------------------

    def spot(self, floor: int, room_id: str) -> Anchor | None:
        cell = self.maps[floor].spots.get(room_id) if floor in self.maps else None
        return Anchor(floor, cell) if cell else None

    def landing(self, floor: int, lift_id: str) -> Anchor | None:
        cell = self.maps[floor].landings.get(lift_id) if floor in self.maps else None
        return Anchor(floor, cell) if cell else None

    def point(self, anchor: Anchor) -> Point:
        return self.maps[anchor.floor].grid.point(*anchor.cell)

    def usable(self, lift_id: str) -> bool:
        """Повезет ли этот лифт этого робота: интеграция, кабина, двери кабины."""
        lift = self.building.lift(lift_id)
        if lift is None or not self.robot.rides_lift or not lift.robots:
            return False
        across, along = sorted((lift.cabin_w_mm, lift.cabin_d_mm))
        small, big = sorted((self.robot.width_mm, self.robot.length_mm))
        fits = small + LIFT_MARGIN_MM <= across and big + LIFT_MARGIN_MM <= along
        return fits and lift.door_mm >= self.robot.need_mm

    # --- пути --------------------------------------------------------------------

    def metres(self, start: Anchor, finish: Anchor) -> float:
        """По этажу: сколько ехать. INF, если не доехать или точки на разных этажах."""
        if start.floor != finish.floor:
            return INF
        grid = self.maps[start.floor].grid
        return self.field(finish)[start.cell[1] * grid.cols + start.cell[0]]

    def field(self, anchor: Anchor) -> list[float]:
        if anchor not in self.fields:
            self.fields[anchor] = plan_module.distances(self.maps[anchor.floor].grid, [anchor.cell])
        return self.fields[anchor]

    def route(self, start: Anchor, finish: Anchor) -> list[Step] | None:
        """Путь от точки до точки, по этажам и лифтам. None: не доехать."""
        key = (start, finish)
        if key not in self.cache:
            self.cache[key] = self._route(start, finish)
        return self.cache[key]

    def _route(self, start: Anchor, finish: Anchor) -> list[Step] | None:
        if start == finish:
            return []
        if start.floor == finish.floor:
            leg = self.leg(start, finish)
            return [leg] if leg else self._transfer_route(start, finish)
        best: tuple[float, list[Step]] | None = None
        for lift in self.building.lifts:
            if not self.usable(lift.id):
                continue
            up, down = self.landing(start.floor, lift.id), self.landing(finish.floor, lift.id)
            if up is None or down is None:
                continue
            first, last = self.leg(start, up), self.leg(down, finish)
            if first is None or last is None:
                continue
            total = first.metres + last.metres
            if best is None or total < best[0]:
                best = (total, [first, Ride(lift.id, start.floor, finish.floor), last])
        return best[1] if best else self._transfer_route(start, finish)

    def _transfer_route(self, start: Anchor, finish: Anchor) -> list[Step] | None:
        """Зональные лифты: пересадка через доступный холл промежуточного этажа.

        Прямые пути сохраняют прежнее правило. Запасной путь минимизирует число
        поездок, затем пеший/наземный путь и вертикальный ход; ожидание неизвестно.
        """
        landings: dict[str, list[Anchor]] = {}
        for lift in self.building.lifts:
            if self.usable(lift.id):
                landings[lift.id] = [
                    anchor
                    for floor in self.building.stops(lift.id)
                    if (anchor := self.landing(floor, lift.id)) is not None
                ]
        nodes = set(anchor for stops in landings.values() for anchor in stops) | {finish}
        if len(nodes) <= 1:
            return None
        by_floor: dict[int, list[Anchor]] = {}
        for node in sorted(nodes, key=lambda a: (a.floor, a.cell)):
            by_floor.setdefault(node.floor, []).append(node)
        lifts_at: dict[Anchor, list[str]] = {}
        for lift, stops in landings.items():
            for anchor in stops:
                lifts_at.setdefault(anchor, []).append(lift)
        distances = {start: (0, 0.0, 0)}
        previous: dict[Anchor, tuple[Anchor, Ride | None]] = {}
        serial = itertools.count()
        queue = [(0, 0.0, 0, next(serial), start)]
        while queue:
            rides, metres, vertical, _, node = heapq.heappop(queue)
            cost = (rides, metres, vertical)
            if distances.get(node) != cost:
                continue
            if node == finish:
                steps = []
                while node != start:
                    before, ride = previous[node]
                    steps.append(ride if ride is not None else self.leg(before, node))
                    node = before
                return list(reversed(steps))
            edges = []
            for target in by_floor.get(node.floor, []):
                if target != node and (walk := self.metres(node, target)) < INF:
                    edges.append((target, (rides, metres + walk, vertical), None))
            for lift in lifts_at.get(node, []):
                for target in landings[lift]:
                    if target.floor != node.floor:
                        edges.append(
                            (
                                target,
                                (rides + 1, metres, vertical + abs(target.floor - node.floor)),
                                Ride(lift, node.floor, target.floor),
                            )
                        )
            for target, total, ride in edges:
                if total < distances.get(target, (INF, INF, INF)):
                    distances[target] = total
                    previous[target] = (node, ride)
                    heapq.heappush(queue, (*total, next(serial), target))
        return None

    def leg(self, start: Anchor, finish: Anchor) -> Leg | None:
        metres = self.metres(start, finish)
        if metres == INF:
            return None
        grid = self.maps[start.floor].grid
        path = plan_module.trace(grid, self.field(finish), start.cell)
        return Leg(start.floor, metres, path, crossings(path, self.maps[start.floor].doors, grid))


class StaffNavigator(Navigator):
    """Ручной маршрут не зависит от выбранного робота и его интеграции с лифтом.

    Проходимость задается отдельным допущением о габарите человека с тележкой.
    """

    def __init__(self, building: Building, clearance_mm: float):
        super().__init__(building, RobotSize(clearance_mm, clearance_mm, clearance_mm, True))

    def usable(self, lift_id: str) -> bool:
        lift = self.building.lift(lift_id)
        need = self.robot.need_mm
        return bool(lift and lift.door_mm >= need and min(lift.cabin_w_mm, lift.cabin_d_mm) >= need + LIFT_MARGIN_MM)


def crossings(path: list[Point], doors: list[Item], grid=None) -> list[tuple[float, Item]]:
    """Какие двери пересекает ломаная и через сколько метров от начала.

    Ломаная по клеткам состоит из отрезков вдоль осей, поэтому достаточно проверить,
    проходит ли отрезок через прямоугольник двери. Метры считаем до середины двери на отрезке. Если сетка есть, дверь это клетки, которые она
    вырезала в стене: проем 0,9 м с краем не на целом метре иначе не накрыл бы центр своей клетки.
    """
    if grid is not None:
        doors = [_carved(door, grid) for door in doors]
    found: list[tuple[float, Item]] = []
    walked = 0.0
    for a, b in zip(path, path[1:], strict=False):
        length = abs(b[0] - a[0]) + abs(b[1] - a[1])
        for door in doors:
            if any(door is item for _, item in found):
                continue
            at = _through(a, b, door)
            if at is not None:
                found.append((walked + at, getattr(door, "source", door)))
        walked += length
    return sorted(found, key=lambda pair: pair[0])


def _carved(door: Item, grid) -> Item:
    """Дверь по клеткам сетки: рамка вокруг клеток, которые она вырезала."""
    cells = grid.cells_of(plan_module.Item(door.id, door.kind, door.x, door.y, door.w, door.h))
    cols, rows = [c for c, _ in cells], [r for _, r in cells]
    step = grid.step_m
    carved = Item(
        door.id,
        door.kind,
        min(cols) * step,
        min(rows) * step,
        (max(cols) - min(cols) + 1) * step,
        (max(rows) - min(rows) + 1) * step,
        door.name,
        door.role,
        door.width_mm,
        door.automatic,
    )
    carved.source = door  # type: ignore[attr-defined]
    return carved


def _through(a: Point, b: Point, door: Item) -> float | None:
    """Через сколько метров от a отрезок a-b входит в середину двери. None: не проходит."""
    left, right, low, high = door.x, door.x + door.w, door.y, door.y + door.h
    if a[1] == b[1]:  # вдоль x
        if not low <= a[1] <= high:
            return None
        lo, hi = sorted((a[0], b[0]))
        middle = (max(lo, left) + min(hi, right)) / 2
        return abs(middle - a[0]) if max(lo, left) <= min(hi, right) else None
    if not left <= a[0] <= right:
        return None
    lo, hi = sorted((a[1], b[1]))
    middle = (max(lo, low) + min(hi, high)) / 2
    return abs(middle - a[1]) if max(lo, low) <= min(hi, high) else None


def flight_s(distance_m: float, speed_m_s: float, acceleration_m_s2: float) -> float:
    """Сколько кабина едет distance_m: разгон, ход на скорости, торможение.

    Если до скорости не разогнаться, едет треугольником: половину пути разгоняется,
    половину тормозит. Рывок не считаем: на этажах больницы он дает доли секунды.
    """
    if distance_m <= 0:
        return 0.0
    ramp_m = speed_m_s**2 / acceleration_m_s2  # разгон и торможение вместе
    if distance_m >= ramp_m:
        return distance_m / speed_m_s + speed_m_s / acceleration_m_s2
    return 2 * (distance_m / acceleration_m_s2) ** 0.5
