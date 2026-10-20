"""Корпус медучреждения: этажи, помещения, двери, лифты, и этаж, разложенный по сетке.

Этаж собран из того же, из чего план склада: участок, секции пола (app.engine.plan.Section) и вещи-
прямоугольники. Вещи у этажа свои:
    room     помещение со стенами по краю, роль говорит, что в нем: аптека, склад, отделение
    door     проем в стене помещения или в коридоре, ширина в мм, автоматическая или ручная
    lift     шахта лифта на этом этаже, lift это id лифта, одна шахта на все этажи, где он стоит
    charge   зарядка, как у склада
    blocked  преграда, как у склада

Коридор это пол вне помещений: его не рисуют отдельно. Стена помещения занимает клетку по краю
прямоугольника, дверь вырезает в ней проход. Если дверь уже, чем нужно роботу, проход для него
не вырезаем: в такое помещение робот не попадет, и проверка плана об этом скажет.

Здесь только расчет: ни файлов, ни базы.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.engine import plan as plan_module
from app.engine.plan import FREE, WALL_CELL, Grid, Plan, Section

ROOM, DOOR, LIFT, CHARGE, BLOCKED = "room", "door", "lift", "charge", "blocked"
KINDS = (ROOM, DOOR, LIFT, CHARGE, BLOCKED)
# Роли помещений: откуда возят (аптека, склад расходников), куда возят (отделение, пост)
PHARMACY, SUPPLIES, WARD, OTHER = "pharmacy", "supplies", "ward", "other"
ROLES = (PHARMACY, SUPPLIES, WARD, OTHER)
CLEANING_BASE = "cleaning"  # роль зарядки: база уборщика этажа, доставщики на ней не заряжаются

Cell = tuple[int, int]
Point = tuple[float, float]


@dataclass
class Item:
    id: str
    kind: str
    x: float
    y: float
    w: float
    h: float
    name: str = ""
    role: str = ""  # room: что в помещении; charge: cleaning, если это база уборщика
    width_mm: float = 0.0  # door: ширина проема
    automatic: bool = True  # door: открывается сама или ее открывает человек
    lift: str = ""  # lift: какой лифт стоит в этой шахте

    @property
    def center(self) -> Point:
        return (self.x + self.w / 2, self.y + self.h / 2)


@dataclass
class Floor:
    number: int
    width_m: float
    length_m: float
    sections: list[Section] = field(default_factory=list)
    items: list[Item] = field(default_factory=list)

    def of(self, kind: str) -> list[Item]:
        return [item for item in self.items if item.kind == kind]

    def rooms(self, role: str | None = None) -> list[Item]:
        return [item for item in self.of(ROOM) if role is None or item.role == role]


@dataclass
class Lift:
    """Лифт целиком: кабина и двери. На каких этажах он стоит, говорят шахты на этажах."""

    id: str
    name: str
    cabin_w_mm: float
    cabin_d_mm: float
    door_mm: float
    robots: bool = True  # интеграция с лифтом есть: робот вызывает его сам
    people_calls_per_hour: float = 0.0


@dataclass
class Building:
    floors: list[Floor]
    lifts: list[Lift]
    floor_height_m: float
    scenario: dict = field(default_factory=dict)

    def floor(self, number: int) -> Floor | None:
        return next((floor for floor in self.floors if floor.number == number), None)

    def lift(self, lift_id: str) -> Lift | None:
        return next((lift for lift in self.lifts if lift.id == lift_id), None)

    def stops(self, lift_id: str) -> list[int]:
        """Этажи, на которых у лифта есть шахта, снизу вверх."""
        return sorted(floor.number for floor in self.floors if any(i.lift == lift_id for i in floor.of(LIFT)))


@dataclass
class FloorMap:
    """Этаж на сетке: где можно ехать, где у помещений точки передачи, где посадка в лифт."""

    floor: int
    grid: Grid
    spots: dict[str, Cell]  # помещение -> клетка внутри, где робот отдает или берет груз
    landings: dict[str, Cell]  # лифт -> клетка перед шахтой
    chargers: list[tuple[Item, Cell]]  # зарядка и клетка, где робот на ней стоит
    doors: list[Item]  # двери, через которые этот робот проходит
    inside: set[int]  # клетки внутри помещений: их уборщик коридоров не моет
    corridor_area_m2: float  # физическое задание не уменьшается из-за ширины выбранного робота

    def corridor(self) -> Grid:
        """Сетка только коридоров: помещения закрыты. По ней уборщик моет змейкой."""
        cells = bytearray(self.grid.cells)
        for index in self.inside:
            cells[index] = WALL_CELL
        return Grid(self.grid.step_m, self.grid.cols, self.grid.rows, cells, self.grid.level, self.grid.levels)

    def corridor_cells(self) -> list[int]:
        return [i for i, value in enumerate(self.grid.cells) if value == FREE and i not in self.inside]


def floor_map(floor: Floor, need_mm: float = 0.0) -> FloorMap:
    """Раскладываем этаж по сетке. need_mm: сколько нужно роботу в проеме; уже не проедет."""
    plan = Plan(
        width_m=floor.width_m,
        length_m=floor.length_m,
        template="clinic",
        items=[
            plan_module.Item(item.id, plan_module.BLOCKED, item.x, item.y, item.w, item.h)
            for item in floor.items
            if item.kind in (BLOCKED, LIFT)
        ],
        edited=True,
        sections=floor.sections,
    )
    grid = plan_module.rasterize(plan, {})
    inside: set[int] = set()
    for room in floor.of(ROOM):
        for col, row in _edge(grid, room):
            if grid.inside(col, row):
                grid.cells[row * grid.cols + col] = WALL_CELL
        inside.update(row * grid.cols + col for col, row in _interior(grid, room))
    physical = {i for i, value in enumerate(grid.cells) if value == FREE and i not in inside}
    for door in floor.of(DOOR):
        for col, row in grid.cells_of(_as_plan_item(door)):
            index = row * grid.cols + col
            if grid.floor(col, row) and index not in inside and not _under(floor, col, row, grid):
                physical.add(index)
    passable = [door for door in floor.of(DOOR) if door.width_mm >= need_mm]
    for door in passable:
        for col, row in grid.cells_of(_as_plan_item(door)):
            if grid.floor(col, row) and not _under(floor, col, row, grid):
                grid.cells[row * grid.cols + col] = FREE
    spots = {room.id: cell for room in floor.of(ROOM) if (cell := _spot(grid, room)) is not None}
    corridor_areas = _corridor_areas(grid, inside)
    landings = {
        shaft.lift: cell
        for shaft in floor.of(LIFT)
        if (cell := _landing(grid, shaft, inside, corridor_areas)) is not None
    }
    chargers = [
        (item, cell)
        for item in floor.of(CHARGE)
        if (cell := next((c for c in grid.cells_of(_as_plan_item(item)) if grid.free(*c)), None)) is not None
    ]
    return FloorMap(floor.number, grid, spots, landings, chargers, passable, inside, float(len(physical)))


def _as_plan_item(item: Item) -> plan_module.Item:
    return plan_module.Item(item.id, item.kind, item.x, item.y, item.w, item.h)


def _cells(grid: Grid, item: Item) -> list[Cell]:
    return grid.cells_of(_as_plan_item(item))


def _edge(grid: Grid, room: Item) -> list[Cell]:
    cells = _cells(grid, room)
    cols = [c for c, _ in cells]
    rows = [r for _, r in cells]
    left, right, low, high = min(cols), max(cols), min(rows), max(rows)
    return [(c, r) for c, r in cells if c in (left, right) or r in (low, high)]


def _interior(grid: Grid, room: Item) -> list[Cell]:
    edge = set(_edge(grid, room))
    return [cell for cell in _cells(grid, room) if cell not in edge]


def _under(floor: Floor, col: int, row: int, grid: Grid) -> bool:
    """Клетка под шахтой или преградой: дверь ее не открывает."""
    x, y = grid.point(col, row)
    return any(
        item.x <= x < item.x + item.w and item.y <= y < item.y + item.h
        for item in floor.items
        if item.kind in (BLOCKED, LIFT)
    )


def _spot(grid: Grid, room: Item) -> Cell | None:
    """Точка передачи: свободная клетка внутри помещения, ближняя к его центру."""
    cells = [cell for cell in _interior(grid, room) if grid.free(*cell)]
    if not cells:
        return None
    cx, cy = room.center
    return min(cells, key=lambda c: (abs(grid.point(*c)[0] - cx) + abs(grid.point(*c)[1] - cy), c))


def _corridor_areas(grid: Grid, inside: set[int]) -> list[int]:
    """Размер связного коридора для каждой клетки, без прохода через помещения."""
    areas = [0] * len(grid.cells)
    for index, value in enumerate(grid.cells):
        if value != FREE or index in inside or areas[index]:
            continue
        component = [index]
        areas[index] = -1
        for current in component:
            col, row = current % grid.cols, current // grid.cols
            for dc, dr in plan_module.NEIGHBOURS:
                c, r = col + dc, row + dr
                neighbour = r * grid.cols + c
                if grid.free(c, r) and neighbour not in inside and areas[neighbour] == 0:
                    areas[neighbour] = -1
                    component.append(neighbour)
        for current in component:
            areas[current] = len(component)
    return areas


def _landing(grid: Grid, shaft: Item, inside: set[int], corridor_areas: list[int]) -> Cell | None:
    """Посадка со стороны основного холла, затем ближе к середине шахты.

    Сторона двери в плане пока не задана. Ближайшая клетка сама по себе может
    оказаться в изолированном кармане за шахтой. Не объявляем весь этаж
    недоступным из-за такого выбора и не соединяем разные стороны через шахту.
    """
    cells = set(_cells(grid, shaft))
    around = {
        (c + dc, r + dr)
        for c, r in cells
        for dc, dr in plan_module.NEIGHBOURS
        if (c + dc, r + dr) not in cells and grid.free(c + dc, r + dr) and (r + dr) * grid.cols + c + dc not in inside
    }
    if not around:
        return None
    cx, cy = shaft.center
    return min(
        around,
        key=lambda c: (
            -corridor_areas[c[1] * grid.cols + c[0]],
            abs(grid.point(*c)[0] - cx) + abs(grid.point(*c)[1] - cy),
            c,
        ),
    )
