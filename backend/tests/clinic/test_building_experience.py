"""Разные этажи, стоимость на карточках, кредит и проверяемый порог безубыточности."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.engine.clinic import money
from app.main import app
from app.schemas import clinic as schema
from app.services import clinic, clinic_contract, clinic_money

client = TestClient(app)


@pytest.mark.parametrize("robot_id,blocked", [(clinic.DEFAULT_DELIVERY, 0), ("ext-keenon-w3", 0), ("ext-pudubot-2", 6)])
@pytest.mark.parametrize("layout", ["linear", "mixed"])
@pytest.mark.parametrize("moved", [False, True])
def test_three_floor_plan_reaches_rooms_according_to_actual_robot_lift_capability(robot_id, blocked, layout, moved):
    house = clinic_contract.generate(
        schema.GenerateRequest(width_m=60, length_m=24, floors=3, wards_per_floor=3, lifts=2, layout=layout)
    )
    for lift in house.lifts:
        lift.door_mm, lift.people_calls_per_hour = 1500, 1
    if moved:
        for floor in house.floors:
            for shaft in floor.items:
                if shaft.kind == "lift":
                    shaft.x, shaft.y = (57, 13) if shaft.lift == "L1" else (54, 12)
    result = client.post(
        "/api/clinic/check",
        json={"building": house.model_dump(), "robot_id": robot_id, "operation_ids": ["floor_delivery"]},
    )
    assert result.status_code == 200, result.text
    checks = result.json()
    assert checks["valid"]
    inaccessible = [item for item in checks["checks"] if item["code"] == "ward_unreachable"]
    # mixed имеет на один пост меньше на втором этаже.
    assert len(inaccessible) == (blocked - 1 if blocked and layout == "mixed" else blocked)
    assert all(item["floor"] > 1 and "не подтверждена работа с лифтом" in item["text"] for item in inaccessible)


@pytest.mark.parametrize("width,depth,floors,posts,lifts", [(72, 32, 2, 4, 1), (96, 40, 4, 6, 2), (60, 28, 3, 4, 1)])
def test_mixed_presets_have_independent_valid_floors_and_physically_aligned_shafts(width, depth, floors, posts, lifts):
    house = clinic_contract.generate(
        schema.GenerateRequest(
            width_m=width, length_m=depth, floors=floors, wards_per_floor=posts, lifts=lifts, layout="mixed"
        )
    )
    assert len({floor.length_m for floor in house.floors}) > 1
    check = clinic_contract.check_plan(schema.CheckRequest(building=house))
    assert check.valid, check.model_dump()
    assert not any(c.code in {"ward_unreachable", "cleaning_unreachable", "cleaning_blocked"} for c in check.checks)
    for lift in house.lifts:
        positions = {(item.x, item.y) for floor in house.floors for item in floor.items if item.lift == lift.id}
        assert len(positions) == 1
    restored = client.post("/api/clinic/import", json=house.model_dump()).json()
    assert restored == house.model_dump(mode="json")


def loan_inputs(**changes):
    fleet = money.Fleet("cleaning", "Test", 1, 1000, 0, 0, 5, None)
    return money.Inputs(
        **dict(
            staff_hours_year=100,
            hour_rub=10,
            horizon=3,
            wage_growth=0,
            inflation=0,
            fleets=[fleet],
            cash_realization_share=1,
            loan_enabled=True,
            loan_rate=0.12,
            loan_months=12,
            loan_own_share=0.2,
            loan_insurance_share=0,
            **changes,
        )
    )


def test_credit_preserves_equipment_price_and_adds_exact_interest_without_double_counting_principal():
    scenarios = {s.id: s for s in money.evaluate(loan_inputs())}
    own, loan = scenarios["purchase"], scenarios["loan"]
    assert loan.start_rub == pytest.approx(200)
    assert loan.financing.principal_rub == pytest.approx(800)
    assert loan.financing.interest_rub == pytest.approx(52)  # 800 * 1% * (12+...+1)/12
    assert loan.financing.payments_rub[0] == pytest.approx(852)
    assert loan.tco_rub == pytest.approx(own.tco_rub + 52)
    assert loan.saving_rub == pytest.approx(scenarios["baseline"].tco_rub - loan.tco_rub)


def test_zero_rate_loan_does_not_make_the_project_pay_back_faster_by_hiding_outstanding_debt():
    settings = replace(loan_inputs(), loan_rate=0, loan_months=36)
    out = {s.id: s for s in money.evaluate(settings)}
    loan = out["loan"]
    assert loan.tco_rub == pytest.approx(out["purchase"].tco_rub)
    assert loan.payback_years == pytest.approx(out["purchase"].payback_years)
    assert loan.financing.equity_payback_years < loan.payback_years
    assert loan.financing.debt_left_rub[-1] == pytest.approx(0, abs=1e-8)


def test_debt_beyond_horizon_is_repaid_and_replacement_is_preserved():
    settings = replace(loan_inputs(), horizon=1, loan_rate=0, loan_months=120, loan_insurance_share=0.01)
    out = {s.id: s for s in money.evaluate(settings)}
    assert sum(out["loan"].financing.payments_rub) == pytest.approx(800)
    assert out["loan"].financing.debt_left_rub[-1] == 0
    assert out["loan"].tco_rub == pytest.approx(out["purchase"].tco_rub + 10)
    long = {s.id: s for s in money.evaluate(replace(settings, horizon=7, loan_months=12))}
    assert long["loan"].tco_rub == pytest.approx(long["purchase"].tco_rub + 10)
    assert long["purchase"].years_rub[5] == 1000


def test_break_even_share_really_produces_zero_saving_for_purchase_rent_and_loan():
    house = clinic_contract.generate(schema.GenerateRequest(width_m=120, length_m=120, floors=1, lifts=0))
    request = schema.MoneyRequest(
        operation_ids=["cleaning"],
        building=house,
        assumptions=schema.MoneyAssumptions(
            cash_realization_share=1,
            cleaning_time_saving_share=0.75,
            cleaner_hour_rub=1000,
            integration_rub=100_000,
            extra_annual_rub=30_000,
            loan_enabled=1,
        ),
    )
    outcome = clinic.Prepared(clinic_contract.from_schema(house), operation_ids=["cleaning"]).run(0, {1: 1}, 42)
    account = clinic_money.estimate(request, outcome=outcome, include_sources=False)
    for scenario in account.scenarios:
        if scenario.id == "baseline" or not scenario.available:
            continue
        share = scenario.cash_share_for_break_even
        assert 0 < share < 1
        given = request.model_copy(deep=True)
        given.assumptions.cash_realization_share = share
        reference = clinic_money.estimate(given, outcome=outcome, include_sources=False)
        calculated = next(s for s in reference.scenarios if s.id == scenario.id)
        assert calculated.saving_rub == pytest.approx(0, abs=1e-6)


def test_card_offer_is_the_same_sized_fleet_and_cash_flow_as_the_final_calculation():
    house = clinic_contract.generate(schema.GenerateRequest(width_m=44, length_m=24, floors=1, lifts=0))
    body = dict(building=house.model_dump(), operation_ids=["cleaning"], assumptions={"loan_enabled": 1})
    response = client.post("/api/clinic/offers", json=body | {"robot_ids": [clinic.DEFAULT_CLEANER]})
    assert response.status_code == 200, response.text
    offer = response.json()["offers"][clinic.DEFAULT_CLEANER]
    final = client.post("/api/clinic/economics", json=body | {"cleaner_id": clinic.DEFAULT_CLEANER}).json()
    assert offer["shift"] == final["shift"]
    assert offer["fleets"] == final["fleets"]
    assert offer["scenarios"] == final["scenarios"]


@pytest.mark.parametrize(
    "assumptions",
    [
        {"loan_rate": -1},
        {"loan_months": 0},
        {"loan_months": 12.5},
        {"loan_own_share": 1.1},
        {"loan_insurance_share": 0.3},
    ],
)
def test_invalid_credit_terms_are_explained(assumptions):
    assert (
        client.post(
            "/api/clinic/economics", json={"operation_ids": ["cleaning"], "assumptions": assumptions}
        ).status_code
        == 422
    )
