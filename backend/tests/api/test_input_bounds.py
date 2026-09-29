"""Границы чисел на входе: огромные и отрицательные числа получают понятный отказ сразу, до расчета."""

import time

import pytest

AREA = "facilities.warehouse.active_area_m2"
VOLUME = "facilities.warehouse.operations.pallet_transport.volume_per_day"
LINE = {"id": "a", "role": "picker", "headcount": 5, "filled": 5, "salary_month": 80000}


@pytest.mark.parametrize(
    "path", ["/api/calculations/preview", "/api/calculations/sensitivity/all", "/api/reports/xlsx"]
)
@pytest.mark.parametrize("value", [1e308, -1, -1e308])
def test_override_out_of_bounds_is_refused(db_client, path, value):
    response = db_client.post(path, json={"overrides": {VOLUME: value}})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "Объем" in detail
    if value > 0:
        # число с пробелами между тысячами, а запятые в самом тексте на месте
        assert "слишком большое число, нужно не больше 2 000 000" in detail


def test_ordinary_big_warehouse_still_counts(db_client):
    # в десять раз больше обычного объема: предупреждение по датасету, но не отказ
    assert db_client.post("/api/calculations/preview", json={"overrides": {VOLUME: 30000}}).status_code == 200


@pytest.mark.parametrize("change", [{"salary_month": 1e308}, {"headcount": -1}, {"filled": 1e9}, {"salary_month": -5}])
def test_staff_numbers_out_of_bounds_are_refused(db_client, change):
    response = db_client.post("/api/calculations/preview", json={"staff": [{**LINE, **change}]})
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"]


def test_budget_out_of_bounds_is_refused(db_client):
    for budget in (1e308, -1, 0):
        response = db_client.post("/api/budget/fit", json={"robot_ids": ["ronavi-h1500"], "budget_rub": budget})
        assert response.status_code == 422, budget


def test_plan_bigger_than_a_kilometre_is_refused_fast(db_client):
    assert db_client.post("/api/plan/generate", json={"width_m": 2000, "length_m": 2000}).status_code == 422
    started = time.perf_counter()
    response = db_client.post("/api/plan/generate", json={"overrides": {AREA: 5_000_000}})
    assert response.status_code == 422
    assert "м, а план строим до 1000 м" in response.json()["detail"]
    assert time.perf_counter() - started < 3
    # километр на сторону еще строится
    assert db_client.post("/api/plan/generate", json={"width_m": 1000, "length_m": 40}).status_code == 200
