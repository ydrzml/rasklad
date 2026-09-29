"""Расчет по объекту: несколько задач сразу, с общими людьми и общими затратами.

Задача считается изолированно (scenarios.evaluate), но объект это не сумма изолированных задач.
Общего у них две вещи, и если их складывать по-честному, получится неправда:

дежурные операторы  один дежурный смотрит и за транспортными роботами, и за уборочным.
                    Считать минимум дежурных на каждую задачу значит нанять троих вместо одного.
общие затраты       интеграция с учетной системой, переделка инфраструктуры и связь делаются
                    один раз на объект, сколько бы задач клиент ни выбрал.

Поэтому каждая задача считается сама по себе, без общего, а общее считается отдельным блоком
по всему объекту: дежурные по всему парку, их стоимость средневзвешенно по парку задач, внедрение
максимумом по задачам, связь одна, переобучение один раз. Итог не зависит от порядка задач.
"""

from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field

from app.engine.economics import financing
from app.engine.economics.scenarios import (
    BASELINE,
    PURCHASE,
    RAAS,
    Comparison,
    Scenario,
    Year,
    by_id,
    evaluate,
    finish,
    growth,
    implementation_costs,
    subsidy_grant,
)
from app.engine.economics.staff import fte_per_post


@dataclass(frozen=True)
class Task:
    """Задача, которую клиент выбрал роботизировать, и решение под нее.

    share: доля объема задачи у этого решения. Смешанный парк это две задачи с одним operation_id
    и разными роботами, доли в сумме единица. Часть считается как задача с долей объема: спрос
    части это доля спроса задачи, а люди это доля того, что роботы забирают на всей задаче."""

    operation_id: str
    robot_id: str
    share: float = 1.0

    @property
    def key(self) -> str:
        return f"{self.operation_id}:{self.robot_id}"


@dataclass
class Shared:
    """Общее на объект: дежурные операторы и разовое внедрение. Считается один раз, не через задачу.

    posts           дежурных одновременно, на весь парк объекта
    operator_cost   стоимость ставки дежурного в год: средневзвешенно по задачам, весом парк.
                    Своей ставки у дежурного нет, платим как замененной роли, а замененные роли
                    у задач разные, поэтому берем среднее: у кого роботов больше, с теми дежурный чаще
    integration     интеграция с учетной системой и переделка инфраструктуры: максимум по задачам.
                    Делается один раз, и если хоть одной задаче нужна, объект ее платит
    software        ПО управления парком: по разу на производителя роботов объекта. Две задачи
                    на роботах одной фирмы работают в одной системе, разные фирмы ставят каждая свою
    scenarios       блок общего по сценариям: вложения, связь и дежурные по годам
    """

    posts: int = 0
    operators_fte: float = 0.0
    retrained_fte: float = 0.0
    operators_short_fte: float = 0.0
    operator_cost: float = 0.0
    integration: float = 0.0
    infrastructure: float = 0.0
    retraining_rub: float = 0.0
    software: float = 0.0
    scenarios: dict[str, Scenario] = field(default_factory=dict)


@dataclass
class FacilityResult:
    feasible: bool
    operator_posts: int = 0
    # каждая задача сама по себе: ее роботы и люди, без общего на объект
    tasks: dict[str, Comparison] = field(default_factory=dict)
    shared: Shared = field(default_factory=Shared)
    scenarios: dict[str, Scenario] = field(default_factory=dict)
    message: str | None = None
    notes: list[str] = field(default_factory=list)
    # задача и решение, на которых не сошелся парк: их называем в сообщении
    failed_operation_id: str | None = None
    failed_robot_id: str | None = None

    @property
    def own(self) -> dict[str, Comparison]:
        return self.tasks


def operator_posts_for_facility(model: dict, facility: dict, fleets: dict[str, tuple[dict, int]]) -> int:
    """Сколько дежурных нужно на объекте одновременно, с учетом всего парка сразу.

    Нагрузка складывается по всем задачам: каждый робот требует своих минут внимания в час.
    Минимум дежурных по объекту применяется один раз, а не к каждой задаче.
    """
    load_minutes = sum(robot["operator_attention_min_per_hour"] * fleet for robot, fleet in fleets.values())
    return max(facility["min_operator_posts"], math.ceil(load_minutes / 60))


def software_per_vendor(robots: list[dict]) -> float:
    """ПО управления парком по разу на производителя: у роботов одной фирмы система общая,
    берем самую дорогую из их лицензий, у разных фирм системы свои и складываются."""
    by_vendor: dict[str, float] = {}
    for robot in robots:
        vendor = robot.get("vendor") or robot["id"]
        by_vendor[vendor] = max(by_vendor.get(vendor, 0.0), float(robot.get("software_rub") or 0.0))
    return sum(by_vendor.values())


def _weighted(values: list[float], weights: list[float]) -> float:
    """Среднее с весами. Если веса нулевые, обычное среднее."""
    total = sum(weights)
    if total <= 0:
        return sum(values) / len(values) if values else 0.0
    return sum(v * w for v, w in zip(values, weights, strict=True)) / total


