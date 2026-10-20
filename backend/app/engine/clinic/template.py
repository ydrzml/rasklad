"""Типовой корпус для показа: четыре этажа, два лифта, аптека и склад на первом, посты на 2-4.

Это чертеж, а не данные: размеры помещений и место лифтов выбрали мы, как шаблоны склада
в config/layouts.yaml. Нормативные числа приходят параметрами из config/clinic.yaml: ширина
дверей по СП 158.13330, кабина лифта по паспорту. Человек правит корпус так же, как план склада.

Этаж 60 x 24 м: помещения по обе стороны коридора, лифтовой холл посередине северной стороны.
Коридор между стенами 2 клетки по сетке в метр, это ближе всего к 2,4 м по СП на нашей сетке.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.engine.clinic.building import (
    BLOCKED,
    CHARGE,
    CLEANING_BASE,
    DOOR,
    LIFT,
    OTHER,
    PHARMACY,
    ROOM,
    SUPPLIES,
    WARD,
    Building,
    Floor,
    Item,
    Lift,
)
from app.engine.plan import Section

WIDTH_M, LENGTH_M = 60.0, 24.0
SOUTH_Y, SOUTH_H = 0.0, 10.0  # помещения южной стороны
NORTH_Y = 12.0  # коридор 10-12, северные помещения от 12 до 24
SHAFT = (28.0, 12.0, 3.0, 3.0)  # первая шахта, вторая вплотную справа
SOUTH_X = (0.0, 10.0, 20.0, 30.0, 40.0, 50.0)
NORTH_X = ((0.0, 9.0), (9.0, 9.0), (18.0, 9.0), (35.0, 9.0), (44.0, 8.0), (52.0, 8.0))
FLOORS = 4


@dataclass(frozen=True)
class Doors:
    ward_mm: float
    office_mm: float
    lab_mm: float


@dataclass(frozen=True)
class Cabin:
    w_mm: float
    d_mm: float
    door_mm: float
    people_calls_per_hour: float


FIRST = [
    ("Приемное отделение", OTHER),
    ("Лаборатория", OTHER),
    ("Аптека", PHARMACY),
    ("Склад расходников", SUPPLIES),
    ("Кабинет", OTHER),
    ("Зарядная роботов", OTHER),
]
FIRST_NORTH = ["Регистратура", "Кабинет", "Кабинет", "Хозяйственная", "Кабинет", "Кабинет"]
DEPARTMENTS = {2: "Терапия", 3: "Хирургия", 4: "Кардиология"}


def building(doors: Doors, cabin: Cabin, floor_height_m: float) -> Building:
    floors = [_floor(number, doors) for number in range(1, FLOORS + 1)]
    lifts = [
        Lift("L1", "Больничный лифт 1", cabin.w_mm, cabin.d_mm, cabin.door_mm, True, cabin.people_calls_per_hour),
        # Датасет: управление лифтами "Да (частично)", поэтому второй лифт без интеграции
        Lift("L2", "Больничный лифт 2", cabin.w_mm, cabin.d_mm, cabin.door_mm, False, cabin.people_calls_per_hour),
    ]
    return Building(floors, lifts, floor_height_m)


def _floor(number: int, doors: Doors) -> Floor:
    items: list[Item] = []
    for index, x in enumerate(SOUTH_X):
        name, role = FIRST[index] if number == 1 else _upper_south(number, index)
        items += _room(f"f{number}-s{index}", name, role, x, SOUTH_Y, 10.0, SOUTH_H, "north", doors)
    for index, (x, w) in enumerate(NORTH_X):
        name, role = (FIRST_NORTH[index], OTHER) if number == 1 else _upper_north(number, index)
        items += _room(f"f{number}-n{index}", name, role, x, NORTH_Y, w, LENGTH_M - NORTH_Y, "south", doors)
    x, y, w, h = SHAFT
    items.append(Item(f"f{number}-L1", LIFT, x, y, w, h, name="Лифт 1", lift="L1"))
    items.append(Item(f"f{number}-L2", LIFT, x + w, y, w, h, name="Лифт 2", lift="L2"))
    # лифтовой холл: преграда за шахтами, чтобы холл не был сквозным
    items.append(Item(f"f{number}-hall", BLOCKED, x, y + h, 2 * w + 1, LENGTH_M - y - h, name="Лестница"))
    if number == 1:
        items.append(Item("f1-charge", CHARGE, 52.0, 3.0, 2.0, 2.0, name="Зарядки доставщиков"))
    # база уборщика этажа в хозяйственной комнате: у Клинботикс док-станция в комплекте
    utility = next(item for item in items if item.kind == ROOM and item.name == "Хозяйственная")
    items.append(
        Item(
            f"f{number}-base", CHARGE, utility.x + 2, utility.y + 6, 2.0, 2.0, name="База уборщика", role=CLEANING_BASE
        )
    )
    return Floor(number, WIDTH_M, LENGTH_M, [Section(f"f{number}", 0.0, 0.0, WIDTH_M, LENGTH_M)], items)


def _upper_south(number: int, index: int) -> tuple[str, str]:
    department = DEPARTMENTS[number]
    if index in (1, 4):
        return f"{department}, пост {number}.{1 if index == 1 else 2}", WARD
    return "Палата", OTHER


def _upper_north(number: int, index: int) -> tuple[str, str]:
    if index == 3:
        return "Хозяйственная", OTHER
    if index == 1:
        return f"Процедурная, пост {number}.3", WARD
    return "Палата", OTHER


def _room(
    room_id: str, name: str, role: str, x: float, y: float, w: float, h: float, side: str, doors: Doors
) -> list[Item]:
    """Помещение и его дверь посередине стены, что выходит в коридор."""
    width_mm = doors.ward_mm if role == WARD or name == "Палата" else doors.office_mm
    if name == "Лаборатория":
        width_mm = doors.lab_mm
    span = max(1.0, width_mm / 1000)
    door_y = y + h - 1 if side == "north" else y
    door = Item(
        f"{room_id}-door",
        DOOR,
        x + w / 2 - span / 2,
        door_y,
        span,
        1.0,
        name=f"Дверь: {name}",
        width_mm=width_mm,
        # хозяйственную открывают руками: у робота-уборщика нет привода дверей
        automatic=name != "Хозяйственная",
    )
    return [Item(room_id, ROOM, x, y, w, h, name=name, role=role), door]
