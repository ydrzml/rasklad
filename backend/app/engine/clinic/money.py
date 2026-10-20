"""Деньги медучреждения: без роботов, покупка и аренда за горизонт.

Высвобожденные часы и сокращение денежных расходов считаем отдельно: в деньги идет только
заданная доля высвобождения, остальная зарплата остается в затратах. Числа приходят из сервиса.

Срок окупаемости как у склада: первый выход накопленного денежного потока в ноль. Горизонт
медучреждения (7 лет) длиннее срока службы (5 лет), и в нем парк покупают второй раз. Остаток
срока службы второго парка на конец горизонта не деньги, но и не потеря: без него покупка
оплачивала бы десять лет работы роботов против семи у аренды и людей. Поэтому в итоге за горизонт,
NPV и стоимости владения его вычитаем отдельной строкой, а в сроке окупаемости не трогаем.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.engine.economics.financing import EQUAL, amortize, month_payments
from app.engine.economics.metrics import cumulative_payback

BASELINE, PURCHASE, RAAS = "baseline", "purchase", "raas"
LOAN = "loan"


@dataclass
class Fleet:
    """Роботы одной задачи: сколько, почем и сколько стоит их держать."""

    task: str
    name: str
    count: int
    price_rub: float
    maintenance_share_year: float
    commissioning_share: float
    life_years: int
    rent_month_rub: float | None  # None: цену аренды не нашли, аренду не считаем
    rent_first_month_rub: float | None = None
    rent_year_rub: float | None = None
    rent_first_year_rub: float | None = None
    commissioning_rub: float | None = None
    maintenance_rub_year: float | None = None
    rent_service_included: bool | None = None


@dataclass
class Inputs:
    staff_hours_year: float  # часы людей в год, которые забирают роботы
    hour_rub: float  # час санитара с начислениями
    horizon: int
    wage_growth: float
    inflation: float
    fleets: list[Fleet]
    cash_realization_share: float = 0.0
    staff_cost_year: float | None = None  # разные ставки санитаров и уборщиц
    robot_staff_cost_year: float = 0.0  # оставшаяся ручная работа, загрузка и помощь роботам
    integration_rub: float = 0.0
    extra_annual_rub: float = 0.0
    additional_staff_cost_year: float = 0.0
    rent_service_included: bool = False
    loan_enabled: bool = False
    loan_rate: float = 0.2
    loan_months: int = 36
    loan_own_share: float = 0.2
    loan_insurance_share: float = 0.01
    discount_rate: float = 0.0
    cash_saving_cap_rub_year: float | None = None


@dataclass
class Loan:
    principal_rub: float
    rate: float
    term_months: int
    first_month_rub: float
    last_month_rub: float
    payments_rub: list[float]
    debt_left_rub: list[float]
    interest_rub: float
    insurance_rub: list[float]
    equity_payback_years: float | None = None


@dataclass
class Scenario:
    id: str
    available: bool = True
    why_not: str = ""
    start_rub: float = 0.0  # деньги на старте
    years_rub: list[float] = field(default_factory=list)  # расходы каждого года 1..H
    tco_rub: float = 0.0  # все за горизонт: старт и годы
    saving_rub: float = 0.0  # насколько меньше, чем без роботов
    effect_year1_rub: float = 0.0  # экономия первого года против людей
    payback_years: float | None = None
    month_rub: float | None = None  # у аренды платеж в месяц
    first_payment_rub: float | None = None
    robot_cost_rub: float = 0.0  # парк, интеграция и эксплуатация без зарплат
    rent_period: str = "month"
    rental_options_rub: dict[str, float] = field(default_factory=dict)
    financing: Loan | None = None
    npv_rub: float = 0.0
    discounted_payback_years: float | None = None
    residual_rub: float = 0.0  # остаток срока службы парка на конец горизонта, не деньги


def growth(rate: float, year: int) -> float:
    return (1 + rate) ** (year - 1)


def evaluate(inputs: Inputs) -> list[Scenario]:
    """Три сценария. Аренда только там, где у всех роботов есть цена аренды: придумывать ее не будем."""
    cost = inputs.staff_cost_year
    if cost is None:
        cost = inputs.staff_hours_year * inputs.hour_rub
    staff = [cost * growth(inputs.wage_growth, t) for t in years(inputs)]
    baseline = Scenario(BASELINE, years_rub=staff, tco_rub=sum(staff))
    # Высвобождение без сокращения бюджета не оплачивает роботов. При избытке помощи
    # над ручной базой дополнительные часы, наоборот, увеличивают затраты полностью.
    net = cost - inputs.robot_staff_cost_year
    savings = max(net, 0.0) * inputs.cash_realization_share
    if inputs.cash_saving_cap_rub_year is not None:
        savings = min(savings, inputs.cash_saving_cap_rub_year)
    saved = savings + min(net, 0.0)
    retained = [
        (cost - saved + inputs.additional_staff_cost_year) * growth(inputs.wage_growth, t) for t in years(inputs)
    ]
    return [
        baseline,
        _finish(_purchase(inputs), staff, retained, inputs.discount_rate),
        _finish(_rent(inputs), staff, retained, inputs.discount_rate),
        _finish(_loan(inputs), staff, retained, inputs.discount_rate),
    ]


def _loan(inputs: Inputs) -> Scenario:
    if not inputs.loan_enabled:
        return Scenario(LOAN, available=False, why_not="Кредит не добавлен к сравнению")
    purchase = _purchase(inputs)
    hardware = sum(one.count * one.price_rub for one in inputs.fleets)
    principal = hardware * (1 - inputs.loan_own_share)
    paid, left = amortize(principal, inputs.loan_rate, inputs.loan_months, inputs.horizon, EQUAL)
    first, last = month_payments(principal, inputs.loan_rate, inputs.loan_months, EQUAL)
    insurance = (
        [
            hardware * inputs.loan_insurance_share * max(0, min(12, inputs.loan_months - 12 * year)) / 12
            for year in range(inputs.horizon)
        ]
        if principal > 0
        else [0.0] * inputs.horizon
    )
    return Scenario(
        LOAN,
        residual_rub=purchase.residual_rub,
        start_rub=purchase.start_rub - principal,
        years_rub=[
            cost + payment + cover for cost, payment, cover in zip(purchase.years_rub, paid, insurance, strict=True)
        ],
        month_rub=first,
        financing=Loan(
            principal,
            inputs.loan_rate,
            inputs.loan_months,
            first,
            last,
            paid,
            left,
            max(0.0, sum(paid) - principal),
            insurance,
        ),
    )


def years(inputs: Inputs) -> range:
    return range(1, inputs.horizon + 1)


def _purchase(inputs: Inputs) -> Scenario:
    start = inputs.integration_rub + sum(one.count * (one.price_rub + commissioning(one)) for one in inputs.fleets)
    costs = []
    for t in years(inputs):
        cost = inputs.extra_annual_rub * growth(inputs.inflation, t)
        for one in inputs.fleets:
            cost += one.count * maintenance(one) * growth(inputs.inflation, t)
            # срок службы вышел: в начале года покупаем парк заново по цене с инфляцией
            if t > 1 and (t - 1) % one.life_years == 0:
                cost += one.count * (one.price_rub + commissioning(one)) * growth(inputs.inflation, t)
        costs.append(cost)
    # Продажи в конце нет: остаток срока службы идет в итог горизонта, но не в денежный поток лет
    left = sum(residual(one, inputs) for one in inputs.fleets)
    return Scenario(PURCHASE, start_rub=start, years_rub=costs, residual_rub=left)


def commissioning(one: Fleet) -> float:
    return one.commissioning_rub if one.commissioning_rub is not None else one.price_rub * one.commissioning_share


def maintenance(one: Fleet) -> float:
    return (
        one.maintenance_rub_year if one.maintenance_rub_year is not None else one.price_rub * one.maintenance_share_year
    )


def rental_extras(inputs: Inputs) -> float:
    return inputs.extra_annual_rub + sum(
        one.count * maintenance(one)
        for one in inputs.fleets
        if not (one.rent_service_included if one.rent_service_included is not None else inputs.rent_service_included)
    )


def residual(one: Fleet, inputs: Inputs) -> float:
    """Остаток срока службы парка на конец горизонта по цене последней покупки, линейно.

    Не поступление денег: в денежный поток лет и в срок окупаемости не входит.
    """
    bought = (inputs.horizon - 1) // one.life_years * one.life_years  # год последней покупки, 0 это старт
    used = inputs.horizon - bought
    if used >= one.life_years:
        return 0.0
    return one.count * one.price_rub * growth(inputs.inflation, bought + 1) * (one.life_years - used) / one.life_years


def _rent(inputs: Inputs) -> Scenario:
    options = []
    if all(not one.count or one.rent_month_rub is not None for one in inputs.fleets):
        options.append(_monthly(inputs))
    if all(not one.count or one.rent_year_rub is not None for one in inputs.fleets):
        annual = sum(one.count * (one.rent_year_rub or 0) for one in inputs.fleets)
        first = sum(
            one.count * (one.rent_first_year_rub if one.rent_first_year_rub is not None else (one.rent_year_rub or 0))
            for one in inputs.fleets
        )
        costs = [(annual + rental_extras(inputs)) * growth(inputs.inflation, t) for t in years(inputs)]
        if costs:
            costs[0] -= annual  # первый год оплачен авансом на старте
        options.append(
            Scenario(
                RAAS,
                start_rub=inputs.integration_rub + first,
                years_rub=costs,
                month_rub=annual / 12,
                first_payment_rub=first,
                rent_period="year",
            )
        )
    if not options:
        missing = [
            one.name for one in inputs.fleets if one.count and one.rent_month_rub is None and one.rent_year_rub is None
        ]
        return Scenario(RAAS, available=False, why_not=f"Полный тариф аренды парка не найден: {', '.join(missing)}")
    chosen = min(options, key=lambda one: one.start_rub + sum(one.years_rub))
    chosen.rental_options_rub = {one.rent_period: one.start_rub + sum(one.years_rub) for one in options}
    return chosen


def _monthly(inputs: Inputs) -> Scenario:
    month = sum(one.count * (one.rent_month_rub or 0.0) for one in inputs.fleets)
    first = sum(
        one.count * (one.rent_first_month_rub if one.rent_first_month_rub is not None else (one.rent_month_rub or 0))
        for one in inputs.fleets
    )
    costs = [(month * 12 + rental_extras(inputs)) * growth(inputs.inflation, t) for t in years(inputs)]
    if costs:
        costs[0] -= month  # первый месяц оплачивается на старте по отдельному тарифу
    return Scenario(
        RAAS, start_rub=inputs.integration_rub + first, years_rub=costs, month_rub=month, first_payment_rub=first
    )


def _finish(scenario: Scenario, staff: list[float], retained: list[float], discount_rate: float = 0) -> Scenario:
    if not scenario.available:
        return scenario
    left = scenario.residual_rub
    scenario.robot_cost_rub = scenario.start_rub + sum(scenario.years_rub) - left
    scenario.years_rub = [robots + people for robots, people in zip(scenario.years_rub, retained, strict=True)]
    effects = [people - robots for people, robots in zip(staff, scenario.years_rub, strict=True)]
    scenario.tco_rub = scenario.start_rub + sum(scenario.years_rub) - left
    scenario.saving_rub = sum(staff) - scenario.tco_rub
    scenario.effect_year1_rub = effects[0] if effects else 0.0
    scenario.payback_years = cumulative_payback([-scenario.start_rub, *effects])
    discounted = [effect / (1 + discount_rate) ** year for year, effect in enumerate(effects, 1)]
    scenario.npv_rub = -scenario.start_rub + sum(discounted) + left / (1 + discount_rate) ** len(effects)
    scenario.discounted_payback_years = cumulative_payback([-scenario.start_rub, *discounted])
    if scenario.financing:
        plan = scenario.financing
        plan.equity_payback_years = scenario.payback_years
        # Возврат маленького аванса не означает окупаемость: учитываем непогашенный долг.
        debts = [plan.principal_rub, *plan.debt_left_rub]
        project_effects = [effect + debts[i] - debts[i + 1] for i, effect in enumerate(effects)]
        scenario.payback_years = cumulative_payback([-scenario.start_rub - plan.principal_rub, *project_effects])
        scenario.discounted_payback_years = cumulative_payback(
            [
                -scenario.start_rub - plan.principal_rub,
                *[effect / (1 + discount_rate) ** year for year, effect in enumerate(project_effects, 1)],
            ]
        )
    return scenario
