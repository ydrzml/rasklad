"""Проверка плана корпуса: можно ли по нему считать смену и что поправить.

Ошибка (error) значит считать нельзя: нет аптеки, некуда возить, нет зарядки, помещение без входа.
Предупреждение (warning) значит считать можно, но часть заявок не выполнить или выполнить
медленно: дверь уже прохода робота, лифт без интеграции, этаж без лифта, ручные двери.
Сведения (info) говорят, сколько точек доступно роботу.

Список проверок по наработкам Аркера, тексты и правила под наш план и наш каталог.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from functools import cache

from app.engine import plan as plan_module
from app.engine.clinic import processes
from app.engine.clinic.building import (
    CHARGE,
    CLEANING_BASE,
    DOOR,
    LIFT,
    PHARMACY,
    ROOM,
    SUPPLIES,
    WARD,
    Building,
    Floor,
    Item,
)
from app.engine.clinic.routes import Anchor, Navigator, RobotSize

ERROR, WARNING, INFO = "error", "warning", "info"
MIN_ROOM_M = 3.0  # меньше трех клеток стена съедает все помещение: правило сетки, а не данные
REACH = "Робот доезжает до {} постов из {}"


@dataclass
class Check:
    level: str
    code: str
    text: str
    floor: int | None = None
    target: str = ""


def check(
    building: Building, robot: RobotSize | None = None, cleaning: bool = False, delivery: bool = True
) -> list[Check]:
    found: list[Check] = []
    for floor in building.floors:
        found += _floor(floor)
    found += _lifts(building)
    found += _required(building, cleaning, delivery)
    if delivery and robot is not None and not any(c.level == ERROR for c in found):
        found += _robot(building, robot)
    return found


def check_cleaner(building: Building, robot: RobotSize) -> list[Check]:
    """Проверяем выход с базы уборщика по его ширине, отдельно от доставщика.

    Не выезжает ни на одном этаже: это ошибка, считать уборку этим роботом незачем, она будет
    нулевой. Не выезжает на части этажей: предупреждение, остальные этажи робот моет.
    """
    nav = Navigator(building, robot)

    out = []
    blocked: list[Check] = []
    with_bases = 0
    for floor in building.floors:
        fmap = nav.maps[floor.number]
        bases = [(item, cell) for item, cell in fmap.chargers if item.role == CLEANING_BASE]
        corridor = set(fmap.corridor_cells())
        if bases and corridor:
            with_bases += 1
        reached = set()
        for _, cell in bases:
            distances = plan_module.distances(fmap.grid, [cell])
            reached.update(index for index in corridor if distances[index] < float("inf"))
        if bases and corridor and not reached:
            blocked.append(
                Check(
                    WARNING, "cleaning_blocked", _blocked_text(floor, bases[0][0], robot), floor.number, bases[0][0].id
                )
            )
        elif reached and len(reached) < len(corridor):
            out.append(
                Check(
                    WARNING,
                    "cleaning_unreachable",
                    f"Уборщику недоступно {len(corridor) - len(reached)} м² коридора",
                    floor.number,
                )
            )
    if blocked and len(blocked) == with_bases:
        blocked = [replace(one, level=ERROR) for one in blocked]
    return blocked + out


def cleaner_unfit(building: Building, robot: RobotSize) -> str | None:
    """Почему уборщик на этом корпусе не работает совсем, или None. Для шага решений, без прогона."""
    errors = [one for one in check_cleaner(building, robot) if one.level == ERROR]
    if not errors:
        return None
    return f"Не выезжает с базы ни на одном этаже. {errors[0].text}"


def delivery_unfit(building: Building, robot: RobotSize) -> str | None:
    """Почему доставщик на этом корпусе не довезет ни одной заявки, или None."""
    found = check(building, robot, delivery=True)
    if any(one.level == ERROR for one in found):
        return None  # ошибки плана общие для всех роботов, их показывает проверка корпуса
    wards = [one for one in found if one.code == "ward_unreachable"]
    reach = next((one for one in found if one.code == "reach"), None)
    if not wards or reach is None or reach.text != REACH.format(0, len(wards)):
        return None
    detail = wards[0].text.split(": ", 1)[-1]
    return f"Не доезжает ни до одного поста. {detail[:1].upper()}{detail[1:]}"


def _blocked_text(floor: Floor, base: Item, robot: RobotSize) -> str:
    """Почему с базы не выехать: дверь помещения базы уже прохода робота, или преграды."""
    rooms = [room for room in floor.of(ROOM) if _overlap(base, room)]
    doors = [door for room in rooms for door in floor.of(DOOR) if _on_wall(door, room)]
    narrow = min((door.width_mm for door in doors), default=None)
    if narrow is not None and narrow < robot.need_mm:
        return (
            f"Уборщику нужен проезд {robot.need_mm:.0f} мм, а дверь помещения базы {narrow:.0f} мм: "
            f"в коридор не выехать. Поставьте базу в коридор или в помещение с проемом от {robot.need_mm:.0f} мм"
        )
    return "Уборщик не может выехать с базы в коридор: проверьте ширину двери и преграды"


def _floor(floor: Floor) -> list[Check]:
    out: list[Check] = []
    rooms = floor.of(ROOM)
    for item in floor.items:
        if item.x < 0 or item.y < 0 or item.x + item.w > floor.width_m or item.y + item.h > floor.length_m:
            out.append(Check(ERROR, "outside", f"{_name(item)} выходит за этаж", floor.number, item.id))
    for index, room in enumerate(rooms):
        if min(room.w, room.h) < MIN_ROOM_M:
            out.append(
                Check(
                    ERROR,
                    "room_small",
                    f"{_name(room)}: помещение уже 3 м, на сетке в метр в нем нет места",
                    floor.number,
                    room.id,
                )
            )
        for other in rooms[index + 1 :]:
            if _overlap(room, other):
                out.append(
                    Check(
                        ERROR,
                        "rooms_overlap",
                        f'{_name(room)} пересекается с помещением "{other.name}"',
                        floor.number,
                        room.id,
                    )
                )
        if not any(_on_wall(door, room) for door in floor.of(DOOR)):
            out.append(
                Check(ERROR, "no_door", f"{_name(room)}: нет двери, в помещение не войти", floor.number, room.id)
            )
    doors = floor.of(DOOR)
    for door in doors:
        if any(
            other.id != door.id
            and min(door.x + door.w, other.x + other.w) - max(door.x, other.x) > 1e-6
            and min(door.y + door.h, other.y + other.h) - max(door.y, other.y) > 1e-6
            for other in doors
        ):
            out.append(
                Check(
                    ERROR,
                    "doors_overlap",
                    f"{_name(door)}: проем пересекается с другой дверью. Передвиньте или удалите лишнюю дверь",
                    floor.number,
                    door.id,
                )
            )
        if door.width_mm <= 0:
            out.append(Check(ERROR, "door_width", f"{_name(door)}: не задана ширина проема", floor.number, door.id))
        elif not door.automatic:
            out.append(
                Check(
                    WARNING,
                    "manual_door",
                    f"{_name(door)}: ручная, робот ждет, пока ее откроет человек",
                    floor.number,
                    door.id,
                )
            )
    return out


def _lifts(building: Building) -> list[Check]:
    out: list[Check] = []
    known = {lift.id for lift in building.lifts}
    for floor in building.floors:
        for shaft in floor.of(LIFT):
            if shaft.lift not in known:
                out.append(
                    Check(
                        ERROR,
                        "lift_unknown",
                        f'Шахта "{shaft.name or shaft.id}": нет лифта {shaft.lift}',
                        floor.number,
                        shaft.id,
                    )
                )
    for lift in building.lifts:
        stops = building.stops(lift.id)
        if len(stops) < 2:
            out.append(
                Check(
                    WARNING,
                    "lift_one_floor",
                    f"{lift.name}: стоит меньше чем на двух этажах, никого не возит",
                    None,
                    lift.id,
                )
            )
        if not lift.robots:
            out.append(
                Check(
                    WARNING, "lift_no_robots", f"{lift.name}: без интеграции, робот сам его не вызовет", None, lift.id
                )
            )
    if len(building.floors) > 1 and not any(
        len(building.stops(lift.id)) > 1 and lift.robots for lift in building.lifts
    ):
        out.append(Check(WARNING, "no_robot_lift", "Нет лифта с интеграцией: роботы не попадут на другие этажи"))
    return out


def _required(building: Building, cleaning: bool, delivery: bool = True) -> list[Check]:
    out: list[Check] = []
    rooms = [room for floor in building.floors for room in floor.of(ROOM)]
    chargers = [item for floor in building.floors for item in floor.of(CHARGE) if item.role != CLEANING_BASE]
    meds = building.scenario.get("meds", {})
    supplies = building.scenario.get("supplies", {})

    def active(settings):
        return settings.get("enabled", True) and (
            any(flow["per_day"] > 0 for flow in settings.get("flows", []))
            if settings.get("mode") == "routes"
            else settings.get("per_day") is None or settings["per_day"] > 0
        )

    delivery = delivery and (active(meds) or active(supplies))
    need_meds = meds.get("enabled", True) and meds.get("mode") != "routes"
    need_supplies = supplies.get("enabled", True) and supplies.get("mode") != "routes"
    if delivery and need_meds and not any(room.role == PHARMACY for room in rooms):
        out.append(Check(ERROR, "no_pharmacy", "Нет аптеки: лекарства возить неоткуда"))
    if delivery and need_supplies and not any(room.role == SUPPLIES for room in rooms):
        out.append(
            Check(
                ERROR if building.scenario else WARNING,
                "no_supplies",
                "Нет склада расходников: добавьте отправителя или выключите процесс",
            )
        )
    if delivery and (need_meds or need_supplies) and not any(room.role == WARD for room in rooms):
        out.append(Check(ERROR, "no_wards", "Нет постов отделений: некуда возить"))
    if delivery and not chargers:
        out.append(Check(ERROR, "no_charge", "Нет зарядки доставщиков"))
    if cleaning:
        for floor in building.floors:
            if processes.cleaning_passes(building, floor.number) <= 0:
                continue
            if not any(item.role == CLEANING_BASE for item in floor.of(CHARGE)):
                out.append(
                    Check(WARNING, "no_cleaning_base", "Нет базы уборщика: коридоры этажа не моем", floor.number)
                )
    return out


def _robot(building: Building, robot: RobotSize) -> list[Check]:
    """Что этому роботу недоступно: узкие двери, лифты, отрезанные посты."""
    out: list[Check] = []
    for floor in building.floors:
        for door in floor.of(DOOR):
            if door.width_mm < robot.need_mm:
                out.append(
                    Check(
                        WARNING,
                        "door_narrow",
                        f"{_name(door)}: проем {door.width_mm:.0f} мм, роботу нужно {robot.need_mm:.0f} мм",
                        floor.number,
                        door.id,
                    )
                )
    nav = Navigator(building, robot)

    @cache
    def wide_doors() -> Navigator:
        return Navigator(building, replace(robot, need_mm=0))

    for lift in building.lifts:
        if lift.robots and robot.rides_lift and not nav.usable(lift.id):
            out.append(
                Check(
                    WARNING,
                    "lift_small",
                    f"{lift.name}: робот не помещается в кабину или двери кабины уже",
                    None,
                    lift.id,
                )
            )
        for number in building.stops(lift.id):
            if nav.landing(number, lift.id) is None:
                out.append(
                    Check(
                        ERROR, "lift_landing", f"{lift.name}: к шахте на этаже {number} не подъехать", number, lift.id
                    )
                )
    roles = {
        role
        for kind, role in (("meds", PHARMACY), ("supplies", SUPPLIES))
        if building.scenario.get(kind, {}).get("enabled", True)
        and building.scenario.get(kind, {}).get("mode") != "routes"
        and building.scenario.get(kind, {}).get("per_day") != 0
    }
    sources = [(f.number, r) for f in building.floors for r in f.of(ROOM) if r.role in roles]
    # При явных маршрутах не требуем доступности постов, не участвующих в процессе.
    auto = bool(roles)
    weights = building.scenario.get("point_weights", {})
    wards = [
        (f.number, r)
        for f in building.floors
        for r in f.of(ROOM)
        if auto and r.role == WARD and weights.get(r.id, 1) > 0
    ]
    reached = 0
    for number, ward in wards:
        target = nav.spot(number, ward.id)
        # Генератор заявок использует всех отправителей активного процесса.
        # Доступная аптека не должна скрывать отрезанный склад расходников.
        blocked = [
            (source, _route_problem(nav, nav.spot(n, source.id), target, wide_doors))
            for n, source in sources
            if target is None or (start := nav.spot(n, source.id)) is None or nav.route(start, target) is None
        ]
        ok = bool(sources) and target is not None and not blocked
        reached += ok
        if not ok:
            detail = (
                f'Из "{_name(blocked[0][0])}": {blocked[0][1]}'
                if blocked
                else "Нет отправителя активного процесса с доступной точкой выдачи"
            )
            out.append(Check(WARNING, "ward_unreachable", f"{_name(ward)}: {detail}", number, ward.id))
    out.append(Check(INFO, "reach", REACH.format(reached, len(wards))))
    rooms = {r.id: (f.number, r) for f in building.floors for r in f.of(ROOM)}
    for kind in ("meds", "supplies"):
        settings = building.scenario.get(kind, {})
        if not settings.get("enabled", True) or settings.get("mode") != "routes":
            continue
        for flow in settings.get("flows", []):
            if flow["per_day"] <= 0 or flow["source"] not in rooms or flow["target"] not in rooms:
                continue
            a, b = rooms[flow["source"]], rooms[flow["target"]]
            start, target = nav.spot(a[0], a[1].id), nav.spot(b[0], b[1].id)
            if start is None or target is None or nav.route(start, target) is None:
                out.append(
                    Check(
                        WARNING,
                        "process_unreachable",
                        f"Маршрут {_name(a[1])} → {_name(b[1])}: {_route_problem(nav, start, target, wide_doors)}",
                        b[0],
                        b[1].id,
                    )
                )
    return out


def _route_problem(
    nav: Navigator, start: Anchor | None, target: Anchor | None, wide_doors: Callable[[], Navigator]
) -> str:
    if start is None or target is None:
        return "в помещении нет свободной точки передачи. Проверьте размеры, пол и преграды"
    if start.floor != target.floor:
        if not nav.robot.rides_lift:
            return (
                "для выбранной модели не подтверждена работа с лифтом. "
                "Включение интеграции у лифта не меняет возможности робота; выберите модель с поддержкой лифта"
            )
        if not any(lift.robots for lift in nav.building.lifts):
            return "нет лифта с интеграцией. Включите ее у подходящего лифта и проверьте остановки"
        if not any(nav.usable(lift.id) for lift in nav.building.lifts):
            return (
                f"ни один лифт с интеграцией не вмещает робота или имеет дверь уже {nav.robot.need_mm:.0f} мм. "
                "Проверьте размеры кабины и ширину ее двери"
            )
    if any(door.width_mm < nav.robot.need_mm for floor in nav.building.floors for door in floor.of(DOOR)):
        if wide_doors().route(start, target) is not None:
            return f"на маршруте есть дверь уже {nav.robot.need_mm:.0f} мм. Расширьте проем или выберите более узкого робота"
    return (
        "нет непрерывного маршрута. Проверьте двери помещений, преграды, "
        "подходы к шахтам и остановки одного лифта на нужных этажах"
    )


def _name(item: Item) -> str:
    return item.name or item.id


def _overlap(a: Item, b: Item) -> bool:
    return a.x < b.x + b.w and b.x < a.x + a.w and a.y < b.y + b.h and b.y < a.y + a.h


def _on_wall(door: Item, room: Item) -> bool:
    """Дверь касается края помещения: стоит в его стене."""
    if not _overlap(door, room):
        return False
    inner = Item("", ROOM, room.x + 1, room.y + 1, room.w - 2, room.h - 2)
    return not (inner.w > 0 and inner.h > 0 and _inside(door, inner))


def _inside(a: Item, b: Item) -> bool:
    return a.x >= b.x and a.y >= b.y and a.x + a.w <= b.x + b.w and a.y + a.h <= b.y + b.h
