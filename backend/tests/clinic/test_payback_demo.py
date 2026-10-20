"""Окупаемость типовых корпусов: период эффекта и затрат, целые ставки, цена часа и календарь.

Типовые корпуса те же, что на шаге плана (frontend/src/app/clinic/plan.ts), с их режимом работы.
Окупаемость проверяем расчетом, а не обещанием: денежный поток, срок и тождества итога.
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import clinic

client = TestClient(app)
INPATIENT = {"shift_start_h": 7, "shift_hours": 24, "cleaning_passes": 2}
DAYTIME = {"shift_start_h": 8, "shift_hours": 12, "cleaning_passes": 2, "days_per_year": 247}
HOSPITAL = {"width_m": 96, "length_m": 40, "floors": 4, "wards_per_floor": 6, "lifts": 2, "layout": "mixed"}
OUTPATIENT = {"width_m": 44, "length_m": 24, "floors": 1, "wards_per_floor": 4, "lifts": 0, "layout": "linear"}
BOTH = [clinic.DELIVERY, clinic.CLEANING]


def building(size: dict, schedule: dict | None) -> dict:
    response = client.post("/api/clinic/generate", json=size | {"furnished": True, "floor_height_m": 3.3})
    assert response.status_code == 200, response.text
    house = response.json()
    house["scenario"] = schedule
    return house


def economics(house: dict, tasks=BOTH, **body) -> dict:
    response = client.post("/api/clinic/economics", json={"operation_ids": tasks, "building": house, **body})
    assert response.status_code == 200, response.text
    return response.json()


def scenario(out: dict, ident: str) -> dict:
    return next(one for one in out["scenarios"] if one["id"] == ident)


@pytest.fixture(scope="module")
def hospital() -> dict:
    return economics(building(HOSPITAL, INPATIENT))


def test_default_window_is_the_full_day_of_an_inpatient_building():
    # Без процессов корпуса считаем сутки: робота покупают и обслуживают на весь год
    out = economics(building(OUTPATIENT, None), tasks=[clinic.CLEANING])
    assert out["shift"]["hours"] == 24
    assert out["assumptions"]["days_per_year"] == 365
    assert clinic.config()["cleaning"]["passes_per_shift"] == 2  # СП 2.1.3678-20: дважды в сутки


def test_hospital_template_pays_back_by_its_own_cash_flow(hospital):
    buy, base = scenario(hospital, "purchase"), scenario(hospital, "baseline")
    people = hospital["people"]
    assert hospital["shift"]["search"]["needed"] is not None  # парк подтвержден на всех seed
    assert people["positions_released"] >= 1
    # срок по денежному потоку: вложения, затем экономия против людей по годам
    cash = [-buy["start_rub"]] + [b - c for b, c in zip(base["years_rub"], buy["years_rub"], strict=True)]
    assert cash[1] == pytest.approx(buy["effect_year1_rub"])
    years = buy["payback_years"]
    assert years is not None and years < 5  # раньше конца срока службы первого парка
    assert sum(cash[: math.floor(years) + 1]) < 0 <= sum(cash[: math.ceil(years) + 1])
    # итог за горизонт: денежный поток плюс остаток срока службы второго парка, не больше
    assert buy["saving_rub"] == pytest.approx(sum(cash) + buy["residual_rub"])
    assert 0 < buy["residual_rub"] < buy["start_rub"]


def test_money_counts_whole_positions_of_each_role(hospital):
    people, assumptions = hospital["people"], hospital["assumptions"]
    worked = assumptions["annual_work_hours"] - assumptions["paid_leave_hours"]
    delivery = math.floor(people["delivery_hours_per_shift"] * 365 / worked)
    cleaning = math.floor(people["cleaning_hours_per_shift"] * 365 / worked)
    assert people["positions_released"] == delivery + cleaning
    cash = (delivery * people["hour_rub"] + cleaning * people["cleaner_hour_rub"]) * worked
    assert people["cash_saving_year_rub"] == pytest.approx(cash)
    assert 0 < assumptions["cash_realization_share"] < 1  # дробный остаток ставок в деньги не идет
    assert any("целые высвобожденные ставки" in one for one in hospital["warnings"])


def test_hour_cost_is_paid_per_worked_hour_not_per_calendar_hour(hospital):
    data = clinic.dataset({})
    worked = 1972 - 160  # отпуск 28 календарных дней, ТК РФ ст. 115
    assert hospital["people"]["hour_rub"] == pytest.approx(
        data["orderly_salary_rub"] * 12 * data["payroll_tax_factor"] / worked
    )


def test_less_than_one_position_does_not_pay_back_and_says_why():
    out = economics(building(OUTPATIENT, DAYTIME))
    assert out["people"]["positions_released"] == 0
    assert out["people"]["cash_saving_year_rub"] <= 0
    assert all(one["payback_years"] is None for one in out["scenarios"] if one["id"] != "baseline")
    assert any("меньше одной ставки" in one for one in out["warnings"])


def test_outpatient_calendar_comes_with_the_building():
    out = economics(building(OUTPATIENT, DAYTIME), tasks=[clinic.CLEANING])
    assert out["shift"]["hours"] == 12
    assert out["assumptions"]["days_per_year"] == 247
    assert not any("365 дней" in one for one in out["readiness"])
    entered = economics(building(OUTPATIENT, DAYTIME), tasks=[clinic.CLEANING], assumptions={"days_per_year": 300})
    assert entered["assumptions"]["days_per_year"] == 300  # ввод в итоге важнее процессов корпуса


def test_cleaning_saving_applies_to_the_floor_the_robot_washed(hospital):
    people = hospital["people"]
    share = hospital["assumptions"]["cleaning_time_saving_share"]
    assert share == pytest.approx(0.8)
    support = people["support_hours_per_shift"] - (
        people["manual_delivery_hours_per_shift"] - people["delivery_hours_per_shift"]
    )
    assert people["cleaning_hours_per_shift"] == pytest.approx(
        people["manual_cleaning_hours_per_shift"] * share - support, abs=1e-6
    )


def test_explicit_zero_realization_restores_the_kept_payroll(hospital):
    house = building(HOSPITAL, INPATIENT)
    kept = economics(house, assumptions={"cash_realization_share": 0})
    assert kept["people"]["cash_saving_year_rub"] == 0
    assert kept["people"]["positions_released"] == 0
    assert scenario(kept, "purchase")["payback_years"] is None
    full = economics(house, assumptions={"cash_realization_share": 1})
    assert full["people"]["cash_saving_year_rub"] == pytest.approx(full["people"]["released_value_year_rub"])
    # полная реализация не хуже целых ставок
    assert scenario(full, "purchase")["payback_years"] <= scenario(hospital, "purchase")["payback_years"]


def test_payback_moves_the_expected_way_with_salary_and_robot_cost(hospital):
    house = building(HOSPITAL, INPATIENT)
    base = scenario(hospital, "purchase")
    richer = scenario(economics(house, overrides={"clinic.orderly_salary_rub": 70_000}), "purchase")
    assert richer["payback_years"] < base["payback_years"]
    assert richer["npv_rub"] > base["npv_rub"]
    pricier = scenario(economics(house, assumptions={"extra_annual_rub": 1_000_000}), "purchase")
    assert pricier["npv_rub"] < base["npv_rub"]
    assert pricier["payback_years"] is None or pricier["payback_years"] > base["payback_years"]


@pytest.mark.parametrize("conditions", [{"paid_leave_hours": 1972}, {"paid_leave_hours": -1}])
def test_leave_cannot_eat_the_whole_year(conditions):
    house = building(OUTPATIENT, DAYTIME)
    response = client.post(
        "/api/clinic/economics", json={"operation_ids": [clinic.CLEANING], "building": house, "assumptions": conditions}
    )
    assert response.status_code == 422, response.text
