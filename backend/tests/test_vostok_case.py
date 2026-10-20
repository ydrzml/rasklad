"""Восток-Сервис (docs/calculation.md, 13.1) проходит прогон смены.

До 17.10.2026 робозона для прогона ставила станции по объему и выработке по умолчанию: 4 станции
на 250 строк в час. У Восток-Сервиса на станции 75 строк в час, и 4 станции давали потолок
4 * 75 = 300 строк в час при пике 357: прогон отвечал "парк не покрывает пик" при любом парке."""

from app.schemas.economics import CalculationRequest, TaskChoice
from app.schemas.plan import Plan
from app.services import calculation, simulation
from app.services import plan as plan_service

W = "facilities.warehouse."
TASK = W + "operations.piece_picking."
# 5 233 строки в сутки, зона 7 000 м2, выработка 30 -> 75 строк в час, весь отбор роботам. Режим как
# в разборе docs/calculation.md 13.1, 2 смены по 11 часов 365 дней: у них 4 смены, склад без выходных
VOSTOK = {
    W + "schedule.shift_hours": 11,
    W + "schedule.days_per_year": 365,
    W + "active_area_m2": 7000,
    TASK + "volume_per_day": 5233,
    TASK + "automatable_share": 1,
    TASK + "productivity_before": 30,
    TASK + "productivity_after": 75,
}


def test_zone_stations_follow_client_numbers():
    """Пик 5 233 / 22 * 1,5 = 356,8 строки в час, с резервом 15% 410,3, на станцию 75: 5,47, вверх 6"""
    plan = simulation.task_plan("warehouse", "piece_picking", None, VOSTOK)
    assert plan_service.measure(plan).stations == 6


def test_vostok_passes_the_shift_run():
    built = plan_service.generate("warehouse", ["piece_picking"], "robot_zone", VOSTOK)
    result = calculation.calculate(
        CalculationRequest(
            operation_id="piece_picking",
            robot_id="ronavi-m",
            tasks=[TaskChoice(operation_id="piece_picking", robot_id="ronavi-m", share=1)],
            plan=Plan.model_validate(plan_service.to_dict(built)),
            use_simulation=True,
            overrides=VOSTOK,
        )
    )
    assert result.feasible, result.message
    # формула 10 роботов; прогон с очередями у станций дает больше, а не меньше
    assert result.sizing.formula_fleet == 10
    assert result.sizing.fleet >= result.sizing.formula_fleet
