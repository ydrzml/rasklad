"""Стенд поиска парка: какими способами найти самый маленький парк, который вытягивает спрос.

В приложении взяли секущую с проверкой параллельно, она живет в app/engine/simulation.py
(search_fleet). Здесь ее копия рядом с остальными способами, чтобы сравнение можно было повторить.

Зачем. Парк берем из прогона смены, а не из формулы. Прогон смены долгий, а кривая
«роботов - операций в час» гоняет его на каждом размере парка подряд: на отборе до минуты
и дольше. Здесь сравниваем способы поиска по времени и по ответу на трех seed.

Что считаем ответом. Самое маленькое число исправных роботов W, при котором потолок смены не
ниже спроса во всех трех seed, и парк = W / готовность, вверх. Во всех трех, а не в среднем:
парк, который справился три раза из трех, мы показываем одним числом без оговорок.

Запуск: cd backend && python -m scripts.fleet_search_bench
"""

from __future__ import annotations

import math
import time
from concurrent.futures import ProcessPoolExecutor
from functools import partial

from app.engine import simulation as sim
from app.engine.economics.fleet import required_fleet, robot_ops_per_hour
from scripts.run_shift_bench import CASES, LEVELS, SEEDS, Setup, curve, setup

WANTED = [
    ("С одной стороны, 10 тыс. м2", 1),
    ("Сквозной, 30 тыс. м2", 1),
    ("Робозона со станциями, 3 тыс. м2", 1),
    ("Робозона со станциями, 10 тыс. м2", 1),
    # трудные случаи: полка ниже спроса и склад, которому не хватает и 250 роботов
    ("Робозона со станциями, 3 тыс. м2", 2),
    ("Робозона со станциями, 30 тыс. м2", 1),
    ("Узкий склад, проезд между рядами", 2),
]
FAST = ("секущая", "секущая, проверка параллельно")

# --- замер одного размера парка ---------------------------------------------------------

_ONE: Setup | None = None


def _load(name: str) -> None:
    """Схему в процесс-помощник кладем один раз: гонять ее в каждой задаче дорого."""
    global _ONE
    _ONE = setup(next(case for case in CASES if case.name == name))


def _ceiling(job: tuple[int, int]) -> tuple[int, int, float]:
    working, seed = job
    s = _ONE
    assert s is not None
    top = sim.plenty(s.layout, s.spec, working)
    value = sim.run_shift(s.layout, s.spec, working, top, s.settings["hours"], seed, record=False).kpi.ops_per_hour
    return working, seed, value


class Meter:
    """Потолок смены при W исправных роботах и seed. Каждый замер делается один раз."""

    def __init__(self, s: Setup, pool: ProcessPoolExecutor | None):
        self.s = s
        self.pool = pool
        self.seen: dict[tuple[int, int], float] = {}
        self.runs = 0

    def many(self, jobs: list[tuple[int, int]]) -> None:
        jobs = [job for job in dict.fromkeys(jobs) if job not in self.seen]
        if not jobs:
            return
        self.runs += len(jobs)
        if self.pool:
            for working, seed, value in self.pool.map(_ceiling, jobs):
                self.seen[(working, seed)] = value
        else:
            global _ONE
            _ONE = self.s
            for job in jobs:
                working, seed, value = _ceiling(job)
                self.seen[(working, seed)] = value

    def covers(self, working: int, demand: float, lazy: bool = True) -> bool:
        """Справился ли парк во всех seed. lazy: следующий seed мерим, только если прошел прошлый."""
        if lazy and not self.pool:
            for seed in SEEDS:
                self.many([(working, seed)])
                if self.seen[(working, seed)] < demand:
                    return False
            return True
        self.many([(working, seed) for seed in SEEDS])
        return all(self.seen[(working, seed)] >= demand for seed in SEEDS)


# --- способы поиска ---------------------------------------------------------------------


def by_curve(s: Setup, demand: float) -> tuple[int | None, int]:
    """Как сейчас в приложении: кривая подряд на одном seed, парк по ней."""
    values = curve(s, SEEDS[0], until=demand)
    measured = len({math.ceil(n * s.settings["availability"]) for n in range(len(values))})
    return required_fleet(demand, values), measured


def bisect(meter: Meter, low: int, high: int, demand: float) -> int | None:
    """low не справляется, high справляется: делим пополам, пока между ними не останется шага."""
    while high - low > 1:
        middle = (low + high) // 2
        if meter.covers(middle, demand):
            high = middle
        else:
            low = middle
    return high


def halving(meter: Meter, demand: float, top: int) -> int | None:
    if not meter.covers(top, demand):
        return None
    return bisect(meter, 0, top, demand)


