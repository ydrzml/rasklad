"""Медучреждение: запросы API в модель и ответ прогона в контракт для чертежа и проигрывателя.

Считает services/clinic.py, здесь только перевод: схема корпуса в корпус движка и обратно,
проверка правок датасета, округление чисел ответа. Формат описан в docs/medical.md.
"""

from __future__ import annotations

import math
from dataclasses import asdict

from app.engine import plan as plan_module
from app.engine.clinic import building as engine
from app.engine.clinic import layouts, processes
from app.engine.clinic.check import ERROR, Check, check, check_cleaner, cleaner_unfit, delivery_unfit
from app.engine.clinic.demand import Job
from app.engine.clinic.template import Cabin, Doors
from app.engine.model_config import value_by_path
from app.schemas import clinic as schema
from app.services import clinic, facility_catalog

EFFECT_NOTE = (
    "Ручной эквивалент выполненных рейсов, до вычета помощи роботам. "
    "Чистое высвобождение и подтвержденную экономию бюджета отдельно считает итог экономики"
)


BadInput = clinic.BadInput  # отказ 422: errors.py ловит его отсюда


def from_schema(building: schema.Building) -> engine.Building:
    floors = [
        engine.Floor(
            floor.number,
            floor.width_m,
            floor.length_m,
            [plan_module.Section(**section.model_dump()) for section in floor.sections],
            [engine.Item(**item.model_dump()) for item in floor.items],
        )
        for floor in building.floors
    ]
    lifts = [engine.Lift(**lift.model_dump(exclude={"name"}), name=lift.name or lift.id) for lift in building.lifts]
    return engine.Building(
        sorted(floors, key=lambda floor: floor.number),
        lifts,
        building.floor_height_m,
        building.scenario.model_dump() if building.scenario else {},
    )


def to_schema(building: engine.Building) -> schema.Building:
    return schema.Building(
        floor_height_m=building.floor_height_m,
        scenario=building.scenario or None,
        floors=[
            schema.Floor(
                number=floor.number,
                name=f"{floor.number} этаж",
                width_m=floor.width_m,
                length_m=floor.length_m,
                sections=[asdict(section) for section in floor.sections],
                items=[schema.Item(**asdict(item)) for item in floor.items],
            )
            for floor in building.floors
        ],
        lifts=[schema.Lift(**asdict(lift)) for lift in building.lifts],
    )


def checked_overrides(overrides: dict[str, float]) -> dict[str, float]:
    """Отраслевой диапазон: предупреждение. Здесь только физические и технические пределы."""
    bounds = {
        f"{clinic.FACILITY}.{row['key']}": (float(row["min"]), float(row["max"]))
        for row in facility_catalog.fields(clinic.FACILITY)
        if row["min"] and row["max"]
    }
    for path, value in overrides.items():
        if path not in bounds:
            raise BadInput(f"У медучреждения нет параметра {path}")
        key = path.removeprefix("clinic.")
        low, high = 0, 1_000_000_000
        if key.endswith("_pct"):
            high = 100
        if key == "payback_horizon_years":
            low, high = 1, 30
        if key == "floors":
            low, high = 1, 40
        if key in {"orderly_salary_rub", "kitchen_salary_rub", "payroll_tax_factor"}:
            low = 0.000001
        if not math.isfinite(value) or not low <= value <= high:
            raise BadInput(f"{path}: допустимо от {low} до {high}")
        if key in {"floors", "payback_horizon_years"} and value != int(value):
            raise BadInput(f"{path}: требуется целое число")
    return overrides


def robot_out(item: clinic.CatalogRobot) -> schema.RobotOut:
    return schema.RobotOut(
        id=item.id,
        product=item.product,
        operation=item.operation,
        availability=item.availability,
        lift=item.lift,
        specs=[schema.SpecOut(**asdict(spec)) for spec in item.specs],
        missing=item.missing,
        speed_m_s=round(item.spec.speed_m_s, 3) if item.spec else None,
    )


