"""Уборка: робота сравниваем с тем, как убирают сейчас, поломоечной машиной или вручную.

Пример руками, склад по умолчанию (10 000 м2 раз в сутки, 365 дней). Люди
подрядчика, поэтому в постах по 2 000 часов в год, без надбавки на отпуска: подмену дает подрядчик.
    машиной: оператор машины 1 250 м2/ч, 10 000 * 365 / 1 250 = 2 920 часов, 2 920 / 2 000 = 1,46 поста;
             робот проходит те же проезды, что машина, и забирает все 1,46 поста: 1 051 200 рублей в год
    вручную: уборщик 230 м2/ч, 10 000 * 365 / 230 = 15 870 часов, 15 870 / 2 000 = 7,9 поста;
             роботу 70% площади, под стеллажами и у стен уборщик остается: 7,9 * 0,7 = 5,53 поста, это 5,53 * 720 000 = 3 981 600 рублей в год
Цена человека подрядчика 60 000 в месяц, взносов нет: 720 000 в год. Доплату за ночные часы подрядчик
платит своим людям сам, она уже в цене часа, поэтому сверху ее не начисляем.
Робот Клинботикс 600 стоит 2,31 млн: против машины окупается за 3,4 года, против ручной уборки за 0,6.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.economics import CalculationRequest
from app.services import calculation, staff

client = TestClient(app)
MANUAL = {"facilities.warehouse.operations.cleaning.by_machine": 0}
CLEANING = [{"operation_id": "cleaning", "robot_id": "clinbotics-600", "share": 1}]


def test_default_is_the_machine():
    form = staff.form("warehouse", ["cleaning"])
    assert [(line.role, line.headcount) for line in form.lines] == [("scrubber_operator", 1.46)]
    result = calculation.calculate(CalculationRequest(tasks=CLEANING))
    assert result.sizing.fte_before == pytest.approx(1.46)
    baseline = next(s for s in result.scenarios if s.id == "baseline")
    assert baseline.years[0].staff_cost_rub == pytest.approx(1.46 * 720_000)
    purchase = next(s for s in result.scenarios if s.id == "purchase")
    assert purchase.payback_cumulative_years == pytest.approx(3.39, abs=0.05)


def test_manual_cleaning_takes_cleaners_by_the_norm():
    form = staff.form("warehouse", ["cleaning"], MANUAL)
    [line] = form.lines
    assert (line.role, line.headcount, line.contractor) == ("cleaner", 7.9, True)
    assert "230" in line.source and "7,9" in line.source
    # объем вдвое больше: уборщиков вдвое больше, как у любой задачи с штатом по умолчанию.
    # Пересчет под объем: посты подрядчика дробные, 7,9 * 2 = 15,8
    volume = "facilities.warehouse.operations.cleaning.volume_per_day"
    double = staff.form("warehouse", ["cleaning"], {**MANUAL, volume: 20_000})
    assert [one.headcount for one in double.lines] == [15.8]


def test_robot_pays_back_against_manual_cleaning():
    """По формуле один робот: 3 981 600 рублей людей подрядчика в год против содержания робота
    без НДС, окупается за 0,6 года"""
    result = calculation.calculate(CalculationRequest(tasks=CLEANING, overrides=MANUAL))
    assert result.sizing.fleet == 1
    assert result.sizing.fte_before == pytest.approx(5.53)
    baseline = next(s for s in result.scenarios if s.id == "baseline")
    assert baseline.years[0].staff_cost_rub == pytest.approx(5.53 * 720_000)
    purchase = next(s for s in result.scenarios if s.id == "purchase")
    assert purchase.payback_cumulative_years == pytest.approx(0.64, abs=0.02)


def test_question_is_asked_in_the_wizard():
    fields = client.get("/api/catalog/parameters", params={"facility": "warehouse", "operations": "cleaning"}).json()
    field = next(one for one in fields if one["path"].endswith("cleaning.by_machine"))
    assert field["yes_no"] and field["key"]
    assert field["yes_no_names"] == ["Поломоечной машиной", "Вручную"]
    assert field["value"] == 1
    assert "как вы убираете сейчас" in field["hint"]


def test_default_cleaning_staff_does_not_argue_with_itself():
    """Штат по умолчанию не спорит с нормой: 1,46 поста оператора машины, вручную 7,9 поста уборщика,
    оба посчитаны по той же норме выработки. А 3 оператора при норме 1,46 это расхождение."""
    for overrides, staff_line in (({}, ("scrubber_operator", 1.46)), (MANUAL, ("cleaner", 7.9))):
        role, people = staff_line
        line = {"id": "cleaners", "role": role, "headcount": people, "filled": people, "salary_month": 60_000}
        body = {"operation_ids": ["cleaning"], "overrides": overrides, "staff": [{**line, "contractor": True}]}
        review = client.post("/api/staff/check", json=body).json()
        assert "norm_gap" not in [note["kind"] for note in review["notes"]], role
    three = {"id": "c", "role": "scrubber_operator", "headcount": 3, "filled": 3, "salary_month": 60_000}
    review = client.post("/api/staff/check", json={"operation_ids": ["cleaning"], "staff": [three]}).json()
    assert "norm_gap" in [note["kind"] for note in review["notes"]]
