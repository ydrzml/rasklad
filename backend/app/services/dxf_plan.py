"""План склада из линий чертежа: контур здания, ряды стеллажей и ворота по слоям, которые назвал человек.

Чистая геометрия без ezdxf и без модулей приложения: линии приходят списками точек, ответ это
словарь в формате плана. Работает в процессе разбора (см. dxf_worker.py).

Что делаем и чего не делаем:
- стены: берем самый большой замкнутый контур на слоях со стенами. Незамкнутые линии пытаемся
  сложить в контур по общим концам. Нет контура, берем рамку вокруг всех линий слоя;
- чертеж, повернутый целиком, разворачиваем по стенам, если стены стоят под одним углом;
- стеллажи: прямоугольники по осям берем как есть, косые заменяем прямоугольником той же
  площади вдоль оси и говорим об этом. Рядом стоящие секции склеиваем в один ряд;
- ворота: рамка каждого значка (линия, дуга, блок) у ближайшей стены здания;
- все края встают на сетку в метр, как на плане. Что не вошло, считаем и пишем в предупреждения.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict

Point = tuple[float, float]
Line = list[Point]

GRID_M = 1.0
JOIN_TOL_M = 0.05  # концы линий ближе этого считаем одной точкой
ANGLE_TOL_DEG = 1.5  # так стена или стеллаж еще считается идущим вдоль оси
TURN_MIN_DEG = 0.5  # меньше этого чертеж не разворачиваем
MIN_SIDE_M = 4.0  # здание короче этого не склад
MAX_SIDE_M = 1000.0
MAX_ITEMS = 4000  # вещей на плане: сервер принимает до 6000, остальное оставляем человеку
MAX_OUTLINE_POINTS = 400
MAX_JOIN_SEGMENTS = 20000
DOCK_DEPTH_M = 1.0
DOOR_REACH_M = 1.5  # ворота дальше этого от стены не считаем воротами
FALLBACK_AISLE_M = 3.5
MIN_RACK_AREA_M2 = 0.5
WALLS, RACKS, DOORS = "walls", "racks", "doors"

__all__ = ["Refused", "build"]


class Refused(Exception):
    """План не построить: текст для человека"""


# --- общая геометрия -------------------------------------------------------------------------


def _bbox(points: list[Point]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _area(points: list[Point]) -> float:
    total = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1], strict=False):
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def _is_closed(line: Line) -> bool:
    return len(line) >= 4 and math.dist(line[0], line[-1]) <= JOIN_TOL_M


def _inside(polygon: list[Point], x: float, y: float) -> bool:
    hit = False
    for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1], strict=False):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def _fold(angle_deg: float) -> float:
    """Угол к ближайшей оси: от -45 до 45 градусов"""
    return (angle_deg + 45) % 90 - 45


def _rotate(lines: list[Line], deg: float) -> list[Line]:
    if not deg:
        return lines
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [[(x * c - y * s, x * s + y * c) for x, y in line] for line in lines]


def _dominant_angle(lines: list[Line]) -> float:
    """Куда повернуты линии в целом: пик по длине отрезков среди углов, свернутых к оси"""
    bins: dict[int, float] = defaultdict(float)
    for line in lines:
        for (x1, y1), (x2, y2) in zip(line, line[1:], strict=False):
            length = math.hypot(x2 - x1, y2 - y1)
            if length > 0:
                angle = _fold(math.degrees(math.atan2(y2 - y1, x2 - x1)))
                bins[round(angle * 4)] += length
    if not bins:
        return 0.0
    peak = max(bins, key=bins.get)
    near = [(k, w) for k, w in bins.items() if abs(k - peak) <= 4]
    return sum(k * w for k, w in near) / sum(w for _, w in near) / 4


# --- сборка контуров из линий ----------------------------------------------------------------


def _loops(lines: list[Line]) -> tuple[list[Line], bool]:
    """Замкнутые контуры: готовые полилинии и собранные из отрезков с общими концами.
    Второе значение: сборку пришлось пропустить, линий слишком много"""
    loops = [line for line in lines if _is_closed(line)]
    open_chains = [list(line) for line in lines if not _is_closed(line) and len(line) >= 2]
    if sum(len(c) - 1 for c in open_chains) > MAX_JOIN_SEGMENTS:
        return loops, True

    def key(p: Point) -> tuple[int, int]:
        return round(p[0] / JOIN_TOL_M), round(p[1] / JOIN_TOL_M)

    ends: dict[tuple[int, int], list[int]] = defaultdict(list)
    for index, chain in enumerate(open_chains):
        ends[key(chain[0])].append(index)
        ends[key(chain[-1])].append(index)
    used = [False] * len(open_chains)

    def take(point: Point) -> int | None:
        for index in ends.get(key(point), []):
            if not used[index]:
                return index
        return None

    for start in range(len(open_chains)):
        if used[start]:
            continue
        used[start] = True
        cur = open_chains[start]
        while True:
            if len(cur) >= 4 and key(cur[0]) == key(cur[-1]):
                loops.append(cur)
                break
            nxt = take(cur[-1])
            if nxt is not None:
                used[nxt] = True
                chain = open_chains[nxt]
                cur = cur + (chain[1:] if key(chain[0]) == key(cur[-1]) else chain[-2::-1])
                continue
            prv = take(cur[0])
            if prv is None:
                break
            used[prv] = True
            chain = open_chains[prv]
            cur = (chain[:-1] if key(chain[-1]) == key(cur[0]) else chain[:0:-1]) + cur
    return loops, False


def _simplify(points: list[Point], tol: float = 1e-6) -> list[Point]:
    """Без повторных и лежащих на прямой точек; замыкающая точка не повторяется"""
    pts = [p for i, p in enumerate(points) if i == 0 or math.dist(p, points[i - 1]) > 1e-9]
    if len(pts) > 1 and math.dist(pts[0], pts[-1]) <= JOIN_TOL_M:
        pts.pop()
    changed = True
    while changed and len(pts) > 3:
        changed = False
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            if abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) <= tol * max(1.0, math.dist(a, c)):
                del pts[i]
                changed = True
                break
    return pts


def _douglas(points: list[Point], tol: float) -> list[Point]:
    """Упрощение замкнутого контура, чтобы точек было не больше предела"""
    if len(points) <= 3:
        return points

    def part(chain: list[Point]) -> list[Point]:
        (x1, y1), (x2, y2) = chain[0], chain[-1]
        length = math.hypot(x2 - x1, y2 - y1) or 1e-9
        far, at = 0.0, 0
        for i in range(1, len(chain) - 1):
            d = abs((x2 - x1) * (y1 - chain[i][1]) - (x1 - chain[i][0]) * (y2 - y1)) / length
            if d > far:
                far, at = d, i
        if far <= tol:
            return [chain[0], chain[-1]]
        return part(chain[: at + 1])[:-1] + part(chain[at:])

    half = len(points) // 2
    return part(points[: half + 1])[:-1] + part(points[half:] + [points[0]])[:-1]


# --- стены -----------------------------------------------------------------------------------


def _outline(lines: list[Line], warnings: list[str]) -> list[Point]:
    loops, skipped = _loops(lines)
    if skipped:
        warnings.append("На слоях стен слишком много отдельных отрезков, замкнуть контур не удалось: взята рамка")
    loops = [_simplify(loop) for loop in loops]
    loops = [loop for loop in loops if len(loop) >= 3 and _area(loop) > 1.0]
    if loops:
        best = max(loops, key=_area)
        if len(loops) > 1:
            warnings.append(
                f"На слоях стен несколько замкнутых контуров ({len(loops)}): здание взято по самому большому, "
                "толщина стен и внутренние контуры не учитываются"
            )
        return best
    points = [p for line in lines for p in line]
    x0, y0, x1, y1 = _bbox(points)
    warnings.append("Стены не замкнуты в контур: взята рамка вокруг всех линий слоя, проверьте углы здания")
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _grid_outline(polygon: list[Point], warnings: list[str]) -> tuple[list[tuple[int, int]], int, int]:
    """Контур в метрах от юго-западного угла, углы на сетке в метр. Прямоугольник возвращается четырьмя точками"""
    x0, y0, _, _ = _bbox(polygon)
    pts: list[tuple[int, int]] = []
    for x, y in polygon:
        p = (round(x - x0), round(y - y0))
        if not pts or p != pts[-1]:
            pts.append(p)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    pts = [(int(x), int(y)) for x, y in _simplify([(float(x), float(y)) for x, y in pts], 1e-9)]
    if len(pts) < 3:
        raise Refused("Стены сложились в точку или линию. Проверьте единицы чертежа и слои со стенами")
    off = 0
    for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1], strict=False):
        if abs(_fold(math.degrees(math.atan2(by - ay, bx - ax)))) > ANGLE_TOL_DEG:
            off += 1
    if off:
        warnings.append(
            f"Стен под углом к осям: {off}. Сетка плана в метр, поэтому они ложатся по клеткам ступеньками. "
            "Проверьте углы здания"
        )
    if len(pts) > MAX_OUTLINE_POINTS:
        simple = _douglas([(float(x), float(y)) for x, y in pts], 0.5)
        pts = [(round(x), round(y)) for x, y in simple][:MAX_OUTLINE_POINTS]
        warnings.append("Контур здания очень подробный, углы упрощены до полуметра")
    width = max(x for x, _ in pts)
    length = max(y for _, y in pts)
    return pts, width, length


# --- прямоугольники --------------------------------------------------------------------------


def _hull(points: list[Point]) -> list[Point]:
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def half(seq: list[Point]) -> list[Point]:
        out: list[Point] = []
        for p in seq:
            while len(out) >= 2 and (
                (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0
            ):
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(pts[::-1])
    return lower[:-1] + upper[:-1]


def _oriented(points: list[Point]) -> tuple[float, float, float, float, float]:
    """Наименьший прямоугольник вокруг точек: центр x, y, длинная и короткая сторона, угол длинной стороны"""
    hull = _hull(points)
    best: tuple[float, float, float, float, float] | None = None
    best_area = math.inf
    for (x1, y1), (x2, y2) in zip(hull, hull[1:] + hull[:1], strict=False):
        theta = math.atan2(y2 - y1, x2 - x1)
        c, s = math.cos(-theta), math.sin(-theta)
        rot = [(x * c - y * s, x * s + y * c) for x, y in hull]
        rx0, ry0, rx1, ry1 = _bbox(rot)
        area = (rx1 - rx0) * (ry1 - ry0)
        if area < best_area:
            best_area = area
            mid = ((rx0 + rx1) / 2, (ry0 + ry1) / 2)
            cx = mid[0] * math.cos(theta) - mid[1] * math.sin(theta)
            cy = mid[0] * math.sin(theta) + mid[1] * math.cos(theta)
            a, b = rx1 - rx0, ry1 - ry0
            angle = math.degrees(theta) + (0 if a >= b else 90)
            best = (cx, cy, max(a, b), min(a, b), angle % 180)
    assert best is not None
    return best


def _snap(x0: float, y0: float, x1: float, y1: float) -> tuple[int, int, int, int]:
    """Края на целые метры; сторона не короче метра"""
    ax0, ay0, ax1, ay1 = round(x0), round(y0), round(x1), round(y1)
    if ax1 <= ax0:
        ax1 = ax0 + 1
    if ay1 <= ay0:
        ay1 = ay0 + 1
    return ax0, ay0, ax1, ay1


def _rack_rects(
    shapes: list[Line], polygon: list[Point] | None, width: int, length: int, warnings: list[str]
) -> list[tuple[int, int, int, int]]:
    rects: set[tuple[int, int, int, int]] = set()
    tilted = poor = outside = tiny = huge = 0
    for shape in shapes:
        pts = _simplify(shape)
        if len(pts) < 3:
            continue
        area = _area(pts)
        cx, cy, a, b, angle = _oriented(pts)
        if a * b < MIN_RACK_AREA_M2 or b < 0.2:
            tiny += 1
            continue
        if a * b > 0.5 * width * length:
            huge += 1
            continue
        if area < 0.8 * a * b:
            poor += 1  # не прямоугольник: берем рамку
            x0, y0, x1, y1 = _bbox(pts)
        elif abs(_fold(angle)) <= ANGLE_TOL_DEG:
            x0, y0, x1, y1 = _bbox(pts)
        else:
            tilted += 1
            # ряд вдоль ближайшей оси: длинная сторона вдоль x, если угол ближе к нулю, иначе вдоль y
            along_x = abs(math.cos(math.radians(angle))) >= abs(math.sin(math.radians(angle)))
            w, h = (a, b) if along_x else (b, a)
            x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
        sx0, sy0, sx1, sy1 = _snap(x0, y0, x1, y1)
        mid = ((sx0 + sx1) / 2, (sy0 + sy1) / 2)
        if not (0 <= mid[0] <= width and 0 <= mid[1] <= length) or (polygon and not _inside(polygon, *mid)):
            outside += 1
            continue
        sx0, sy0, sx1, sy1 = max(sx0, 0), max(sy0, 0), min(sx1, width), min(sy1, length)
        if sx1 > sx0 and sy1 > sy0:
            rects.add((sx0, sy0, sx1, sy1))
    if tilted:
        warnings.append(
            f"Стеллажей под углом: {tilted}. Сетка плана вдоль осей, поэтому они заменены прямоугольниками "
            "той же площади вдоль ближайшей оси. Проверьте их на плане"
        )
    if poor:
        warnings.append(f"Стеллажей не прямоугольной формы: {poor}. Взяты рамками вокруг фигур")
    if outside:
        warnings.append(f"Стеллажей вне контура здания: {outside}. Они пропущены")
    if tiny:
        warnings.append(f"Слишком мелких фигур на слоях стеллажей: {tiny}. Они пропущены")
    if huge:
        warnings.append(
            f"Фигур размером с половину здания на слоях стеллажей: {huge}. Они пропущены: похоже, это контур, а не стеллаж"
        )
    return sorted(rects)


def _merge(rects: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """Секции, стоящие вплотную, склеиваем в ряд: сначала вдоль x, потом вдоль y. Одинаковая толщина обязательна"""

    def pass_(items: list[tuple[int, int, int, int]], axis: int) -> list[tuple[int, int, int, int]]:
        groups: dict[tuple[int, int], list[tuple[int, int, int, int]]] = defaultdict(list)
        for r in items:
            groups[(r[1], r[3]) if axis == 0 else (r[0], r[2])].append(r)
        out: list[tuple[int, int, int, int]] = []
        for group in groups.values():
            group.sort(key=lambda r: r[axis])
            cur = group[0]
            for r in group[1:]:
                if r[axis] <= cur[axis + 2]:
                    cur = (
                        (cur[0], cur[1], max(cur[2], r[2]), cur[3])
                        if axis == 0
                        else (cur[0], cur[1], cur[2], max(cur[3], r[3]))
                    )
                else:
                    out.append(cur)
                    cur = r
            out.append(cur)
        return out

    merged = pass_(pass_(rects, 0), 1)
    return sorted(set(merged))


def _aisle(rects: list[tuple[int, int, int, int]]) -> float:
    """Типичный проезд между соседними параллельными рядами: середина по всем зазорам"""
    gaps: list[int] = []
    for axis in (0, 1):  # ряды вдоль x стоят друг над другом: смотрим зазор по y
        rows = [r for r in rects if (r[2] - r[0] >= r[3] - r[1]) == (axis == 0)]
        rows.sort(key=lambda r: (r[1], r[0]) if axis == 0 else (r[0], r[1]))
        for a, b in zip(rows, rows[1:], strict=False):
            if axis == 0 and a[0] < b[2] and b[0] < a[2] and b[1] > a[3]:
                gaps.append(b[1] - a[3])
            if axis == 1 and a[1] < b[3] and b[1] < a[3] and b[0] > a[2]:
                gaps.append(b[0] - a[2])
    gaps = [g for g in gaps if g >= 1]
    return float(statistics.median(gaps)) if gaps else FALLBACK_AISLE_M


# --- ворота и буфер --------------------------------------------------------------------------


def _wall_of(box: tuple[float, float, float, float], width: int, length: int) -> tuple[str, float, float, float]:
    """Ближайшая сторона рамки здания, расстояние до нее и отрезок вдоль стены"""
    x0, y0, x1, y1 = box
    sides = {
        "west": min(abs(x0), abs(x1)),
        "east": min(abs(width - x0), abs(width - x1)),
        "south": min(abs(y0), abs(y1)),
        "north": min(abs(length - y0), abs(length - y1)),
    }
    wall = min(sides, key=sides.get)
    return (wall, sides[wall], *((x0, x1) if wall in ("south", "north") else (y0, y1)))


def _strip(wall: str, along: int, size: int, depth: int, width: int, length: int) -> tuple[int, int, int, int]:
    return {
        "south": (along, 0, size, depth),
        "north": (along, length - depth, size, depth),
        "west": (0, along, depth, size),
        "east": (width - depth, along, depth, size),
    }[wall]


def _docks(shapes: list[Line], width: int, length: int, warnings: list[str]) -> list[tuple[str, int, int]]:
    spans: dict[str, list[list[float]]] = defaultdict(list)
    far = 0
    for shape in shapes:
        wall, dist, a0, a1 = _wall_of(_bbox(shape), width, length)
        if dist > DOOR_REACH_M:
            far += 1
            continue
        spans[wall].append([a0, a1])
    if far:
        warnings.append(f"Значков ворот не у стены здания: {far}. Они пропущены")
    docks: list[tuple[str, int, int]] = []
    for wall, items in spans.items():
        items.sort()
        merged: list[list[float]] = [items[0]]
        for a0, a1 in items[1:]:
            if a0 <= merged[-1][1] + 0.3:
                merged[-1][1] = max(merged[-1][1], a1)
            else:
                merged.append([a0, a1])
        edge = -1
        limit = width if wall in ("south", "north") else length
        for a0, a1 in merged:
            start = max(round(a0), edge + 1, 0)  # простенок в метр между воротами, как требует редактор
            end = min(max(round(a1), start + 1), limit)
            if end > start:
                docks.append((wall, start, end - start))
                edge = end
    return docks


def _buffers(
    docks: list[tuple[str, int, int]],
    racks: list[tuple[int, int, int, int]],
    width: int,
    length: int,
    depth_max: int,
    warnings: list[str],
) -> list[tuple[int, int, int, int]]:
    """Буфер за воротами: на всю ширину ворот одной стены, глубиной до первого стеллажа"""
    out: list[tuple[int, int, int, int]] = []
    by_wall: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for wall, start, size in docks:
        by_wall[wall].append((start, start + size))
    skipped = 0
    for wall, spans in by_wall.items():
        a0, a1 = min(s for s, _ in spans), max(e for _, e in spans)
        free = float(width if wall in ("west", "east") else length)
        for x0, y0, x1, y1 in racks:
            lo, hi = (x0, x1) if wall in ("south", "north") else (y0, y1)
            if lo >= a1 or hi <= a0:
                continue
            dist = {"south": y0, "north": length - y1, "west": x0, "east": width - x1}[wall]
            free = min(free, dist)
        depth = min(depth_max, int(free) - int(DOCK_DEPTH_M))
        if depth < 1:
            skipped += 1
            continue
        x, y, w, h = _strip(wall, a0, a1 - a0, depth, width, length)
        shift = {"south": (0, 1), "north": (0, -1), "west": (1, 0), "east": (-1, 0)}[wall]
        out.append((x + shift[0], y + shift[1], w, h))
    if skipped:
        warnings.append("За воротами нет места под буфер: поставьте его на плане сами")
    return out


# --- сборка плана ----------------------------------------------------------------------------


def build(layers: dict[str, tuple[str, list[Line]]], factor: float, buffer_depth_m: int) -> dict:
    """layers: имя слоя -> (роль, линии в единицах чертежа); factor: метров в единице.
    Ответ: размеры здания, контур, вещи плана в метрах от юго-западного угла здания, предупреждения"""
    warnings: list[str] = []
    by_role: dict[str, list[Line]] = {WALLS: [], RACKS: [], DOORS: []}
    for role, lines in layers.values():
        if role in by_role:
            by_role[role].extend([[(x * factor, y * factor) for x, y in line] for line in lines])
    if not by_role[WALLS]:
        raise Refused("Укажите хотя бы один слой со стенами: по нему строится здание")

    turn = _dominant_angle(by_role[WALLS])
    if abs(turn) >= TURN_MIN_DEG:
        by_role = {role: _rotate(lines, -turn) for role, lines in by_role.items()}
        warnings.append(f"Чертеж повернут на {turn:.1f} градуса: развернули его по стенам, подложку не кладем")
    else:
        turn = 0.0

    polygon_m = _outline(by_role[WALLS], warnings)
    ox, oy, _, _ = _bbox(polygon_m)
    outline, width, length = _grid_outline(polygon_m, warnings)
    if min(width, length) < MIN_SIDE_M or max(width, length) > MAX_SIDE_M:
        raise Refused(
            f"Здание получилось {width} на {length} м. Проверьте единицы чертежа и слои со стенами: "
            "склад короче 4 м или длиннее километра на плане не бывает"
        )
    is_rect = len(outline) == 4 and all(
        ax == bx or ay == by for (ax, ay), (bx, by) in zip(outline, outline[1:] + outline[:1], strict=False)
    )
    polygon = None if is_rect else [(float(x), float(y)) for x, y in outline]

    def local(lines: list[Line]) -> list[Line]:
        return [[(x - ox, y - oy) for x, y in line] for line in lines]

    rack_loops, skipped = _loops(local(by_role[RACKS]))
    if skipped:
        warnings.append("На слоях стеллажей слишком много отдельных отрезков: незамкнутые линии не собирались")
    if any(role == RACKS for role, _ in layers.values()) and not rack_loops:
        warnings.append("На слоях стеллажей нет замкнутых фигур: стеллажи не найдены. Нужны прямоугольники или блоки")
    rects = _merge(_rack_rects(rack_loops, polygon, width, length, warnings))
    if len(rects) > MAX_ITEMS:
        raise Refused(f"Стеллажей получилось {len(rects)}, больше {MAX_ITEMS}. Оставьте на слое только план склада")

    door_shapes = [line for line in local(by_role[DOORS]) if len(line) >= 2]
    docks = _docks(door_shapes, width, length, warnings) if door_shapes else []
    buffers = _buffers(docks, rects, width, length, buffer_depth_m, warnings) if docks else []

    aisle = _aisle(rects)
    items: list[dict] = []
    for index, (x0, y0, x1, y1) in enumerate(rects, 1):
        w, h = x1 - x0, y1 - y0
        items.append(
            {
                "id": f"dxf-rack-{index}",
                "kind": "racks",
                "x": x0,
                "y": y0,
                "w": w,
                "h": h,
                "rows": "x" if w >= h else "y",
                "row_m": float(min(w, h)),
                "block_rows": 1,
                "aisle_m": aisle,
            }
        )
    for index, (wall, start, size) in enumerate(docks, 1):
        x, y, w, h = _strip(wall, start, size, int(DOCK_DEPTH_M), width, length)
        items.append({"id": f"dxf-dock-{index}", "kind": "dock", "x": x, "y": y, "w": w, "h": h, "role": "both"})
    for index, (x, y, w, h) in enumerate(buffers, 1):
        items.append({"id": f"dxf-buffer-{index}", "kind": "buffer", "x": x, "y": y, "w": w, "h": h, "role": "both"})
    if not docks:
        warnings.append("Ворота не найдены: укажите слой с воротами или поставьте их на плане сами")
    return {
        "width_m": width,
        "length_m": length,
        "outline": [] if is_rect else [[x, y] for x, y in outline],
        "items": items,
        "warnings": warnings,
        "counts": {"racks": len(rects), "docks": len(docks), "buffers": len(buffers)},
        "turn_deg": round(turn, 2),
    }
