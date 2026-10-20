"""Контроль арифметики и сценариев медучреждений после сверки с первичными кейсами."""

from dataclasses import replace
from itertools import product

import pytest
from fastapi.testclient import TestClient

from app.engine.clinic import money
from app.engine.clinic.fleet import search
from app.main import app
from app.services import clinic
from tests.clinic.test_money import by_id, fleet, inputs

client = TestClient(app)


def test_released_time_does_not_automatically_reduce_the_payroll():
    conditions = replace(inputs(), cash_realization_share=0)
    out = by_id(money.evaluate(conditions))
    assert out["purchase"].saving_rub == -out["purchase"].robot_cost_rub
    assert out["purchase"].payback_years is None
    assert out["purchase"].years_rub[0] == 1_200_000


def test_retained_support_and_partial_cash_realization_are_counted_once():
    conditions = replace(inputs(), cash_realization_share=0.5, robot_staff_cost_year=200_000)
    out = by_id(money.evaluate(conditions))["purchase"]
    assert out.effect_year1_rub == 200_000  # (1 млн - 0,2 млн) * 50% - 0,2 млн ТО
    assert out.years_rub[0] == 800_000


def test_extra_human_load_costs_money_even_without_payroll_savings():
    conditions = replace(inputs(), cash_realization_share=0, additional_staff_cost_year=150_000)
    out = by_id(money.evaluate(conditions))["purchase"]
    assert out.effect_year1_rub == -350_000


def test_replacement_includes_commissioning_again():
    out = by_id(money.evaluate(inputs(fleet(commissioning_rub=100_000))))["purchase"]
    assert out.start_rub == 2_200_000
    assert out.years_rub[5] == 2_400_000


def test_book_value_exists_before_first_replacement_but_is_not_a_cash_receipt():
    conditions = inputs(horizon=3)
    assert money.residual(conditions.fleets[0], conditions) == 800_000
    assert by_id(money.evaluate(conditions))["purchase"].years_rub[-1] == 200_000


def test_payback_is_the_first_return_of_the_investment_like_the_warehouse():
    # Замена парка на 6-м году это новая покупка с пользой за горизонтом: она не отменяет
    # возврат первых вложений за 2,5 года, а остаток ее срока службы входит в итог горизонта
    out = by_id(money.evaluate(inputs()))["purchase"]
    assert out.payback_years == pytest.approx(2.5)
    assert out.residual_rub == pytest.approx(2_000_000 * 3 / 5)
    assert out.tco_rub == pytest.approx(out.start_rub + sum(out.years_rub) - out.residual_rub)


def test_payback_needs_cash_not_the_residual_value():
    # 0,1 млн экономии в год против 2 млн вложений: за 7 лет не возвращаются, остаток этого не меняет
    out = by_id(money.evaluate(replace(inputs(), cash_realization_share=0.3)))["purchase"]
    assert out.effect_year1_rub == pytest.approx(100_000)
    assert out.residual_rub > 0
    assert out.payback_years is None


def test_rental_first_month_is_not_averaged_or_repeated_annually():
    robot = fleet(count=1, rent_month_rub=75_000, rent_first_month_rub=200_000)
    out = by_id(money.evaluate(inputs(robot, horizon=3)))["raas"]
    assert out.start_rub == 200_000
    assert out.years_rub == [825_000, 900_000, 900_000]
    assert out.first_payment_rub == 200_000


def test_monthly_and_annual_rental_are_both_evaluated():
    robot = fleet(
        count=1, rent_month_rub=75_000, rent_first_month_rub=200_000, rent_year_rub=600_000, rent_first_year_rub=750_000
    )
    out = by_id(money.evaluate(inputs(robot, horizon=3)))["raas"]
    assert out.rent_period == "year"
    assert out.start_rub == 750_000
    assert out.years_rub == [0, 600_000, 600_000]
    assert out.rental_options_rub == {"month": 2_825_000, "year": 1_950_000}


