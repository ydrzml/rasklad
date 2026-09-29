"""Пока человек вводит числа, параметры бывают невозможны: 5 смен по 11 ч. Любой адрес, который их
получил, отвечает понятным отказом 422 по-русски, а не ошибкой сервера 500."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
IMPOSSIBLE = {
    "facilities.warehouse.schedule.shifts": 5,
    "facilities.warehouse.schedule.shift_hours": 11,
}


def test_plan_generate_refuses_impossible_schedule():
    response = client.post("/api/plan/generate", json={"overrides": IMPOSSIBLE})
    assert response.status_code == 422, response.text
    assert "55 ч работы в сутки" in response.json()["detail"]


def test_staff_check_refuses_impossible_schedule():
    response = client.post(
        "/api/staff/check", json={"operation_ids": ["pallet_transport"], "overrides": IMPOSSIBLE, "staff": []}
    )
    assert response.status_code == 422, response.text
    assert "в сутках 24" in response.json()["detail"]


def test_unknown_path_is_refused_everywhere():
    response = client.post("/api/plan/generate", json={"overrides": {"economics.no_such_value": 1}})
    assert response.status_code == 422, response.text
    assert "economics.no_such_value" in response.json()["detail"]


def test_negative_override_names_the_value():
    response = client.post(
        "/api/calculations/preview", json={"overrides": {"robots.ronavi-h1500.price_rub": -2_700_000}}
    )
    assert response.status_code == 422, response.text
    assert "меньше нуля" in response.json()["detail"]
