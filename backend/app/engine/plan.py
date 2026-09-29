"""План объекта: строим из шаблона, кладем на сетку, считаем по нему расстояния.

Зачем он нужен. Если считать объект квадратом со стороной из корня площади (ворота посередине
нижней стороны, задание в случайной точке, объезжать нечего), длина маршрута почти не зависит
от геометрии, а она определяет производительность робота и размер парка.

План из шаблона и план, нарисованный руками, это одна и та же структура. Поэтому пропуск
шага не особый случай: если человек не чертил, считаем по сгенерированному плану и честно
пишем, что не знаем, где на объекте ворота.

Как устроен план. Здание складывается из секций: прямоугольников с отметкой пола и высотой
потолка. Секции могут лежать друг на друге, верхняя закрывает нижнюю: так антресоль или рампа
кладутся поверх основного зала. Секция-вырез убирает пол, из нее получается двор или выступ.
Поэтому склад может быть буквой Г или П, а часть его может стоять выше.

Движок раскладывает секции по сетке клеток в метр. На пол ставятся вещи: зоны хранения, ворота,
буферы у ворот, станции, зарядка, перегородки и пандусы. Все вещи тоже прямоугольники.

Между клетками с разной отметкой пола робот не проедет, пока их не соединит пандус.

Здесь только расчет. Файлы читает services/plan.py, шаблоны и константы приходят сюда
словарями из config/layouts.yaml.

Система координат: метры, ноль в левом нижнем углу участка. x идет на восток, y на север.
Строка floor[0] это полоса участка от y=0 до y=1. Строки пола собирает движок из секций,
но понимает и старый вид плана, где они приходят прямо от интерфейса.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field, replace

GRID_M = 1.0  # шаг сетки. Прилипание в метр, свободных контуров и поворотов у нас нет
# Простенок между соседними воротами. Это правило рисования, а не данные: иначе двое ворот
# вплотную на плане не отличить от одних широких, и их нельзя сузить, не задев соседа.
DOCK_GAP_M = GRID_M
INF = float("inf")

RACKS, DOCK, BUFFER, STATION, CHARGE, BLOCKED, RAMP, AISLE = (
    "racks",
    "dock",
    "buffer",
    "station",
    "charge",
    "blocked",
    "ramp",
    "aisle",
)
# Линия движения: полоса, по которой едут только в одну сторону. Линия с поворотами это несколько
# полос. Поперек полосы переезжать можно, как дорогу, а ехать вдоль против стрелки нельзя.
FLOW = "flow"
KINDS = (RACKS, DOCK, BUFFER, STATION, CHARGE, BLOCKED, RAMP, AISLE, FLOW)
DIRECTIONS = {"east": (1, 0), "west": (-1, 0), "north": (0, 1), "south": (0, -1)}
# Что встает внутрь зоны хранения и убирает под собой стеллажи. Проезд это полоса, которую человек
# кладет через зону там, где ему нужен поперечный проезд, а не через равные run_m.
CARVE = (RAMP, STATION, BUFFER, DOCK, AISLE)
RECEIVING, SHIPPING, BOTH = "receiving", "shipping", "both"
FAST, SLOW = "fast", "slow"  # как часто берут из зоны хранения, если человек это знает

OUTSIDE = "."  # клетка участка вне здания
FREE, RACK_CELL, WALL_CELL = 0, 1, 2
WALLS = ("south", "north", "west", "east")
NEIGHBOURS = ((1, 0), (-1, 0), (0, 1), (0, -1))

# Насколько может ухудшиться маршрут, когда программа ставит зарядку. Это наше правило, а не данные:
# зарядка не должна перегораживать проезд, а полметра объезда на маршрут в десятки метров
# это шум округления сетки.
CHARGE_ROUTE_TOLERANCE_M = 0.5
# Станция на пути: насколько может вырасти средний маршрут, если станции считать препятствием.
# Полметра дает шаг сетки на объезде угла, больше это уже проезд, перекрытый станцией
STATION_ROUTE_TOLERANCE_M = 1.0
CHARGE_CANDIDATES = 12  # сколько лучших мест проверяем на то, что зарядка не мешает проезду


@dataclass
class Level:
    """Уровень пола: отметка от нуля и высота до потолка над этим полом."""

    floor_m: float = 0.0
    ceiling_m: float = 0.0


@dataclass
class Section:
    """Секция здания: прямоугольник пола с отметкой и потолком, или вырез, если hole.

    Удлинить склад значит потянуть секцию за край, поднять часть значит положить сверху
    секцию с другой отметкой пола. Рисовать пол клетками неудобно: это проверили на показе.
    """

    id: str
    x: float
    y: float
    w: float
    h: float
    floor_m: float = 0.0
    ceiling_m: float = 0.0
    hole: bool = False
    # Контур здания точками: многоугольник в метрах. Если точки есть, пол секции это клетки внутри
    # контура, а x, y, w, h только рамка вокруг него. Так обводят склад буквой Г или П одной линией,
    # а не складывают его из прямоугольников и вырезов
    points: list[tuple[float, float]] = field(default_factory=list)


@dataclass
class Item:
    """Вещь на плане. Все вещи это прямоугольники на сетке в метр.

    Стеллажи стоят рядами: у каждого ряда тип стеллажа, толщина, проезд и ярусы. Ряды ставят
    по одному или сразу несколько инструментом «Ряды», тогда у них общая группа. Проезд между
    рядами это пол между двумя соседними рядами, а не число внутри вещи.

    Вещь racks бывает и зоной на много рядов, их нарезает сетка по rack_cut. Такие планы
    лежат в проектах, поэтому зону движок понимает, а rows_of раскладывает ее
    на ряды при чтении. Тип подставляет числа по умолчанию из config/layouts.yaml.
    """

    id: str
    kind: str
    x: float
    y: float
    w: float
    h: float
    aisle_m: float = 0.0  # racks: ширина проезда между рядами
    run_m: float = 0.0  # racks: длина ряда до поперечного проезда
    rows: str = "y"  # racks: вдоль какой оси тянутся ряды
    rack_top_m: float = 0.0  # racks: отметка верхнего яруса от пола
    rack_type: str = ""  # racks: тип стеллажа, пусто значит фронтальный
    row_m: float = 0.0  # racks: толщина ряда, у фронтального это две рамы спиной к спине
    block_rows: int = 1  # racks: сколько рядов стоят вплотную между проездами, у мобильного больше одного
    cross_m: float = 0.0  # racks: ширина поперечного проезда, ноль значит главный проезд склада
    tiers: int = 0  # racks: число ярусов; если задано, верхний ярус считается из шага яруса
    tier_m: float = 0.0  # racks: шаг яруса по высоте
    role: str = ""  # dock и buffer: приемка, отгрузка или и то и другое
    auto: bool = False  # charge: место выбрала программа, а не человек
    turnover: str = ""  # racks: FAST ходовое, SLOW редкое, пусто значит по пути: ближе к воротам ходовее
    direction: str = ""  # flow: куда можно ехать по полосе, east, west, north или south
    group: str = ""  # racks: ряды, поставленные вместе инструментом «Ряды»; щелчок выбирает их все

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.w / 2, self.y + self.h / 2)


@dataclass
class Plan:
    width_m: float  # размер участка, а не здания: вокруг здания есть место, чтобы дорисовать
    length_m: float
    template: str
    items: list[Item] = field(default_factory=list)
    edited: bool = False  # трогал человек или это чистая генерация
    floor: list[str] = field(default_factory=list)  # строки клеток, с юга на север
    levels: list[Level] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)  # если есть, пол собирается из них

    @property
    def area_m2(self) -> float:
        return self.width_m * self.length_m

    @property
    def known(self) -> bool:
        """Планировку назвал человек: правил чертеж или строил по анкете и фото, а не взял типовую"""
        return self.edited or self.template == "custom"

    def of(self, kind: str) -> list[Item]:
        return [item for item in self.items if item.kind == kind]


# --- генерация из шаблона ---------------------------------------------------------------


# Длинная сторона здания. Больше километра склады не бывают, а генератор на таком здании
# считает десятки секунд: отказываем сразу и понятно
MAX_BUILDING_SIDE_M = 1000


class TooBig(ValueError):
    """Здание по площади и пропорции выходит длиннее MAX_BUILDING_SIDE_M."""


def generate(
    template: dict,
    constants: dict,
    area_m2: float,
    stations: int = 0,
    ceiling_m: float = 0.0,
    margin_m: int = 0,
) -> Plan:
    """План по шаблону планировки и площади активной зоны.

    Длины и ширины склада нет ни в ТЗ, ни в датасете: там только площадь. Поэтому габариты
    выводим из площади и пропорции шаблона, а пропорция у нас без источника. На шаге плана
    форма здания правится, чтобы человек поставил свою.

    Длинная сторона здания лежит вдоль оси x. Лист в редакторе широкий и невысокий, и здание,
    вытянутое по вертикали, занимало треть ширины листа. Стены в шаблонах названы с учетом этого:
    у одностороннего склада ворота на короткой стене, то есть на западной.

    margin_m это пустое место вокруг здания: оно не данные, а поле редактора, чтобы было куда
    дорисовать пристройку.
    """
    width, length = _size(area_m2, template["aspect"])
    if max(width, length) > MAX_BUILDING_SIDE_M:
        area, side = (f"{value:,.0f}".replace(",", " ") for value in (area_m2, max(width, length)))
        raise TooBig(
            f"Здание площадью {area} м2 выходит длиной {side} м, а план строим до "
            f"{MAX_BUILDING_SIDE_M} м на сторону. Проверьте площадь объекта"
        )
    top = max(0.0, ceiling_m - constants["rack_top_below_ceiling_m"]) if ceiling_m else 0.0

    items: list[Item] = []
    items += _docks(template, constants, width, length, area_m2)
    items += _buffers(template, constants, width, length, items)
    items += _stations(template, constants, width, length, stations)
    items += _storage(template, constants, width, length, top)
    for item in items:
        item.x += margin_m
        item.y += margin_m

    lot_w, lot_l = int(width) + 2 * margin_m, int(length) + 2 * margin_m
    hall = Section("hall", float(margin_m), float(margin_m), width, length, 0.0, ceiling_m)
    plan = Plan(width_m=float(lot_w), length_m=float(lot_l), template=template["id"], items=items, sections=[hall])
    charge = place_charge(plan, constants)
    if charge:
        plan.items.append(charge)
    return plan


def _size(area_m2: float, aspect: float) -> tuple[float, float]:
    """Ширина по x и длина по y. aspect это длинная сторона к короткой, длинная идет по x."""
    width = max(GRID_M, round(math.sqrt(area_m2 * aspect)))
    return float(width), float(max(GRID_M, round(area_m2 / width)))


def _wall_length(wall: str, width: float, length: float) -> float:
    return width if wall in ("south", "north") else length


def _opposite(wall: str) -> str:
    return {"south": "north", "north": "south", "west": "east", "east": "west"}[wall]


def _insets(template: dict, constants: dict) -> dict[str, float]:
    """Сколько метров у каждой стены занято не хранением: доковая зона, проезды, станции."""
    main = constants["aisle_main_m"]
    insets = dict.fromkeys(WALLS, main)
    for dock in template["docks"]:
        insets[dock["wall"]] = max(insets[dock["wall"]], constants["dock_zone_depth_m"])
    wall = (template.get("stations") or {}).get("wall")
    if wall:
        # полоса под станции плюс главный проезд мимо них
        insets[wall] = max(insets[wall], main * 2)
    return insets


def _split(total: int, parts: int) -> list[int]:
    """Делит ворота между записями шаблона поровну, каждой записи хотя бы одни ворота."""
    if parts >= total:
        return [1] * parts
    base, extra = divmod(total, parts)
    return [base + (1 if index < extra else 0) for index in range(parts)]


def _strip(wall: str, along: float, size: float, depth: float, width: float, length: float) -> tuple[float, ...]:
    """Прямоугольник вдоль стены: along это отступ по стене, size его длина, depth глубина."""
    return {
        "south": (along, 0.0, size, depth),
        "north": (along, length - depth, size, depth),
        "west": (0.0, along, depth, size),
        "east": (width - depth, along, depth, size),
    }[wall]


def _docks(template: dict, constants: dict, width: float, length: float, area_m2: float) -> list[Item]:
    """Ворота по площади объекта, шагом фур, посередине своей стены.

    Источники расходятся вдвое: одни ворота на 500 м2 против одних на 800-1000. Взяли реже,
    это записано в config/layouts.yaml: ворот меньше, очередь у ворот длиннее, окупаемость хуже.
    Между приемкой и отгрузкой делим поровну: как у клиента, мы не знаем. Если в записи шаблона
    стоит число ворот, как в анкете «Свой склад», берем его.
    """
    if not template["docks"]:
        return []
    pitch = constants["dock_pitch_m"]
    if all("count" in entry for entry in template["docks"]):
        counts = [int(entry["count"]) for entry in template["docks"]]
    else:
        total = max(1, round(area_m2 / constants["area_per_dock_m2"]))
        counts = _split(total, len(template["docks"]))

    by_wall: dict[str, list[tuple[dict, int]]] = {}
    for entry, count in zip(template["docks"], counts, strict=True):
        by_wall.setdefault(entry["wall"], []).append((entry, count))

    items: list[Item] = []
    for wall, entries in by_wall.items():
        span = sum(count for _, count in entries) * pitch
        # посередине стены, но по сетке в метр: вещи на плане стоят в целых клетках
        offset = float(max(0, round((_wall_length(wall, width, length) - span) / 2)))
        for entry, count in entries:
            for _ in range(count):
                # створка на клетку уже шага: между воротами простенок, как требует редактор
                x, y, w, h = _strip(wall, offset, pitch - DOCK_GAP_M, GRID_M, width, length)
                items.append(Item(id=f"dock-{len(items)}", kind=DOCK, x=x, y=y, w=w, h=h, role=entry.get("kind", BOTH)))
                offset += pitch
    return items


def _buffers(template: dict, constants: dict, width: float, length: float, docks: list[Item]) -> list[Item]:
    """Буфер у ворот: сюда робот ставит паллету, отсюда ее забирают в машину.

    Буфер занимает доковую зону за вычетом главного проезда вдоль стеллажей. Глубина доковой
    зоны у нас без источника, оценка F, поэтому и глубина буфера такая же слабая.
    """
    depth = max(GRID_M, math.floor(constants["dock_zone_depth_m"] - constants["aisle_main_m"] - GRID_M))
    items = []
    for entry in template.get("buffers") or []:
        wall = entry["wall"]
        on_wall = [dock for dock in docks if _wall_of(dock, width, length) == wall]
        if not on_wall:
            continue
        along = (lambda d: d.x) if wall in ("south", "north") else (lambda d: d.y)
        size = (lambda d: d.w) if wall in ("south", "north") else (lambda d: d.h)
        start = min(along(dock) for dock in on_wall)
        finish = max(along(dock) + size(dock) for dock in on_wall)
        x, y, w, h = _strip(wall, start, finish - start, depth, width, length)
        # буфер стоит за воротами, а не в них: сдвигаем на глубину створки
        shift = {"south": (0, GRID_M), "north": (0, -GRID_M), "west": (GRID_M, 0), "east": (-GRID_M, 0)}[wall]
        items.append(
            Item(
                id=f"buffer-{wall}",
                kind=BUFFER,
                x=x + shift[0],
                y=y + shift[1],
                w=w,
                h=h,
                role=entry.get("kind", BOTH),
            )
        )
    return items


def _wall_of(item: Item, width: float, length: float) -> str:
    gaps = {"west": item.x, "east": width - item.x - item.w, "south": item.y, "north": length - item.y - item.h}
    return min(gaps, key=gaps.get)


def _stations(template: dict, constants: dict, width: float, length: float, stations: int) -> list[Item]:
    """Станции комплектации: робот везет стеллаж к человеку и ждет очереди.

    Сколько их нужно, считается из пикового спроса и выработки человека, поэтому число
    приходит снаружи, а план только ставит их по стене.
    """
    if stations <= 0:
        return []
    facing = template["docks"][0]["wall"] if template["docks"] else "south"
    wall = (template.get("stations") or {}).get("wall") or _opposite(facing)
    side = constants["rack_bay_m"]
    wall_m = _wall_length(wall, width, length)
    items = []
    for index in range(stations):
        along = max(0.0, round(wall_m * (index + 1) / (stations + 1) - side / 2))
        x, y, w, h = _strip(wall, along, round(side), round(constants["aisle_main_m"]), width, length)
        items.append(Item(id=f"station-{index}", kind=STATION, x=x, y=y, w=w, h=h))
    return items


def _storage(template: dict, constants: dict, width: float, length: float, top_m: float) -> list[Item]:
    """Одна зона хранения на всю свободную площадь: ряды внутри нарезает сетка.

    Тип стеллажа задает шаблон: в робозоне это стеллажи, которые возит робот, в остальных
    фронтальный. Ярусов столько, сколько шагов яруса помещается под верхним ярусом.
    """
    if template["racks"] == "none":
        return []  # человек сказал, что нарисует стеллажи сам
    insets = _insets(template, constants)
    x, y = round(insets["west"]), round(insets["south"])
    w = round(width - insets["west"] - insets["east"])
    h = round(length - insets["south"] - insets["north"])
    if w <= 0 or h <= 0:
        return []
    # along_flow и grid: ряды тянутся вдоль потока, across_flow: поперек него. Поток идет от
    # стены с воротами: от южной или северной вдоль y, от западной или восточной вдоль x
    facing = template["docks"][0]["wall"] if template["docks"] else "south"
    flow = "y" if facing in ("south", "north") else "x"
    across = "x" if flow == "y" else "y"
    rows = across if template["racks"] == "across_flow" else flow
    kind = rack_type(constants, template.get("rack_type", FRONT))
    item = Item(id="racks", kind=RACKS, x=x, y=y, w=w, h=h, rows=rows, **rack_defaults(kind, constants))
    item.aisle_m = constants[template["aisle"]]
    if not item.tiers and top_m and item.tier_m:
        item.tiers = int(top_m // item.tier_m) + 1
    item.rack_top_m = top_of(item)
    return [item]


FRONT = "front"


def rack_type(constants: dict, type_id: str) -> dict:
    """Тип стеллажа из config/layouts.yaml. Незнакомый или пустой тип считаем фронтальным:
    так читаются планы, сохраненные до того, как у зоны появился тип."""
    types = constants.get("rack_types") or {}
    return types.get(type_id) or types.get(FRONT) or {}


def rack_defaults(kind: dict, constants: dict) -> dict:
    """Числа, которые тип стеллажа подставляет в зону хранения. Строка вместо числа это ссылка
    на константу склада: проезд погрузчика или главный проезд у типов общие."""

    def value(key: str) -> float:
        raw = kind[key]
        return constants[raw] if isinstance(raw, str) else raw

    return {
        "rack_type": kind["id"],
        "row_m": value("row_m"),
        "block_rows": int(value("block_rows")),
        "aisle_m": value("aisle_m"),
        "run_m": value("run_m"),
        "cross_m": value("cross_m"),
        "tier_m": value("tier_m"),
        "tiers": int(value("tiers")) if "tiers" in kind else 0,
    }


def top_of(item: Item) -> float:
    """Отметка верхнего яруса. Если задано число ярусов, нижний стоит на полу, а каждый следующий
    выше на шаг яруса. Иначе берем отметку, которую человек поставил сам."""
    if item.tiers > 0 and item.tier_m > 0:
        return round((item.tiers - 1) * item.tier_m, 2)
    return item.rack_top_m


@dataclass(frozen=True)
class RackCut:
    """Как зона хранения режется на ряды. По этим же числам рисует редактор.

    Поперек рядов идут блоки: ряд, а у мобильного несколько рядов вплотную, потом проезд.
    Блоков ровно столько, сколько помещается целиком, а остаток делится поровну между краями,
    чтобы у стены не висел обрезок ряда. Вдоль рядов их режут поперечные проезды: частей
    столько, чтобы ни одна не была длиннее run_m, и все части одной длины.
    """

    band: float  # толщина блока рядов
    pitch: float  # блок и проезд за ним
    blocks: int
    offset: float  # отступ первого блока от края зоны
    used: float  # сколько занимают блоки с проездами между ними
    seg: float  # длина части ряда между поперечными проездами
    cross: float
    segments: int


def rack_cut(item: Item, constants: dict) -> RackCut:
    row = item.row_m or constants["rack_depth_m"] * 2
    band = row * max(1, item.block_rows)
    aisle = max(item.aisle_m, GRID_M)
    cross = item.cross_m or constants["aisle_main_m"]
    extent, length = (item.h, item.w) if item.rows == "x" else (item.w, item.h)
    blocks = max(1, int((extent + aisle + 1e-6) // (band + aisle)))
    used = min(extent, blocks * band + (blocks - 1) * aisle)
    # run_m 0 значит «без поперечных проездов»: так рисуют зону по фото, а проезд кладут рукой
    run = max(item.run_m, GRID_M)
    segments = max(1, math.ceil((length + cross) / (run + cross) - 1e-6)) if item.run_m > 0 else 1
    seg = (length - (segments - 1) * cross) / segments
    if seg <= 0:
        segments, seg = 1, length
    return RackCut(band, band + aisle, blocks, (extent - used) / 2, used, seg, cross, segments)


def in_rack(cut: RackCut, across: float, along: float) -> bool:
    """Стоит ли стеллаж в точке зоны: across поперек рядов от края зоны, along вдоль ряда."""
    at = across - cut.offset
    if at < -TIE or at >= cut.used - TIE:
        return False
    if _within(at, cut.pitch) >= cut.band - TIE:
        return False  # проезд между блоками
    return _within(along, cut.seg + cut.cross) < cut.seg - TIE  # иначе поперечный проезд


# Центр клетки бывает ровно на краю ряда: ряд толщиной 2,3 м от 0,6 м. Край ряда в клетку не входит,
# начало входит, а разница в последнем знаке дробного числа не решает, чья это клетка
TIE = 1e-9


def _within(value: float, period: float) -> float:
    """Остаток от деления, где почти целый период считается нулем: начало следующего блока."""
    rest = value % period
    return 0.0 if rest > period - TIE else rest


# --- ряды ---------------------------------------------------------------------------------

# Проезд между двумя рядами это пол между ними, если он не шире их проезда плюс клетка сетки.
# Это наше правило, а не данные: шире стоят ряды у главного проезда, там роботы разъезжаются
# свободно, и мест в таком проезде мы не ограничиваем. Клетка запаса нужна, потому что ряды на
# листе прилипают к метру, а толщина ряда дробная.
CORRIDOR_SLACK_M = GRID_M
EPS = 1e-6


def is_row(item: Item, constants: dict) -> bool:
    """Ряд, а не старая зона: один блок поперек и без поперечных проездов."""
    cut = rack_cut(item, constants)
    extent = item.h if item.rows == "x" else item.w
    return cut.blocks == 1 and cut.segments == 1 and abs(extent - cut.band) < 1e-3


def rows_of(plan: Plan, constants: dict) -> Plan:
    """Старые зоны хранения на много рядов раскладываем на ряды: так их правит редактор.

    Ряды встают ровно там, где их нарезал rack_cut, поперечный проезд режет ряд на куски, поэтому
    расчет по плану не меняется. Ряды одной зоны получают ее имя группой: щелчок по ряду выбирает
    всю бывшую зону, двойной один ряд. Змейка зоны называется так же и остается ее змейкой.
    """
    items: list[Item] = []
    changed = False
    for item in plan.items:
        if item.kind != RACKS or is_row(item, constants):
            items.append(item)
            continue
        changed = True
        items += split_zone(item, constants)
    return replace(plan, items=items) if changed else plan


def split_zone(item: Item, constants: dict) -> list[Item]:
    cut = rack_cut(item, constants)
    along_x = item.rows == "x"
    rows = []
    for block in range(cut.blocks):
        start = cut.offset + block * cut.pitch
        for part in range(cut.segments):
            at = part * (cut.seg + cut.cross)
            x, y, w, h = (
                (item.x + at, item.y + start, cut.seg, cut.band)
                if along_x
                else (item.x + start, item.y + at, cut.band, cut.seg)
            )
            suffix = f"r{block}" if cut.segments == 1 else f"r{block}-{part}"
            rows.append(
                replace(
                    item,
                    id=f"{item.id}-{suffix}",
                    x=round(x, 6),
                    y=round(y, 6),
                    w=round(w, 6),
                    h=round(h, 6),
                    run_m=0.0,
                    group=item.group or item.id,
                )
            )
    return rows


@dataclass(frozen=True)
class Gap:
    """Проезд между двумя соседними рядами: пол между ними там, где они идут вдоль друг друга.

    across это ось поперек рядов, along вдоль. low и high это номера рядов в plan.of(RACKS):
    low ближе к нулю по оси поперек.
    """

    low: int
    high: int
    rows: str  # вдоль какой оси идут оба ряда
    start: float  # поперек: от края первого ряда
    end: float  # до края второго
    first: float  # вдоль: общий кусок двух рядов
    last: float

    @property
    def width(self) -> float:
        return round(self.end - self.start, 2)

    def rect(self) -> tuple[float, float, float, float]:
        if self.rows == "x":
            return (self.first, self.start, self.last - self.first, self.end - self.start)
        return (self.start, self.first, self.end - self.start, self.last - self.first)


def _spans(item: Item, constants: dict) -> tuple[float, float, float, float]:
    """Где стоят стеллажи ряда: поперек от и до, вдоль от и до."""
    cut = rack_cut(item, constants)
    if item.rows == "x":
        return (item.y + cut.offset, item.y + cut.offset + cut.band, item.x, item.x + item.w)
    return (item.x + cut.offset, item.x + cut.offset + cut.band, item.y, item.y + item.h)


def gaps_between(racks: list[Item], constants: dict) -> list[Gap]:
    """Все проезды между соседними рядами. Между рядами не должно стоять третьего ряда, иначе
    это два проезда, а не один. Старые зоны на много рядов сюда не входят: их проезды внутри
    зоны, их находит corridor_of по rack_cut."""
    rows = [(index, item, _spans(item, constants)) for index, item in enumerate(racks) if is_row(item, constants)]
    found = []
    for low, a, (_a0, a1, al0, al1) in rows:
        near = []
        for high, b, (b0, b1, bl0, bl1) in rows:
            if high == low or b.rows != a.rows or b0 < a1 - EPS:
                continue
            first, last = max(al0, bl0), min(al1, bl1)
            if last - first <= EPS or b0 - a1 > max(a.aisle_m, b.aisle_m) + CORRIDOR_SLACK_M:
                continue
            near.append((b0, high, b1, first, last))
        near.sort()
        for b0, high, _b1, first, last in near:
            # третий ряд между ними на том же куске закрывает проезд
            if any(
                c0 < b0 - EPS and c1 <= b0 + EPS and min(last, cl1) - max(first, cl0) > EPS
                for c0, _h, c1, cl0, cl1 in near
            ):
                continue
            if b0 - a1 > EPS:
                found.append(Gap(low, high, a.rows, a1, b0, first, last))
    return found


def serpentine_rows(racks: list[Item], picked: list[int], constants: dict, name: str, first: str = "") -> list[Item]:
    """Змейка по проездам между рядами: те же полосы, что у зоны, только проезды это пол между
    соседними рядами из picked. В соседних проездах в разные стороны."""
    chosen = set(picked)
    gaps = [gap for gap in gaps_between(racks, constants) if gap.low in chosen and gap.high in chosen]
    if not gaps:
        return []
    # куски одного проезда между поперечными проездами это одна полоса во всю длину, как у зоны
    lines: dict[tuple[str, float, float], list[Gap]] = {}
    for gap in gaps:
        lines.setdefault((gap.rows, round(gap.start, 3), round(gap.end, 3)), []).append(gap)
    ways = ("east", "west") if gaps[0].rows == "x" else ("north", "south")
    if first in ways and first != ways[0]:
        ways = (ways[1], ways[0])
    lanes = []
    for number, key in enumerate(sorted(lines, key=lambda one: one[1])):
        parts = lines[key]
        whole = replace(parts[0], first=min(one.first for one in parts), last=max(one.last for one in parts))
        x, y, w, h = whole.rect()
        lanes.append(Item(id=f"{name}-flow-{number}", kind=FLOW, x=x, y=y, w=w, h=h, direction=ways[number % 2]))
    return lanes


def block_of(racks: list[Item], index: int, constants: dict) -> list[int]:
    """Ряды, которые стоят вместе с этим: его группа, а если группы нет, все ряды, до которых
    от него можно дойти через проезды между соседними рядами."""
    item = racks[index]
    if item.group:
        return [number for number, one in enumerate(racks) if one.group == item.group]
    links: dict[int, set[int]] = {}
    for gap in gaps_between(racks, constants):
        links.setdefault(gap.low, set()).add(gap.high)
        links.setdefault(gap.high, set()).add(gap.low)
    seen, queue = {index}, deque([index])
    while queue:
        for other in links.get(queue.popleft(), ()):
            if other not in seen:
                seen.add(other)
                queue.append(other)
    return sorted(seen)


# --- сетка ------------------------------------------------------------------------------


@dataclass
class Grid:
    """План, разложенный по клеткам в метр.

    cells говорит, можно ли здесь ехать: свободно, стеллаж или стена. level это номер уровня
    пола клетки, у клетки вне здания он -1, а сами уровни с отметкой и потолком лежат в levels.
    ramps это клетки под пандусами: с них можно съехать на любую соседнюю отметку.
    oneway это клетки под линией движения и направление, в котором по ним можно ехать.
    """

    step_m: float
    cols: int
    rows: int
    cells: bytearray
    level: list[int] = field(default_factory=list)
    levels: list[Level] = field(default_factory=list)
    ramps: set[int] = field(default_factory=set)
    oneway: dict[int, tuple[int, int]] = field(default_factory=dict)
    # проезды между рядами по клеткам: считаются один раз на сетку, первым вызовом corridor_of
    gap_cells: dict[int, Corridor] | None = None

    def allows(self, a: int, b: int, dc: int, dr: int) -> bool:
        """Можно ли переехать из клетки a в соседнюю b шагом (dc, dr): против стрелки линии
        движения нельзя ни въехать, ни выехать, поперек можно."""
        back = (-dc, -dr)
        return self.oneway.get(a) != back and self.oneway.get(b) != back

    def at(self, col: int, row: int) -> int:
        return self.cells[row * self.cols + col]

    def inside(self, col: int, row: int) -> bool:
        return 0 <= col < self.cols and 0 <= row < self.rows

    def free(self, col: int, row: int) -> bool:
        return self.inside(col, row) and self.cells[row * self.cols + col] == FREE

    def floor(self, col: int, row: int) -> bool:
        return self.inside(col, row) and self.level[row * self.cols + col] >= 0

    def height(self, index: int) -> float:
        """Отметка пола клетки. Два уровня с одной отметкой и разным потолком это один пол."""
        level = self.level[index]
        return self.levels[level].floor_m if 0 <= level < len(self.levels) else float(level)

    def joins(self, a: int, b: int) -> bool:
        """Можно ли переехать из клетки a в соседнюю b: та же отметка пола или пандус между ними."""
        return a in self.ramps or b in self.ramps or self.height(a) == self.height(b)

    def point(self, col: int, row: int) -> tuple[float, float]:
        """Центр клетки в метрах."""
        return ((col + 0.5) * self.step_m, (row + 0.5) * self.step_m)

    def cell(self, x: float, y: float) -> tuple[int, int]:
        col = min(self.cols - 1, max(0, int(x / self.step_m)))
        row = min(self.rows - 1, max(0, int(y / self.step_m)))
        return col, row

    def cells_of(self, item: Item) -> list[tuple[int, int]]:
        """Клетки под прямоугольником: сколько он накрывает, но хотя бы одна."""
        first = self.cell(item.x, item.y)
        last = self.cell(item.x + max(0.0, item.w - self.step_m / 2), item.y + max(0.0, item.h - self.step_m / 2))
        return [(col, row) for row in range(first[1], last[1] + 1) for col in range(first[0], last[0] + 1)]


def ground(plan: Plan) -> tuple[list[str], list[Level]]:
    """Пол участка строками клеток и список уровней. Если здание задано секциями, собираем из них.

    Секции кладутся по порядку, следующая закрывает предыдущую. Уровень это пара «отметка пола
    и потолок»: одна отметка с разными потолками дает разные уровни, но робот между ними едет.
    """
    if not plan.sections:
        return plan.floor, plan.levels
    cols, rows = lot(plan)
    marks = [[OUTSIDE] * cols for _ in range(rows)]
    levels: list[Level] = []
    for section in plan.sections:
        if section.hole:
            mark = OUTSIDE
        else:
            level = Level(section.floor_m, section.ceiling_m)
            if level not in levels:
                levels.append(level)
            mark = _digit(levels.index(level))
        inside = _polygon(section.points) if len(section.points) >= 3 else None
        for row in range(max(0, round(section.y)), min(rows, round(section.y + section.h))):
            line = marks[row]
            for col in range(max(0, round(section.x)), min(cols, round(section.x + section.w))):
                if inside is None or inside(col + GRID_M / 2, row + GRID_M / 2):
                    line[col] = mark
    return ["".join(line) for line in marks], levels


def _polygon(points: list[tuple[float, float]]):
    """Лежит ли точка внутри контура: луч вправо пересекает стороны нечетное число раз.
    Клетка пола та, чей центр внутри, так же пол собирает и редактор."""
    edges = list(zip(points, points[1:] + points[:1], strict=True))

    def inside(x: float, y: float) -> bool:
        hit = False
        for (x1, y1), (x2, y2) in edges:
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
        return hit

    return inside


def _digit(value: int) -> str:
    return "0123456789abcdefghijklmnopqrstuvwxyz"[min(value, 35)]


def lot(plan: Plan) -> tuple[int, int]:
    """Размер участка в клетках. Если секция вылезла за край, участок растет под нее:
    молча обрезать нарисованное здание нельзя."""
    width = max([plan.width_m, *(section.x + section.w for section in plan.sections)])
    length = max([plan.length_m, *(section.y + section.h for section in plan.sections)])
    return max(1, round(width / GRID_M)), max(1, round(length / GRID_M))


def rasterize(plan: Plan, constants: dict) -> Grid:
    cols, rows = lot(plan)
    floor, levels = ground(plan)
    grid = Grid(GRID_M, cols, rows, bytearray(cols * rows), [0] * (cols * rows), list(levels))
    if floor:
        for row in range(rows):
            line = floor[row] if row < len(floor) else ""
            for col in range(cols):
                mark = line[col] if col < len(line) else OUTSIDE
                index = row * cols + col
                if mark == OUTSIDE:
                    grid.cells[index] = WALL_CELL
                    grid.level[index] = -1
                else:
                    grid.level[index] = int(mark, 36)

    for item in plan.items:
        if item.kind == BLOCKED:
            _paint(grid, item, WALL_CELL)
        elif item.kind == RACKS:
            _paint_racks(grid, item, constants)
    # Пандус, станция, буфер и ворота вырезают себе место в зоне хранения: стеллажей под ними
    # нет, робот туда заезжает. Так вещь можно поставить внутрь зоны, не дробя ее на куски.
    for item in plan.items:
        if item.kind in CARVE:
            for col, row in grid.cells_of(item):
                if grid.at(col, row) == RACK_CELL:
                    grid.cells[row * cols + col] = FREE
    for item in plan.of(RAMP):
        for col, row in grid.cells_of(item):
            if grid.floor(col, row):
                grid.ramps.add(row * cols + col)
    for item in plan.of(FLOW):
        if item.direction in DIRECTIONS:
            for col, row in grid.cells_of(item):
                grid.oneway[row * cols + col] = DIRECTIONS[item.direction]
    return grid


def _paint(grid: Grid, item: Item, value: int) -> None:
    for col, row in grid.cells_of(item):
        grid.cells[row * grid.cols + col] = value


def _paint_racks(grid: Grid, item: Item, constants: dict) -> None:
    """Режет зону хранения на ряды по rack_cut: проверяем центр каждой клетки."""
    cut = rack_cut(item, constants)
    for col, row in grid.cells_of(item):
        if grid.at(col, row) != FREE:
            continue  # вне здания стеллаж не встанет
        x, y = grid.point(col, row)
        across, along = (y - item.y, x - item.x) if item.rows == "x" else (x - item.x, y - item.y)
        if in_rack(cut, across, along):
            grid.cells[row * grid.cols + col] = RACK_CELL


# --- расстояния -------------------------------------------------------------------------


def distances(grid: Grid, sources: list[tuple[int, int]], toward: bool = True) -> list[float]:
    """Волна от нескольких точек сразу: до какой клетки сколько метров ехать.

    Обход в ширину по четырем соседям. По клетке в метр это движение по проездам с объездом
    стеллажей, а не расстояние по прямой. Между уровнями пола волна проходит только по пандусу.

    toward говорит, куда едет робот: от клетки к источнику (по умолчанию, так считается путь до
    ворот) или от источника к клетке. Пока на плане нет линии движения, это одно и то же, а по
    полосе в одну сторону путь туда и путь обратно разные.
    """
    return reach(grid, sources, toward)[0]


def reach(grid: Grid, sources: list[tuple[int, int]], toward: bool = True) -> tuple[list[float], list[int]]:
    """Та же волна, но еще и с клеткой-источником: из какой клетки буфера пришел путь.

    Буфер у ворот это полоса вдоль стены, и робот разгружается в той ее клетке, куда приехал,
    а не в первой клетке полосы. -1 у клетки, до которой волна не дошла.
    """
    field_m = [INF] * len(grid.cells)
    origin = [-1] * len(grid.cells)
    queue: deque[tuple[int, int]] = deque()
    for col, row in sources:
        index = row * grid.cols + col
        if grid.free(col, row) and field_m[index] == INF:
            field_m[index] = 0.0
            origin[index] = index
            queue.append((col, row))
    while queue:
        col, row = queue.popleft()
        here = row * grid.cols + col
        step = field_m[here] + grid.step_m
        for dc, dr in NEIGHBOURS:
            nc, nr = col + dc, row + dr
            if not grid.free(nc, nr):
                continue
            there = nr * grid.cols + nc
            # волна идет от источника, а робот к нему: при toward он едет из there в here
            moves = grid.allows(there, here, -dc, -dr) if toward else grid.allows(here, there, dc, dr)
            if field_m[there] == INF and grid.joins(here, there) and moves:
                field_m[there] = step
                origin[there] = origin[here]
                queue.append((nc, nr))
    return field_m, origin


def sources_of(grid: Grid, items: list[Item]) -> list[tuple[int, int]]:
    """Проезжие клетки под прямоугольниками: отсюда пускаем волну."""
    return [cell for item in items for cell in grid.cells_of(item) if grid.free(*cell)]


def targets(plan: Plan) -> list[Item]:
    """Куда робот везет груз: в буфер у ворот, а если буфера нет, прямо к воротам."""
    return plan.of(BUFFER) or plan.of(DOCK)


def task_cells(grid: Grid) -> list[tuple[int, int]]:
    """Где рождаются задания: проезжая клетка у торца стеллажа.

    Случайная точка не годится: она может попасть внутрь стеллажа. Робот забирает груз из прохода, а не изнутри ряда, поэтому берем лицевые клетки.
    """
    found = []
    for row in range(grid.rows):
        for col in range(grid.cols):
            if grid.at(col, row) != FREE:
                continue
            if any(
                grid.at(col + dc, row + dr) == RACK_CELL for dc, dr in NEIGHBOURS if grid.inside(col + dc, row + dr)
            ):
                found.append((col, row))
    return found


def serpentine(item: Item, constants: dict, first: str = "") -> list[Item]:
    """Линия движения змейкой по проездам зоны хранения: в соседних проездах в разные стороны.

    Так часто делают на складах, где ездят погрузчики или роботы: по проезду едут в одну сторону,
    навстречу никто не попадается, и разъезжаться не надо. Одним действием на всю зону, чтобы
    не рисовать полосу в каждый проезд. Поперечные и главные проезды остаются двусторонними.
    """
    cut = rack_cut(item, constants)
    along_x = item.rows == "x"
    ways = ("east", "west") if along_x else ("north", "south")
    if first in ways and first != ways[0]:
        ways = (ways[1], ways[0])
    lanes = []
    for gap in range(cut.blocks - 1):
        start = cut.offset + gap * cut.pitch + cut.band
        width = cut.pitch - cut.band
        x, y, w, h = (item.x, item.y + start, item.w, width) if along_x else (item.x + start, item.y, width, item.h)
        lanes.append(Item(id=f"{item.id}-flow-{gap}", kind=FLOW, x=x, y=y, w=w, h=h, direction=ways[gap % 2]))
    return lanes


def rack_of(plan: Plan, grid: Grid, cell: tuple[int, int]) -> Item | None:
    """Зона хранения, к стеллажу которой примыкает место: место это клетка проезда у ряда."""
    col, row = cell
    for dc, dr in NEIGHBOURS:
        if grid.inside(col + dc, row + dr) and grid.at(col + dc, row + dr) == RACK_CELL:
            x, y = grid.point(col + dc, row + dr)
            for item in plan.of(RACKS):
                if item.x <= x < item.x + item.w and item.y <= y < item.y + item.h:
                    return item
    return None


def trace(grid: Grid, field_m: list[float], start: tuple[int, int], toward: bool = True) -> list[tuple[float, float]]:
    """Путь от клетки до ближайшего источника волны: спуск по полю расстояний.

    Возвращаем ломаную по точкам поворота, а не все клетки подряд. Прямым отрезком такой путь
    не описать: он прошел бы сквозь стеллажи. Ломаная всегда идет от клетки к источнику. Если
    поле посчитано от источника (toward=False), робот едет по ней в обратную сторону, и шаги
    проверяем в его направлении.
    """
    col, row = start
    if not grid.free(col, row) or field_m[row * grid.cols + col] == INF:
        return [grid.point(col, row)]
    path = [(col, row)]
    while field_m[row * grid.cols + col] > 0:
        here = row * grid.cols + col
        options = [
            (col + dc, row + dr)
            for dc, dr in NEIGHBOURS
            if grid.free(col + dc, row + dr)
            and grid.joins(here, (row + dr) * grid.cols + col + dc)
            and (
                grid.allows(here, (row + dr) * grid.cols + col + dc, dc, dr)
                if toward
                else grid.allows((row + dr) * grid.cols + col + dc, here, -dc, -dr)
            )
        ]
        if not options:
            break
        best = min(options, key=lambda cell: field_m[cell[1] * grid.cols + cell[0]])
        if field_m[best[1] * grid.cols + best[0]] >= field_m[here]:
            break
        col, row = best
        path.append(best)
    return simplify([grid.point(col, row) for col, row in path])


def simplify(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Оставляем только точки поворота: по складу с рядами их обычно три-пять."""
    if len(points) < 3:
        return list(points)
    kept = [points[0]]
    for before, here, after in zip(points, points[1:], points[2:], strict=False):
        if (here[0] - before[0], here[1] - before[1]) != (after[0] - here[0], after[1] - here[1]):
            kept.append(here)
    kept.append(points[-1])
    return kept