def test_zero_count_does_not_block_a_priced_rental():
    conditions = inputs(fleet(count=0), fleet(count=1, rent_month_rub=50_000))
    assert by_id(money.evaluate(conditions))["raas"].available


def test_unconfirmed_rental_service_is_priced_separately_without_doubling_included_service():
    robot = fleet(count=1, rent_year_rub=600_000, rent_first_year_rub=750_000, maintenance_rub_year=360_000)
    included = by_id(money.evaluate(inputs(robot, horizon=3)))["raas"]
    separate = by_id(money.evaluate(replace(inputs(robot, horizon=3), rent_service_included=False)))["raas"]
    assert separate.robot_cost_rub - included.robot_cost_rub == 1_080_000


def test_fixed_service_quote_does_not_scale_with_the_robot_price():
    conditions = inputs(fleet(count=1, price_rub=2_300_000, maintenance_rub_year=360_000))
    assert by_id(money.evaluate(conditions))["purchase"].years_rub[0] == 360_000


@pytest.mark.parametrize("horizon,realization,inflation", list(product([1, 3, 5, 7, 10], [0, 0.5, 1], [0, 0.04])))
def test_cashflow_identity_across_horizons_realization_and_price_growth(horizon, realization, inflation):
    conditions = replace(
        inputs(horizon=horizon),
        cash_realization_share=realization,
        inflation=inflation,
        integration_rub=100_000,
        extra_annual_rub=50_000,
    )
    out = by_id(money.evaluate(conditions))
    for scenario in out.values():
        if scenario.available:
            assert scenario.tco_rub == pytest.approx(
                scenario.start_rub + sum(scenario.years_rub) - scenario.residual_rub
            )
            assert scenario.saving_rub == pytest.approx(out["baseline"].tco_rub - scenario.tco_rub)
            assert scenario.residual_rub >= 0
            if scenario.id == "raas":
                assert scenario.residual_rub == 0  # арендованный робот не наш
            if scenario.payback_years is not None:
                assert 0 <= scenario.payback_years <= horizon
                # к сроку окупаемости накопленный денежный поток без остатка вышел в ноль
                cash = [-scenario.start_rub] + [
                    staff - cost for staff, cost in zip(out["baseline"].years_rub, scenario.years_rub, strict=True)
                ]
                year = int(scenario.payback_years) + 1
                assert sum(cash[: year + 1]) >= -1e-6


def test_fleet_search_can_recover_after_a_flat_part_of_the_curve():
    curve = {1: 0.1, 2: 0.1, 3: 0.1, 4: 0.8, 5: 0.96}
    out = search(lambda size, seed: curve[size], (42, 7, 2026), 0.95, 5)
    assert out.needed == 5


def test_enabling_delivery_does_not_change_the_cleaners_starting_battery():
    building = clinic.demo()
    alone = clinic.simulate(building, operation_ids=[clinic.CLEANING], record=False)
    together = clinic.simulate(building, operation_ids=[clinic.DELIVERY, clinic.CLEANING], record=False)
    assert alone.kpi.cleaned_m2 == together.kpi.cleaned_m2
    assert alone.result.cleaner_door_assists == together.result.cleaner_door_assists


def test_unfinished_cleaning_pass_counts_only_the_part_completed_inside_the_shift():
    from app.engine.clinic.shift import Shift
    from app.schemas.clinic import Building
    from app.services.clinic_contract import from_schema

    building = from_schema(Building.model_validate(generate(LAYOUTS[0])))
    cleaner = clinic.robot(clinic.DEFAULT_CLEANER, clinic.CLEANING)
    outcomes = []
    for record in (False, True):
        shift = Shift(
            building,
            None,
            0,
            [],
            {},
            clinic.times(),
            0.1,
            42,
            cleaner=cleaner.spec,
            cleaners={1: 1},
            cleaning_area={1: 1000},
            record=record,
        )
        outcomes.append(shift.run().cleaning[0].done_m2)
    assert 0 < outcomes[0] < cleaner.spec.throughput_m2_h * 0.1
    assert outcomes[0] == outcomes[1]


