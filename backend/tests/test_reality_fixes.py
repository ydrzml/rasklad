"""Пять правок по сверке с реальными складами (reports/reality-check.md, "Что чинить в модели").

Руками на складе по умолчанию: 2 смены по 11 часов, 365 дней, ставок на пост 22 * 365 / 1972 * 1,25 = 5,09.
"""

import copy

import pytest

from app.engine.economics import BASELINE, PURCHASE, evaluate
from app.engine.economics.scenarios import communications, fixed_scale, night_hours
from app.schemas.economics import CalculationRequest
from app.services import calculation
from app.services.calculation import model_with_overrides

W = "facilities.warehouse."
VAT = 1.22
PALLETS = ("warehouse", "pallet_transport", "ronavi-h1500")


@pytest.fixture(scope="module")
def model():
    return model_with_overrides({})[0]


def facility(model):
    return model["facilities"][0]


def test_prices_without_vat_and_a_choice_to_keep_it(model):
    """Роботы 13 * 2,7 млн = 35,1 млн с НДС, без НДС 35,1 / 1,22 = 28,77 млн. Люди не меняются."""
    net = evaluate(model, *PALLETS, fleet=13)
    gross = evaluate(model_with_overrides({"economics.vat.with_vat": 1})[0], *PALLETS, fleet=13)
    assert gross.scenarios[PURCHASE].capex["hardware"] == pytest.approx(35_100_000)
    assert net.scenarios[PURCHASE].capex["hardware"] == pytest.approx(35_100_000 / VAT)
    assert net.scenarios[PURCHASE].years[0].opex["maintenance"] == pytest.approx(3_510_000 / VAT)
    assert net.scenarios[BASELINE].tco == pytest.approx(gross.scenarios[BASELINE].tco)
    # аренда тоже без НДС: 13 * 100 000 * 12 / 1,22
    assert net.scenarios["raas"].years[0].opex["raas_fee"] == pytest.approx(13 * 1_200_000 / VAT)


def test_communications_from_fleet(model):
    """Связь 300 000 в год на 10 роботов: на 13 это 390 000, на 1-2 робота не берем, Wi-Fi уже есть"""
    site = facility(model)
    assert communications(site, 1) == 0
    assert communications(site, 2) == 0
    assert communications(site, 3) == pytest.approx(90_000)
    assert communications(site, 13) == pytest.approx(390_000)
    pilot = evaluate(model, *PALLETS, fleet=1)
    assert pilot.scenarios[PURCHASE].years[0].opex["communications"] == 0


def test_fixed_costs_follow_the_project_size(model):
    """Интеграция 5 млн дана на проект около 10 роботов. Пилот на 1 робота: 20%, 1 млн, без НДС 0,82 млн.
    13 роботов: целиком, 5 / 1,22 = 4,10 млн, больше не растет"""
    site = facility(model)
    assert fixed_scale(site, 1) == pytest.approx(0.2)
    assert fixed_scale(site, 5) == pytest.approx(0.5)
    assert fixed_scale(site, 13) == 1
    pilot = evaluate(model, *PALLETS, fleet=1).scenarios[PURCHASE].capex
    assert pilot["integration"] == pytest.approx(1_000_000 / VAT)
    assert pilot["infrastructure"] == pytest.approx(600_000 / VAT)
    assert pilot["software"] == pytest.approx(300_000 / VAT)
    big = evaluate(model, *PALLETS, fleet=13).scenarios[PURCHASE].capex
    assert big["integration"] == pytest.approx(5_000_000 / VAT)


def test_pallet_robot_takes_floor_transport_not_the_whole_job(model):
    """Водителей 25, роботу 0,74 их работы: 25 * 0,74 = 18,5 ставки. Парк по объему 1 900 паллет (0,95)
    в 22 часа смен: 2 000 * 0,95 / 22 * 1,5 * 1,15 = 149,0 паллеты в час"""
    result = evaluate(model, *PALLETS)
    assert result.sizing.fte_before == pytest.approx(18.5)
    assert result.sizing.design_demand == pytest.approx(2000 * 0.95 / 22 * 1.5 * 1.15)


def test_peak_hours_cost_people_extra(model):
    """Пик: людей 18,5 / 5,09 = 3,63 в смену, пик 1,5 два часа в день: сверх среднего 0,5 * 3,63 * 2 * 365 =
    1 327 человеко-часов, по 320 рублей это 424 500 рублей в первый год. Ночь: 22 часа с 06:00 идут до 04:00,
    ночных часов 22 - 16 = 6 из 22, доплата 20%: 18,5 * 1 880 640 * 0,2 * 6 / 22 = 1 897 700 рублей"""
    result = evaluate(model, *PALLETS)
    s = result.sizing
    staff = s.fte_before * s.worker_cost
    extra = 0.5 * s.fte_before / s.fte_per_post * 2 * 365 * 320
    assert extra == pytest.approx(424_500, abs=100)
    assert night_hours(model, facility(model)) == 6
    night = staff * 0.2 * 6 / 22
    assert night == pytest.approx(1_897_700, abs=100)
    assert result.scenarios[BASELINE].years[0].staff_cost == pytest.approx(staff + extra + night)


def test_night_hours_cost_a_fifth_more(model):
    """Круглые сутки: 24 - 16 = 8 ночных часов из 24, доплата 20%: люди дороже на 0,2 * 8 / 24 = 6,7%"""
    changed = copy.deepcopy(model)
    site = facility(changed)
    site["schedule"] = {**site["schedule"], "shifts": 3, "shift_hours": 8, "days_per_year": 365}
    assert night_hours(changed, site) == 8
    # уборку делают свои люди: у уборки пика нет, остается только ночь
    for line in site["staff"]:
        line["contractor"] = False
    cleaning = evaluate(changed, "warehouse", "cleaning", "clinbotics-600")
    s = cleaning.sizing
    expected = s.fte_before * s.worker_cost * (1 + 0.2 * 8 / 24)
    assert cleaning.scenarios[BASELINE].years[0].staff_cost == pytest.approx(expected)


def test_contractor_gets_no_night_surcharge(model):
    """Уборку отдают подряду: платим цену договора за час (360 руб, config/model.yaml), доплату за ночь
    по ТК РФ ст. 154 платит подрядчик своим людям, и она уже в цене. Раньше база уборки выходила
    на 0,2 * 6 / 22 = 5,5% дороже."""
    cleaning = evaluate(model, "warehouse", "cleaning", "clinbotics-600")
    s = cleaning.sizing
    assert all(t.contractor for t in s.takes)
    assert night_hours(model, facility(model)) == 6
    assert cleaning.scenarios[BASELINE].years[0].staff_cost == pytest.approx(s.fte_before * s.worker_cost)
    assert s.fte_before * s.worker_cost == pytest.approx(1.46 * 60_000 * 12)


def test_round_the_clock_line():
    """Склад работает не круглосуточно: рядом с ответом строка, сколько было бы в 3 смены 365 дней"""
    result = calculation.calculate(CalculationRequest())
    assert result.round_the_clock is not None
    assert result.round_the_clock.text.startswith("При круглосуточной работе (3 смены, 365 дней) покупка")
    around = {W + "schedule.shifts": 3, W + "schedule.shift_hours": 8, W + "schedule.days_per_year": 365}
    assert calculation.calculate(CalculationRequest(overrides=around)).round_the_clock is None
