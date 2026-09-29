"""Бюджет на старте: сколько роботов в него влезает со всеми вложениями и что они вытянут.

Честно, как просил заказчик: не цена изделия, а вложения на старте целиком, как их считает
экономика покупки. Роботы, зарядки, ПО, станции, пусконаладка и переобучение растут с парком,
общее на объект (интеграция, инфраструктура) и резерв 10% на все берутся так же, как в расчете.
Парк подбираем половинным делением: вложения с парком не убывают.
"""

from __future__ import annotations

from app.engine.economics.facility import FacilityResult
from app.engine.economics.scenarios import PURCHASE, RAAS, by_id, evaluate
from app.schemas.budget import BudgetCheck, BudgetFit, BudgetFitRequest, BudgetTask
from app.schemas.economics import CalculationRequest
from app.services.calculation import Prepared, model_with_overrides


def fit_task(
    model: dict,
    facility_id: str,
    operation_id: str,
    robot_id: str,
    budget_rub: float | None,
    route_m: float | None = None,
    share: float = 1.0,
) -> BudgetFit:
    """Одна задача с одним решением сама по себе: нужный парк по формуле и парк по бюджету.
    Без бюджета только парк по формуле: шаг решения по нему предупреждает, что решение может
    не покрыть пик, еще до прогона смены."""

    def investment(scenario: str, fleet: int | None) -> float | None:
        comparison = evaluate(model, facility_id, operation_id, robot_id, route_m=route_m, fleet=fleet, share=share)
        if not comparison.feasible or scenario not in comparison.scenarios:
            return None
        return comparison.scenarios[scenario].investment_year0

    needed = evaluate(model, facility_id, operation_id, robot_id, route_m=route_m, share=share)
    fleet_needed = needed.sizing.fleet if needed.feasible and needed.sizing else None
    if budget_rub is None:
        return BudgetFit(
            robot_id=robot_id,
            fleet_needed=fleet_needed,
            fleet_fits=0,
            investment_rub=0.0,
            investment_needed_rub=investment(PURCHASE, fleet_needed) if fleet_needed is not None else None,
            raas_start_rub=None,
            raas_fits=None,
        )
    top = fleet_needed if fleet_needed is not None else model["engine"]["max_fleet"]
    fits = largest_fitting(lambda fleet: investment(PURCHASE, fleet), budget_rub, top)
    raas_start = investment(RAAS, fleet_needed) if fleet_needed is not None else None
    return BudgetFit(
        robot_id=robot_id,
        fleet_needed=fleet_needed,
        fleet_fits=fits,
        investment_rub=investment(PURCHASE, fits) or 0.0,
        investment_needed_rub=investment(PURCHASE, fleet_needed) if fleet_needed is not None else None,
        raas_start_rub=raas_start,
        raas_fits=None if raas_start is None else raas_start <= budget_rub,
    )


def largest_fitting(cost, budget_rub: float, top: int) -> int:
    """Самый большой парк от 0 до top, чья стоимость не больше бюджета. Стоимость с парком не
    убывает, поэтому половинное деление; если не влезает и ноль роботов (подготовка объекта
    дороже бюджета), ответ 0."""
    low, high = 0, top
    if (cost(0) or 0.0) > budget_rub:
        return 0
    while low < high:
        middle = (low + high + 1) // 2
        value = cost(middle)
        if value is not None and value <= budget_rub:
            low = middle
        else:
            high = middle - 1
    return low


def fit(request: BudgetFitRequest) -> list[BudgetFit]:
    model, _ = model_with_overrides(request.overrides)
    route_m = None
    if request.plan is not None:
        from app.services import plan as plan_service

        route_m = plan_service.measure(plan_service.from_dict(request.plan.model_dump())).route_m
    return [
        fit_task(model, request.facility_id, request.operation_id, robot_id, request.budget_rub, route_m, request.share)
        for robot_id in request.robot_ids
    ]


def check(
    request: CalculationRequest,
    prepared: Prepared,
    result: FacilityResult,
    run,
) -> BudgetCheck | None:
    """Бюджет в расчете: влезает ли покупка и аренда, а если покупка не влезла, сколько роботов
    каждой задачи бюджет покупает при прочих задачах как есть и что они вытянут за смену.

    run(fleets) считает объект заново с заданным парком у части задач, как чувствительность.
    """
    budget = request.budget_rub
    if not budget or not result.feasible or PURCHASE not in result.scenarios:
        return None
    purchase_fits = result.scenarios[PURCHASE].investment_year0 <= budget
    raas = result.scenarios.get(RAAS)
    check = BudgetCheck(
        budget_rub=budget,
        purchase_fits=purchase_fits,
        raas_fits=None if raas is None else raas.investment_year0 <= budget,
    )
    if purchase_fits:
        return check
    facility = by_id(prepared.model["facilities"], request.facility_id)
    for choice in request.choices():
        own = result.tasks[choice.key]
        needed = own.sizing.fleet if own.sizing else 0

        def cost(fleet: int, key: str = choice.key) -> float | None:
            other: FacilityResult = run({key: fleet})
            if not other.feasible or PURCHASE not in other.scenarios:
                return None
            return other.scenarios[PURCHASE].investment_year0

        fits = largest_fitting(cost, budget, needed)
        done_share, ops_per_hour = _shift_with(request, prepared, choice, fits) if 0 < fits < needed else (None, None)
        if fits == 0:
            done_share, ops_per_hour = 0.0, 0.0
        check.tasks.append(
            BudgetTask(
                operation_id=choice.operation_id,
                operation_name=by_id(facility["operations"], choice.operation_id)["name"],
                robot_id=choice.robot_id,
                share=choice.share,
                fleet_needed=needed,
                fleet_fits=fits,
                investment_rub=cost(fits) or 0.0,
                done_share=done_share,
                ops_per_hour=ops_per_hour,
            )
        )
    return check


def _shift_with(
    request: CalculationRequest, prepared: Prepared, choice, fleet: int
) -> tuple[float | None, float | None]:
    """Один прогон смены с парком по бюджету: какую долю спроса смены он сделал."""
    if not request.use_simulation:
        return None, None
    from app.services import simulation

    model, facility, operation, robot = simulation._parts(
        request.facility_id,
        choice.operation_id,
        choice.robot_id,
        simulation.with_share(request.overrides, request.facility_id, choice.operation_id, choice.share),
    )
    plan = simulation.task_plan(request.facility_id, choice.operation_id, prepared.drawn, request.overrides)
    outcome = simulation.run(
        request.facility_id,
        choice.operation_id,
        choice.robot_id,
        fleet,
        plan,
        with_events=False,
        by_turnover=simulation.slotted(facility),
        overrides=request.overrides,
        share=choice.share,
    )
    size = simulation.per_trip(robot, operation)
    demand = sum(simulation.shift_demand(model, facility, operation))
    done = outcome.kpi.done * size
    return (min(1.0, done / demand) if demand > 0 else None), outcome.kpi.ops_per_hour * size
