"""Типовой корпус: проверка плана проходит, прогон правдоподобный и укладывается в секунды."""

from __future__ import annotations

import time

from app.engine.clinic.check import ERROR
from app.engine.clinic.shift import CLEANING, IN_LIFT
from app.services import clinic

LIMIT_S = 10  # цель по заданию: прогон с поиском парка на типовом корпусе до 10 с


def test_demo_plan_is_valid_and_every_post_is_reachable():
    outcome = clinic.simulate(clinic.demo(), fleet=1, record=False)
    assert not [check for check in outcome.checks if check.level == ERROR]
    assert "Робот доезжает до 9 постов из 9" in [check.text for check in outcome.checks]


def test_demo_shift_is_plausible_and_fast():
    began = time.perf_counter()
    outcome = clinic.simulate(clinic.demo())
    spent = time.perf_counter() - began
    assert spent < LIMIT_S
    kpi = outcome.kpi
    assert outcome.search and outcome.search.needed is not None
    assert 1 <= outcome.fleet <= clinic.config()["engine"]["max_fleet"]
    urgent = [job for job in outcome.result.jobs if job.urgent and job.deadline_s <= outcome.result.hours * 3600]
    assert all(job.on_time for job in urgent)
    assert kpi.on_time_share >= 0.95
    assert kpi.blocked == 0
    # заявка с комплектацией 12 минут по датасету: в среднем полчаса и меньше, как у пилотов в больницах
    assert 12 < kpi.avg_delivery_min < 40
    assert kpi.staff_hours > 0
    lifts = {lift.lift: lift for lift in kpi.lifts}
    assert lifts["L1"].robot_rides > 0 and lifts["L2"].robot_rides == 0  # второй без интеграции
    assert kpi.cleaned_m2 > 0.9 * sum(c.area_m2 for c in kpi.cleaning)
    actions = {segment.action for segment in outcome.result.segments}
    assert {IN_LIFT, CLEANING} <= actions


def test_robot_without_lift_cannot_serve_upper_floors():
    outcome = clinic.simulate(clinic.demo(), "ext-pudubot-2", fleet=2, record=False)
    assert outcome.kpi.done == 0 and outcome.kpi.blocked > 0
    assert outcome.kpi.bottleneck.startswith("план:")


def test_dataset_override_changes_the_volume():
    base = clinic.simulate(clinic.demo(), fleet=2, record=False).kpi.created
    more = clinic.simulate(
        clinic.demo(), fleet=2, record=False, overrides={"clinic.drug_orders_per_day": 680}
    ).kpi.created
    assert more > 1.6 * base
