"""Смена оплаты, цены или штата не гоняет прогон смены заново (app/services/simulation.py, for_shift).

Тестировщики меняли срок лизинга на шаге экономики, и расчет с тремя решениями шел больше минуты:
поиск парка держал ответы в памяти по всем правкам, и срок лизинга в ключе делал каждый ответ новым."""

from fastapi.testclient import TestClient

from app.main import app
from app.services import simulation

client = TestClient(app)


def test_money_does_not_reach_the_shift():
    kept = {
        "robots.ronavi-h1500.avg_speed_m_s": 1.2,
        "facilities.warehouse.operations.pallet_transport.volume_per_day": 1500,
        "facilities.warehouse.schedule.shift_hours": 10,
        "economics.peak_reserve_share": 0.2,
    }
    money = {
        "financing.leasing.term_months": 24,
        "financing.method": 2,
        "subsidies.frp.chosen": 1,
        "ramp_up.pallet_transport.months": 3,
        "economics.wage_growth": 0.1,
        "robots.ronavi-h1500.price_rub": 2_000_000,
        "robots.ronavi-h1500.raas.fee_rub_month": 90_000,
        "facilities.warehouse.implementation.integration_rub": 1,
        "facilities.warehouse.staff.forklift-operators.salary_month": 90_000,
    }
    assert simulation.for_shift(kept | money) == kept


def test_lease_term_reuses_the_found_fleet():
    body = {"use_simulation": True, "overrides": {"financing.method": 2}}
    assert client.post("/api/calculations/preview", json=body).status_code == 200
    before = simulation.fleet_search.cache_info()
    for months in (24, 36, 48):
        body["overrides"]["financing.leasing.term_months"] = months
        assert client.post("/api/calculations/preview", json=body).status_code == 200
    after = simulation.fleet_search.cache_info()
    assert after.misses == before.misses


def test_wrong_lease_term_does_not_break_the_step():
    """Неверный срок не валит расчет: покупка за свои деньги, ошибка у поля срока.
    Раньше весь шаг экономики вместо расчета показывал отказ, и поле срока было не достать."""
    lease = {"financing.method": 2}
    for term in (0, 12.5, 400):
        response = client.post(
            "/api/calculations/preview",
            json={"overrides": lease | {"financing.leasing.term_months": term}},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["feasible"]
        assert [p["path"] for p in body["payment_problems"]] == ["financing.leasing.term_months"]
        purchase = next(s for s in body["scenarios"] if s["id"] == "purchase")
        assert purchase["financing"]["method"] == "own"
        assert "считаем за свои деньги" in " ".join(body["notes"])
    good = client.post("/api/calculations/preview", json={"overrides": lease | {"financing.leasing.term_months": 24}})
    assert good.json()["payment_problems"] == []
    assert next(s for s in good.json()["scenarios"] if s["id"] == "purchase")["financing"]["method"] == "leasing"