def evaluate_facility(
    model: dict,
    facility_id: str,
    tasks: list[Task],
    subsidy_ids: tuple[str, ...] = (),
    raas_buyout: bool = True,
    curves: dict[str, list[float]] | None = None,
    route_m: float | None = None,
    fleets: dict[str, int] | None = None,
    registry: bool = False,
) -> FacilityResult:
    """Считает задачи каждую саму по себе, общее на объект отдельным блоком и складывает в объект.

    От порядка задач итог не зависит: общее не вешается на первую задачу, а считается по всем.
    fleets: парк задан снаружи, как в чувствительности, где прогон заново не гоняют.
    registry: все выбранные роботы в реестре российской промышленной продукции (719): от этого
    зависят меры поддержки.
    """
    if not tasks:
        return FacilityResult(feasible=False, message="Не выбрано ни одной задачи")

    facility = by_id(model["facilities"], facility_id)
    econ = model["economics"]
    curves = curves or {}
    fleets = fleets or {}

    # Каждая задача без дежурных: они общие и считаются ниже по всему парку
    results: dict[str, Comparison] = {}
    for task in tasks:
        comparison = evaluate(
            model,
            facility_id,
            task.operation_id,
            task.robot_id,
            (),
            raas_buyout,
            curves.get(task.key),
            posts=0,
            shared=False,
            route_m=route_m,
            fleet=fleets.get(task.key),
            share=task.share,
        )
        if not comparison.feasible:
            operation = by_id(facility["operations"], task.operation_id)
            return FacilityResult(
                feasible=False,
                failed_operation_id=task.operation_id,
                failed_robot_id=task.robot_id,
                message=(
                    f"Задача «{operation['name']}»: парк не покрывает пиковый спрос "
                    f"{comparison.peak_demand:.0f} операций в час"
                ),
            )
        results[task.key] = comparison

    robots = {task.key: by_id(model["robots"], task.robot_id) for task in tasks}
    sizes = {op: c.sizing for op, c in results.items()}
    weights = [float(sizes[task.key].fleet) for task in tasks]

    posts = operator_posts_for_facility(model, facility, {op: (robots[op], s.fleet) for op, s in sizes.items()})
    per_post = fte_per_post(facility, econ["annual_work_hours"])
    operators = posts * per_post
    # переучиваем в дежурных людей с любой задачи, один раз на объект
    freed = sum(s.people_freed_fte for s in sizes.values())
    retrained = min(operators, freed)
    impls = [implementation_costs(facility, by_id(facility["operations"], task.operation_id)) for task in tasks]
    shared = Shared(
        posts=posts,
        operators_fte=operators,
        retrained_fte=retrained,
        operators_short_fte=operators - retrained,
        operator_cost=_weighted([sizes[task.key].operator_cost for task in tasks], weights),
        integration=max(impl["integration_rub"] for impl in impls),
        infrastructure=max(impl["infrastructure_rub"] for impl in impls),
        retraining_rub=retrained * max(impl["retraining_rub_per_person"] for impl in impls),
        software=software_per_vendor(list(robots.values())),
    )

    result = FacilityResult(feasible=True, operator_posts=posts, tasks=results, shared=shared)
    available = _available(results, result.notes)
    horizon = econ["horizon_years"]
    for scenario_id in available:
        shared.scenarios[scenario_id] = _shared_scenario(
            model, facility, scenario_id, shared, [robots[t.key] for t in tasks], weights, raas_buyout, horizon
        )
    for scenario_id in available:
        parts = [results[task.key].scenarios[scenario_id] for task in tasks] + [shared.scenarios[scenario_id]]
        total = _sum_scenario(model, scenario_id, parts, subsidy_ids, registry)
        result.scenarios[scenario_id] = total
    return result


def _available(results: dict[str, Comparison], notes: list[str]) -> list[str]:
    """Сценарий попадает в объект, только если он посчитан у всех задач. Аренда есть не у всех
    решений: складывать аренду по одним задачам с покупкой по другим нельзя, это был бы уже
    четвертый сценарий."""
    available = set.intersection(*(set(comparison.scenarios) for comparison in results.values()))
    for scenario_id in (PURCHASE, RAAS):
        if scenario_id not in available:
            missing = [name for name, c in results.items() if scenario_id not in c.scenarios]
            notes.append(
                f"Сценарий «{scenario_id}» по объекту не считаем: его нет у задач {', '.join(missing)}. "
                "Для этих решений нет публичной цены аренды"
            )
    return [scenario_id for scenario_id in (BASELINE, PURCHASE, RAAS) if scenario_id in available]