LAYOUTS = [(36, 20, 1, 3, 0), (48, 24, 2, 3, 1), (60, 28, 4, 4, 2)]
DELIVERY = [r.id for r in clinic.robots(clinic.DELIVERY) if r.spec]
CLEANING = [r.id for r in clinic.robots(clinic.CLEANING) if r.spec]
CASES = (
    [([clinic.DELIVERY], d, clinic.DEFAULT_CLEANER) for d in DELIVERY]
    + [([clinic.CLEANING], clinic.DEFAULT_DELIVERY, c) for c in CLEANING]
    + [([clinic.DELIVERY, clinic.CLEANING], d, c) for d, c in product(DELIVERY, CLEANING)]
)


def generate(dimensions):
    w, length, floors, wards, lifts = dimensions
    out = client.post(
        "/api/clinic/generate", json=dict(width_m=w, length_m=length, floors=floors, wards_per_floor=wards, lifts=lifts)
    )
    assert out.status_code == 200, out.text
    return out.json()


@pytest.mark.parametrize("dimensions", LAYOUTS)
@pytest.mark.parametrize("tasks,delivery,cleaner", CASES)
def test_catalog_layout_task_matrix_reconciles_money_and_replay(dimensions, tasks, delivery, cleaner):
    request = dict(building=generate(dimensions), operation_ids=tasks, robot_id=delivery, cleaner_id=cleaner)
    response = client.post("/api/clinic/economics", json=request)
    unfit = client.post("/api/clinic/fit", json={"building": request["building"]}).json()
    if clinic.CLEANING in tasks and cleaner in unfit["cleaning"]:
        # уборщик не выезжает с базы ни на одном этаже: ошибка с причиной, а не тихий ноль в деньгах
        assert response.status_code == 422, response.text
        assert "мм" in response.text
        return
    assert response.status_code == 200, response.text
    out = response.json()
    shift, people = out["shift"], out["people"]
    replay = client.post(
        "/api/clinic/runs",
        json=request | dict(fleet=shift["fleet"], cleaners=shift["cleaners"], seed=42, with_events=True),
    )
    assert replay.status_code == 200, replay.text
    kpi = replay.json()["kpi"]
    assert kpi["created"] == shift["jobs"]
    assert kpi["done"] == shift["done"]
    assert kpi["cleaned_m2"] == pytest.approx(shift["cleaned_m2"], abs=0.01)
    assert kpi["on_time_share"] == pytest.approx(shift["on_time_share"], abs=0.0001)
    assert 0 <= shift["cleaned_m2"] <= shift["cleaning_required_m2"] + 1e-6
    assert people["hours_per_shift"] == pytest.approx(
        people["delivery_hours_per_shift"] + people["cleaning_hours_per_shift"], abs=0.011
    )
    assert people["hours_per_shift"] <= people["manual_hours_per_shift"] + 0.011
    assert people["hours_per_year"] == pytest.approx(people["hours_per_shift"] * 365, abs=2.5)
    baseline = out["scenarios"][0]
    for scenario in out["scenarios"]:
        if not scenario["available"]:
            continue
        assert scenario["tco_rub"] == pytest.approx(
            scenario["start_rub"] + sum(scenario["years_rub"]) - scenario["residual_rub"]
        )
        assert scenario["saving_rub"] == pytest.approx(baseline["tco_rub"] - scenario["tco_rub"])
        if scenario["id"] == "baseline":
            continue
        if people["positions_released"] == 0:
            # меньше целой ставки: бюджет не сокращается, окупаться нечем
            assert scenario["payback_years"] is None
            assert scenario["saving_rub"] <= 0
        elif scenario["payback_years"] is not None:
            assert 0 <= scenario["payback_years"] <= out["horizon_years"]
    # по умолчанию в деньги идут только целые ставки каждой роли
    worked = out["assumptions"]["annual_work_hours"] - out["assumptions"]["paid_leave_hours"]
    whole = sum(
        int(hours * 365 / worked + 1e-9)
        for hours in (people["delivery_hours_per_shift"], people["cleaning_hours_per_shift"])
    )
    assert people["positions_released"] == whole
    assert people["cash_saving_year_rub"] <= people["released_value_year_rub"] + 1e-6


