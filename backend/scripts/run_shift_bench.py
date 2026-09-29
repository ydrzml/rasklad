"""Стенд прогона смены: гоняем движок на наборе складов и пишем таблицу в docs/simulation-check.md.

Зачем. Тесты проверяют формулы на маленьких схемах, а врать движок может на настоящем плане:
на большом складе, с воротами на двух стенах, с пандусом. Стенд строит планы теми же функциями,
что и приложение, считает кривую парка и один прогон смены с логом и проверяет лог.

Движок здесь не правим. Проверки лога лежат тут же, их берут и тесты
(tests/test_shift_invariants.py), чтобы стенд и тесты мерили одно и то же.

Запуск: cd backend && python -m scripts.run_shift_bench
"""

from __future__ import annotations

import math
import statistics
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path

from app.engine import plan as P
from app.engine import simulation as sim
from app.engine.economics.fleet import peak_demand, required_fleet, robot_ops_per_hour
from app.engine.economics.scenarios import by_id
from app.engine.economics.staff import hours_per_day
from app.services import plan as plan_service
from app.services.calculation import model_with_overrides

DOC = Path(__file__).resolve().parents[2] / "docs" / "simulation-check.md"
START, END = "<!-- стенд: начало -->", "<!-- стенд: конец -->"

SEEDS = (42, 7, 2026)  # три seed, чтобы отличить сдвиг от правки и шум случайности
PALLETS, PICKING = "pallet_transport", "piece_picking"
ROBOT_FOR = {PALLETS: "ronavi-h1500", PICKING: "ronavi-m"}
# Уровни спроса, операций в час. Средний это спрос из датасета с пиком и резервом, как в эталоне,
# крайние взяты сами, чтобы видеть, где склад справляется, а где упирается в потолок.
LEVELS = {PALLETS: (50, 149, 300), PICKING: (1000, 2352, 4000)}
JUMP_M = 1.5  # разрыв больше клетки с запасом: робот не мог так переехать
STEP_M = 0.25  # шаг, с которым идем по ломаной, проверяя клетки под ней


# --- склады ------------------------------------------------------------------------------


@dataclass
class Case:
    name: str
    operation: str
    build: Callable[[], P.Plan]

    @property
    def robot(self) -> str:
        return ROBOT_FOR[self.operation]


def _size(area_m2: float) -> tuple[int, int]:
    """Габариты с пропорцией 1.4, как у анкеты «Свой склад»: длинная сторона вдоль x."""
    side = math.sqrt(area_m2)
    return round(side * math.sqrt(1.4)), round(side / math.sqrt(1.4))


def _template(template_id: str, operation: str, area_m2: float) -> Callable[[], P.Plan]:
    width, length = _size(area_m2)
    return lambda: plan_service.generate("warehouse", [operation], template_id, width_m=width, length_m=length)


def two_walls() -> P.Plan:
    """Свой склад по анкете: по четверо ворот на южной и северной стене, ряды поперек потока."""
    width, length = _size(10_000)
    answers = {"docks": [{"wall": "south", "count": 4}, {"wall": "north", "count": 4}], "racks": "across"}
    return plan_service.generate(
        "warehouse", [PALLETS], plan_service.CUSTOM, width_m=width, length_m=length, custom=answers
    )


def mezzanine() -> P.Plan:
    """Склад с одной стороны и антресолью на 1,2 м у северной стены, наверх ведет один пандус."""
    plan = _template("one_side", PALLETS, 10_000)()
    hall = plan.sections[0]
    top = P.Section("mezzanine", hall.x, hall.y + hall.h - 20, hall.w, 20, 1.2, 8.8)
    racks = plan.of(P.RACKS)[0]
    ramp = P.Item(id="ramp", kind=P.RAMP, x=racks.x + 20, y=top.y - 4, w=4, h=8)
    return plan_service.resolve(replace(plan, sections=[*plan.sections, top], items=[*plan.items, ramp]))