def _shared_scenario(
    model: dict,
    facility: dict,
    scenario_id: str,
    shared: Shared,
    robots: list[dict],
    weights: list[float],
    raas_buyout: bool,
    horizon: int,
) -> Scenario:
    """Блок общего на объект в одном сценарии: внедрение и переобучение на старте, связь и дежурные
    по годам. Без роботов общего нет: люди работают, как работали."""
    econ = model["economics"]
    scenario = Scenario(scenario_id)
    if scenario_id == BASELINE:
        scenario.years = [Year(t, 0.0, {}, 0.0, 0.0, 0.0, 0.0) for t in range(1, horizon + 1)]
        return scenario

    items = {
        "software": shared.software if scenario_id == PURCHASE else 0.0,
        "integration": shared.integration,
        "infrastructure": shared.infrastructure,
        "retraining": shared.retraining_rub,
    }
    items["reserve"] = sum(items.values()) * econ["capex_reserve_share"]
    scenario.capex = items
    scenario.capex_total = sum(items.values())

    # Срок списания у объекта из разных роботов: средневзвешенно по парку, как и стоимость дежурного
    life = _weighted([robot["service_life_years"] for robot in robots], weights)
    terms = [(robot.get("raas") or {}).get("contract_months", 0) // 12 for robot in robots]
    term = _weighted(terms, weights)
    for t in range(1, horizon + 1):
        if scenario_id == RAAS:
            # при аренде часть присмотра берет поставщик, пока договор идет: у каждой задачи свой срок
            shares = [
                1 - robot["raas"]["support_share"] if not (raas_buyout and t > robot_term) else 1.0
                for robot, robot_term in zip(robots, terms, strict=True)
            ]
            operator_share = _weighted(shares, weights)
            amortization = scenario.capex_total / term if term > 0 and t <= term else 0.0
        else:
            operator_share = 1.0
            amortization = scenario.capex_total / life if life > 0 and t <= life else 0.0
        opex = {
            "communications": facility["implementation"]["communications_rub_year"] * growth(econ["inflation"], t),
            "operators": shared.operators_fte * shared.operator_cost * growth(econ["wage_growth"], t) * operator_share,
        }
        effect = -sum(opex.values())
        scenario.years.append(Year(t, 0.0, opex, effect, 0.0, effect, amortization))
    return scenario


def _sum_scenario(
    model: dict, scenario_id: str, parts: list[Scenario], subsidy_ids: tuple[str, ...], registry: bool = False
) -> Scenario:
    total = Scenario(scenario_id)
    total.capex = _sum_dicts(part.capex for part in parts)
    total.capex_total = sum(part.capex_total for part in parts)
    total.years = [_sum_years(rows) for rows in zip(*(part.years for part in parts), strict=True)]
    if scenario_id == BASELINE:
        total.tco = sum(part.tco for part in parts)
        return total
    if scenario_id == PURCHASE:
        # господдержка и способ оплаты от вложений объекта целиком, после сложения
        chosen = financing.chosen_supports(model, subsidy_ids)
        total.grant = subsidy_grant(model, tuple(sorted(chosen)), total.capex_total)
        plain = finish(model, copy.deepcopy(total))
        _pay(model, total, chosen, registry)
        total.financing.plain_payback = plain.payback_cumulative
        total.financing.plain_npv = plain.npv
        total.financing.plain_irr = plain.irr
        total.financing.plain_tco = plain.tco
    return finish(model, total)


def _pay(model: dict, scenario: Scenario, chosen: set[str], registry: bool) -> None:
    """Кредит или лизинг и меры поддержки: платежи, страховка и возврат затрат по годам, поток своих денег."""
    plan, support = financing.plan(
        model, scenario.capex, scenario.capex_total, scenario.grant, len(scenario.years), chosen, registry
    )
    scenario.financing = plan
    scenario.financed = plan.principal_rub + plan.advance_loan_rub
    scenario.debt_left = plan.debt_left_rub if scenario.financed > 0 else []
    before_debt = []
    for year, got, insured in zip(scenario.years, support, plan.insurance_rub, strict=True):
        paid = plan.payments_rub[year.t - 1] if plan.payments_rub else 0.0
        loans = plan.advance_loan_payments_rub[year.t - 1] if plan.advance_loan_payments_rub else 0.0
        # страховку требует кредитор: это затрата способа оплаты, экономия проекта от нее не меняется
        year.insurance = insured
        year.financing = paid + loans
        year.support = got
        year.cash_flow = year.effect - year.investment - year.financing - year.insurance + year.support
        before_debt.append(year.effect - year.investment - year.insurance + year.support)
    financing.cover(model.get("financing"), before_debt, [y.financing for y in scenario.years], plan)


def _sum_years(rows: tuple[Year, ...]) -> Year:
    first = rows[0]
    opex = _sum_dicts(row.opex for row in rows)
    effect = sum(row.effect for row in rows)
    investment = sum(row.investment for row in rows)
    return Year(
        t=first.t,
        staff_cost=sum(row.staff_cost for row in rows),
        opex=opex,
        effect=effect,
        investment=investment,
        cash_flow=effect - investment,
        amortization=sum(row.amortization for row in rows),
        ramp=sum(row.ramp for row in rows),
        insurance=sum(row.insurance for row in rows),
    )


def _sum_dicts(dicts) -> dict[str, float]:
    total: dict[str, float] = {}
    for item in dicts:
        for key, value in item.items():
            total[key] = total.get(key, 0.0) + value
    return total
