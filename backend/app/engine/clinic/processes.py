"""Связь масштаба корпуса с процессами. Без файлов, каталога и выбора робота.

Суточные объемы отделены от окна прогона. Потоки маршрутов округляются совместно,
а не по одному: большое число малых потоков не увеличивает объем из-за округления.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.engine.clinic.building import PHARMACY, ROOM, SUPPLIES, WARD, Building
from app.engine.clinic.demand import MEDS, Volume


@dataclass
class Process:
    kind: str
    volume: Volume
    sources: list[str]
    targets: list[str]
    flows: list[tuple[str, str, float]] | None = None


def window(building: Building, start: int = 7, hours: int = 8) -> tuple[int, int]:
    return building.scenario.get("shift_start_h", start), building.scenario.get("shift_hours", hours)


def profile(building: Building, industry_day: list[float]) -> list[float]:
    scenario = building.scenario
    mode = scenario.get("schedule", "industry")
    weights = (
        [1.0] * 24 if mode == "uniform" else scenario.get("hourly_weights", []) if mode == "custom" else industry_day
    )
    total = sum(weights)
    return [weight / total for weight in weights] if total else [0.0] * 24


def validate(building: Building) -> None:
    """Ссылки проверяются при расчете, чтобы исправимый импорт открывался в редакторе."""
    scenario = building.scenario
    rooms = {r.id: r for floor in building.floors for r in floor.of(ROOM)}
    wards = {key for key, room in rooms.items() if room.role == WARD}
    if set(scenario.get("point_weights", {})) - wards:
        raise ValueError("Веса нагрузки ссылаются на удаленный пост или помещение с другой ролью")
    if set(scenario.get("floor_cleaning_passes", {})) - {floor.number for floor in building.floors}:
        raise ValueError("Настройка уборки ссылается на отсутствующий этаж")
    for kind in (MEDS, SUPPLIES):
        process = scenario.get(kind, {})
        if not process.get("enabled", True) or process.get("mode") != "routes":
            continue
        if not process.get("flows"):
            raise ValueError(f"{kind}: добавьте хотя бы один маршрут или выключите процесс")
        for flow in process["flows"]:
            if flow["source"] not in rooms or flow["target"] not in rooms:
                raise ValueError(f"{kind}: отправитель или получатель маршрута отсутствует на плане")
            if flow["source"] == flow["target"]:
                raise ValueError(f"{kind}: отправитель и получатель должны различаться")


def plan(building: Building, data: dict, delivery: dict) -> list[Process]:
    validate(building)
    rooms = [room for floor in building.floors for room in floor.of(ROOM)]
    wards = [room.id for room in rooms if room.role == WARD]
    weights = building.scenario.get("point_weights", {})
    effective = sum(weights.get(ward, 1.0) for ward in wards)
    result = []
    for kind, key, role in ((MEDS, "drug_orders_per_day", PHARMACY), (SUPPLIES, "supply_trips_per_day", SUPPLIES)):
        settings = building.scenario.get(kind, {})
        if not settings.get("enabled", True):
            continue
        mode = settings.get("mode", "per_point")
        per_day = settings.get("per_day")
        per_day = data[key] if per_day is None else per_day
        sources = [room.id for room in rooms if room.role == role]
        targets = [ward for ward in wards if weights.get(ward, 1.0) > 0]
        flows = None
        if mode == "routes":
            flows = [(f["source"], f["target"], f["per_day"]) for f in settings["flows"] if f["per_day"] > 0]
            per_day = sum(weight for _, _, weight in flows)
            sources = sorted({source for source, _, _ in flows})
            targets = sorted({target for _, target, _ in flows})
        else:
            if mode == "per_point":
                per_day *= effective / max(1.0, data["drug_delivery_points"])
            if weights:
                flows = [(source, target, weights.get(target, 1.0)) for source in sources for target in targets]
        # Старый план без сценария сохраняет прежнее поведение при отсутствии расходников.
        if not sources or not targets:
            per_day = 0.0

        def value(name, default, values=settings):
            entered = values.get(name)
            return default if entered is None else entered

        result.append(
            Process(
                kind,
                Volume(
                    per_day,
                    value("urgent_share", data["stat_share_pct"] / 100 if kind == MEDS else 0.0),
                    value("picking_min", data["drug_picking_min"] if kind == MEDS else delivery["supplies_pick_s"] / 60)
                    * 60,
                    value("deadline_min", delivery["routine_deadline_min"]) * 60,
                    value("urgent_deadline_min", delivery["stat_deadline_min"]) * 60,
                ),
                sources,
                targets,
                flows,
            )
        )
    return result


def cleaning_passes(building: Building, floor: int, default: float = 1.0) -> float:
    return building.scenario.get("floor_cleaning_passes", {}).get(
        floor, building.scenario.get("cleaning_passes", default)
    )