def formula_start(meter: Meter, demand: float, top: int, guess: int) -> int | None:
    """Старт с формулы, потом шаги в нужную сторону, растущие вдвое, потом деление пополам."""
    guess = min(top, max(1, guess))
    if meter.covers(guess, demand):
        high, step = guess, max(1, guess // 10)
        low = high - step
        while low > 0 and meter.covers(low, demand):
            high, step = low, step * 2
            low = high - step
        return bisect(meter, max(0, low), high, demand)
    low, step = guess, max(1, guess // 10)
    high = low + step
    while high < top and not meter.covers(high, demand):
        low, step = high, step * 2
        high = min(top, low + step)
    if high >= top and not meter.covers(top, demand):
        return None
    return bisect(meter, low, high, demand)


def spread(meter: Meter, demand: float, top: int, guess: int, width: int = 4) -> int | None:
    """Параллельно: за раз мерим несколько размеров парка вокруг догадки на всех seed.
    Вилка сужается в width + 1 раз за раунд, а не вдвое."""
    low, high = 0, None
    # сначала вилка вокруг формулы: догадка и шаги вверх
    guess = min(top, max(1, guess))
    points = sorted({min(top, max(1, round(guess * k))) for k in (0.8, 1.0, 1.25, 1.6, 2.0)})
    while high is None:
        meter.many([(w, seed) for w in points for seed in SEEDS])
        ok = [w for w in points if all(meter.seen[(w, seed)] >= demand for seed in SEEDS)]
        bad = [w for w in points if w not in ok]
        if ok:
            high = min(ok)
            low = max([w for w in bad if w < high], default=0)
        else:
            if points[-1] >= top:
                return None
            low = points[-1]
            points = sorted({min(top, low + round(low * k)) for k in (0.25, 0.5, 1.0, 2.0)})
    while high - low > 1:
        step = (high - low) / (width + 1)
        points = sorted({low + max(1, round(step * k)) for k in range(1, width + 1)} - {high})
        points = [w for w in points if low < w < high]
        meter.many([(w, seed) for w in points for seed in SEEDS])
        for w in points:
            if all(meter.seen[(w, seed)] >= demand for seed in SEEDS):
                high = w
                break
            low = w
    return high


def secant(meter: Meter, demand: float, top: int, guess: int) -> int | None:
    """Прицел по секущей: кривая до полки почти прямая, поэтому по двум замерам на одном seed
    видно, где она пересечет спрос. Потом ответ подтверждаем на всех seed: сам ответ и парк на
    единицу меньше. Не подтвердился, шагаем в нужную сторону шагом, растущим вдвое, и делим
    вилку пополам. Если и полный парк не тянет спрос, ответа нет: это полка."""
    seed = SEEDS[0]
    points: list[tuple[int, float]] = [(0, 0.0)]
    working = min(top, max(1, guess))
    for _ in range(6):
        meter.many([(working, seed)])
        points.append((working, meter.seen[(working, seed)]))
        (w1, v1), (w2, v2) = sorted(points, key=lambda one: abs(one[1] - demand))[:2]
        if v1 == v2:
            break
        nxt = min(top, max(1, math.ceil(w1 + (demand - v1) * (w2 - w1) / (v2 - v1) - 1e-9)))
        if nxt == top and meter.covers(top, demand) is False:
            return None
        if any(nxt == w for w, _ in points):
            working = nxt
            break
        working = nxt
    return confirm(meter, demand, top, working)


def confirm(meter: Meter, demand: float, top: int, working: int) -> int | None:
    """Ответ подтвержден, когда справился он и не справился парк на единицу меньше."""
    both = [(working, seed) for seed in SEEDS] + [(working - 1, seed) for seed in SEEDS if working > 1]
    meter.many(both)
    if meter.covers(working, demand):
        if working == 1 or not meter.covers(working - 1, demand):
            return working
        high, step = working - 1, 2
        while True:  # вниз, пока справляется
            low = max(0, high - step)
            if low == 0 or not meter.covers(low, demand):
                return bisect(meter, low, high, demand)
            high, step = low, step * 2
    low, step = working, 1
    while True:  # вверх, пока не справится
        high = min(top, low + step)
        if meter.covers(high, demand):
            return bisect(meter, low, high, demand)
        if high >= top:
            return None
        low, step = high, step * 2


def fleet_of(working: int | None, s: Setup) -> int | None:
    return None if working is None else math.ceil(working / s.settings["availability"] - 1e-9)


def main() -> None:
    workers = min(12, len(SEEDS) * 4)
    for name, level in WANTED:
        case = next(one for one in CASES if one.name == name)
        s = setup(case)
        demand = LEVELS[case.operation][level]
        top = math.floor(s.max_fleet * s.settings["availability"])
        formula = math.ceil(demand / (robot_ops_per_hour(s.robot, s.measures.route_m) * s.robot["utilization"]))
        guess = math.ceil(formula * s.settings["availability"])
        print(f"\n{name}: спрос {demand}, формула {formula}")

        began = time.perf_counter()
        fleet, _ = by_curve(s, demand)
        print(f"  кривая подряд, один seed      парк {fleet}  {time.perf_counter() - began:6.1f} с")

        for title, run in [
            ("пополам, три seed", partial(halving, demand=demand, top=top)),
            ("от формулы, три seed", partial(formula_start, demand=demand, top=top, guess=guess)),
            ("секущая", partial(secant, demand=demand, top=top, guess=guess)),
        ]:
            meter = Meter(s, None)
            began = time.perf_counter()
            working = run(meter)
            print(
                f"  {title:<28}  парк {fleet_of(working, s)}  {time.perf_counter() - began:6.1f} с,"
                f" прогонов {meter.runs}"
            )

        with ProcessPoolExecutor(workers, initializer=_load, initargs=(name,)) as pool:
            list(pool.map(_ceiling, [(1, SEEDS[0])] * workers))  # прогреть помощников
            for title, run in [
                ("от формулы, seed параллельно", partial(formula_start, demand=demand, top=top, guess=guess)),
                ("вилка параллельно", partial(spread, demand=demand, top=top, guess=guess)),
                ("секущая, проверка параллельно", partial(secant, demand=demand, top=top, guess=guess)),
            ]:
                meter = Meter(s, pool)
                began = time.perf_counter()
                working = run(meter)
                print(
                    f"  {title:<28}  парк {fleet_of(working, s)}  {time.perf_counter() - began:6.1f} с,"
                    f" прогонов {meter.runs}"
                )


if __name__ == "__main__":
    main()
