"""Кредит, лизинг и господдержка на эталоне по плану: числа посчитаны руками в docs/calculation.md,
раздел "Кредит, лизинг и господдержка". Эталон покупки: CAPEX 40.57 млн, эффект 32.71, 35.06, 34.94,
40.26, 43.14 млн, окупаемость 1.22 года, NPV 84.92 млн."""

import copy
from pathlib import Path

import pytest

from app.engine.economics import PURCHASE, RAAS, metrics
from app.engine.economics.facility import Task, evaluate_facility
from app.engine.economics.financing import EQUAL, GRACE, amortize, annuity, schedule
from app.engine.model_config import load_model

REFERENCE = Path(__file__).parent / "reference" / "fixtures" / "reference_warehouse.yaml"
PLAN_ROUTE_M = 65.73012232415903
PALLETS = [Task("pallet_transport", "ronavi-h1500")]
CAPEX = 40_568_990.11
INSURED = (24_300_000 + 600_000) * 0.007  # роботы и зарядки, 0.7% в год: 174 300

# условия по умолчанию из config/model.yaml, заморожены здесь вместе с эталоном
FINANCING = {
    "method": 0,
    "loan": {"rate": 0.15, "term_months": 60, "own_share": 0.2},
    "leasing": {"rate": 0.17, "term_months": 60, "advance_share": 0.2},
    "insurance_share_year": 0.007,
    "debt_cover_min": 1.2,
}
BLOCKED = "для склада в Москве недоступна"
SUBSIDIES = [
    {"id": "msp-1764", "name": "Льготный кредит МСП", "kind": "loan_rate", "chosen": 0, "rate": 0.105},
    {
        "id": "frp-leasing",
        "name": "Заем ФРП на аванс",
        "kind": "leasing_advance_loan",
        "chosen": 0,
        "rate": 0.01,
        "price_share": 0.45,
        "advance_share": 0.9,
        "term_months": 60,
        "grace_months": 36,
        "min_project_rub": 20_000_000,
    },
    {
        "id": "minpromtorg-robotics",
        "name": "Возврат затрат",
        "kind": "capex_refund",
        "chosen": 0,
        "share": 0.2,
        "cap_rub": 80_000_000,
    },
]


@pytest.fixture(scope="module")
def base():
    """Меры без отметки "недоступна": так проверяем их арифметику. Недоступность проверяет свой тест."""
    model = copy.deepcopy(load_model(REFERENCE)[0])
    model["financing"] = copy.deepcopy(FINANCING)
    model["subsidies"] = model["subsidies"] + copy.deepcopy(SUBSIDIES)
    return model


def purchase(model, method=0, chosen=(), registry=False, **changes):
    changed = copy.deepcopy(model)
    changed["financing"]["method"] = method
    for path, value in changes.items():
        part, key = path.split("__")
        changed["financing"][part][key] = value
    for measure in changed["subsidies"]:
        if measure["id"] in chosen:
            measure["chosen"] = 1
    result = evaluate_facility(changed, "warehouse", PALLETS, route_m=PLAN_ROUTE_M, registry=registry)
    return result.scenarios[PURCHASE], result.scenarios[RAAS]


def test_own_money_is_the_reference(base):
    """Без новых опций цифры эталона не двигаются, обе окупаемости одинаковые."""
    own, raas = purchase(base)
    assert own.capex_total == pytest.approx(CAPEX)
    assert own.investment_year0 == pytest.approx(CAPEX)
    assert own.payback_cumulative == pytest.approx(1.224103)
    assert own.payback_own == pytest.approx(own.payback_cumulative)
    assert own.npv == pytest.approx(84_924_731.72)
    assert own.tco == pytest.approx(111_322_953.66)
    assert own.financing.method == "own" and own.financing.interest_rub == 0
    assert own.years[0].insurance == 0  # за свои деньги страховку никто не требует
    assert raas.npv == pytest.approx(87_744_524.69)


def test_annuity_by_hand():
    # 32.46 млн на 60 месяцев под 15%: 32.46 * 0.0125 / (1 - 1.0125^-60) = 0.772 млн в месяц
    assert annuity(32_455_192.09, 0.15, 60) == pytest.approx(772_106.75, abs=0.01)
    assert annuity(1200, 0, 12) == pytest.approx(100)


def test_equal_principal_by_hand():
    """Тело равными долями: 1.2 млн на 12 месяцев под 12%, проценты с остатка.
    Проценты: 0.01 * (1.2 + 1.1 + ... + 0.1) млн = 0.01 * 7.8 = 78 тыс."""
    years, left = amortize(1_200_000, 0.12, 12, 1, EQUAL)
    assert years[0] == pytest.approx(1_278_000)
    assert left == [0.0]


