"""Сколько доставщиков нужно корпусу: самый маленький парк, при котором вовремя не меньше цели.

Как у склада (simulation.search_fleet): парк подтверждаем на каждом seed, а не на одном удачном.
Ищем снизу вверх, потому что парк больницы маленький: от одного до нескольких десятков,
и каждая смена считается за десятые доли секунды. Доля вовремя по парку остается для графика.
Поиск ограничен по времени: ответ нужен за секунды, а не за минуту.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Quality:
    share: float | None
    valid: bool = True  # дополнительные требования: завершение и срочные заявки


Measure = Callable[[int, int], float | None | Quality]


@dataclass
class FleetSearch:
    needed: int | None  # None: цель не достигнута
    curve: list[tuple[int, float]] = field(default_factory=list)  # парк и худшая по seed доля вовремя
    stopped: str = ""  # почему поиск кончился без парка: полка или время


def search(
    measure: Measure, seeds: tuple[int, ...], target: float, max_fleet: int, budget_s: float = float("inf")
) -> FleetSearch:
    began = time.perf_counter()
    curve: list[tuple[int, float]] = []
    for fleet in range(1, max_fleet + 1):
        shares = []
        valid = True
        for seed in seeds:
            measured = measure(fleet, seed)
            valid = valid and (measured.valid if isinstance(measured, Quality) else True)
            shares.append(measured.share if isinstance(measured, Quality) else measured)
            if time.perf_counter() - began > budget_s:
                break
        worst = min((share for share in shares if share is not None), default=1.0)
        curve.append((fleet, worst))
        if len(shares) < len(seeds):  # время вышло посреди шага: парк не подтвержден на всех seed
            return FleetSearch(None, curve, "поиск не уложился во время, парк дальше не проверяли")
        if worst >= target and valid:
            return FleetSearch(fleet, curve)
        if time.perf_counter() - began > budget_s:
            return FleetSearch(None, curve, "поиск не уложился во время, парк дальше не проверяли")
    return FleetSearch(None, curve, f"не хватило и {max_fleet} роботов")
