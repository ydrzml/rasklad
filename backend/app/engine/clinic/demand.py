"""Заявки смены: лекарства из аптеки и расходники со склада в отделения.

Сколько заявок в сутки и какая доля срочных, дает датасет организатора. Он считает на всю
больницу (точек доставки 22), поэтому объем на корпус берем по числу отделений на плане:
заявок на точку в сутки, умноженное на точки. Распределение по часам: часы пиков из датасета
несут долю peak_share, остальные часы ровно. Внутри часа заявки идут через равные промежутки,
как задания у склада, со сдвигом от seed: так прогоны с разными seed не совпадают по минутам.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

MEDS, SUPPLIES = "meds", "supplies"


@dataclass
class Job:
    id: str
    kind: str
    source: str  # помещение-источник
    target: str  # отделение
    created_s: float
    deadline_s: float
    urgent: bool
    pick_s: float = 0.0  # сколько заявку собирают перед выдачей роботу
    ready_s: float | None = None
    picked_s: float | None = None
    done_s: float | None = None
    robot: int | None = None
    blocked: str = ""  # почему заявку не выполнить: не доехать

    @property
    def on_time(self) -> bool:
        return self.done_s is not None and self.done_s <= self.deadline_s


@dataclass(frozen=True)
class Volume:
    per_day: float  # заявок в сутки на корпус
    urgent_share: float
    pick_s: float
    deadline_s: float
    urgent_deadline_s: float


def hourly(per_day: float, peaks: list[tuple[int, int]], peak_share: float, start_h: int, hours: int) -> list[float]:
    """Заявок в каждый час смены. peaks: часы суток с какого по какой, как в датасете."""
    peak_hours = {hour % 24 for begin, end in peaks for hour in range(begin, end)}
    count = len(peak_hours)
    in_peak = per_day * peak_share / count if count else 0.0
    off_peak = per_day * (1 - peak_share if count else 1.0) / max(1, 24 - count)
    return [in_peak if (start_h + hour) % 24 in peak_hours else off_peak for hour in range(hours)]


def jobs(
    kind: str,
    volume: Volume,
    profile_share: list[float],
    sources: list[str],
    targets: list[str],
    seed: int,
    flows: list[tuple[str, str, float]] | None = None,
    arrival_spread: float = 1.0,
) -> list[Job]:
    """Заявки одного вида за смену. profile_share: доля суточного объема в каждом часе смены."""
    if not sources or not targets:
        return []
    rng = random.Random(f"{seed}:{kind}")
    out: list[Job] = []
    carry = rng.random()
    for hour, share in enumerate(profile_share):
        count = volume.per_day * share
        carry += count
        whole = int(carry)
        carry -= whole
        for number in range(whole):
            at = hour * 3600 + (number + rng.random()) * 3600 / max(1, whole) * arrival_spread
            urgent = rng.random() < volume.urgent_share
            # срок от готовности заказа: комплектацию делает аптека, а не робот
            deadline = at + volume.pick_s + (volume.urgent_deadline_s if urgent else volume.deadline_s)
            source, target = (
                rng.choices(flows, weights=[flow[2] for flow in flows], k=1)[0][:2]
                if flows
                else (rng.choice(sources), rng.choice(targets))
            )
            job = Job(f"{kind}-{len(out) + 1:03}", kind, source, target, at, deadline, urgent)
            job.pick_s = volume.pick_s
            out.append(job)
    return sorted(out, key=lambda job: job.created_s)
