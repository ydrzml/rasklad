"""Деньги медучреждения: три сценария по часам санитаров, аренда только с ценой, итог для мастера."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.engine.clinic import money
from app.main import app
from app.services import clinic

client = TestClient(app)
HORIZON = 7


def fleet(**changes) -> money.Fleet:
    base = {
        "task": "floor_delivery",
        "name": "Доставщик",
        "count": 2,
        "price_rub": 1_000_000.0,
        "maintenance_share_year": 0.1,
        "commissioning_share": 0.0,
        "life_years": 5,
        "rent_month_rub": None,
    }
    return money.Fleet(**(base | changes))


def inputs(*fleets: money.Fleet, hours: float = 2000.0, horizon: int = HORIZON) -> money.Inputs:
    return money.Inputs(
        hours, 500.0, horizon, 0.0, 0.0, list(fleets) or [fleet()], cash_realization_share=1, rent_service_included=True
    )


def by_id(scenarios: list[money.Scenario]) -> dict[str, money.Scenario]:
    return {one.id: one for one in scenarios}


def test_baseline_is_staff_hours_times_hour_cost():
    found = by_id(money.evaluate(inputs()))
    assert found["baseline"].years_rub == [1_000_000.0] * HORIZON
    assert found["baseline"].tco_rub == pytest.approx(7_000_000)


def test_purchase_counts_renewal_without_fictitious_sale_revenue():
    found = by_id(money.evaluate(inputs()))["purchase"]
    assert found.start_rub == 2_000_000
    # первый год: люди 1 млн против обслуживания 0,2 млн, вложения 2 млн вернутся за 2,5 года
    assert found.effect_year1_rub == pytest.approx(800_000)
    assert found.payback_years == pytest.approx(2.5)
    # На 6-м году парк покупают заново. Остаток срока службы не превращается в выручку.
    assert found.years_rub[5] == pytest.approx(2_200_000)
    assert found.years_rub[6] == pytest.approx(200_000)
    assert found.saving_rub == pytest.approx(7_000_000 - found.tco_rub)


def test_no_residual_when_the_horizon_ends_with_the_service_life():
    found = by_id(money.evaluate(inputs(horizon=5)))["purchase"]
    assert found.years_rub == [pytest.approx(200_000)] * 5


def test_rent_only_when_every_robot_has_a_rent_price():
    priced = fleet(name="Уборщик", rent_month_rub=100_000.0)
    rent = by_id(money.evaluate(inputs(fleet(), priced)))["raas"]
    assert rent.available is False and "Доставщик" in rent.why_not and "Уборщик" not in rent.why_not
    rent = by_id(money.evaluate(inputs(priced)))["raas"]
    assert rent.available and rent.month_rub == 200_000
    assert rent.start_rub == 200_000 and rent.years_rub[0] == pytest.approx(2_200_000)


def test_purchase_that_never_pays_back_says_so():
    found = by_id(money.evaluate(inputs(hours=100.0)))["purchase"]
    assert found.payback_years is None and found.saving_rub < 0


def economics(**body) -> dict:
    response = client.post("/api/clinic/economics", json={"operation_ids": ["floor_delivery"], **body})
    assert response.status_code == 200, response.text
    return response.json()


def test_default_answer_has_robots_money_people_and_sources():
    body = economics()
    assert body["horizon_years"] == HORIZON  # горизонт медучреждения в датасете, у склада 5
    assert body["fleets"][0]["name"] == "Pudu FlashBot Max" and body["fleets"][0]["count"] >= 1
    assert body["shift"] | {"floors": 4, "wards": 9, "lifts": 2} == body["shift"]
    scenarios = {one["id"]: one for one in body["scenarios"]}
    assert scenarios["purchase"]["start_rub"] == pytest.approx(body["fleets"][0]["count"] * 1_411_000)
    assert scenarios["raas"]["available"] is False  # цены аренды FlashBot Max не нашли
    assert body["people"]["hours_per_shift"] > 0 and body["people"]["orderlies"] is None
    assert body["not_counted"]
    assert all(item["source"] and item["trust"] in "SABCDEF" for item in body["sources"])


def test_hour_cost_comes_from_the_dataset_salary():
    base = economics()["people"]["hour_rub"]
    raised = economics(overrides={"clinic.orderly_salary_rub": 82_500})["people"]["hour_rub"]
    assert raised == pytest.approx(base * 1.5, abs=1)


def test_cleaning_adds_cleaners_and_skipped_tasks_are_named():
    body = economics(operation_ids=["floor_delivery", "cleaning", "disinfection"])
    assert [one["task"] for one in body["fleets"]] == ["Доставка по этажам", "Уборка помещений"]
    assert body["skipped"] == ["Обеззараживание"]
    assert body["shift"]["cleaned_m2"] > 0


def test_tasks_without_money_and_unknown_robots_are_refused():
    assert client.post("/api/clinic/economics", json={"operation_ids": ["disinfection"]}).status_code == 422
    assert client.post("/api/clinic/economics", json={"operation_ids": []}).status_code == 422
    unknown = {"operation_ids": ["floor_delivery"], "robot_id": "aethon-moxi"}
    assert client.post("/api/clinic/economics", json=unknown).status_code == 404


def test_money_numbers_have_sources():
    _, provenance = clinic.model()
    assert provenance["money.shifts_counted"].trust == "D"
    assert provenance["money.annual_work_hours"].trust == "S"


def test_own_building_from_the_plan_step_is_what_the_shift_runs_on():
    building = client.get("/api/clinic/template").json()
    # верхний этаж убрали: постов на три меньше, лифты те же
    building["floors"] = [one for one in building["floors"] if one["number"] != 4]
    body = economics(building=building)
    assert body["shift"] | {"floors": 3, "wards": 6, "lifts": 2} == body["shift"]
    assert not any("типов" in line for line in body["not_counted"])


def test_building_with_plan_errors_is_refused_with_the_reason():
    building = client.get("/api/clinic/template").json()
    for floor in building["floors"]:
        floor["items"] = [one for one in floor["items"] if one.get("role") != "pharmacy"]
    answer = client.post("/api/clinic/economics", json={"operation_ids": ["floor_delivery"], "building": building})
    assert answer.status_code == 422
    assert "План не посчитать" in answer.text


def test_every_model_number_is_in_where_the_numbers_come_from():
    from app.services.clinic_money import MODEL_NAMES

    _, provenance = clinic.model()
    model = {path for path in provenance if not path.startswith("money.")}
    assert model == set(MODEL_NAMES), "у числа смены нет названия для экрана"
    body = economics(operation_ids=["floor_delivery", "cleaning"])
    shift = [one for one in body["sources"] if one["group"] == "Смена"]
    assert len(shift) == len(MODEL_NAMES)
    for one in body["sources"]:
        if one["trust"] == "F":
            said = one["source"].lower()
            assert said.startswith(("источника нет", "нет источника", "наша цель")) or "допущение" in said
        if one["trust"] in "SABC" and one["group"] in ("Смена", "Деньги"):
            assert one["date"], one["name"]


def test_demo_on_the_template_is_on_time_and_quick():
    # демо для показа: смена на типовом корпусе, парк подобран, ответ за секунды (у прошлого демо было 37 с)
    started = time.perf_counter()
    body = economics()
    assert time.perf_counter() - started < 5
    assert body["shift"]["on_time_share"] >= 0.95