def narrow() -> P.Plan:
    """Узкий склад 90 на 8 метров: один ряд стеллажей вдоль южной стены и широкий проезд вдоль него."""
    constants = plan_service.constants()
    hall = P.Section("hall", 0, 0, 90, 8, 0.0, 10.0)
    racks = P.Item(
        id="racks",
        kind=P.RACKS,
        x=6,
        y=0,
        w=84,
        h=3,
        rows="x",
        **P.rack_defaults(P.rack_type(constants, "front"), constants),
    )
    dock = P.Item(id="dock", kind=P.DOCK, x=0, y=3, w=1, h=4, role=P.BOTH)
    buffer = P.Item(id="buffer", kind=P.BUFFER, x=1, y=3, w=4, h=4, role=P.BOTH)
    plan = P.Plan(width_m=90, length_m=8, template="custom", items=[dock, buffer, racks], sections=[hall])
    return plan_service.resolve(plan)


def between_rows() -> P.Plan:
    """Узкий склад 90 на 8 метров с рядами по обе стороны одного проезда: разъехаться негде."""
    constants = plan_service.constants()
    hall = P.Section("hall", 0, 0, 90, 8, 0.0, 10.0)
    racks = P.Item(
        id="racks",
        kind=P.RACKS,
        x=6,
        y=0,
        w=84,
        h=8,
        rows="x",
        **P.rack_defaults(P.rack_type(constants, "front"), constants),
    )
    dock = P.Item(id="dock", kind=P.DOCK, x=0, y=2, w=1, h=4, role=P.BOTH)
    buffer = P.Item(id="buffer", kind=P.BUFFER, x=1, y=2, w=4, h=4, role=P.BOTH)
    plan = P.Plan(width_m=90, length_m=8, template="custom", items=[dock, buffer, racks], sections=[hall])
    return plan_service.resolve(plan)


def snake() -> P.Plan:
    """Склад с одной стороны на 10 тысяч м2, по проездам змейка: в соседних в разные стороны."""
    plan = _template("one_side", PALLETS, 10_000)()
    for group in dict.fromkeys(item.group or item.id for item in plan.of(P.RACKS)):
        plan = plan_service.serpentine(plan, group)
    return plan_service.resolve(plan)


CASES = [
    *[
        Case(f"{name}, {area // 1000} тыс. м2", operation, _template(template_id, operation, area))
        for template_id, name, operation in (
            ("through", "Сквозной", PALLETS),
            ("corner", "Г-образный", PALLETS),
            ("one_side", "С одной стороны", PALLETS),
            ("robot_zone", "Робозона со станциями", PICKING),
        )
        for area in (3_000, 10_000, 30_000)
    ],
    Case("Свой склад, ворота на двух стенах", PALLETS, two_walls),
    Case("Антресоль и пандус, 10 тыс. м2", PALLETS, mezzanine),
    Case("С одной стороны, 10 тыс. м2, змейка", PALLETS, snake),
    Case("Узкий склад, один проезд", PALLETS, narrow),
    Case("Узкий склад, проезд между рядами", PALLETS, between_rows),
]


# --- прогон ------------------------------------------------------------------------------


@dataclass
class Setup:
    """Все, что нужно для прогона одного склада: план, сетка, схема, робот и настройки."""

    plan: P.Plan
    grid: P.Grid
    measures: P.Measures
    layout: sim.Layout  # без ломаных: для кривой
    traced: sim.Layout  # с ломаными: для прогона с логом
    robot: dict
    spec: sim.RobotSpec
    settings: dict
    max_fleet: int


