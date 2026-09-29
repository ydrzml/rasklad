"""Что подготовить на складе до роботов: собираем для правил план, робота и прогон смены.

Правила лежат в engine/readiness.py. Здесь чтение: план клиента или типовой, характеристики
робота из каталога (data/catalog/warehouse.csv, с оценками) и из собранных источников
(data/specs/sources.csv: условия работы, связь, зарядка, уклон), парк и прогон смены тем же
парком, что в расчете.
"""

from __future__ import annotations

import csv
import math
from functools import lru_cache
from urllib.parse import urlparse

from app.engine import plan as plan_engine
from app.engine import readiness as engine
from app.engine.economics.scenarios import by_id, implementation_costs
from app.schemas.readiness import ReadinessItem, ReadinessRequest, ReadinessResult, ReadinessRobot
from app.services import plan as plan_service
from app.services import simulation
from app.services.calculation import model_with_overrides
from app.services.selection import catalog
from app.settings import settings

# Какие поля источников идут в список. Остальное в sources.csv про деньги и производительность
SOURCE_FIELDS = ("operating_conditions", "connectivity", "charging_infrastructure", "max_incline_deg")
# Оценка одной строки источника по шкале проекта (docs/data-sources.md, "Оценка достоверности"):
# только производитель или интегратор это C, только организатор или СМИ это D
TRUST_BY_TYPE = {"производитель": "C", "интегратор": "C", "эксплуатант": "C", "организатор": "D", "СМИ": "D"}
# Кого слушаем первым, если источников несколько
PREFERRED = ("производитель", "организатор", "интегратор", "эксплуатант", "СМИ")


@lru_cache(maxsize=1)
def _sources() -> dict[tuple[str, str], list[dict[str, str]]]:
    """Актуальные строки источников по решению и полю. Устаревшие и значения по аналогу не берем:
    аналог это цифра похожей модели, а готовить склад надо под свою."""
    found: dict[tuple[str, str], list[dict[str, str]]] = {}
    path = settings.data_dir / "specs" / "sources.csv"
    with path.open(encoding="utf-8-sig") as file:
        for row in csv.DictReader(file, delimiter=";"):
            if row["field"] not in SOURCE_FIELDS or row.get("current") in ("устарело", "аналог"):
                continue
            if row["source_type"].startswith("аналог") or not row["value"]:
                continue
            found.setdefault((row["catalog_id"], row["field"]), []).append(row)
    for rows in found.values():
        rows.sort(key=lambda row: PREFERRED.index(row["source_type"]) if row["source_type"] in PREFERRED else 9)
    return found


def _spec(row: dict[str, str]) -> engine.Spec:
    url = row["source"] if row["source"].startswith("http") else ""
    where = site(url) if url else row["source"]
    return engine.Spec(row["value"], TRUST_BY_TYPE.get(row["source_type"], "D"), f"{row['source_type']}: {where}", url)


def site(url: str) -> str:
    """Сайт источника без длинного адреса: dikom-a.ru, а не служебный поддомен и путь к файлу."""
    host = urlparse(url).hostname or url
    parts = host.removeprefix("www.").split(".")
    return ".".join(parts[-2:]) if len(parts) > 2 else ".".join(parts)


def _specs(catalog_id: str, field: str) -> list[engine.Spec]:
    """Разные значения поля, первым самый надежный источник. Одинаковые слова от двух источников склеиваем."""
    seen: dict[str, engine.Spec] = {}
    for row in _sources().get((catalog_id, field), []):
        seen.setdefault(row["value"].strip().lower(), _spec(row))
    return list(seen.values())


def _catalog_spec(row: dict, field: str) -> engine.Spec | None:
    value = (row.get(field) or "").strip()
    if not value:
        return None
    return engine.Spec(value, row.get(f"{field}_trust") or "F", "каталог решений с нашей проверкой источников")