def test_grace_pays_only_interest_first():
    """ФРП: три года только проценты, тело в последние два года."""
    years, left = amortize(2_400_000, 0.01, 60, 5, GRACE, 36)
    assert years[0] == pytest.approx(24_000)  # 1% от 2.4 млн
    assert left[2] == pytest.approx(2_400_000)
    assert left[3] == pytest.approx(1_200_000) and left[4] == 0


def test_debt_longer_than_horizon_is_paid_in_the_last_year():
    """Остаток долга за горизонтом гасим в последний год: иначе он выпал бы из стоимости владения."""
    years = schedule(1_000_000, 0.12, 60, 3)
    paid = annuity(1_000_000, 0.12, 60) * 12
    assert years[0] == pytest.approx(paid) and years[1] == pytest.approx(paid)
    assert paid * 3 < sum(years) < paid * 5


def test_payback_with_debt_by_hand():
    """Чистая позиция = накопленный поток - остаток долга. Старт -8 - 32 = -40, год 1: 15 - 28 = -13,
    год 2: 41 - 22 = 19, окупаемость 1 + 13 / 32 = 1.40625."""
    cash = [-8, 23, 26]
    assert metrics.payback_with_debt(cash, [32, 28, 22]) == pytest.approx(1 + 13 / 32)
    assert metrics.payback_with_debt(cash, [0, 0, 0]) == pytest.approx(metrics.cumulative_payback(cash))


def test_loan_by_hand(base):
    loan, _ = purchase(base, method=1)
    plan = loan.financing
    assert plan.principal_rub == pytest.approx(CAPEX * 0.8)  # 32.46 млн в долг
    assert loan.investment_year0 == pytest.approx(8_113_798.02)
    # тело 32.46 / 60 = 0.541 млн в месяц, проценты с остатка: первый год 6.49 + 4.42 = 10.91 млн
    assert plan.payments_rub[0] == pytest.approx(10_913_058.34, abs=1)
    assert plan.interest_rub == pytest.approx(12_373_542, abs=1)
    assert plan.insurance_rub == pytest.approx([INSURED] * 5)
    assert loan.years[0].insurance == pytest.approx(INSURED)
    # главная окупаемость с учетом долга, первый взнос отдельно
    assert loan.payback_cumulative == pytest.approx(1.396146, abs=1e-6)
    assert loan.payback_own == pytest.approx(0.375202, abs=1e-6)
    assert loan.npv == pytest.approx(85_131_893, abs=1_000)
    # CAPEX и простой срок по ТЗ показатели проекта: от способа оплаты не зависят
    assert loan.capex_total == pytest.approx(CAPEX)
    assert loan.payback_simple == pytest.approx(1.240168)
    # проценты и страховка входят в стоимость владения
    assert loan.tco == pytest.approx(111_322_953.66 + 12_373_542 + INSURED * 5, abs=2)
    assert plan.plain_payback == pytest.approx(1.224103) and plan.plain_irr == pytest.approx(0.81150, abs=1e-5)
    assert plan.weak_cover_years == []  # экономия покрывает платежи с запасом: от 2.98 раза


def test_month_payments_by_hand(base):
    """Платеж в месяц для панели оплаты по тем же формулам, что график по годам.
    Кредит: тело 32.455 / 60 = 0.5409 млн, первый 0.5409 + 32.455 * 0.15 / 12 = 0.9466 млн,
    последний 0.5409 + 0.5409 * 0.15 / 12 = 0.5477 млн. Лизинг: равный платеж 0.5249 млн."""
    loan, _ = purchase(base, method=1)
    first, last = loan.financing.month_payments
    assert first == pytest.approx(946_609.77, abs=0.01)
    assert last == pytest.approx(547_681.37, abs=0.01)
    # первый год графика сходится с платежами по месяцам: тело 12 долей и проценты с остатка
    body = CAPEX * 0.8 / 60
    year1 = sum(body + (CAPEX * 0.8 - body * m) * 0.15 / 12 for m in range(12))
    assert loan.financing.payments_rub[0] == pytest.approx(year1)
    lease, _ = purchase(base, method=2)
    assert lease.financing.month_payments == pytest.approx((524_886.40, 524_886.40), abs=0.01)
    own, _ = purchase(base)
    assert own.financing.month_payments == (0.0, 0.0)


def test_msp_rate_by_hand(base):
    """Льготная ставка 10.5% вместо 15%, тот же дифференцированный график."""
    loan, _ = purchase(base, method=1, chosen=("msp-1764",))
    plan = loan.financing
    assert plan.rate == 0.105
    msp = next(s for s in plan.supports if s.id == "msp-1764")
    market = schedule(CAPEX * 0.8, 0.15, 60, 5, EQUAL)
    assert msp.applied and msp.rub == pytest.approx(sum(market) - sum(plan.payments_rub))