# --- проезды между рядами ---------------------------------------------------------------


@dataclass(frozen=True)
class Corridor:
    """Проезд между двумя блоками рядов от одного поперечного проезда до другого.

    Здесь роботы и мешают друг другу: разъехаться негде, а робот, который грузит у стеллажа,
    стоит в проезде. key одинаковый у всех мест одного проезда, ends это клетки сразу за его
    концами, через них робот въезжает и выезжает.
    """

    key: tuple[int, int, int]  # зона хранения, номер проезда поперек рядов, номер части ряда
    ends: tuple[tuple[int, int], ...]


def corridor_of(plan: Plan, constants: dict, grid: Grid, cell: tuple[int, int]) -> Corridor | None:
    """В каком проезде между рядами стоит место. None значит «не в проезде».

    Место у внешнего края зоны, в поперечном проезде или на вырезанном под вещь пятачке
    ни в какой проезд не входит: там главный проезд или открытый пол, и места в нем мы
    не ограничиваем. Ряды режем тем же rack_cut, что и сетку, поэтому проезд здесь тот же,
    что на плане.
    """
    x, y = grid.point(*cell)
    for number, item in enumerate(plan.of(RACKS)):
        if not (item.x <= x < item.x + item.w and item.y <= y < item.y + item.h):
            continue
        cut = rack_cut(item, constants)
        across, along = (y - item.y, x - item.x) if item.rows == "x" else (x - item.x, y - item.y)
        at = across - cut.offset
        if at < 0 or at >= cut.used or at % cut.pitch < cut.band:
            return None  # край зоны или пятачок внутри блока
        part = cut.seg + cut.cross
        if along % part >= cut.seg:
            return None  # поперечный проезд
        segment = int(along // part)
        ends = []
        for end in (segment * part - GRID_M / 2, segment * part + cut.seg + GRID_M / 2):
            spot = grid.cell(item.x + end, y) if item.rows == "x" else grid.cell(x, item.y + end)
            if grid.free(*spot) and spot != cell:
                ends.append(spot)
        return Corridor((number, int(at // cut.pitch), segment), tuple(ends))
    if grid.gap_cells is None:
        grid.gap_cells = _gap_cells(plan, constants, grid)
    return grid.gap_cells.get(cell[1] * grid.cols + cell[0])


def _gap_cells(plan: Plan, constants: dict, grid: Grid) -> dict[int, Corridor]:
    """Клетки проездов между отдельными рядами. Концы проезда это клетки сразу за общим куском
    двух рядов на той же линии, что и место: через них робот въезжает и выезжает."""
    found: dict[int, Corridor] = {}
    for gap in gaps_between(plan.of(RACKS), constants):
        x, y, w, h = gap.rect()
        for col, row in grid.cells_of(Item(id="", kind=AISLE, x=x, y=y, w=w, h=h)):
            cx, cy = grid.point(col, row)
            if not (x <= cx < x + w and y <= cy < y + h) or not grid.free(col, row):
                continue
            if gap.rows == "x":
                ends = [grid.cell(gap.first - GRID_M / 2, cy), grid.cell(gap.last + GRID_M / 2, cy)]
            else:
                ends = [grid.cell(cx, gap.first - GRID_M / 2), grid.cell(cx, gap.last + GRID_M / 2)]
            exits = tuple(end for end in ends if grid.free(*end) and end != (col, row))
            found[row * grid.cols + col] = Corridor((-1, gap.low, gap.high), exits)
    return found


def inside_m(grid: Grid, field_m: list[float], cell: tuple[int, int], corridor: Corridor) -> float | None:
    """Сколько метров робот едет по проезду от места до выхода к цели.

    Выход тот конец, через который лежит кратчайший путь: волна до места равна волне до конца
    плюс путь по проезду. Если не сходится ни один конец, значит к месту есть путь короче,
    например через проезд, положенный поперек зоны рукой. Тогда проезда не знаем и отдаем None.
    """
    here = field_m[cell[1] * grid.cols + cell[0]]
    found = [
        (abs(end[0] - cell[0]) + abs(end[1] - cell[1])) * grid.step_m
        for end in corridor.ends
        if field_m[end[1] * grid.cols + end[0]] + (abs(end[0] - cell[0]) + abs(end[1] - cell[1])) * grid.step_m
        <= here + 1e-6
    ]
    return min(found) if found else None


# --- зарядку ставит программа -----------------------------------------------------------


def place_charge(plan: Plan, constants: dict) -> Item | None:
    """Место для зарядки: рядом с тем, куда роботы возят груз, но так, чтобы не мешать проезду.

    Зарядку человек ставить не должен: у нее одна задача, и ее можно посчитать. Робот едет
    заряжаться после разгрузки, поэтому крюк считаем от буфера у ворот. Кандидаты это места
    вдоль стены на свободном полу, не в буфере, не на станциях и не у ворот. Из самых близких
    берем первое, которое не удлиняет маршрут и не отрезает ни одного места у стеллажей.

    Сколько мест в зоне, решает расчет парка, а не план: на шаге плана робот еще не выбран.
    """
    along = round(constants["rack_bay_m"] * 4)
    depth = round(constants["aisle_main_m"])
    base = replace(plan, items=[item for item in plan.items if item.kind != CHARGE])
    grid = rasterize(base, constants)
    field_m = distances(grid, sources_of(grid, targets(base)))
    busy = [item for item in base.items if item.kind in (DOCK, BUFFER, STATION, RAMP)]

    blocked = _prefix(grid, lambda index: grid.cells[index] != FREE or field_m[index] == INF)
    taken = _prefix_of(grid, busy)
    cost = _prefix(grid, lambda index: 0 if field_m[index] == INF else field_m[index])

    found: list[tuple[float, Item]] = []
    for w, h in ((along, depth), (depth, along)):
        for row in range(grid.rows - h + 1):
            for col in range(grid.cols - w + 1):
                if _sum(blocked, grid, col, row, w, h) or _sum(taken, grid, col, row, w, h):
                    continue
                if not _hugs_wall(grid, col, row, w, h):
                    continue
                if len({grid.height((row + r) * grid.cols + col + c) for r in (0, h - 1) for c in (0, w - 1)}) > 1:
                    continue
                mean = _sum(cost, grid, col, row, w, h) / (w * h)
                found.append((mean, Item(id="charge", kind=CHARGE, x=col, y=row, w=w, h=h, auto=True)))
    if not found:
        return None

    found.sort(key=lambda pair: pair[0])
    before = _route(base, constants)
    for _, candidate in found[:CHARGE_CANDIDATES]:
        # проверяем, не перегородит ли зона проезд, если в ней будут стоять роботы
        blocker = Item(id="probe", kind=BLOCKED, x=candidate.x, y=candidate.y, w=candidate.w, h=candidate.h)
        probe = replace(base, items=[*base.items, blocker])
        after = _route(probe, constants)
        if after[1] >= before[1] and after[0] <= before[0] + CHARGE_ROUTE_TOLERANCE_M:
            return candidate
    return found[0][1]


def _route(plan: Plan, constants: dict) -> tuple[float, int]:
    """Средний маршрут и сколько мест у стеллажей достижимо: этим проверяем, не мешает ли зарядка."""
    grid = rasterize(plan, constants)
    field_m = distances(grid, sources_of(grid, targets(plan)))
    reach = [field_m[row * grid.cols + col] for col, row in task_cells(grid) if field_m[row * grid.cols + col] < INF]
    return (sum(reach) / len(reach) if reach else 0.0), len(reach)


def _prefix(grid: Grid, value) -> list[float]:
    """Суммы по прямоугольникам за одно обращение: иначе перебор мест для зарядки идет минутами."""
    width = grid.cols + 1
    table = [0.0] * (width * (grid.rows + 1))
    for row in range(grid.rows):
        line = 0.0
        for col in range(grid.cols):
            line += value(row * grid.cols + col)
            table[(row + 1) * width + col + 1] = table[row * width + col + 1] + line
    return table


def _prefix_of(grid: Grid, items: list[Item]) -> list[float]:
    mask = bytearray(grid.cols * grid.rows)
    for item in items:
        for col, row in grid.cells_of(item):
            mask[row * grid.cols + col] = 1
    return _prefix(grid, lambda index: mask[index])


def _sum(table: list[float], grid: Grid, col: int, row: int, w: int, h: int) -> float:
    width = grid.cols + 1
    return (
        table[(row + h) * width + col + w]
        - table[row * width + col + w]
        - table[(row + h) * width + col]
        + table[row * width + col]
    )


def _hugs_wall(grid: Grid, col: int, row: int, w: int, h: int) -> bool:
    """Зона прижата к стене целой стороной: так она не торчит посреди проезда."""
    sides = (
        [(col + c, row - 1) for c in range(w)],
        [(col + c, row + h) for c in range(w)],
        [(col - 1, row + r) for r in range(h)],
        [(col + w, row + r) for r in range(h)],
    )
    return any(all(not grid.floor(c, r) for c, r in side) for side in sides)


# --- что план двигает в расчете ---------------------------------------------------------


@dataclass
class RouteMap:
    """Карта пути до буфера у ворот: чем красить пол в слое «далеко от ворот».

    Строки участка с юга на север, символ на клетку: цифра это ступень цвета, восклицательный
    знак это проезжая клетка, до которой не доехать, точка это стеллаж, стена или улица, ее не
    красим. Границы ступеней в метрах лежат отдельно, их на одну больше, чем ступеней.
    """

    rows: list[str] = field(default_factory=list)
    bands_m: list[float] = field(default_factory=list)


@dataclass
class Measures:
    """Числа, которые план отдает расчету. Декораций на плане нет: у каждой вещи свое число."""

    width_m: float  # габариты здания, а не участка
    length_m: float
    area_m2: float  # площадь пола здания
    docks: int  # мест у ворот: сколько роботов разгружаются одновременно
    buffers: int
    stations: int
    aisles: int  # проездов между рядами: столько роботов едут, не мешая друг другу
    aisle_m: float  # самый узкий проезд: он идет в подбор решений
    rack_depth_m: float  # глубина ряда стеллажей: по ней редактор рисует ряды тем же шагом
    cross_aisle_m: float  # поперечный проезд через каждые run_m: тоже нужен редактору для рядов
    rack_top_m: float  # самый высокий верхний ярус: он идет в подбор, до него должен достать штабелер
    levels: int  # сколько разных уровней пола в здании
    ramps: int  # пандусы: робот должен их брать, а уклон у роботов почти никто не публикует
    route_m: float  # средний маршрут от места у стеллажа до буфера у ворот
    route_to_station_m: float  # то же до ближайшей станции комплектации
    charge_detour_m: float  # крюк от буфера до зоны зарядки
    storage_m2: float
    storage_share: float
    task_points: int
    unreachable_points: int
    closed_racks: int = 0  # зоны, в блок которых робот не заезжает: набивной и мобильный стеллаж
    unreachable: list[tuple[int, int]] = field(default_factory=list)  # клетки мест, до которых не доехать
    route_map: RouteMap = field(default_factory=RouteMap)  # путь до буфера по клеткам: слой на плане
    checks: list[Check] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class Check:
    """Строка списка проверок плана. Ни одна не запрещает идти дальше."""

    label: str
    ok: bool
    detail: str = ""  # что не так, если не ok


UNREACHABLE_SHOWN = 4000  # больше клеток на плане не рисуем: красного и так будет видно
ROUTE_BANDS = 12  # не больше стольких ступеней в слое «далеко от ворот»; шаг красивое число, так что бывает меньше
NICE_STEPS_M = (5, 10, 20, 25, 50, 100, 200, 500)  # шаг ступени округляем до красивого числа


def measure(plan: Plan, constants: dict) -> Measures:
    """Считает план один раз: волна от буферов, волна от станций, площади и предупреждения."""
    grid = rasterize(plan, constants)
    docks, stations, charge = plan.of(DOCK), plan.of(STATION), plan.of(CHARGE)
    tasks = task_cells(grid)

    to_target = distances(grid, sources_of(grid, targets(plan)))
    # С линией движения путь от ворот к месту и обратно разный: маршрут считаем как половину
    # круга туда и обратно, чтобы формула «2 * маршрут» дала тот же цикл.
    from_target = distances(grid, sources_of(grid, targets(plan)), toward=False) if plan.of(FLOW) else to_target
    to_station = distances(grid, sources_of(grid, stations)) if stations else []

    reachable = [cell for cell in tasks if _read(grid, to_target, cell) < INF and _read(grid, from_target, cell) < INF]
    lost = [cell for cell in tasks if _read(grid, to_target, cell) == INF or _read(grid, from_target, cell) == INF]

    racks = plan.of(RACKS)
    storage = sum(_storage_area(item, constants) for item in racks)
    aisle_m = narrowest(racks, constants)
    floor = [index for index, level in enumerate(grid.level) if level >= 0]
    width, length = _bounds(grid, floor)
    used = {grid.height(index) for index in floor}

    measures = Measures(
        width_m=width,
        length_m=length,
        area_m2=len(floor) * grid.step_m**2,
        docks=len(docks),
        buffers=len(plan.of(BUFFER)),
        stations=len(stations),
        aisles=aisle_count(racks, constants),
        aisle_m=aisle_m,
        rack_depth_m=constants["rack_depth_m"],
        cross_aisle_m=constants["aisle_main_m"],
        rack_top_m=max((top_of(item) for item in racks), default=0.0),
        levels=len(used),
        ramps=len(plan.of(RAMP)),
        route_m=_mean((_read(grid, to_target, cell) + _read(grid, from_target, cell)) / 2 for cell in reachable),
        route_to_station_m=(
            _mean(_read(grid, to_station, cell) for cell in reachable if _read(grid, to_station, cell) < INF)
            if stations
            else 0.0
        ),
        charge_detour_m=min((_read(grid, to_target, cell) for cell in sources_of(grid, charge)), default=0.0),
        storage_m2=storage,
        storage_share=storage / (len(floor) * grid.step_m**2) if floor else 0.0,
        task_points=len(tasks),
        unreachable_points=len(lost),
        closed_racks=sum(1 for item in racks if not rack_type(constants, item.rack_type).get("robot_inside", True)),
        unreachable=lost[:UNREACHABLE_SHOWN],
    )
    measures.route_map = route_map(grid, to_target)
    measures.checks = _checks(plan, grid, measures, constants, lost, to_target)
    measures.warnings = [check.detail for check in measures.checks if not check.ok]
    return measures


def aisle_widths(racks: list[Item], constants: dict, people: bool = False) -> list[float]:
    """Ширины проездов между рядами. У отдельных рядов это пол между соседями, у старой зоны
    ее число. Ряд, которому не с кем образовать проезд, дает свое число проезда: оно задано
    типом стеллажа. people оставляет только проезды, где работают люди с погрузчиками."""
    allowed = [not people or rack_type(constants, item.rack_type).get("people", True) for item in racks]
    gaps = gaps_between(racks, constants)
    paired = {gap.low for gap in gaps} | {gap.high for gap in gaps}
    found = [gap.width for gap in gaps if allowed[gap.low] or allowed[gap.high]]
    found += [
        item.aisle_m
        for index, item in enumerate(racks)
        if allowed[index] and index not in paired and item.aisle_m > 0 and (not gaps or not is_row(item, constants))
    ]
    return found


def narrowest(racks: list[Item], constants: dict) -> float:
    """Самый узкий проезд: он идет в подбор решений."""
    return min(aisle_widths(racks, constants), default=0.0)


def _bounds(grid: Grid, floor: list[int]) -> tuple[float, float]:
    if not floor:
        return grid.cols * grid.step_m, grid.rows * grid.step_m
    cols = [index % grid.cols for index in floor]
    rows = [index // grid.cols for index in floor]
    return (max(cols) - min(cols) + 1) * grid.step_m, (max(rows) - min(rows) + 1) * grid.step_m


def route_map(grid: Grid, field_m: list[float]) -> RouteMap:
    """Слой «далеко от ворот»: каждая проезжая клетка получает ступень по длине пути до буфера.

    Ступеней до двенадцати: шаг ступени это самый длинный путь, поделенный на двенадцать и
    округленный вверх до красивого числа: 5, 10, 20, 25, 50 метров, а ступеней столько, сколько
    таких шагов укладывается в самый длинный путь. Так шкала кончается на «160 м», а не на «240».
    Красим только проезжие клетки: путь считается по ним. Под стеллажами ничего нет.
    """
    far = max((value for value in field_m if value < INF), default=0.0)
    if not far or not field_m:
        return RouteMap()
    raw = far / ROUTE_BANDS
    step = next((nice for nice in NICE_STEPS_M if nice >= raw), NICE_STEPS_M[-1])
    count = max(1, math.ceil(far / step - 1e-6))
    rows = []
    for row in range(grid.rows):
        line = []
        for col in range(grid.cols):
            index = row * grid.cols + col
            if grid.cells[index] != FREE:
                line.append(OUTSIDE)
            elif field_m[index] == INF:
                line.append("!")
            else:
                line.append(_digit(min(count - 1, int(field_m[index] // step))))
        rows.append("".join(line))
    return RouteMap(rows=rows, bands_m=[float(step * band) for band in range(count + 1)])


def _read(grid: Grid, field_m: list[float], cell: tuple[int, int]) -> float:
    return field_m[cell[1] * grid.cols + cell[0]] if field_m else INF


def _mean(values) -> float:
    collected = [value for value in values if value < INF]
    return sum(collected) / len(collected) if collected else 0.0


def _storage_area(item: Item, constants: dict) -> float:
    """Площадь под стеллажами по геометрии, а не по клеткам.

    Сетка в метр округляет ряды и занижает площадь примерно на десятую часть. Расстояния
    по сетке считать правильно, а площадь нет: ее считаем по тем же числам, которыми ряды нарезаны.
    """
    cut = rack_cut(item, constants)
    return cut.blocks * cut.band * cut.segments * cut.seg


def aisle_count(racks: list[Item], constants: dict) -> int:
    """Сколько проездов: у каждого блока рядов свой. У мобильного стеллажа блок это несколько
    рядов вплотную, и проезд в нем открыт один. Ряд, который поперечный проезд разрезал на куски,
    остается одним рядом: куски одной группы на одной линии считаем один раз."""
    lines = set()
    total = 0
    for item in racks:
        if not is_row(item, constants):
            total += rack_cut(item, constants).blocks
            continue
        across = _spans(item, constants)[0]
        lines.add((item.group or item.id, item.rows, round(across, 3)))
    return total + len(lines)


# Запас на округление: ряды на листе стоят до сантиметра, а проезд робозоны ровно по минимуму
AISLE_SLACK_M = 0.05


def robot_aisle_m(constants: dict) -> float:
    """Проезд, который мы закладываем роботу между рядами: каталожный минимум робота с запасом,
    тот же, что у проездов робозоны (config/layouts.yaml, aisle_robot_zone_m, оценка F).
    Уже него проезд впритык, но робот проходит, пока проезд не уже его каталожного минимума."""
    return constants["aisle_robot_zone_m"]


def narrow_aisles(racks: list[Item], constants: dict, need_m: float | None = None) -> list[float]:
    """Проезды между рядами уже need_m, от самого узкого. Без need_m это проезд, который мы
    закладываем роботу (robot_aisle_m) с запасом на округление.

    Сетка плана в метр, и проезд в полметра на ней то исчезает, то становится проезжей клеткой:
    прогон смены повез бы робота там, где он не пройдет. Поэтому узкий проезд видно до расчета.
    У старой зоны на много рядов проезды внутри нее, их ширина это ее число проезда."""
    need = robot_aisle_m(constants) - AISLE_SLACK_M if need_m is None else need_m
    widths = [gap.width for gap in gaps_between(racks, constants)]
    widths += [
        item.aisle_m
        for item in racks
        if not is_row(item, constants) and item.aisle_m > 0 and rack_cut(item, constants).blocks > 1
    ]
    return sorted(width for width in widths if width < need)


def touching_rows(racks: list[Item], constants: dict) -> int:
    """Сколько рядов стоят впритык к соседу или наезжают на него: пола между ними нет, и к стеллажам
    с этой стороны робот не подъедет. Куски одного ряда на одной линии соседями не считаем: их
    разделяет поперечный проезд. Ряды сортируем поперек, чтобы не сравнивать каждый с каждым."""
    found: set[int] = set()
    for axis in ("x", "y"):
        rows = sorted(
            (
                (spans, index)
                for index, item in enumerate(racks)
                if item.rows == axis and is_row(item, constants)
                for spans in [_spans(item, constants)]
            ),
            key=lambda one: one[0][0],
        )
        for at, ((_a0, a1, al0, al1), low) in enumerate(rows):
            for (b0, _b1, bl0, bl1), high in rows[at + 1 :]:
                if b0 > a1 + EPS:
                    break
                if min(al1, bl1) - max(al0, bl0) > EPS:
                    found.update((low, high))
    return len(found)


def _level_of(grid: Grid, item: Item) -> int:
    """Уровень, на котором стоит вещь: тот, что под большинством ее клеток."""
    seen = [grid.level[row * grid.cols + col] for col, row in grid.cells_of(item)]
    seen = [level for level in seen if level >= 0]
    return max(set(seen), key=seen.count) if seen else -1


def _checks(
    plan: Plan, grid: Grid, measures: Measures, constants: dict, lost: list, to_target: list[float]
) -> list[Check]:
    """Что с планом так и что не так. Ничего не запрещаем: свой объект человек знает лучше нас.

    Проверки идут списком с галочками, а не только ошибками: закрытая проверка видна так же,
    как открытая, и план хочется довести, а не просто не замечать предупреждений.
    """
    found = [
        Check(
            "Есть ворота",
            measures.docks > 0,
            "На плане нет ворот: роботу некуда везти груз и неоткуда начинать маршрут",
        ),
    ]
    inside = [dock for dock in plan.of(DOCK) if not _on_outer_wall(grid, dock)]
    if measures.docks:
        found.append(
            Check(
                "Ворота в наружной стене",
                not inside,
                f"Ворот не в наружной стене: {len(inside)}. Машина к ним не подъедет",
            )
        )
    found.append(
        Check(
            "Есть зона хранения",
            measures.task_points > 0,
            "На плане нет зон хранения: заданиям неоткуда браться, маршрут посчитать нечем",
        )
    )

    other = 0
    if lost:
        reached = {grid.height(index) for index, value in enumerate(to_target) if value < INF}
        other = sum(1 for col, row in lost if grid.height(row * grid.cols + col) not in reached)
    if other:
        found.append(
            Check(
                "Все места у стеллажей доступны",
                False,
                f"До {other} мест у стеллажей робот не доедет: они на другом уровне пола, а пандуса туда нет",
            )
        )
    if len(lost) > other:
        found.append(
            Check(
                "Все места у стеллажей доступны",
                False,
                f"До {len(lost) - other} мест у стеллажей робот не доедет: "
                "проезд перекрыт другой зоной или стеллажи сомкнуты",
            )
        )
    if not lost and measures.task_points:
        found.append(Check("Все места у стеллажей доступны", True))

    levels = grid.levels
    tall = []
    for item in plan.of(RACKS):
        level = _level_of(grid, item)
        ceiling = levels[level].ceiling_m if 0 <= level < len(levels) else 0.0
        if ceiling and top_of(item) > ceiling:
            tall.append(f"Верхний ярус {top_of(item):.1f} м выше потолка {ceiling:.1f} м: стеллаж не встанет")
    if plan.of(RACKS):
        found += [Check("Стеллажи ниже потолка", False, text) for text in tall] or [
            Check("Стеллажи ниже потолка", True)
        ]

    dead = [item for item in plan.of(RAMP) if len(_heights_around(grid, item)) < 2]
    if plan.of(RAMP):
        found += [
            Check(
                "Пандусы ведут на другой уровень",
                False,
                "Пандус никуда не ведет: с обоих его концов пол на одной отметке",
            )
            for _ in dead
        ] or [Check("Пандусы ведут на другой уровень", True)]

    found += _station_check(plan, constants)

    racks = plan.of(RACKS)
    robot = robot_aisle_m(constants)
    if racks:
        tight = narrow_aisles(racks, constants)
        more = f" Таких проездов на плане: {len(tight)}." if len(tight) > 1 else ""
        # Робот на шаге плана еще не выбран: сравниваем с тем, что закладываем, и только предупреждаем.
        # Расчет блокирует шаг экономики, когда проезд уже каталожного минимума выбранного робота
        found.append(
            Check(
                "Робот проходит между рядами",
                not tight,
                (
                    f"Между рядами {_comma(tight[0])} м, а мы советуем роботам не меньше {_comma(robot)} м."
                    f"{more} Если выбранному роботу по каталогу нужно больше, чем есть, экономику не посчитать: "
                    "раздвиньте ряды"
                )
                if tight
                else "",
            )
        )
    touching = touching_rows(racks, constants)
    if touching:
        found.append(
            Check(
                "Ряды не стоят впритык",
                False,
                f"Рядов впритык к соседу: {touching}. Проезда между ними нет, и к стеллажам с этой стороны "
                f"робот не подъедет: раздвиньте ряды хотя бы на {_comma(robot)} м",
            )
        )

    # в зоне без людей проезд под робота это норма, а не ошибка
    narrow = min(constants["aisle_reach_truck_m"], constants["aisle_forklift_m"])
    shared = aisle_widths(racks, constants, people=True)
    if shared:
        robot_passes = min(shared) >= robot - AISLE_SLACK_M
        found.append(
            Check(
                "Погрузчик проходит в проезды",
                min(shared) >= narrow,
                f"Самый узкий проезд {_comma(min(shared))} м, а погрузчику нужно от {_comma(narrow)} м. "
                + (
                    "Робот проедет, но пока в зоне работают люди и погрузчики, такой проезд им не подходит"
                    if robot_passes
                    else "Люди с погрузчиками здесь тоже не пройдут"
                ),
            )
        )
    return found


def _station_check(plan: Plan, constants: dict) -> list[Check]:
    """Станции не должны стоять в проезде.

    На листе станция вырезает под собой пол, и маршрут через нее считается проезжим. На деле у
    станции стоит человек и ждут роботы, так что это препятствие. Считаем план, где станции
    заняли место как перегородки: если так до мест у стеллажей не доехать или маршрут заметно
    длиннее, станции перекрывают проезд. Тот же прием, что у зарядки.
    """
    stations = plan.of(STATION)
    if not stations or not plan.of(RACKS):
        return []
    # станция внутри зоны стеллажей, между рядами: там только проезды, и станция их занимает
    racks = plan.of(RACKS)
    zone = (
        min(one.x for one in racks),
        min(one.y for one in racks),
        max(one.x + one.w for one in racks),
        max(one.y + one.h for one in racks),
    )
    inside = [
        one
        for one in stations
        if min(one.x + one.w, zone[2]) - max(one.x, zone[0]) > 0.5
        and min(one.y + one.h, zone[3]) - max(one.y, zone[1]) > 0.5
    ]
    if inside:
        return [
            Check(
                "Станции не перекрывают проезд",
                False,
                f"Станций между рядами стеллажей: {len(inside)}. Там проезды, а у станции стоит человек и ждут роботы. "
                "Поставьте станции у края зоны, а не в проездах между рядами",
            )
        ]
    # станция стоит прямо у стеллажа: закрывает места, откуда берут груз, или торец ряда
    grid = rasterize(plan, constants)
    faces = set(task_cells(grid))
    covered = {cell for one in stations for cell in grid.cells_of(one)} & faces
    if covered:
        return [
            Check(
                "Станции не перекрывают проезд",
                False,
                f"Станции стоят вплотную к стеллажам и закрывают {len(covered)} мест, откуда берут груз. "
                "Поставьте станции у края зоны, а не в проездах между рядами",
            )
        ]
    before = _route(plan, constants)
    walls = [Item(id=f"probe-{one.id}", kind=BLOCKED, x=one.x, y=one.y, w=one.w, h=one.h) for one in stations]
    after = _route(replace(plan, items=[*[item for item in plan.items if item.kind != STATION], *walls]), constants)
    lost = before[1] - after[1]
    longer = after[0] - before[0]
    if lost > 0:
        return [
            Check(
                "Станции не перекрывают проезд",
                False,
                f"Станции стоят в проезде: если у них человек и ждут роботы, до {lost} мест у стеллажей не доехать. "
                "Поставьте станции у края зоны, а не поперек проездов",
            )
        ]
    if longer > STATION_ROUTE_TOLERANCE_M:
        return [
            Check(
                "Станции не перекрывают проезд",
                False,
                f"Станции стоят в проезде: объезжать их роботу дальше, маршрут длиннее на {_comma(longer)} м. "
                "Поставьте станции у края зоны, а не поперек проездов",
            )
        ]
    return [Check("Станции не перекрывают проезд", True)]


def _comma(value: float) -> str:
    """Метры для человека: одна цифра после запятой"""
    return f"{value:.1f}".replace(".", ",")


def _heights_around(grid: Grid, item: Item) -> set[float]:
    """Отметки пола под пандусом и вокруг него: пандус нужен, только если их хотя бы две."""
    found = set()
    for col, row in grid.cells_of(item):
        for dc, dr in ((0, 0), *NEIGHBOURS):
            if grid.floor(col + dc, row + dr):
                found.add(grid.height((row + dr) * grid.cols + col + dc))
    return found


def _on_outer_wall(grid: Grid, item: Item) -> bool:
    """Ворота стоят в наружной стене, если рядом с ними есть клетка вне здания."""
    for col, row in grid.cells_of(item):
        for dc, dr in NEIGHBOURS:
            if not grid.inside(col + dc, row + dr) or grid.level[(row + dr) * grid.cols + col + dc] < 0:
                return True
    return False