def _robot_facts(
    model: dict,
    provenance: dict,
    choice: ReadinessRobot,
    name: str,
    waits: dict[str, float],
    waiting: float,
    operation: str = "",
) -> engine.RobotFacts:
    robot = by_id(model["robots"], choice.robot_id)
    row = next((one for one in catalog() if one["id"] == robot.get("catalog_id")), {})
    kind = row.get("type", "").lower()
    price_path = f"robots.{choice.robot_id}.charger_price_rub"
    price = provenance.get(price_path)
    per_charger = robot.get("robots_per_charger") or 0
    catalog_id = robot.get("catalog_id", "")
    connectivity = _specs(catalog_id, "connectivity")
    charging = _specs(catalog_id, "charging_infrastructure")
    incline = _specs(catalog_id, "max_incline_deg")
    return engine.RobotFacts(
        name=row.get("product") or f"{robot.get('vendor', '')} {robot.get('model', '')}".strip(),
        task=name,
        operation=operation,
        mobile="мобильн" in kind or "наземн" in kind,
        fleet=choice.fleet,
        # так же, как экономика: парк, деленный на роботов на одно место (engine/economics/scenarios.py)
        chargers=math.ceil(choice.fleet / per_charger) if per_charger else 0,
        charger_price_rub=robot.get("charger_price_rub") or 0.0,
        charger_price=engine.Spec(
            str(robot.get("charger_price_rub") or 0), price.trust if price else "F", price.source if price else ""
        ),
        aisle_mm=_catalog_spec(row, "min_aisle_width_mm"),
        lift_mm=_catalog_spec(row, "lift_height_mm"),
        stacking_mm=model["engine"]["selection"]["stacking_lift_mm"],
        navigation=_catalog_spec(row, "navigation_type"),
        connectivity=connectivity[0] if connectivity else None,
        conditions=_specs(catalog_id, "operating_conditions"),
        charging=charging[0] if charging else None,
        max_incline_deg=incline[0] if incline else None,
        waits=waits,
        waiting_share=waiting,
    )


def _plan_facts(drawn: plan_engine.Plan) -> engine.PlanFacts:
    measures = plan_service.measure(drawn)
    grid = plan_engine.rasterize(drawn, plan_service.constants())
    return engine.PlanFacts(
        aisle_m=measures.aisle_m,
        rack_top_m=measures.rack_top_m,
        closed_racks=measures.closed_racks,
        ramps=engine.ramps_of(drawn, grid),
        checks=measures.checks,
        edited=drawn.known,
    )


def _budget_note(model: dict, provenance: dict, facility_id: str, operation_ids: list[str]) -> str:
    """Что на подготовку уже стоит в экономике. Инфраструктура как в расчете объекта: максимум
    по задачам, она делается один раз (docs/decisions.md, "Решение выбирается на каждую задачу")."""
    facility = by_id(model["facilities"], facility_id)
    infra = max(
        implementation_costs(facility, by_id(facility["operations"], task))["infrastructure_rub"]
        for task in operation_ids
    )
    link = facility["implementation"]["communications_rub_year"]
    base = f"facilities.{facility_id}.implementation"
    infra_trust = getattr(provenance.get(f"{base}.infrastructure_rub"), "trust", "F")
    link_trust = getattr(provenance.get(f"{base}.communications_rub_year"), "trust", "F")
    return (
        f"В экономике на подготовку объекта уже заложено {engine.money(infra)} (инфраструктура, оценка "
        f"{infra_trust}) и связь {engine.money(link)} в год (оценка {link_trust}). Источников у этих чисел "
        "нет: это наши допущения, их заменит смета по этому списку"
    )


def readiness(request: ReadinessRequest) -> ReadinessResult:
    model, provenance = model_with_overrides(request.overrides)
    facility = by_id(model["facilities"], request.facility_id)
    operations = {one["id"]: one for one in facility["operations"]}
    first = request.tasks[0].operation_id
    drawn = (
        plan_service.from_dict(request.plan.model_dump())
        if request.plan is not None
        else simulation.plan_for(request.facility_id, first, None)
    )
    own = drawn if request.plan is not None else None
    several = len(request.tasks) > 1
    robots = []
    for task in request.tasks:
        for choice in task.robots:
            # прогон тем же парком и по тому же плану, что смена на экране: из него очереди по местам.
            # Парк ноль бывает при нулевом объеме: гонять нечего, очередей нет
            waits, waiting = {}, 0.0
            if choice.fleet:
                kpi = simulation.run(
                    request.facility_id,
                    task.operation_id,
                    choice.robot_id,
                    choice.fleet,
                    # отбор на плане под погрузчик шел по робозоне: очереди берем оттуда же
                    simulation.task_plan(request.facility_id, task.operation_id, own, request.overrides),
                    with_events=False,
                    by_turnover=simulation.slotted(facility),
                    overrides=request.overrides,
                    share=choice.share,
                ).kpi
                waits, waiting = kpi.waits, kpi.waiting_share
            name = operations[task.operation_id]["name"] if several else ""
            robots.append(_robot_facts(model, provenance, choice, name, waits, waiting, task.operation_id))
    communications = provenance.get(f"facilities.{request.facility_id}.implementation.communications_rub_year")
    found = engine.collect(
        _plan_facts(drawn),
        robots,
        facility["implementation"]["communications_rub_year"],
        engine.Spec(
            "", communications.trust if communications else "F", communications.source if communications else ""
        ),
    )
    return ReadinessResult(
        items=[ReadinessItem(**vars(item)) for item in found.items],
        counts=found.counts,
        plan_edited=drawn.known,
        budget_note=_budget_note(model, provenance, request.facility_id, [task.operation_id for task in request.tasks]),
    )
