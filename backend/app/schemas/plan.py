"""План объекта: что интерфейс рисует в редакторе и что уходит в расчет.

План это данные, а не картинка. Он лежит в проекте, участвует в версии расчета и целиком
приходит на сервер: в браузере не считается ничего, включая длину маршрута.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.engine.plan import KINDS, MAX_BUILDING_SIDE_M


class Item(BaseModel):
    """Одна вещь на плане. Все вещи это прямоугольники на сетке в метр."""

    id: str
    kind: str = Field(description=f"Что это: {', '.join(KINDS)}")
    x: float
    y: float
    w: float
    h: float
    aisle_m: float = Field(default=0.0, description="Зона хранения: ширина проезда между рядами")
    run_m: float = Field(default=0.0, description="Зона хранения: длина ряда до поперечного проезда")
    rows: str = Field(default="y", description="Зона хранения: вдоль какой оси тянутся ряды")
    rack_top_m: float = Field(default=0.0, description="Зона хранения: отметка верхнего яруса от пола")
    rack_type: str = Field(default="", description="Зона хранения: тип стеллажа, пусто значит фронтальный")
    row_m: float = Field(default=0.0, description="Зона хранения: толщина ряда, ноль значит двойная рама")
    block_rows: int = Field(default=1, ge=1, le=40, description="Зона хранения: рядов вплотную между проездами")
    cross_m: float = Field(default=0.0, description="Зона хранения: поперечный проезд, ноль значит главный")
    tiers: int = Field(
        default=0, ge=0, le=40, description="Зона хранения: число ярусов, ноль значит верхний ярус задан сам"
    )
    tier_m: float = Field(default=0.0, ge=0, description="Зона хранения: шаг яруса по высоте")
    role: str = Field(default="", description="Ворота и буфер: приемка, отгрузка или и то и другое")
    auto: bool = Field(default=False, description="Зарядка: место выбрала программа, а не человек")
    turnover: Literal["", "fast", "slow"] = Field(
        default="", description="Зона хранения: ходовая или редкая, пусто значит по пути до ворот"
    )
    direction: Literal["", "east", "west", "north", "south"] = Field(
        default="", description="Линия движения: куда можно ехать по полосе, против нельзя"
    )
    group: str = Field(default="", description="Ряд стеллажей: ряды, поставленные вместе, щелчок выбирает их все")


class Level(BaseModel):
    """Уровень пола: отметка от нуля и высота до потолка над этим полом."""

    floor_m: float = Field(default=0.0, ge=-20, le=50)
    ceiling_m: float = Field(default=0.0, ge=0, le=60)


class Section(BaseModel):
    """Секция здания: прямоугольник или контур точками, с отметкой пола и потолком. Секции лежат
    друг на друге, верхняя закрывает нижнюю. Вырез убирает пол: так получается двор или выступ."""

    id: str
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    floor_m: float = Field(default=0.0, ge=-20, le=50, description="Отметка пола от нуля")
    ceiling_m: float = Field(default=0.0, ge=0, le=60, description="Высота до потолка над этим полом")
    hole: bool = Field(default=False, description="Вырез: здесь пола нет")
    points: list[tuple[float, float]] = Field(
        default_factory=list,
        max_length=400,
        description=(
            "Контур здания точками в метрах. Если точек три и больше, пол это клетки внутри контура, "
            "а x, y, w, h рамка вокруг него"
        ),
    )


# Потолки на размер плана в запросе. Ряды стеллажей идут отдельными зонами: в типовом плане
# около 70 зон, у здания 300 на 170 м около 300, у самого большого, 1000 на 1000 м, почти 6000.
# План открыт гостю и уходит на замер после каждой правки, поэтому больше не принимаем
MAX_PLAN_ITEMS = 6000
# Строк пола не больше, чем метров на самой длинной стороне участка с запасом
MAX_FLOOR_ROWS = 4000
# Сторона здания и участка. Самый большой склад в параметрах 50 000 м2, это около 300 м на сторону
MAX_SIDE_M = MAX_BUILDING_SIDE_M
MAX_LOT_M = MAX_SIDE_M + 100


class Plan(BaseModel):
    # Участок это здание не длиннее километра и поле вокруг него. На участке 2 на 2 км генератор шел
    # 47 секунд и собирал план, который не проходил собственную проверку
    width_m: float = Field(gt=0, le=MAX_LOT_M, description="Размер участка, а не здания")
    length_m: float = Field(gt=0, le=MAX_LOT_M)
    template: str = "one_side"
    edited: bool = Field(default=False, description="Трогал человек или это чистая генерация")
    floor: list[str] = Field(
        default_factory=list,
        max_length=MAX_FLOOR_ROWS,
        description=(
            "Клетки участка строками с юга на север: точка это место вне здания, цифра или буква это "
            "номер уровня пола. Пустой список значит, что весь участок это пол нулевого уровня"
        ),
    )
    levels: list[Level] = Field(default_factory=list, max_length=20)
    sections: list[Section] = Field(
        default_factory=list,
        max_length=50,
        description="Здание секциями. Если они есть, пол и уровни собираются из них, а floor не нужен",
    )
    items: list[Item] = Field(default_factory=list, max_length=MAX_PLAN_ITEMS)


class Template(BaseModel):
    id: str
    name: str
    about: str
    fits: str
    aspect: float = Field(description="Пропорция здания: длинная сторона к короткой, длинная лежит вдоль оси x")
    aisle_m: float = Field(description="Ширина проезда между рядами в этом шаблоне")


class RackType(BaseModel):
    """Тип стеллажа и числа, которые он подставляет в зону хранения. Человек их правит."""

    id: str
    name: str
    about: str
    robot_inside: bool = Field(description="Заезжает ли робот внутрь блока или берет груз только с торца")
    rack_type: str
    row_m: float
    block_rows: int
    aisle_m: float
    run_m: float
    cross_m: float
    tier_m: float
    tiers: int = Field(description="Ноль значит ярусы считаются из высоты потолка")


class RouteMap(BaseModel):
    """Слой «далеко от ворот»: путь до буфера по клеткам, сервер уже разложил его по ступеням цвета."""

    rows: list[str] = Field(
        default_factory=list,
        description=(
            "Строки участка с юга на север, символ на клетку: цифра это ступень цвета, «!» это проезжая "
            "клетка, до которой не доехать, точка это стеллаж, стена или улица"
        ),
    )
    bands_m: list[float] = Field(default_factory=list, description="Границы ступеней в метрах, на одну больше ступеней")


class PlanCheck(BaseModel):
    label: str
    ok: bool
    detail: str = Field(default="", description="Что не так, если проверка не прошла")


class Measures(BaseModel):
    """Числа, которые план двигает в расчете. Декораций на плане нет."""

    width_m: float = Field(description="Габариты здания, а не участка")
    length_m: float
    area_m2: float = Field(description="Площадь пола здания")
    docks: int = Field(description="Мест у ворот: столько роботов разгружаются одновременно")
    buffers: int
    stations: int
    aisles: int = Field(description="Проездов между рядами: столько роботов едут, не мешая друг другу")
    aisle_m: float = Field(description="Самый узкий проезд: он идет в подбор решений")
    rack_depth_m: float = Field(description="Глубина ряда стеллажей: по ней редактор рисует ряды тем же шагом")
    cross_aisle_m: float = Field(description="Поперечный проезд между блоками рядов: редактор режет ряды тем же шагом")
    rack_top_m: float = Field(description="Самый высокий верхний ярус: до него должен достать штабелер")
    levels: int = Field(description="Сколько разных уровней пола в здании")
    ramps: int
    route_m: float = Field(description="Средний маршрут от места у стеллажа до буфера у ворот")
    route_to_station_m: float
    charge_detour_m: float = Field(description="Крюк от буфера до зоны зарядки")
    storage_m2: float
    storage_share: float
    task_points: int
    unreachable_points: int
    closed_racks: int = Field(default=0, description="Зоны, в блок которых робот не заезжает: набивной и мобильный")
    unreachable: list[list[int]] = Field(
        default_factory=list, description="Клетки мест у стеллажей, до которых не доехать: столбец и строка"
    )
    route_map: RouteMap = Field(default_factory=RouteMap, description="Слой «далеко от ворот» для плана")
    checks: list[PlanCheck] = Field(default_factory=list, description="Проверки плана списком с галочками")
    warnings: list[str] = Field(default_factory=list)


class DockWall(BaseModel):
    """Ворота на одной стене: какая стена и сколько ворот."""

    wall: Literal["west", "east", "south", "north"] = Field(description="Запад это слева на листе, юг снизу")
    count: int = Field(ge=1, le=60)


class CustomLayout(BaseModel):
    """Ответы анкеты «Свой склад»: вместо схемы потока человек говорит, где ворота и как стоят ряды."""

    docks: list[DockWall] = Field(default_factory=list, description="Стены с воротами; пусто значит без ворот")
    racks: Literal["across", "along", "none"] = Field(
        default="across", description="Ряды поперек потока, вдоль него или без стеллажей: человек нарисует сам"
    )


class GenerateRequest(BaseModel):
    facility_id: str = "warehouse"
    operation_ids: list[str] = Field(default_factory=lambda: ["pallet_transport"])
    template_id: str = Field(default="one_side", description="Схема потока или «custom»: план по анкете")
    width_m: float | None = Field(default=None, gt=0, le=MAX_SIDE_M)
    length_m: float | None = Field(default=None, gt=0, le=MAX_SIDE_M)
    overrides: dict[str, float] = Field(default_factory=dict)
    custom: CustomLayout | None = Field(default=None, description="Анкета для шаблона «custom»")


class GeneratedPlan(BaseModel):
    """План и его числа. План может вернуться не таким, каким пришел: зарядку ставит программа."""

    plan: Plan
    measures: Measures
