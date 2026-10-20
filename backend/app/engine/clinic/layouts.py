"""Генератор редактируемых корпусов: геометрия, без норм и экономических коэффициентов."""

from __future__ import annotations

import math

from app.engine.clinic.building import (
    CHARGE,
    CLEANING_BASE,
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
from app.engine.clinic.template import Cabin, Doors, _room
from app.engine.plan import Section


def generate(
    width: int,
    length: int,
    floors: int,
    wards: int,
    lift_count: int,
    furnished: bool,
    floor_height: float,
    doors: Doors,
    cabin: Cabin,
    layout: str = "linear",
) -> Building:
    result = Building([], [], floor_height)
    if furnished and floors > 1:
        result.lifts = [
            Lift(
                f"L{i + 1}",
                f"Больничный лифт {i + 1}",
                cabin.w_mm,
                cabin.d_mm,
                cabin.door_mm,
                True,
                cabin.people_calls_per_hour,
            )
            for i in range(lift_count)
        ]
    reference_length, reference_wards = length, wards
    for number in range(1, floors + 1):
        if furnished and layout == "mixed":
            length = max(18, 8 + 3 * lift_count if lift_count > 2 else 18, reference_length - 4 * ((number - 1) % 3))
            wards = max(1, reference_wards - (number - 1) % 2)
        floor = Floor(number, width, length, [Section(f"f{number}", 0, 0, width, length)], [])
        result.floors.append(floor)
        if not furnished:
            continue
        # Восточные 8 м оставляем под шахты и холл. Между помещениями: коридор 4 м.
        south_h = (length - 4) // 2
        north_y = south_h + 4
        columns = max(4, math.ceil((wards + 4) / 2))
        edges = [math.floor(i * (width - 8) / columns) for i in range(columns + 1)]
        left = wards
        for north in (False, True):
            for column in range(columns):
                role, name = OTHER, "Кабинет"
                utility = north and column == 0
                charging = not north and column == 2 and number == 1
                if utility:
                    name = "Хозяйственная"
                elif number == 1 and not north and column < 2:
                    role, name = (PHARMACY, "Аптека") if column == 0 else (SUPPLIES, "Склад расходников")
                elif charging:
                    name = "Зарядная"
                elif left:
                    role, name = WARD, f"Пост {number}.{wards - left + 1}"
                    left -= 1
                x, w = edges[column], edges[column + 1] - edges[column]
                y, h = (north_y, length - north_y) if north else (0, south_h)
                room_id = f"f{number}-{'n' if north else 's'}{column}"
                floor.items += _room(room_id, name, role, x, y, w, h, "south" if north else "north", doors)
                if utility or charging:
                    floor.items.append(
                        Item(
                            f"{room_id}-base",
                            CHARGE,
                            x + 1,
                            y + 2,
                            min(2, w - 2),
                            2,
                            name="База уборщика" if utility else "Зарядка доставщиков",
                            role=CLEANING_BASE if utility else "",
                        )
                    )
        for index, lift in enumerate(result.lifts):
            # Два лифта сохраняют прежнее место. Большая группа занимает восточную полосу.
            shaft_x = width - 7 + index * 3 if lift_count <= 2 else width - 4
            shaft_y = (2 if layout == "mixed" else north_y) if lift_count <= 2 else 2 + index * 3
            floor.items.append(Item(f"f{number}-{lift.id}", LIFT, shaft_x, shaft_y, 3, 3, name=lift.name, lift=lift.id))
        assert sum(item.kind == ROOM and item.role == WARD for item in floor.items) == wards
    return result
