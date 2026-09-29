"""План объекта для API: читаем шаблоны, строим план, считаем по нему числа.

Движок файлов не читает, поэтому шаблоны и константы из config/layouts.yaml загружаются здесь
и уходят в engine/plan.py словарями.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import replace
from functools import lru_cache

from app.engine import plan as engine
from app.engine.economics.fleet import peak_demand
from app.engine.economics.scenarios import by_id
from app.engine.model_config import Provenance, load_model
from app.errors import NotFound
from app.services.calculation import model_with_overrides
from app.settings import settings

DEFAULT_TEMPLATE = "one_side"
ROBOT_ZONE = "robot_zone"
# Проезд уже этого значения: стеллажи стоят плотно, под робота, а не под погрузчик. Тот же порог,
# что ZONE_AISLE_M в frontend/src/app/steps/peak.ts: правило плана под отбор одно на фронте и сервере
ZONE_AISLE_M = 2.5
CUSTOM = "custom"  # план по анкете, а не по схеме потока
# Пустое место вокруг здания. Это не данные, а поле редактора: без него пристройку дорисовать некуда.
LOT_MARGIN_M = 16


class UnknownTemplate(ValueError):
    """Пользователь попросил шаблон планировки, которого у нас нет."""


@lru_cache(maxsize=1)
def _layouts() -> tuple[dict, dict[str, Provenance]]:
    return load_model(settings.config_dir / "layouts.yaml")


@lru_cache(maxsize=1)
def constants() -> dict:
    """Константы склада вместе с типами стеллажей: движку они нужны в одном словаре."""
    raw = _layouts()[0]
    return {**raw["constants"], "rack_types": {kind["id"]: kind for kind in raw["rack_types"]}}


def rack_types() -> list[dict]:
    """Типы стеллажей с числами по умолчанию: их подставляет окно зоны хранения."""
    return [{**kind, **engine.rack_defaults(kind, constants())} for kind in _layouts()[0]["rack_types"]]


def provenance() -> dict[str, Provenance]:
    return _layouts()[1]


def templates() -> list[dict]:
    return _layouts()[0]["templates"]


def template(template_id: str) -> dict:
    for item in templates():
        if item["id"] == template_id:
            return item
    raise UnknownTemplate(template_id)


OPPOSITE = {"south": "north", "north": "south", "west": "east", "east": "west"}


def custom_template(answers: dict) -> dict:
    """Шаблон из ответов анкеты «Свой склад»: ворота на названной стене, буфер за ними,
    зарядка у противоположной, ряды поперек потока или вдоль, или без стеллажей.
    Проезд погрузчика: в своем складе люди с техникой обычно есть."""
    docks = [entry for entry in answers.get("docks") or [] if entry.get("count", 0) > 0]
    walls = list(dict.fromkeys(entry["wall"] for entry in docks))
    racks = {"across": "across_flow", "along": "along_flow", "none": "none"}[answers.get("racks", "across")]
    return {
        "id": CUSTOM,
        "name": "Свой склад",
        "about": "План по ответам: размеры, стены с воротами и направление рядов.",
        "fits": "Склад, не похожий ни на одну схему потока.",
        "aspect": 1.4,
        "aisle": "aisle_forklift_m",
        "racks": racks,
        "docks": [{"wall": entry["wall"], "kind": "both", "count": int(entry["count"])} for entry in docks],
        "buffers": [{"wall": wall, "kind": "both"} for wall in walls],
        "chargers": {"wall": OPPOSITE[walls[0]] if walls else "east"},
    }


def stations_needed(model: dict, facility: dict, operation: dict) -> int:
    """Сколько станций комплектации нужно по спросу и выработке человека на станции.

    Считается до плана и не зависит от робота, поэтому генератор может расставить станции сам.
    Там, где робот работает не по схеме «товар к человеку», станций нет.
    """
    rate = operation.get("productivity_after")
    if not rate:
        return 0
    design = peak_demand(operation, facility) * (1 + model["economics"]["peak_reserve_share"])
    return math.ceil(design / rate)


def generate(
    facility_id: str,
    operation_ids: list[str],
    template_id: str = DEFAULT_TEMPLATE,
    overrides: dict[str, float] | None = None,
    width_m: float | None = None,
    length_m: float | None = None,
    custom: dict | None = None,
) -> engine.Plan:
    """План по шаблону и параметрам объекта. Габариты можно задать свои: в датасете их нет.
    Шаблон «custom» строится из ответов анкеты, а не из config/layouts.yaml."""
    model, _ = model_with_overrides(overrides or {})
    facility = by_id(model["facilities"], facility_id)
    stations = max(
        (stations_needed(model, facility, by_id(facility["operations"], task)) for task in operation_ids),
        default=0,
    )
    picked = custom_template(custom or {}) if template_id == CUSTOM else template(template_id)
    # Робозона под отбор занимает часть склада, а не весь: на 10 000 м2 путь до станции выходил 53 м,
    # и прогон просил вдвое больше роботов, чем ставят на таком потоке (docs/decisions.md)
    area = picking_zone_m2(facility) if template_id == ROBOT_ZONE else facility["active_area_m2"]
    if width_m and length_m:
        # человек поставил свои габариты: пропорция шаблона уступает им, площадь берем из них
        picked, area = dict(picked, aspect=width_m / length_m), width_m * length_m
    plan = engine.generate(
        picked,
        constants(),
        area,
        stations,
        ceiling_m=facility["constraints"].get("ceiling_m", 0.0),
        margin_m=LOT_MARGIN_M,
    )
    # шаблон кладет одну зону, а редактор правит ряды: раскладываем сразу
    return engine.rows_of(plan, constants())


def picking_zone_m2(facility: dict) -> float:
    """Площадь робозоны под штучный отбор: часть зоны работы роботов, которую назвал человек
    (по умолчанию от плотности рынка, config/model.yaml, picking_zone_share)."""
    share = facility.get("picking_zone_share") or 1.0
    return float(round(facility["active_area_m2"] * min(1.0, share)))


def fits_picking(plan: engine.Plan) -> bool:
    """План человека и есть робозона по шаблону. Отбор «товар к человеку» считаем по робозоне при любом
    плане, а этот признак решает, нужна ли на шаге 5 строка про то, что посчитано не по его плану.
    То же правило, что planFitsPicking в frontend/src/app/steps/peak.ts."""
    return plan.template == ROBOT_ZONE


def resolve(plan: engine.Plan) -> engine.Plan:
    """Зарядку ставит программа. Пока человек ее не передвинул, место выбирается заново после
    каждой правки: сдвинул стеллажи, и зарядка переехала туда, где она ближе и не мешает.

    Старая зона хранения на много рядов, сохраненная в проекте до рядов, здесь же раскладывается
    на ряды: редактор получит план уже рядами, а расчет от этого не меняется."""
    plan = engine.rows_of(plan, constants())
    # верхний ярус считается из числа ярусов: пишем его в план, чтобы экран показал то же число
    items = [
        replace(item, rack_top_m=engine.top_of(item)) if item.kind == engine.RACKS else item for item in plan.items
    ]
    plan = replace(plan, items=items)
    manual = [item for item in plan.of(engine.CHARGE) if not item.auto]
    if manual:
        return plan
    rest = [item for item in plan.items if item.kind != engine.CHARGE]
    placed = engine.place_charge(replace(plan, items=rest), constants())
    return replace(plan, items=rest + ([placed] if placed else []))


def serpentine(plan: engine.Plan, zone_id: str, first: str = "") -> engine.Plan:
    """Змейка по проездам одним действием. zone_id это группа рядов, один ряд или старая зона.
    У ряда змейка ложится на всю его группу, а без группы на ряды, которые стоят с ним рядом.
    Прежние полосы этих рядов убираем: иначе вторая змейка легла бы поверх первой."""
    racks = plan.of(engine.RACKS)
    zone = next((item for item in racks if item.id == zone_id), None)
    if zone is not None and not engine.is_row(zone, constants()):
        lanes, name = engine.serpentine(zone, constants(), first), zone_id
    else:
        index = next((number for number, item in enumerate(racks) if zone_id in (item.id, item.group)), None)
        if index is None:
            raise NotFound(f"На плане нет зоны хранения {zone_id}")
        block = engine.block_of(racks, index, constants())
        # имя полос одно на всю группу или на весь блок, с какого бы ряда змейку ни просили
        name = racks[index].group or min(racks[number].id for number in block)
        lanes = engine.serpentine_rows(racks, block, constants(), name, first)
    kept = [item for item in plan.items if not item.id.startswith(f"{name}-flow-")]
    return replace(plan, items=kept + lanes, edited=True)


def measure(plan: engine.Plan) -> engine.Measures:
    return engine.measure(plan, constants())


def to_dict(plan: engine.Plan) -> dict:
    return {
        "width_m": plan.width_m,
        "length_m": plan.length_m,
        "template": plan.template,
        "edited": plan.edited,
        "floor": list(plan.floor),
        "levels": [vars(level) for level in plan.levels],
        "sections": [
            {**vars(section), "points": [list(point) for point in section.points]} for section in plan.sections
        ],
        "items": [dict(vars(item)) for item in plan.items],
    }


def from_dict(raw: dict) -> engine.Plan:
    return engine.Plan(
        width_m=raw["width_m"],
        length_m=raw["length_m"],
        template=raw.get("template", DEFAULT_TEMPLATE),
        edited=raw.get("edited", False),
        items=[engine.Item(**item) for item in raw.get("items", [])],
        floor=list(raw.get("floor") or []),
        levels=[engine.Level(**level) for level in raw.get("levels") or []],
        sections=[_section(section) for section in raw.get("sections") or []],
    )


def _section(raw: dict) -> engine.Section:
    """Секция из запроса. У контура точками рамку считаем сами: по ней движок режет участок."""
    points = [(float(x), float(y)) for x, y in raw.get("points") or []]
    if len(points) < 3:
        return engine.Section(**{**raw, "points": []})
    xs, ys = [x for x, _ in points], [y for _, y in points]
    frame = {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}
    return engine.Section(**{**raw, **frame, "points": points})


def digest(plan: engine.Plan) -> str:
    """Отпечаток плана: им кешируется кривая парка.

    Словарь в ключ кеша не положить, а у каждого нового плана кривую надо считать заново:
    от геометрии зависит и длина маршрута, и число мест у ворот.
    """
    body = json.dumps(to_dict(plan), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha1(body.encode("utf-8")).hexdigest()[:16]
