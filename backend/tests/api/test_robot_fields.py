"""Неверные значения робота дают понятный отказ с именем поля, а не "На сервере что-то сломалось".

Срок службы 3,5 года падал на целом числе лет в амортизации, скорость 0 и роботов на зарядку 0
делили на ноль, срок договора аренды 18 месяцев падал на расчете по годам."""

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)
R = "robots.ronavi-h1500."


@pytest.mark.parametrize(
    ("path", "value", "name"),
    [
        (R + "service_life_years", 3.5, "Срок службы робота"),
        (R + "service_life_years", 0, "Срок службы робота"),
        (R + "battery_life_years", 2.5, "Срок службы аккумулятора"),
        (R + "avg_speed_m_s", 0, "Средняя скорость"),
        (R + "robots_per_charger", 0, "Роботов на одну зарядку"),
        (R + "robots_per_charger", 1.5, "Роботов на одну зарядку"),
        (R + "raas.contract_months", 0, "Срок договора аренды"),
        (R + "raas.contract_months", 18, "Срок договора аренды"),
        ("engine.simulation.availability", 0, "Готовность робота"),
    ],
)
def test_wrong_robot_value_is_refused_with_field_name(path, value, name):
    response = client.post("/api/calculations/preview", json={"overrides": {path: value}})
    assert response.status_code == 422, response.text
    assert response.json()["detail"].startswith(name)


def test_whole_years_still_count():
    response = client.post("/api/calculations/preview", json={"overrides": {R + "service_life_years": 4}})
    assert response.status_code == 200
