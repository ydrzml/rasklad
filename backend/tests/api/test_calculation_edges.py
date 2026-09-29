"""Расчет и отчеты через API на крайних данных: ноль объема, огромные числа, отрицательные значения,
расчет, который не сошелся. Сервер должен ответить понятно, а не упасть."""

import math

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
VOLUME = "facilities.warehouse.operations.pallet_transport.volume_per_day"
SALARY = "facilities.warehouse.staff.forklift-operators.salary_month"
PRICE = "robots.ronavi-h1500.price_rub"
HORIZON = "economics.horizon_years"
SHIFTS = "facilities.warehouse.schedule.shifts"
DAYS = "facilities.warehouse.schedule.days_per_year"


def preview(**overrides):
    return client.post("/api/calculations/preview", json={"overrides": overrides})


def scenario(result: dict, scenario_id: str) -> dict:
    return next(s for s in result["scenarios"] if s["id"] == scenario_id)


def finite_numbers(value) -> bool:
    """Во всем ответе нет NaN и бесконечностей: JSON их не переносит, браузер покажет мусор."""
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(finite_numbers(v) for v in value.values())
    if isinstance(value, list):
        return all(finite_numbers(v) for v in value)
    return True


# --- Ноль ------------------------------------------------------------------------------


def test_zero_volume_answers_with_zero_fleet_and_no_payback():
    response = preview(**{VOLUME: 0})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["feasible"]
    assert result["sizing"]["fleet"] == 0
    purchase = scenario(result, "purchase")
    assert purchase["payback_cumulative_years"] is None
    assert purchase["verdict"]["band"] == "не окупается"
    assert finite_numbers(result)


def test_zero_shifts_or_days_are_refused_with_a_reason():
    for path in (SHIFTS, DAYS):
        response = preview(**{path: 0})
        assert response.status_code == 422, response.text
        assert "больше нуля" in response.json()["detail"]


def test_too_many_working_days_are_refused():
    response = preview(**{DAYS: 400})
    assert response.status_code == 422
    assert "400" in response.json()["detail"]


# --- Огромное и отрицательное ---------------------------------------------------------


# Большие, но допустимые числа: правка может быть до тысячи значений модели (calculation.MAX_OVERRIDE_FACTOR).
# Дальше отказ, его проверяет test_input_bounds
HUGE_VOLUME = 1_900_000
HUGE_PRICE = 2 * 10**9
HUGE_SALARY = 5 * 10**7


def test_huge_volume_is_not_covered_and_the_answer_says_so():
    response = preview(**{VOLUME: HUGE_VOLUME})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["feasible"] is False
    assert finite_numbers(result)


def test_huge_price_and_salary_give_finite_numbers():
    for overrides in ({PRICE: HUGE_PRICE}, {SALARY: HUGE_SALARY}, {PRICE: HUGE_PRICE, SALARY: HUGE_SALARY}):
        response = preview(**overrides)
        assert response.status_code == 200, response.text
        result = response.json()
        assert finite_numbers(result), overrides
        for scenario_id in ("purchase", "raas"):
            assert scenario(result, scenario_id)["verdict"]["band"]


def test_negative_override_does_not_crash():
    for overrides in ({VOLUME: -100}, {SALARY: -1}, {PRICE: -2_700_000}):
        response = preview(**overrides)
        assert response.status_code in (200, 422), response.text
        if response.status_code == 200:
            assert finite_numbers(response.json()), overrides


def test_negative_override_is_refused():
    for overrides in ({VOLUME: -100}, {SALARY: -1}, {PRICE: -2_700_000}):
        assert preview(**overrides).status_code == 422, overrides


def test_horizon_can_be_stretched_to_ten_years():
    response = preview(**{HORIZON: 10})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["horizon_years"] == 10
    for scenario_id in ("baseline", "purchase", "raas"):
        assert len(scenario(result, scenario_id)["years"]) == 10


def test_fractional_and_zero_horizon_are_refused():
    for horizon in (0, -5, 2.5):
        response = preview(**{HORIZON: horizon})
        assert response.status_code == 422, (horizon, response.status_code, response.text[:200])


# --- Чувствительность и отчеты на крайних данных -------------------------------------


def test_sensitivity_on_infeasible_calculation_is_refused_not_crashed():
    response = client.post("/api/calculations/sensitivity", json={"overrides": {VOLUME: HUGE_VOLUME}})
    assert response.status_code == 422, response.text
    assert "не сошелся" in response.json()["detail"]


def test_sensitivity_with_zero_volume_answers():
    response = client.post("/api/calculations/sensitivity", json={"overrides": {VOLUME: 0}})
    assert response.status_code in (200, 422), response.text
    if response.status_code == 200:
        assert finite_numbers(response.json())


def test_reports_are_built_for_zero_fleet_and_huge_numbers():
    for overrides in ({VOLUME: 0}, {PRICE: HUGE_PRICE}, {SALARY: HUGE_SALARY}):
        pdf = client.post("/api/reports/pdf", json={"overrides": overrides})
        assert pdf.status_code == 200, (overrides, pdf.text[:300])
        assert pdf.content.startswith(b"%PDF")
        xlsx = client.post("/api/reports/xlsx", json={"overrides": overrides})
        assert xlsx.status_code == 200, (overrides, xlsx.text[:300])
        assert xlsx.content.startswith(b"PK")


def test_reports_for_infeasible_calculation_answer_without_a_crash():
    for url in ("/api/reports/pdf", "/api/reports/xlsx"):
        response = client.post(url, json={"overrides": {VOLUME: HUGE_VOLUME}})
        assert response.status_code in (200, 422), (url, response.status_code, response.text[:300])


def test_sensitivity_marks_variants_where_the_fleet_does_not_fit():
    # отбор на 855 тыс. строк в сутки: 470 роботов (1,9 строки за подачу), при +10% объема формула уходит за 500
    body = {
        "facility_id": "warehouse",
        "operation_id": "piece_picking",
        "robot_id": "ronavi-m",
        "use_simulation": False,
        "overrides": {"facilities.warehouse.operations.piece_picking.volume_per_day": 855_000},
    }
    response = client.post("/api/calculations/sensitivity", json=body)
    assert response.status_code == 200, response.text
    volume = next(p for p in response.json()["params"] if p["id"] == "volume")
    grown = [cell for cell in volume["cells"] if cell["delta"] > 0]
    assert all(cell["outcomes"] == [] and cell["baseline_tco_rub"] is None for cell in grown)
    assert next(cell for cell in volume["cells"] if cell["delta"] == 0)["outcomes"]
