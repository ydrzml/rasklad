"""Независимые условия прогона. Исходные настройки и паспортные данные не изменяются."""

from copy import copy
from dataclasses import replace

from app.schemas.clinic import MoneyRequest, StressProfile
from app.services import clinic


def prepare(base: clinic.Prepared, profile: StressProfile) -> clinic.Prepared:
    result = copy(base)
    result.condition_id = profile.id
    result.demand_factor = profile.demand_factor
    result.arrival_spread = profile.arrival_spread
    result._jobs = {}
    # Меняется только трафик, геометрия и габариты прежние: карты маршрутов переиспользуются.
    result.building = replace(
        base.building,
        lifts=[
            replace(lift, people_calls_per_hour=lift.people_calls_per_hour * profile.lift_traffic_factor)
            for lift in base.building.lifts
        ],
    )
    if base.delivering:
        spec = base.robot.spec
        result.robot = replace(
            base.robot,
            spec=replace(
                spec,
                speed_m_s=spec.speed_m_s * profile.speed_factor,
                run_time_h=spec.run_time_h * profile.runtime_factor,
            ),
        )
    if base.cleaner:
        spec = base.cleaner.spec
        result.cleaner = replace(
            base.cleaner,
            spec=replace(
                spec,
                speed_m_s=spec.speed_m_s * profile.speed_factor,
                run_time_h=spec.run_time_h * profile.runtime_factor,
                throughput_m2_h=spec.throughput_m2_h * profile.cleaning_factor,
            ),
        )
    result.run_times = replace(
        base.run_times,
        load_s=base.run_times.load_s * profile.handling_factor,
        handover_s=base.run_times.handover_s * profile.handling_factor,
        door_manual_s=base.run_times.door_manual_s * profile.door_wait_factor,
    )
    return result


def accounts(request: MoneyRequest, profile: StressProfile) -> MoneyRequest:
    defaults = clinic.config()["money"]
    values = request.assumptions.model_dump(exclude_none=True)
    for name in ("delivery_support_min_per_job", "cleaner_support_min_per_shift", "manual_door_assist_s"):
        values[name] = values.get(name, defaults[name]) * profile.support_factor
    # Внутреннее преобразование сценария может выйти за границы пользовательского ввода.
    assumptions = request.assumptions.model_copy(update=values)
    return request.model_copy(update={"assumptions": assumptions})
