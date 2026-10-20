"""Разбор DXF в линии по слоям. Работает в отдельном процессе (см. dxf_underlay.py): тут нет
ничего, кроме ezdxf и стандартной библиотеки, чтобы процесс стартовал быстро.

Из файла берем только геометрию: отрезки, полилинии, дуги, окружности, эллипсы, сплайны и то,
что лежит внутри блоков и размеров. Надписи, штриховка и сплошные заливки не рисуются, но слой с
ними остается в списке, чтобы человек видел, что это за слой и что его можно не включать.
Ничего из файла не исполняется: DXF это данные, а ezdxf их только читает."""

from __future__ import annotations

import io
import math
import re

MAX_ENTITIES = 400_000  # объектов в чертеже; склад на тысячи стеллажей укладывается в десятки тысяч
MAX_POINTS = 3_000_000  # вершин в линиях после разбиения кривых
MIN_FOR_TRIM = 20  # линий, с которых убираем потерянные одиночки далеко в стороне
MAX_DEPTH = 6  # вложенность блоков
SEGMENTS = 2000  # на сколько долей делим длинную сторону, когда разбиваем кривые
MAX_PATH_BYTES = 6 * 1024 * 1024  # линий в ответе: больше браузер не удержит в памяти сайта
ADVICE = "Сохраните в AutoCAD только нужные слои (стены, стеллажи, ворота) или как DXF R2000 без блоков и штриховок"
TOO_BIG = f"В чертеже больше 400 тысяч объектов, он слишком подробный. {ADVICE}"
# $INSUNITS -> метров в единице чертежа
UNIT_M = {1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1.0, 14: 0.1}
UNIT_NAME = {1: "дюймы", 2: "футы", 4: "миллиметры", 5: "сантиметры", 6: "метры", 14: "дециметры"}
GUESS = ((1.0, 6), (0.001, 4), (0.01, 5))  # (метров в единице, код): чаще всего метры или миллиметры
HALL_RANGE_M = (15.0, 1500.0)  # склад короче 15 м или длиннее 1,5 км это не склад
# слова в имени слоя: что на нем обычно лежит
NOISE = re.compile(
    r"dim|размер|text|txt|надпис|штамп|рамк|frame|title|border|grid|сетк|ось|оси|axis|hatch|штрих"
    r"|defpoints|viewport|анно|anno",
    re.I,
)
ROLES = (
    ("walls", re.compile(r"wall|стен|контур|outline", re.I)),
    ("racks", re.compile(r"rack|shelf|стелл|полк|storage|хранен", re.I)),
    ("doors", re.compile(r"door|dock|gate|ворот|двер", re.I)),
)
Line = list[tuple[float, float]]


class Refused(Exception):
    """Файл нельзя взять: текст для человека"""


def _stream(content: bytes):
    import ezdxf
    from ezdxf import recover

    try:
        # recover читает двоичный поток, угадывает кодировку и прощает мелкие огрехи файла
        doc, _ = recover.read(io.BytesIO(content))
        return doc
    except ezdxf.DXFError as error:
        raise Refused("Файл не читается как DXF: он поврежден или записан не по правилам формата") from error
    except (UnicodeDecodeError, ValueError, KeyError, IndexError, AttributeError, TypeError) as error:
        raise Refused("Файл не читается как DXF: он поврежден или это другой формат") from error


def _flatten(entity, distance: float) -> list[Line]:
    """Ломаные из объекта: список списков вершин. Отрезки и полилинии без дуг берем как есть, кривые
    делит сам объект: так в разы быстрее, чем через общий путь, а на больших чертежах их сотни тысяч"""
    kind = entity.dxftype()
    try:
        if kind == "LINE":
            start, end = entity.dxf.start, entity.dxf.end
            return [[(start.x, start.y), (end.x, end.y)]]
        if kind == "LWPOLYLINE" and not entity.has_arc and _flat_up(entity):
            points = [(x, y) for x, y in entity.get_points("xy")]
            if entity.closed and len(points) > 2:
                points.append(points[0])
            return [points] if len(points) >= 2 else []
        if kind in ("CIRCLE", "ARC"):
            points = [(v.x, v.y) for v in entity.flattening(distance)]
        elif kind in ("ELLIPSE", "SPLINE"):
            points = [(v.x, v.y) for v in entity.flattening(distance)]
        else:
            return _through_path(entity, distance)
    except (TypeError, ValueError, ZeroDivisionError, AttributeError, IndexError):
        return []
    return [points] if len(points) >= 2 else []


def _flat_up(entity) -> bool:
    """Полилиния лежит в плане чертежа лицом вверх: ее точки уже в координатах чертежа"""
    extrusion = entity.dxf.extrusion
    return abs(extrusion.x) < 1e-9 and abs(extrusion.y) < 1e-9 and extrusion.z > 0


