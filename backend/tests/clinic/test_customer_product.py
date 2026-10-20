"""Данные разных заказчиков, бюджетные ограничения, коммерческие условия и частичный проект."""

from types import SimpleNamespace

import pytest

from app.engine.clinic import money
from app.schemas import clinic as schema
from app.services import clinic, clinic_contract, clinic_money, clinic_optimizer, clinic_portfolio


def building():
    return clinic_contract.generate(
        schema.GenerateRequest(width_m=44, length_m=24, floors=1, wards_per_floor=4, lifts=0)
    )


def test_industry_ranges_do_not_reject_a_smaller_or_more_expensive_customer():
    given = {"clinic.orderlies": 5, "clinic.orderly_salary_rub": 100_000, "clinic.floors": 1}
    assert clinic_contract.checked_overrides(given) == given
    for value in (-1, float("inf"), float("nan")):
        with pytest.raises(clinic.BadInput):
            clinic_contract.checked_overrides({"clinic.orderlies": value})
    with pytest.raises(clinic.BadInput):
        clinic_contract.checked_overrides({"clinic.payback_horizon_years": 2.5})


def test_cash_ceiling_and_discounting_use_actual_cash_not_the_value_of_all_free_time():
    machine = money.Fleet("cleaning", "Test", 1, 100_000, 0, 0, 30, None)
    inputs = money.Inputs(
        1000, 100, 3, 0, 0, [machine], cash_realization_share=1, cash_saving_cap_rub_year=20_000, discount_rate=0.1
    )
    purchase = next(s for s in money.evaluate(inputs) if s.id == "purchase")
    # из 30 лет службы за горизонт 3 года прошли 3: 27/30 цены остаются работающим роботом
    left = 100_000 * 27 / 30
    assert purchase.residual_rub == pytest.approx(left)
    assert purchase.saving_rub == pytest.approx(-40_000 + left)
    assert purchase.npv_rub == pytest.approx(-100_000 + sum(20_000 / 1.1**year for year in range(1, 4)) + left / 1.1**3)
    # остаток не деньги: срок окупаемости считается только по денежному потоку
    assert purchase.payback_years is None
    assert purchase.discounted_payback_years is None
    inputs.cash_saving_cap_rub_year = 60_000
    purchase = next(s for s in money.evaluate(inputs) if s.id == "purchase")
    assert purchase.payback_years < purchase.discounted_payback_years < 3


def test_rental_service_terms_are_individual_and_do_not_change_purchase_costs():
    first = money.Fleet("delivery", "A", 1, 1000, 0.1, 0, 5, 10, rent_service_included=True)
    second = money.Fleet("cleaning", "B", 1, 2000, 0.1, 0, 5, 10, rent_service_included=False)
    given = money.Inputs(1000, 100, 1, 0, 0, [first, second], cash_realization_share=1, rent_service_included=True)
    assert money.rental_extras(given) == 200
    actual = {s.id: s for s in money.evaluate(given)}
    # горизонт 1 год из 5 лет службы: 4/5 цены парка остаются работающими роботами
    assert actual["purchase"].residual_rub == 2400
    assert actual["purchase"].robot_cost_rub == 3300 - 2400
    assert actual["raas"].robot_cost_rub == 440


def test_measured_manual_work_and_real_staff_are_visible_without_claiming_staff_sla():
    house = building()
    request = schema.MoneyRequest(
        operation_ids=["floor_delivery"],
        building=house,
        assumptions=schema.MoneyAssumptions(
            manual_delivery_min_per_job=20,
            delivery_hour_rub=700,
            delivery_staff_per_shift=0,
            days_per_year=250,
            annual_work_hours=1800,
        ),
    )
    result = clinic_money.estimate(request, include_sources=False)
    assert result.shift.done > 0
    assert result.people.manual_delivery_hours_per_shift == pytest.approx(result.shift.done / 3)
    assert result.people.hour_rub == 700
    # ставка работает годовые часы без отпуска 160 ч (ТК РФ ст. 115)
    assert result.people.fte == pytest.approx(result.people.hours_per_year / (1800 - 160))
    assert any("превышает ресурс" in note for note in result.readiness)
    assert not any("365 дней" in note for note in result.readiness)


def test_supplier_quote_changes_only_the_quoted_model_and_zero_is_not_unknown():
    house = building()
    base = schema.MoneyRequest(operation_ids=["floor_delivery"], building=house)
    outcome = clinic.simulate(clinic_contract.from_schema(house), operation_ids=["floor_delivery"], record=False)
    old = clinic_money.estimate(base, outcome=outcome, include_sources=False)
    quote = schema.RobotQuote(
        source="КП от заказчика", price_rub=0, maintenance_rub_year=37, commissioning_rub=13, life_years=9
    )
    request = base.model_copy(update={"quotes": {base.robot_id: quote}})
    actual = clinic_money.estimate(request, outcome=outcome, include_sources=False)
    purchase = next(s for s in actual.scenarios if s.id == "purchase")
    assert actual.fleets[0].price_rub == 0
    count = actual.fleets[0].count
    assert purchase.start_rub == 13 * count
    assert purchase.robot_cost_rub == pytest.approx(
        count * (13 + sum(37 * 1.04**i for i in range(actual.horizon_years)))
    )
    other = clinic_money.estimate(
        base.model_copy(update={"quotes": {"another-model": quote}}), outcome=outcome, include_sources=False
    )
    assert other.scenarios == old.scenarios
    assert not any("коммерческое предложение неполное" in note for note in actual.readiness)


def test_partial_project_can_recommend_cleaning_while_delivery_stays_manual():
    request = schema.OptimizationRequest(
        building=building(),
        operation_ids=["floor_delivery", "cleaning"],
        delivery_ids=[clinic.DEFAULT_DELIVERY],
        cleaner_ids=[clinic.DEFAULT_CLEANER],
        max_delivery_fleet=3,
        max_cleaners_per_floor=1,
        time_budget_s=18,
        assumptions=schema.MoneyAssumptions(
            cash_realization_share=1,
            manual_cleaning_m2_per_hour=50,
            cleaner_hour_rub=500,
            cash_saving_cap_rub_year=100_000,
        ),
        quotes={
            clinic.DEFAULT_CLEANER: schema.RobotQuote(
                source="Test", price_rub=5000, maintenance_rub_year=0, commissioning_rub=0, life_years=10
            )
        },
    )
    result = clinic_portfolio.compare(request)
    best = next(row for row in result["options"] if row["id"] == result["recommended_id"])
    assert best["automated"] == ["cleaning"]
    assert best["manual"] == ["floor_delivery"]
    assert best["candidate"]["incremental_npv_cost_rub"] < 0
    assert best["candidate"]["upfront_rub"] == 5000
    assert best["candidate"]["validated"]
    assert result["manual_service_verified"] is False


def test_incomplete_search_cannot_claim_that_manual_work_is_the_best_option(monkeypatch):
    monkeypatch.setattr(
        clinic_optimizer,
        "optimize",
        lambda request: SimpleNamespace(
            candidates=[], recommended_id=None, fully_enumerated=False, stopped="Лимит времени"
        ),
    )
    result = clinic_portfolio.compare(schema.OptimizationRequest(operation_ids=["cleaning"], building=building()))
    assert not result["complete"]
    assert not result["manual_is_cheapest"]
    assert result["recommended_id"] is None


@pytest.mark.parametrize("quote", [{"price_rub": -1}, {"life_years": 0}, {"maintenance_rub_year": float("nan")}])
def test_invalid_quotes_are_rejected(quote):
    with pytest.raises(ValueError):
        schema.RobotQuote(**quote)