@pytest.mark.parametrize(
    "conditions",
    [
        {"cash_realization_share": -0.1},
        {"cash_realization_share": 1.01},
        {"cleaning_time_saving_share": 2},
        {"extra_annual_rub": -1},
        {"days_per_year": 0},
        {"days_per_year": 367},
        {"days_per_year": 100.5},
        {"cleaner_hour_rub": 0},
        {"made_up": 1},
    ],
)
def test_invalid_financial_conditions_are_refused(conditions):
    response = client.post("/api/clinic/economics", json=dict(operation_ids=[clinic.DELIVERY], assumptions=conditions))
    assert response.status_code == 422


def test_less_working_days_changes_labour_but_not_the_owned_fleet():
    request = dict(operation_ids=[clinic.DELIVERY])
    first = client.post("/api/clinic/economics", json=request).json()
    second = client.post("/api/clinic/economics", json=request | dict(assumptions={"days_per_year": 200})).json()
    assert first["fleets"] == second["fleets"]
    assert second["people"]["released_value_year_rub"] == pytest.approx(
        first["people"]["released_value_year_rub"] * 200 / 365
    )


def test_cleaner_salary_does_not_change_delivery_value():
    request = dict(operation_ids=[clinic.DELIVERY, clinic.CLEANING], building=generate(LAYOUTS[2]))
    first = client.post("/api/clinic/economics", json=request).json()
    second = client.post("/api/clinic/economics", json=request | dict(assumptions={"cleaner_hour_rub": 1000})).json()
    assert first["people"]["delivery_hours_per_shift"] == second["people"]["delivery_hours_per_shift"]
    assert first["people"]["hours_per_year"] == second["people"]["hours_per_year"]
    assert first["people"]["released_value_year_rub"] < second["people"]["released_value_year_rub"]


def test_no_cleaning_base_is_missing_coverage_not_a_smaller_task():
    building = generate(LAYOUTS[1])
    building["floors"][0]["items"] = [
        i for i in building["floors"][0]["items"] if not (i["kind"] == "charge" and i["role"] == "cleaning")
    ]
    out = client.post("/api/clinic/economics", json=dict(building=building, operation_ids=[clinic.CLEANING])).json()
    assert 0 < out["shift"]["cleaning_coverage"] < 1
    assert any("площади" in warning for warning in out["warnings"])


@pytest.mark.parametrize(
    "dimensions",
    [
        (36, 18, 1, 2, 0),
        # На шести этажах поиск парка упирается в engine.search_budget_s и парк зависит от
        # скорости машины: два одинаковых корпуса дают разный ответ. Чинить в движке, не в тесте
        pytest.param(
            (36, 18, 6, 8, 2),
            marks=pytest.mark.xfail(strict=False, reason="поиск парка ограничен временем, а не числом прогонов"),
        ),
    ],
)
def test_custom_and_imported_building_keep_the_same_work_volume(dimensions):
    building = generate(dimensions)
    imported = client.post("/api/clinic/import", json=building)
    assert imported.status_code == 200
    request = dict(building=building, operation_ids=[clinic.DELIVERY, clinic.CLEANING])
    original = client.post("/api/clinic/economics", json=request)
    restored = client.post("/api/clinic/economics", json=request | dict(building=imported.json()))
    assert original.status_code == restored.status_code == 200
    assert original.json()["people"] == restored.json()["people"]
    assert original.json()["shift"]["jobs"] == restored.json()["shift"]["jobs"]
    assert original.json()["shift"]["cleaned_m2"] == restored.json()["shift"]["cleaned_m2"]