def robots() -> schema.Robots:
    return schema.Robots(
        delivery=[robot_out(item) for item in clinic.robots(clinic.DELIVERY)],
        cleaning=[robot_out(item) for item in clinic.robots(clinic.CLEANING)],
    )


def assumptions() -> list[schema.Assumption]:
    """Откуда цифры модели: путь в config/clinic.yaml, значение, источник, дата, оценка."""
    values, provenance = clinic.model()
    return [
        schema.Assumption(
            path=path, value=value_by_path(values, path), source=source.source, date=source.date, trust=source.trust
        )
        for path, source in provenance.items()
    ]


def template() -> schema.Building:
    return to_schema(clinic.demo())


def generate(request: schema.GenerateRequest) -> schema.Building:
    cfg = clinic.config()
    building, lift = cfg["building"], cfg["lift"]
    return to_schema(
        layouts.generate(
            request.width_m,
            request.length_m,
            request.floors,
            request.wards_per_floor,
            request.lifts,
            request.furnished,
            request.floor_height_m,
            Doors(building["ward_door_mm"], building["office_door_mm"], building["lab_door_mm"]),
            Cabin(lift["cabin_w_mm"], lift["cabin_d_mm"], lift["door_mm"], lift["people_calls_per_hour"]),
            request.layout,
        )
    )


def check_plan(request: schema.CheckRequest) -> schema.CheckResult:
    building = from_schema(request.building)
    delivering = clinic.DELIVERY in request.operation_ids
    picked = clinic.robot(request.robot_id if delivering else clinic.DEFAULT_DELIVERY, clinic.DELIVERY)
    cleaner = (
        clinic.robot(request.cleaner_id, clinic.CLEANING)
        if request.cleaner_id and clinic.CLEANING in request.operation_ids
        else None
    )
    cleaning = clinic.CLEANING in request.operation_ids and bool(cleaner and cleaner.spec)
    found = check(building, picked.spec.size if picked.spec else None, cleaning=cleaning, delivery=delivering)
    try:
        processes.validate(building)
    except ValueError as error:
        found.append(Check("error", "scenario", str(error)))
    if cleaning and not any(item.level == ERROR for item in found):
        found += check_cleaner(building, cleaner.spec.size)
    areas = clinic.corridor_areas(building, cleaner) if cleaning else {}
    return schema.CheckResult(
        valid=not any(item.level == ERROR for item in found),
        checks=[schema.CheckOut(**asdict(item)) for item in found],
        corridor_m2=areas,
    )


def fit(request: schema.FitRequest) -> schema.FitResult:
    """Роботы, которым этот корпус не подходит совсем, с причиной: шаг решений показывает их как "не подходит".

    Без прогона, только по плану и габаритам. План с ошибками не судим: его ошибки общие для всех
    роботов и видны на проверке корпуса.
    """
    building = from_schema(request.building)
    out = schema.FitResult(delivery={}, cleaning={})
    try:
        processes.validate(building)
    except ValueError:
        return out
    for item in clinic.robots(clinic.DELIVERY):
        if item.spec and (reason := delivery_unfit(building, item.spec.size)):
            out.delivery[item.id] = reason
    for item in clinic.robots(clinic.CLEANING):
        if item.spec and (reason := cleaner_unfit(building, item.spec.size)):
            out.cleaning[item.id] = reason
    return out