def setup(case: Case, slotted: bool = False) -> Setup:
    """Схему собираем так же, как services/simulation.py, только seed и лог в своих руках.

    Схем две: для кривой без ломаных и для прогона с логом. Ломаную движок строит на каждый рейс,
    даже если лог не пишется, и с ней кривая считается в двадцать раз дольше.
    """
    model, _ = model_with_overrides({})
    facility = by_id(model["facilities"], "warehouse")
    operation = by_id(facility["operations"], case.operation)
    robot = by_id(model["robots"], case.robot)
    settings = model["engine"]["simulation"]
    plan = case.build()
    constants = plan_service.constants()
    measures = P.measure(plan, constants)
    rate = operation.get("productivity_after")

    def layout(with_trails: bool) -> sim.Layout:
        return sim.build_layout(
            plan,
            constants,
            measures,
            robots_per_aisle=settings["robots_per_aisle"],
            station_service_s=3600 / rate * operation.get("ops_per_trip", 1) if rate else 0.0,
            with_trails=with_trails,
            popularity=(facility["fast_share"], facility["fast_picks_share"]) if slotted else None,
        )

    spec = sim.RobotSpec(
        speed_m_s=robot["avg_speed_m_s"],
        handling_s=robot["handling_s"],
        run_time_h=robot["run_time_h"],
        charge_time_h=robot["charge_time_h"],
        per_charger=robot["robots_per_charger"],
        refill_s=robot.get("refill_s"),
    )
    return Setup(
        plan,
        P.rasterize(plan, constants),
        measures,
        layout(False),
        layout(True),
        robot,
        spec,
        settings,
        model["engine"]["max_fleet_simulated"],
    )


def curve(s: Setup, seed: int, max_fleet: int | None = None, until: float | None = None) -> list[float]:
    """Кривая парка, как в приложении: избыточный спрос, шаг из конфига, готовность как доля
    исправных роботов. Останавливается на until или на полке."""
    top = max_fleet or s.max_fleet
    return sim.throughput_curve(
        s.layout,
        s.spec,
        top,
        sim.plenty(s.layout, s.spec, top),
        s.settings["hours"],
        seed,
        s.settings["curve_step"],
        availability=s.settings["availability"],
        until=until,
    )


# --- проверки лога -----------------------------------------------------------------------


@dataclass
class LogCheck:
    """Что не так с логом одного прогона. Пустые списки значат, что все сходится."""

    gaps_s: float = 0.0  # сколько секунд в сумме у роботов нет ни одного отрезка
    overlaps: int = 0  # отрезки одного робота налезают друг на друга
    jumps: list[tuple[int, float, float]] = field(default_factory=list)  # робот, секунда, на сколько метров прыгнул
    through: list[tuple[int, float, str]] = field(default_factory=list)  # робот, секунда, сквозь что проехал
    against: list[tuple[int, float]] = field(default_factory=list)  # робот и секунда, когда ехал против стрелки
    over_shift: list[int] = field(default_factory=list)  # у кого сумма времени больше смены


def by_robot(segments: list[sim.Segment]) -> dict[int, list[sim.Segment]]:
    grouped: dict[int, list[sim.Segment]] = {}
    for part in segments:
        grouped.setdefault(part.robot, []).append(part)
    for parts in grouped.values():
        parts.sort(key=lambda part: (part.from_s, part.to_s))
    return grouped


def check_log(segments: list[sim.Segment], grid: P.Grid, fleet: int, hours: float) -> LogCheck:
    shift_s = hours * 3600
    found = LogCheck()
    grouped = by_robot(segments)
    for robot in range(fleet):
        parts = grouped.get(robot, [])
        clock = 0.0
        last_point = None
        for part in parts:
            if part.from_s > clock + 1e-6:
                found.gaps_s += part.from_s - clock
            elif part.from_s < clock - 1e-6:
                found.overlaps += 1
            if last_point and _gap(last_point, part.path[0]) > JUMP_M:
                found.jumps.append((robot, part.from_s, _gap(last_point, part.path[0])))
            if part.action == sim.MOVING:
                crossed = _crosses(grid, part.path)
                if crossed:
                    found.through.append((robot, part.from_s, crossed))
                if grid.oneway and _against(grid, part.path):
                    found.against.append((robot, part.from_s))
            clock = max(clock, part.to_s)
            last_point = part.path[-1]
        found.gaps_s += max(0.0, shift_s - clock)
        if sum(part.to_s - part.from_s for part in parts) > shift_s + 1e-6:
            found.over_shift.append(robot)
    return found


