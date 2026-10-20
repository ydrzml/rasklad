"""Маленький корпус для тестов: два этажа, коридор, аптека внизу, пост наверху, один лифт.

Этаж 20 x 10 м. Аптека и зарядка на первом, пост на втором, коридор посередине по y 4-6,
шахта лифта у северной стены. Числа времени взяты из config/clinic.yaml через сервис, чтобы
тесты проверяли модель с теми же числами, что и прогон в приложении.
"""

from __future__ import annotations

from app.engine.clinic.building import CHARGE, DOOR, LIFT, PHARMACY, ROOM, WARD, Building, Floor, Item, Lift
from app.engine.clinic.routes import RobotSize
from app.engine.clinic.shift import RobotSpec
from app.engine.plan import Section

ROBOT = RobotSize(need_mm=600, length_mm=540, width_mm=530, rides_lift=True)
SPEC = RobotSpec(speed_m_s=0.8, run_time_h=9, charge_time_h=4, size=ROBOT, reserve=0.2)


def floor(number: int, room: Item, door: Item, extra: list[Item] | None = None) -> Floor:
    items = [room, door, Item(f"f{number}-shaft", LIFT, 9, 7, 2, 3, name="Лифт", lift="L1"), *(extra or [])]
    return Floor(number, 20, 10, [Section(f"f{number}", 0, 0, 20, 10)], items)


def house(
    door_mm: float = 1200,
    automatic: bool = True,
    lift_robots: bool = True,
    cabin_mm: tuple[float, float] = (1500, 2700),
    people: float = 0.0,
) -> Building:
    first = floor(
        1,
        Item("pharmacy", ROOM, 0, 0, 6, 4, name="Аптека", role=PHARMACY),
        Item("pharmacy-door", DOOR, 2, 3, 1, 1, name="Дверь аптеки", width_mm=900),
        [Item("charge", CHARGE, 15, 1, 1, 1, name="Зарядка")],
    )
    second = floor(
        2,
        Item("post", ROOM, 14, 0, 6, 4, name="Пост", role=WARD),
        Item("post-door", DOOR, 16, 3, 1, 1, name="Дверь поста", width_mm=door_mm, automatic=automatic),
    )
    lift = Lift("L1", "Лифт", cabin_mm[0], cabin_mm[1], 1200, lift_robots, people)
    return Building([first, second], [lift], 3.3)