def _through_path(entity, distance: float) -> list[Line]:
    from ezdxf import path as ezpath

    try:
        made = ezpath.make_path(entity)
    except (TypeError, ValueError, ZeroDivisionError, AttributeError):
        return []
    lines = []
    for sub in made.sub_paths():
        points = [(v.x, v.y) for v in sub.flattening(distance, segments=4)]
        if len(points) >= 2:
            lines.append(points)
    return lines


class _Reader:
    def __init__(self, distance: float, blocks=None):
        self.distance = distance
        self.blocks = blocks  # таблица блоков файла: по ней вставки берут готовые линии блока
        self.layers: dict[str, dict] = {}
        self.points = 0
        self.entities = 0
        self.skipped: dict[str, int] = {}
        # линии каждого блока в его собственных координатах: блок разбираем один раз, а не на каждую вставку
        self.cache: dict[str, _Reader | None] = {}

    def layer(self, name: str) -> dict:
        return self.layers.setdefault(name, {"lines": [], "texts": 0, "fills": 0})

    def skip(self, kind: str, count: int = 1) -> None:
        self.skipped[kind] = self.skipped.get(kind, 0) + count

    def count(self, entities: int, points: int) -> None:
        self.entities += entities
        if self.entities > MAX_ENTITIES:
            raise Refused(TOO_BIG)
        self.points += points
        if self.points > MAX_POINTS:
            raise Refused(f"Чертеж слишком подробный: в нем больше трех миллионов точек. {ADVICE}")

    def take(self, entity, layer: str, depth: int) -> None:
        self.count(1, 0)
        kind = entity.dxftype()
        own = entity.dxf.layer if entity.dxf.hasattr("layer") else layer
        name = layer if own == "0" else own  # слой 0 внутри блока это слой вставки
        if kind in ("TEXT", "MTEXT", "ATTRIB", "ATTDEF"):
            self.layer(name)["texts"] += 1
        elif kind in ("HATCH", "SOLID", "TRACE", "MESH", "3DFACE"):
            self.layer(name)["fills"] += 1
        elif kind == "INSERT" and self.blocks is not None:
            self.insert(entity, name, depth)
        elif kind in ("INSERT", "DIMENSION"):
            self.explode(entity, name, depth)
        elif kind in ("LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "ELLIPSE", "SPLINE"):
            lines = _flatten(entity, self.distance)
            self.count(0, sum(len(one) for one in lines))
            self.layer(name)["lines"].extend(lines)
        else:
            self.skip(kind)

    def explode(self, entity, name: str, depth: int) -> None:
        if depth >= MAX_DEPTH:
            self.skip(entity.dxftype())
            return
        try:
            parts = list(entity.virtual_entities())
        except Exception:  # noqa: BLE001 - битый блок не должен ронять весь файл
            self.skip(entity.dxftype())
            return
        for part in parts:
            self.take(part, name, depth + 1)

    def block(self, title: str, depth: int) -> _Reader | None:
        """Линии блока по слоям в координатах блока; слой 0 остается нулем и потом берет слой вставки"""
        if title not in self.cache:
            inner = _Reader(self.distance, self.blocks)
            inner.cache = self.cache
            try:
                parts = list(self.blocks.get(title))
            except Exception:  # noqa: BLE001 - битый блок не должен ронять весь файл
                parts = None
            if parts is not None:
                for part in parts:
                    inner.take(part, "0", depth + 1)
            self.cache[title] = inner if parts is not None else None
        return self.cache[title]

    def insert(self, entity, name: str, depth: int) -> None:
        if depth >= MAX_DEPTH:
            self.skip("INSERT")
            return
        inner = self.block(entity.dxf.name, depth) if self.blocks.get(entity.dxf.name) is not None else None
        if inner is None:
            self.skip("INSERT")
            return
        try:
            places = [entity.matrix44()] if entity.mcount <= 1 else [one.matrix44() for one in entity.multi_insert()]
        except (TypeError, ValueError, ZeroDivisionError, AttributeError):
            self.skip("INSERT")
            return
        for matrix in places:
            self.place(inner, matrix, name)

    def place(self, inner: _Reader, matrix, name: str) -> None:
        """Готовые линии блока на месте одной вставки: сдвиг, поворот и масштаб матрицей вставки"""
        self.count(inner.entities, inner.points)
        for kind, many in inner.skipped.items():
            self.skip(kind, many)
        for own, stat in inner.layers.items():
            target = self.layer(name if own == "0" else own)
            target["texts"] += stat["texts"]
            target["fills"] += stat["fills"]
            for line in stat["lines"]:
                target["lines"].append([(v.x, v.y) for v in matrix.fast_2d_transform(line)])


def _percentile(values: list[float], share: float) -> float:
    return values[min(len(values) - 1, max(0, int(share * (len(values) - 1))))]


def _core_box(layers: dict[str, dict]) -> tuple[float, float, float, float] | None:
    """Рамка основной части чертежа без одиноких объектов далеко в стороне. Берем 1-й и 99-й
    процентили вершин и добавляем запас в размер рамки с каждой стороны: так склад с парой
    потерянных линий не растягивается на километры."""
    xs: list[float] = []
    ys: list[float] = []
    for layer in layers.values():
        for line in layer["lines"]:
            xs.append(line[0][0])
            ys.append(line[0][1])
    if not xs:
        return None
    if len(xs) < MIN_FOR_TRIM:
        # на малом чертеже проценты ничего не значат: берем все линии, как есть
        return -math.inf, -math.inf, math.inf, math.inf
    step = max(1, len(xs) // 200_000)
    xs, ys = sorted(xs[::step]), sorted(ys[::step])
    x0, x1, y0, y1 = _percentile(xs, 0.01), _percentile(xs, 0.99), _percentile(ys, 0.01), _percentile(ys, 0.99)
    w, h = max(x1 - x0, 1e-9), max(y1 - y0, 1e-9)
    return x0 - w, y0 - h, x1 + w, y1 + h


def _units(doc, span: float) -> dict:
    code = int(doc.header.get("$INSUNITS", 0) or 0)
    if code in UNIT_M:
        return {"code": code, "name": UNIT_NAME[code], "factor_m": UNIT_M[code], "source": "file"}
    for factor, guess in GUESS:
        if HALL_RANGE_M[0] <= span * factor <= HALL_RANGE_M[1]:
            return {"code": guess, "name": UNIT_NAME[guess], "factor_m": factor, "source": "guess"}
    return {"code": 6, "name": UNIT_NAME[6], "factor_m": 1.0, "source": "unknown"}


def _hint(name: str) -> tuple[str, bool]:
    """Что за слой по имени и включать ли его сразу"""
    for role, pattern in ROLES:
        if pattern.search(name):
            return role, True
    if NOISE.search(name):
        return "noise", False
    return "", True


def _path(lines: list[Line], x0: float, y1: float, digits: int) -> str:
    """Путь SVG: ноль в левом верхнем углу рамки, ось y вниз, как в картинке. Точки на сетке с шагом
    10^-digits единиц, после первой точки линии идут сдвиги от предыдущей: так путь короче в разы.
    Соседние точки в одной клетке сетки сливаются, линия в одну клетку пропадает: на экране это точка"""
    step = 10.0**-digits

    def text(cells: int) -> str:
        return str(cells * round(step)) if digits <= 0 else f"{cells * step:.{digits}f}"

    parts = []
    for line in lines:
        cells = [(round((x - x0) / step), round((y1 - y) / step)) for x, y in line]
        kept = [cells[0]] + [cell for before, cell in zip(cells, cells[1:], strict=False) if cell != before]
        if len(kept) < 2:
            continue
        moves = " ".join(f"{text(x - px)} {text(y - py)}" for (px, py), (x, y) in zip(kept, kept[1:], strict=False))
        parts.append(f"M{text(kept[0][0])} {text(kept[0][1])}l{moves}")
    return "".join(parts)


def _paths(kept: dict[str, list[Line]], x0: float, y1: float, span: float) -> dict[str, str]:
    """Пути слоев с шагом сетки в десятитысячную долю чертежа. Не влезли в ответ: шаг крупнее в 10 раз,
    и еще раз. Подложка это картинка под планом, сотой доли чертежа на ней хватает"""
    finest = 4 - int(math.floor(math.log10(span))) if span > 0 else 2
    for digits in range(finest, finest - 3, -1):
        paths = {name: _path(lines, x0, y1, min(6, digits)) for name, lines in kept.items()}
        if sum(len(one) for one in paths.values()) <= MAX_PATH_BYTES:
            break
    return paths


def _near(layers: dict[str, dict], core) -> tuple[dict[str, list[Line]], int]:
    """Линии, у которых хоть одна вершина в основной рамке; сколько отброшено"""
    x0, y0, x1, y1 = core
    kept: dict[str, list[Line]] = {}
    far = 0
    for name, layer in layers.items():
        kept[name] = []
        for line in layer["lines"]:
            if any(x0 <= x <= x1 and y0 <= y <= y1 for x, y in line):
                kept[name].append(line)
            else:
                far += 1
    return kept, far


def _box(lines: list[Line]) -> list[float] | None:
    if not lines:
        return None
    xs = [x for line in lines for x, _ in line]
    ys = [y for line in lines for _, y in line]
    return [min(xs), min(ys), max(xs), max(ys)]


def _off(doc, name: str) -> bool:
    try:
        layer = doc.layers.get(name)
        return bool(layer.is_off() or layer.is_frozen())
    except Exception:  # noqa: BLE001 - слоя нет в таблице: значит он включен
        return False


def _collect(content: bytes):
    """Разобранный файл, линии по слоям без далеких одиночек и сам читатель (счетчики, пропущенное)"""
    doc = _stream(content)
    modelspace = doc.modelspace()
    if len(modelspace) > MAX_ENTITIES:
        raise Refused(TOO_BIG)

    # шаг разбиения кривых по габариту из заголовка файла; нет габарита, берем 1 единицу
    try:
        low, high = doc.header["$EXTMIN"], doc.header["$EXTMAX"]
        rough = max(abs(high[0] - low[0]), abs(high[1] - low[1]))
    except (KeyError, IndexError, TypeError):
        rough = 0.0
    reader = _Reader(distance=rough / SEGMENTS if 0 < rough < 1e9 else 1.0, blocks=doc.blocks)
    for entity in modelspace:
        reader.take(entity, "0", 0)

    core = _core_box(reader.layers)
    if core is None:
        raise Refused(
            "В чертеже нет линий: только надписи или пустой лист. Проверьте, что план лежит в модели, а не на листе"
        )
    kept, far = _near(reader.layers, core)
    return doc, kept, far, reader


def read(content: bytes) -> dict:
    doc, kept, far, reader = _collect(content)
    boxes = {name: _box(lines) for name, lines in kept.items()}
    present = [box for box in boxes.values() if box]
    if not present:
        raise Refused("В чертеже нет линий, которые можно показать")
    gx0, gy0 = min(b[0] for b in present), min(b[1] for b in present)
    gx1, gy1 = max(b[2] for b in present), max(b[3] for b in present)
    span = max(gx1 - gx0, gy1 - gy0)
    digits = max(0, min(6, 5 - int(math.floor(math.log10(span))))) if span > 0 else 2
    paths = _paths(kept, gx0, gy1, span)

    layers = []
    for name, lines in kept.items():
        stat, box = reader.layers[name], boxes[name]
        role, shown = _hint(name)
        off = _off(doc, name)
        shape = [box[0] - gx0, box[1] - gy0, box[2] - gx0, box[3] - gy0] if box else [0, 0, 0, 0]
        layers.append(
            {
                "name": name,
                "lines": len(lines),
                "texts": stat["texts"],
                "fills": stat["fills"],
                "role": role,
                "on": bool(shown and box and not off),
                "off_in_file": off,
                # рамка слоя в единицах чертежа от левого нижнего угла всего чертежа, y вверх
                "box": [round(v, digits) for v in shape],
                "d": paths[name],
            }
        )
    layers.sort(key=lambda one: (-one["lines"], one["name"]))
    return {
        "units": _units(doc, span),
        "width": round(gx1 - gx0, digits),
        "height": round(gy1 - gy0, digits),
        "layers": layers,
        "far_away": far,
        "skipped": reader.skipped,
    }


def build(content: bytes, roles: dict[str, str], factor: float, buffer_depth_m: int) -> dict:
    """План по слоям, которым человек назвал роль: здание, ряды стеллажей, ворота"""
    from app.services import dxf_plan

    _, kept, _, _ = _collect(content)
    layers = {name: (roles[name], lines) for name, lines in kept.items() if name in roles}
    try:
        return dxf_plan.build(layers, factor, buffer_depth_m)
    except dxf_plan.Refused as error:
        raise Refused(str(error)) from error


def _limit_memory() -> None:
    try:
        import resource

        # чертеж в 80 МБ занимает до 1,7 ГБ, адресов процессу нужно больше, чем памяти
        limit = 3 * 1024 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ImportError, ValueError, OSError):
        pass  # на Windows лимита памяти процессу нет, остаются размер файла и таймаут


def run(content: bytes, conn, task: str = "read", args: tuple = ()) -> None:
    """Тело процесса: лимит памяти, разбор, ответ в трубу. Любая ошибка уходит текстом, процесс не падает молча"""
    try:
        _limit_memory()
        conn.send(("ok", read(content) if task == "read" else build(content, *args)))
    except Refused as error:
        conn.send(("refused", str(error)))
    except MemoryError:
        conn.send(("refused", f"Чертежу не хватило памяти сервера. {ADVICE}"))
    except Exception:  # noqa: BLE001 - чужой файл может сломать парсер как угодно, наружу идет общий текст
        conn.send(("refused", "Не удалось разобрать файл. Сохраните чертеж в AutoCAD заново как DXF и повторите"))
    finally:
        conn.close()