def _gap(a: sim.Point, b: sim.Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _crosses(grid: P.Grid, path: list[sim.Point]) -> str:
    """Идем по ломаной мелким шагом: под каждой точкой должна быть проезжая клетка."""
    for a, b in zip(path, path[1:], strict=False):
        steps = max(1, math.ceil(_gap(a, b) / STEP_M))
        for i in range(steps + 1):
            x = a[0] + (b[0] - a[0]) * i / steps
            y = a[1] + (b[1] - a[1]) * i / steps
            col, row = grid.cell(x, y)
            cell = grid.at(col, row)
            if cell == P.RACK_CELL:
                return "стеллаж"
            if cell == P.WALL_CELL:
                return "стену"
    return ""


def _against(grid: P.Grid, path: list[sim.Point]) -> bool:
    """Едет ли ломаная против стрелки линии движения: проверяем каждый шаг в клетку."""
    for a, b in zip(path, path[1:], strict=False):
        (col, row), (end_col, end_row) = grid.cell(*a), grid.cell(*b)
        if col != end_col and row != end_row:
            continue  # косой отрезок бывает только без сетки, по клеткам его не пройти
        dc, dr = (end_col > col) - (end_col < col), (end_row > row) - (end_row < row)
        while (col, row) != (end_col, end_row):
            here, there = row * grid.cols + col, (row + dr) * grid.cols + col + dc
            if not grid.allows(here, there, dc, dr):
                return True
            col, row = col + dc, row + dr
    return False


def unreachable_issued(layout: sim.Layout) -> int:
    """Сколько мест выдаются заданием, хотя до цели от них не доехать: движок считает им путь в ноль."""
    field_m = layout.to_station_m if layout.with_stations else layout.to_dock_m
    return sum(1 for value in field_m if value == P.INF)


# --- один склад --------------------------------------------------------------------------


@dataclass
class Row:
    case: Case
    measures: P.Measures
    corridors: int  # частей проездов между рядами: столько мест-очередей в прогоне
    ceilings: list[float]  # кривая там, где остановилась, по seed
    reach: list[int]  # до скольких роботов дошла кривая по seed
    flat: bool  # вышла ли кривая на полку до предела парка
    fleets: dict[int, list[int | None]]  # парк на уровень спроса по seed
    slotted: list[int | None]  # парк на спросе датасета, если товар разложен по ходовости, по seed
    formula: int  # парк по формуле на спросе датасета: цикл по маршруту плана и коэффициент загрузки
    fleet: int  # парк в прогоне на спросе датасета
    ops: float  # операций в час в этом прогоне
    waiting: float
    idle: float
    bottleneck: str
    curve_s: float
    log: LogCheck
    segments: int
    unreachable: int
    longest_wait: tuple[float, sim.Point] | None


def bench(case: Case) -> Row:
    s = setup(case)
    fast = setup(case, slotted=True)
    curves, times = [], []
    levels = LEVELS[case.operation]
    for seed in SEEDS:
        began = time.perf_counter()
        curves.append(curve(s, seed, until=levels[-1]))
        times.append(time.perf_counter() - began)
    fleets = {level: [required_fleet(level, values) for values in curves] for level in levels}

    # один прогон смены на спросе датасета, как его видит проигрыватель: пиковый спрос весь день
    main = curves[0]
    fleet = required_fleet(levels[1], main) or s.max_fleet
    demand = _dataset_demand(case.operation)
    result = sim.run_shift(s.traced, s.spec, fleet, demand, s.settings["hours"], SEEDS[0], record=True)
    kpi = result.kpi
    waits = [part for part in result.segments if part.action == sim.WAITING]
    longest = max(waits, key=lambda part: part.to_s - part.from_s, default=None)
    return Row(
        case=case,
        measures=s.measures,
        corridors=len({aisle for aisle in s.layout.aisle_of if aisle >= 0}),
        ceilings=[max(values) for values in curves],
        reach=[len(values) - 1 for values in curves],
        flat=all(_flat(values, s.max_fleet, levels[-1]) for values in curves),
        fleets=fleets,
        slotted=[required_fleet(levels[1], curve(fast, seed, until=levels[1])) for seed in SEEDS],
        formula=math.ceil(levels[1] / (robot_ops_per_hour(s.robot, s.measures.route_m) * s.robot["utilization"])),
        fleet=fleet,
        ops=kpi.ops_per_hour,
        waiting=kpi.waiting_share,
        idle=max(0.0, 1 - kpi.busy_share - kpi.waiting_share - kpi.charging_share),
        bottleneck=kpi.bottleneck,
        curve_s=statistics.mean(times),
        log=check_log(result.segments, s.grid, fleet, s.settings["hours"]),
        segments=len(result.segments),
        unreachable=unreachable_issued(s.layout),
        longest_wait=(longest.to_s - longest.from_s, longest.path[0]) if longest else None,
    )


def _dataset_demand(operation_id: str) -> list[float]:
    """Спрос датасета по часам смены, как в проигрывателе: два часа пика, остальное ровно."""
    model, _ = model_with_overrides({})
    facility = by_id(model["facilities"], "warehouse")
    settings = model["engine"]["simulation"]
    return sim.demand_profile(
        peak_demand(by_id(facility["operations"], operation_id), facility) / facility["peak_factor"],
        facility["peak_factor"],
        settings["peak_hours"],
        hours_per_day(facility["schedule"]),
        settings["hours"],
    )


def _flat(values: list[float], limit: int, until: float) -> bool:
    """Полка: кривая остановилась сама, не дойдя ни до спроса, ни до предела парка."""
    return len(values) - 1 < limit and values[-1] < until


# --- документ ----------------------------------------------------------------------------


def _spread(values: list[float], digits: int = 0) -> str:
    low, high = min(values), max(values)
    if round(low, digits) == round(high, digits):
        return f"{low:.{digits}f}"
    return f"{low:.{digits}f}-{high:.{digits}f}"


def _fleet(values: list[int | None], limit: int, flat: bool) -> str:
    if any(value is None for value in values):
        return "не покрыть: полка ниже" if flat else f"больше {limit}"
    return _spread([float(value) for value in values])


def _share(value: float) -> str:
    return f"{value * 100:.0f}%"


def render(rows: list[Row], limit: int, hours: float) -> str:
    lines = [
        START,
        "",
        f"Смена {hours:.0f} часов, seed {', '.join(map(str, SEEDS))}, кривая до {limit} роботов, как в приложении. "
        "Кривая останавливается, когда дошла до высокого уровня спроса или вышла на полку.",
        "Через дефис разброс между seed. Где разброса нет, число одно.",
        "",
        "### Склады и потолок",
        "",
        "| Склад | Габариты, м | Ворот | Проездов в плане | Частей проездов между рядами | Станций | Маршрут, м | Кривая дошла до роботов | Операций в час там | Полка | Кривая, с |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        m = row.measures
        lines.append(
            f"| {row.case.name} | {m.width_m:.0f} * {m.length_m:.0f} | {m.docks} | {m.aisles} | {row.corridors} | {m.stations} | "
            f"{m.route_m:.0f} | {_spread([float(n) for n in row.reach])} | {_spread(row.ceilings)} | "
            f"{'да' if row.flat else 'нет'} | {row.curve_s:.1f} |"
        )
    lines += [
        "",
        "### Парк на три уровня спроса",
        "",
        "Паллеты: 50, 149 и 300 операций в час. Отбор: 1000, 2352 и 4000 строк в час. "
        "Средний уровень это спрос датасета с пиком и резервом, как в эталоне. "
        "Рядом парк по формуле на том же спросе и том же маршруте плана: цикл туда и обратно "
        "плюс погрузка, умноженный на коэффициент загрузки 0.75. "
        "В последней колонке прогон с галочкой «товар разложен по ходовости»: 20% мест у ворот дают 75% заданий.",
        "",
        "| Склад | Низкий | Датасет | Высокий | Датасет по формуле | Датасет, товар разложен по ходовости |",
        "|---|---|---|---|---|---|",
    ]
    for row in rows:
        cells = [_fleet(row.fleets[level], limit, row.flat) for level in LEVELS[row.case.operation]]
        lines.append(f"| {row.case.name} | {' | '.join(cells)} | {row.formula} | {_fleet(row.slotted, limit, False)} |")
    lines += [
        "",
        "### Прогон смены на спросе датасета",
        "",
        f"Парк по кривой первого seed, а если кривая не достает до спроса, {limit} роботов. "
        "Спрос с пиком, как в проигрывателе: два часа пиковой нагрузки в середине смены, остальное ровно, "
        "за сутки объем датасета. Операций в час это среднее за смену.",
        "",
        "| Склад | Операций в час | Ожидание | Простой | Узкое место |",
        "|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row.case.name} | {row.ops:.0f} | {_share(row.waiting)} | {_share(row.idle)} | {row.bottleneck} |"
        )
    lines += [
        "",
        "### Проверки лога",
        "",
        "Дыры это время, когда у робота нет ни одного отрезка. Прыжок это когда следующий отрезок начинается "
        f"дальше {JUMP_M} м от конца предыдущего. Сквозь стеллаж или стену проверяем по ломаной с шагом {STEP_M} м. "
        "Против стрелки проверяем каждый шаг ломаной по клеткам, если на плане есть линия движения.",
        "",
        "| Склад | Отрезков | Дыры, доля смены | Наложения | Прыжки | Сквозь стеллаж или стену | Против стрелки | Больше смены | Недостижимых мест выдается | Самое долгое ожидание |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        log = row.log
        wait = (
            f"{row.longest_wait[0]:.1f} с у точки {row.longest_wait[1][0]:.0f}, {row.longest_wait[1][1]:.0f}"
            if row.longest_wait
            else "нет"
        )
        lines.append(
            f"| {row.case.name} | {row.segments} | {_share(log.gaps_s / (row.fleet * hours * 3600))} | "
            f"{log.overlaps} | {len(log.jumps)} | {_through(log)} | {len(log.against)} | {len(log.over_shift)} | {row.unreachable} | {wait} |"
        )
    lines += ["", END]
    return "\n".join(lines)


def _through(log: LogCheck) -> str:
    if not log.through:
        return "0"
    kinds = sorted({what for _, _, what in log.through})
    return f"{len(log.through)} ({', '.join(kinds)})"


def write(rows: list[Row], limit: int, hours: float) -> None:
    block = render(rows, limit, hours)
    text = DOC.read_text(encoding="utf-8") if DOC.exists() else f"# Проверка прогона смены\n\n{START}\n{END}\n"
    head, _, rest = text.partition(START)
    _, _, tail = rest.partition(END)
    DOC.write_text(head + block + tail, encoding="utf-8")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    rows = []
    for case in CASES:
        began = time.perf_counter()
        rows.append(bench(case))
        print(f"{case.name}: {time.perf_counter() - began:.1f} с", flush=True)
    s = setup(CASES[0])
    write(rows, s.max_fleet, s.settings["hours"])
    print(f"Таблица записана в {DOC.name}")


if __name__ == "__main__":
    main()
