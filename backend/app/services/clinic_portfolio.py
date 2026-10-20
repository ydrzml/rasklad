"""Выбор процессов для роботизации при одинаковой остальной ручной работе.

Ручной вариант: финансовая точка отсчета. Его SLA не подтверждается этой моделью.
Денежные разницы отдельных процессов сопоставимы: нетронутая работа сокращается из обеих сторон.
"""

import time
from itertools import combinations

from app.schemas.clinic import OptimizationRequest
from app.services import clinic, clinic_optimizer


def compare(request: OptimizationRequest) -> dict:
    tasks = list(dict.fromkeys(t for t in request.operation_ids if t in ("floor_delivery", "cleaning")))
    if not tasks:
        raise clinic.BadInput("Выберите доставку или уборку")
    subsets = [list(group) for count in range(1, len(tasks) + 1) for group in combinations(tasks, count)]
    start = time.perf_counter()
    options = []
    for index, subset in enumerate(subsets):
        remaining = request.time_budget_s - (time.perf_counter() - start)
        row = {
            "id": "+".join(subset),
            "automated": subset,
            "manual": [t for t in tasks if t not in subset],
            "candidate": None,
            "complete": False,
            "message": "",
        }
        if remaining < 2:
            row["message"] = "Время сравнения исчерпано; этот вариант не проверен"
        else:
            seconds = max(2, min(30, remaining / (len(subsets) - index)))
            try:
                result = clinic_optimizer.optimize(
                    request.model_copy(update={"operation_ids": subset, "time_budget_s": seconds})
                )
                row["candidate"] = next(
                    (c.model_dump() for c in result.candidates if c.id == result.recommended_id), None
                )
                row["complete"] = result.fully_enumerated
                row["message"] = (
                    result.stopped
                    if row["candidate"]
                    else "Состав, выполняющий требования, не подтвержден: " + result.stopped
                )
            except clinic.BadInput as error:
                row["message"] = str(error)
        options.append(row)
    checked = [row for row in options if row["candidate"] is not None]
    beneficial = [row for row in checked if row["candidate"]["incremental_npv_cost_rub"] < -0.01]
    best = min(beneficial, key=lambda row: row["candidate"]["incremental_npv_cost_rub"], default=None)
    return {
        "options": options,
        "recommended_id": best["id"] if best else None,
        "manual_is_cheapest": bool(checked) and not beneficial,
        "complete": all(row["complete"] for row in options),
        "manual_service_verified": False,
        "notes": [
            "Ручная работа: финансовая база с нулевыми дополнительными инвестициями; ее сроки и достаточность штата не проверены симуляцией",
            "Сравнение по худшему NPV среди проверенных условий; неавтоматизируемые процессы остаются ручными и не включаются в затраты выбранного фрагмента",
            "Рассматриваются доставка лекарств и расходников и полы коридоров одного корпуса; пакетные рейсы, отказы и ограниченный ресурс помощников пока не моделируются",
        ],
    }