def test_blocked_measure_does_nothing(base):
    blocked = copy.deepcopy(base)
    for measure in blocked["subsidies"]:
        if measure["id"] in ("msp-1764", "minpromtorg-robotics"):
            measure["blocked"] = BLOCKED
    loan, _ = purchase(blocked, method=1, chosen=("msp-1764", "minpromtorg-robotics"))
    plain, _ = purchase(base, method=1)
    for one in loan.financing.supports[::2]:
        assert not one.applied and one.reason == f"недоступна: {BLOCKED}"
    assert loan.npv == pytest.approx(plain.npv)


def test_msp_needs_a_loan(base):
    own, _ = purchase(base, method=0, chosen=("msp-1764",))
    msp = next(s for s in own.financing.supports if s.id == "msp-1764")
    assert not msp.applied and msp.reason == "работает только с кредитом"
    assert own.npv == pytest.approx(84_924_731.72)


def test_leasing_by_hand(base):
    lease, _ = purchase(base, method=2)
    plan = lease.financing
    assert plan.base_rub == pytest.approx(26_400_000)  # роботы 24.3 + зарядки 0.6 + ПО 1.5
    assert plan.own_start_rub == pytest.approx(5_280_000)  # аванс 20%
    assert plan.principal_rub == pytest.approx(21_120_000)
    assert plan.payments_rub[0] == pytest.approx(524_886.40 * 12, abs=0.1)
    assert plan.markup_year == pytest.approx(0.078585, abs=1e-6)  # (5.28 + 31.49) / 26.4 - 1 = 39.3% за 5 лет
    assert lease.investment_year0 == pytest.approx(19_448_990.11)  # 40.57 - 21.12
    assert lease.payback_cumulative == pytest.approx(1.355659, abs=1e-6)
    assert lease.payback_own == pytest.approx(0.741208, abs=1e-6)


def test_frp_needs_the_registry(base):
    lease, _ = purchase(base, method=2, chosen=("frp-leasing",))
    frp = next(s for s in lease.financing.supports if s.id == "frp-leasing")
    assert not frp.applied and "реестре" in frp.reason
    listed, _ = purchase(base, method=2, chosen=("frp-leasing",), registry=True)
    frp = next(s for s in listed.financing.supports if s.id == "frp-leasing")
    # min(аванс 5.28 * 0.9 = 4.752, цена 26.4 * 0.45 = 11.88) = 4.752 млн под 1%
    assert frp.applied and frp.rub == pytest.approx(4_752_000)
    assert listed.investment_year0 == pytest.approx(19_448_990.11 - 4_752_000)
    # первые три года только проценты: 1% от 4.752 млн
    assert listed.financing.advance_loan_payments_rub[0] == pytest.approx(47_520)


def test_refund_comes_a_year_later_and_does_not_combine(base):
    """Возврат затрат: 20% без резерва и переобучения, в поток первого года. С другой мерой не совмещается."""
    own, _ = purchase(base, chosen=("minpromtorg-robotics",))
    refund = next(s for s in own.financing.supports if s.id == "minpromtorg-robotics")
    assert own.capex_total - own.capex["reserve"] - own.capex["retraining"] == pytest.approx(36_830_000)
    assert refund.rub == pytest.approx(7_366_000)
    assert own.investment_year0 == pytest.approx(CAPEX)
    assert own.years[0].support == pytest.approx(7_366_000)
    assert own.payback_cumulative == pytest.approx(1.013991, abs=1e-6)
    both, _ = purchase(base, method=1, chosen=("minpromtorg-robotics", "msp-1764"))
    refund = next(s for s in both.financing.supports if s.id == "minpromtorg-robotics")
    assert not refund.applied and "не совмещается" in refund.reason


def test_weak_cover_is_flagged(base):
    """Кредит на год: платежи больше экономии, банк может не дать. Предупреждаем, расчет не ломаем."""
    loan, _ = purchase(base, method=1, loan__term_months=12)
    assert loan.financing.weak_cover_years == [1]


def test_tco_identity_holds_with_debt(base):
    """TCO без роботов - TCO сценария = сумма эффектов - вложения за горизонт, и с долгом тоже."""
    for method in (1, 2):
        scenario, _ = purchase(base, method=method, chosen=("minpromtorg-robotics",))
        baseline = sum(y.staff_cost + y.effect + y.opex_total for y in scenario.years)
        assert baseline - scenario.tco == pytest.approx(scenario.effect_total - scenario.investment_total, abs=1)


def test_raas_is_untouched(base):
    _, plain = purchase(base)
    _, with_loan = purchase(base, method=1, chosen=("msp-1764", "minpromtorg-robotics"))
    assert with_loan.npv == pytest.approx(plain.npv)
    assert with_loan.tco == pytest.approx(plain.tco)
