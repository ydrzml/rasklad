"""Журнал событий прогона смены в CSV (ТЗ, п. 3.6: экспорт лога визуализации).

Собираем на сервере из того же прогона, что видит проигрыватель: тот же план, парк, правки и seed,
поэтому строки журнала совпадают с тем, что едет на экране. Разделитель точка с запятой и метка
UTF-8 в начале: так файл открывается в русском Excel двойным щелчком, без мастера импорта.
"""

from __future__ import annotations

import csv
import io

from app.schemas.simulation import SimulationRequest
from app.services import simulation

HEADER = [
    "робот",
    "начало, с от начала смены",
    "конец, с",
    "начало, чч:мм:сс",
    "конец, чч:мм:сс",
    "действие",
    "x начала, м",
    "y начала, м",
    "x конца, м",
    "y конца, м",
    "путь, м",
]


def csv_log(request: SimulationRequest) -> bytes:
    drawn = request.plan.model_dump() if request.plan else None
    plan = simulation.plan_for(request.facility_id, request.operation_id, drawn, request.overrides)
    result = simulation.run(
        request.facility_id,
        request.operation_id,
        request.robot_id,
        request.fleet,
        plan,
        True,
        request.slotted_by_turnover,
        request.overrides,
        request.share,
    )
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\r\n")
    writer.writerow(HEADER)
    for part in sorted(result.segments, key=lambda one: (one.from_s, one.robot)):
        (x0, y0), (x1, y1) = part.path[0], part.path[-1]
        length = sum(
            ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
            for (ax, ay), (bx, by) in zip(part.path, part.path[1:], strict=False)
        )
        writer.writerow(
            [
                part.robot + 1,  # на экране роботы с единицы
                _num(part.from_s),
                _num(part.to_s),
                _clock(part.from_s),
                _clock(part.to_s),
                part.action,
                _num(x0),
                _num(y0),
                _num(x1),
                _num(y1),
                _num(length),
            ]
        )
    return ("\ufeff" + out.getvalue()).encode("utf-8")


def _num(value: float) -> str:
    """Десятичная запятая: русский Excel иначе прочтет 12.5 как дату или текст."""
    return f"{value:.1f}".replace(".", ",")


def _clock(seconds: float) -> str:
    whole = int(seconds)
    return f"{whole // 3600:02d}:{whole % 3600 // 60:02d}:{whole % 60:02d}"
