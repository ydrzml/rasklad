"""Маленькие склады и дарксторы: типовая робозона вмещает стеллажи, мастер доходит до результата.

До 17.10.2026 робозона была 10% склада: на 1 500 м2 это 150 м2, и ворота, буфер и станции
съедали ее целиком. Расчет отвечал "план не заполнен", хотя типовая схема и была выбрана."""

import re
from pathlib import Path

import pytest

from app.engine import plan as plan_engine
from app.schemas.economics import CalculationRequest, TaskChoice
from app.schemas.plan import Plan
from app.schemas.staff import StaffLine
from app.services import calculation, staff
from app.services import plan as plan_service

W = "facilities.warehouse."
# Даркстор: 500 заказов в сутки (X5, retail.ru, 17.03.2022) по 15 позиций (Ашан, retail.ru, 2023),
# 40% ассортимента в робозоне (Яндекс Лавка, docs/calculation.md, 13.4)
DARKSTORE = {
    W + "active_area_m2": 1500,
    W + "operations.piece_picking.volume_per_day": 7500,
    W + "operations.piece_picking.automatable_share": 0.4,
}


def test_zone_minimum_by_hand():
    """Пример из storage_minimum: 9 + 11,4 вверх 21 м на 21 + 7,2 вверх 29 м"""
    template = plan_service.template("robot_zone")
    assert plan_engine.storage_minimum(template, plan_service.constants()) == (21.0, 29.0)
    assert plan_service.zone_minimum_m2() == 609


def test_zone_minimum_is_the_same_on_front_and_server():
    peak = (Path(__file__).resolve().parents[2] / "frontend/src/app/steps/peak.ts").read_text(encoding="utf-8")
    front = float(re.search(r"export const ZONE_MIN_M2 = ([\d.]+);", peak).group(1))
    assert front == plan_service.zone_minimum_m2()


@pytest.mark.parametrize("area", [500, 1000, 1500, 3000])
def test_small_robot_zone_has_racks(area):
    overrides = {**DARKSTORE, W + "active_area_m2": area}
    plan = plan_service.generate("warehouse", ["piece_picking"], "robot_zone", overrides)
    measures = plan_service.measure(plan)
    assert measures.task_points > 0
    assert measures.stations >= 1


def test_big_zone_keeps_its_shape():
    """На демо-складе робозона 1 000 м2 вмещает стеллажи и квадратом: 32 * 31 = 992 м2, размеры по пропорции шаблона"""
    plan = plan_service.generate("warehouse", ["piece_picking"], "robot_zone")
    hall = plan.sections[0]
    assert (hall.w, hall.h) == (32.0, 31.0)


def test_own_size_is_not_stretched():
    plan = plan_service.generate("warehouse", ["piece_picking"], "robot_zone", width_m=20, length_m=20)
    hall = plan.sections[0]
    assert (hall.w, hall.h) == (20.0, 20.0)


def test_darkstore_reaches_result():
    """Даркстор 1 500 м2 проходит мастер: план по типовой схеме, штат под объем, прогон смены"""
    built = plan_service.generate("warehouse", ["piece_picking"], "robot_zone", DARKSTORE)
    form = staff.form("warehouse", ["piece_picking"], DARKSTORE)
    lines = [StaffLine(**line.model_dump(include=set(StaffLine.model_fields))) for line in form.lines]
    result = calculation.calculate(
        CalculationRequest(
            operation_id="piece_picking",
            robot_id="ronavi-m",
            tasks=[TaskChoice(operation_id="piece_picking", robot_id="ronavi-m", share=1)],
            plan=Plan.model_validate(plan_service.to_dict(built)),
            use_simulation=True,
            overrides=DARKSTORE,
            staff=lines,
        )
    )
    assert result.feasible, result.message
    assert result.sizing.fleet >= 1
    assert any(scenario.id == "purchase" for scenario in result.scenarios)