def workload(request: schema.WorkloadRequest) -> schema.WorkloadResult:
    building = from_schema(request.building)
    data = clinic.dataset(checked_overrides(request.overrides))
    try:
        streams = (
            processes.plan(building, data, clinic.config()["delivery"])
            if clinic.DELIVERY in request.operation_ids
            else []
        )
    except ValueError as error:
        raise BadInput(str(error)) from error
    shares = clinic.profile(building)
    weights = building.scenario.get("point_weights", {})
    wards = [room for floor in building.floors for room in floor.of(engine.ROOM) if room.role == engine.WARD]
    cfg = clinic.config()
    start, length = processes.window(building, int(cfg["demand"]["shift_start_h"]), clinic.hours())
    daily = sum(stream.volume.per_day for stream in streams)
    warnings = []
    if daily * sum(shares) > clinic.MAX_JOBS:
        warnings.append(
            f"Технический предел прогона {clinic.MAX_JOBS} заявок. Сократите окно или разделите объект на зоны"
        )
    if length < 24:
        warnings.append("Экономика учитывает только это окно. Остальные часы суток не домножаются")
    for stream in streams:
        if not stream.sources or not stream.targets:
            warnings.append(f"{stream.kind}: нет отправителей или получателей, поток равен нулю")
    return schema.WorkloadResult(
        floors=len(building.floors),
        area_m2=sum(f.width_m * f.length_m for f in building.floors),
        points=len(wards),
        effective_points=sum(weights.get(r.id, 1) for r in wards),
        reference_points=data["drug_delivery_points"],
        shift_start_h=start,
        shift_hours=length,
        daily_share=sum(shares),
        demand_per_hour=[daily * share for share in shares],
        processes=[
            schema.ProcessWorkload(
                kind=p.kind,
                per_day=p.volume.per_day,
                in_window=p.volume.per_day * sum(shares),
                routes=len(p.flows) if p.flows is not None else len(p.sources) * len(p.targets),
            )
            for p in streams
        ],
        cleaning_m2={
            f.number: len(engine.floor_map(f).corridor_cells())
            * processes.cleaning_passes(building, f.number, cfg["cleaning"]["passes_per_shift"])
            for f in building.floors
        }
        if clinic.CLEANING in request.operation_ids
        else {},
        warnings=warnings,
    )


def run(request: schema.RunRequest) -> schema.RunResult:
    building = from_schema(request.building) if request.building else clinic.demo()
    outcome = clinic.simulate(
        building,
        request.robot_id,
        request.fleet,
        request.cleaner_id,
        request.cleaners,
        request.seed,
        checked_overrides(request.overrides),
        record=request.with_events,
        operation_ids=request.operation_ids,
    )
    result, kpi, found = outcome.result, outcome.kpi, outcome.search
    events = request.with_events
    return schema.RunResult(
        fleet=outcome.fleet,
        cleaners=outcome.cleaners,
        hours=result.hours,
        shift_start_h=processes.window(building, int(clinic.config()["demand"]["shift_start_h"]))[0],
        robot=robot_out(outcome.robot),
        cleaner=robot_out(outcome.cleaner) if outcome.cleaner else None,
        demand_per_hour=[round(value, 3) for value in outcome.demand_per_hour],
        kpi=schema.Kpi(**asdict(kpi)),
        effect=schema.Effect(
            staff_hours_per_shift=round(kpi.staff_hours, 2),
            cleaned_m2_per_shift=round(kpi.cleaned_m2, 1),
            note=EFFECT_NOTE,
        ),
        search=_search(found),
        checks=[schema.CheckOut(**asdict(item)) for item in outcome.checks],
        jobs=[schema.JobOut(**_job(job)) for job in result.jobs],
        segments=[schema.Segment(**_rounded(asdict(segment))) for segment in result.segments] if events else [],
        lift_segments=[schema.LiftSegment(**_rounded(asdict(seg))) for seg in result.lift_segments] if events else [],
    )


def _search(found) -> schema.Search | None:
    if found is None:
        return None
    return schema.Search(
        needed=found.needed,
        target=clinic.config()["delivery"]["on_time_target"],
        curve=[(fleet, round(share, 4)) for fleet, share in found.curve],
        stopped=found.stopped,
    )


def _job(job: Job) -> dict:
    data = asdict(job)
    data.pop("pick_s")
    return _rounded(data)


def _rounded(data):
    """Секунды и метры до сотых: в логе на смену тысячи отрезков, лишние знаки только раздувают ответ."""
    if isinstance(data, float):
        return round(data, 2)
    if isinstance(data, dict):
        return {key: _rounded(value) for key, value in data.items()}
    if isinstance(data, (list, tuple)):
        return [_rounded(value) for value in data]
    return data
