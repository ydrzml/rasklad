"""Аэропорт и медучреждение: задачи, поля второго шага и список решений с объяснением.

Расчетной модели у этих объектов нет, поэтому путь у них короче: объект и задачи, параметры
из датасета организатора, список решений. Плана, прогона смены и экономики нет, и экран так
и говорит. Все берем из data/facilities и data/specs, ничего не додумываем: нет источника,
значит "нет данных".
"""

from __future__ import annotations

import csv
import re
from functools import lru_cache

from app.errors import NotFound
from app.schemas.catalog import (
    Check,
    FacilityCondition,
    FacilitySolution,
    FacilitySolutions,
    Operation,
    Parameter,
    SourcedSpec,
)
from app.services.catalog_uses import BY_KEY
from app.services.selection import photo_url
from app.settings import settings

SHEETS = {"airport": "Аэропорт", "clinic": "Медучреждение"}
RANGE_SOURCE = "Границы min и max из датасета организатора, Датасеты_хакатон.xlsx"

# Поля, которые стоят наверху второго шага, кроме объемов задач: без них объект не описать
MAIN = {"airport": ["terminal_area_m2", "passengers_per_day"], "clinic": ["floor_area_m2", "floors", "beds"]}

# Какие параметры объекта читают проверки решений. Они тоже встают наверх шага: от них зависит список
RULE_FIELDS = {
    ("airport", "baggage_transport"): ["apron_winter_temp_c"],
    ("airport", "patrol"): ["apron_winter_temp_c"],
    ("clinic", "floor_delivery"): ["corridor_width_m", "floors"],
    ("clinic", "cart_transport"): ["corridor_width_m", "floors", "meal_cart_mass_kg", "linen_container_mass_kg"],
    ("clinic", "disinfection"): ["corridor_width_m"],
    ("clinic", "cleaning"): ["corridor_width_m"],
}

SPEC_LABELS = {
    "payload_kg": "Грузоподъемность",
    "min_aisle_width_mm": "Минимальный проход",
    "max_speed_m_s": "Скорость",
    "runtime_h": "Время работы",
    "charge_time_h": "Зарядка",
    "throughput": "Производительность",
    "navigation_type": "Навигация",
    "dimensions_mm": "Габариты",
    "robot_mass_kg": "Масса",
    "positioning_accuracy_mm": "Точность позиционирования",
    "lift_height_mm": "Высота подъема",
}
SPEC_UNITS = {"max_speed_m_s": "м/с", "runtime_h": "ч", "charge_time_h": "ч", "robot_mass_kg": "кг", "payload_kg": "кг"}

# Статус из списка решений: можно ли купить. Прототип и снятая с продажи версия не подходят,
# пилот и решение без продавца в России требуют проверки
AVAILABILITY = {
    "эксплуатация": ("fits", "в эксплуатации по каталогу организатора"),
    "продается в России": ("fits", "продается в России"),
    "пилот": ("unknown", "статус пилот: серийных поставок пока нет"),
    "пилот в больницах": ("unknown", "пилот в больницах, в продажу не поступает"),
    "продавца в России не нашли": ("unknown", "продавца в России не нашли"),
    "нет данных о продаже": ("unknown", "не нашли, продается ли"),
    "прототип": ("blocks", "прототип, купить нельзя"),
    "справочно": ("blocks", "эта версия в России не продается"),
    "снят с производства": ("blocks", "производитель снял модель с производства"),
}
STATUS_ORDER = {"recommended": 0, "needs_check": 1, "excluded": 2}
# Кому верим, если источники расходятся: как в правилах данных, сначала организатор
SOURCE_ORDER = ["организатор", "производитель", "интегратор", "эксплуатант", "СМИ"]
NOT_FOUND = "не найдено"
NUMERIC = re.compile(r"(до |от |≈)?[\d\s.,×–-]+")


def _read(name: str) -> list[dict[str, str]]:
    with (settings.data_dir / name).open(encoding="utf-8-sig") as file:
        return list(csv.DictReader(file, delimiter=";"))


@lru_cache(maxsize=4)
def fields(facility_id: str) -> list[dict[str, str]]:
    """Лист датасета организатора: параметр, значение, min, max, источник и наша сверка."""
    if facility_id not in SHEETS:
        raise NotFound(f"Нет объекта {facility_id}")
    return _read(f"facilities/{facility_id}.csv")


@lru_cache(maxsize=1)
def _tasks() -> list[dict[str, str]]:
    return _read("facilities/tasks.csv")


@lru_cache(maxsize=1)
def _solutions() -> list[dict[str, str]]:
    return _read("facilities/solutions.csv")


@lru_cache(maxsize=1)
def _specs() -> dict[tuple[str, str], dict[str, str]]:
    return {(row["catalog_id"], row["field"]): row for row in _read("specs/specs.csv")}


@lru_cache(maxsize=1)
def _sources() -> dict[tuple[str, str], list[dict[str, str]]]:
    found: dict[tuple[str, str], list[dict[str, str]]] = {}
    for row in _read("specs/sources.csv"):
        found.setdefault((row["catalog_id"], row["field"]), []).append(row)
    return found


def has_solutions(facility_id: str) -> bool:
    return facility_id in SHEETS


def solutions_count(facility_id: str) -> int:
    return sum(1 for row in _solutions() if row["facility"] == facility_id)


def operations(facility_id: str) -> list[Operation]:
    """Задачи объекта для первого шага. Объем и штат берем из датасета, по ключу параметра."""
    by_key = {row["key"]: row for row in fields(facility_id)}
    out = []
    for task in (row for row in _tasks() if row["facility"] == facility_id):
        volume = by_key[task["volume_key"]]
        found = sum(
            1 for row in _solutions() if row["facility"] == facility_id and row["operation"] == task["operation"]
        )
        staff = [by_key[key] for key in task["staff_keys"].split(",") if key]
        out.append(
            Operation(
                id=task["operation"],
                name=BY_KEY[(facility_id, task["operation"])].label,
                description=task["description"],
                volume_per_day=float(volume["value"]),
                volume_label=volume["name"],
                unit=volume["unit"],
                volume_source=volume["source"],
                volume_trust=volume["rating"],
                performed_by=[_staff_name(row) for row in staff],
                takeover="",
                solutions_count=found,
                available=found > 0,
                unavailable_reason=None if found else "Решений под эту задачу мы не нашли",
            )
        )
    return out


def _staff_name(row: dict[str, str]) -> str:
    # название как в датасете, чтобы его можно было найти в листе: "Численность санитаров ...: 65 чел."
    return f"{row['name']}: {_number(float(row['value']))} {row['unit']}"


def parameters(facility_id: str, operation_ids: list[str]) -> list[Parameter]:
    """Числовые поля листа датасета. Наверху объемы выбранных задач, площадь и то, что читают проверки."""
    tasks = {row["operation"]: row for row in _tasks() if row["facility"] == facility_id}
    for operation_id in operation_ids:
        if operation_id not in tasks:
            raise NotFound(f"У объекта нет задачи {operation_id}")
    main = set(MAIN[facility_id])
    for operation_id in operation_ids:
        main.add(tasks[operation_id]["volume_key"])
        main.update(RULE_FIELDS.get((facility_id, operation_id), []))
    return [
        Parameter(
            path=f"{facility_id}.{row['key']}",
            group=row["section"],
            group_name=row["section"],
            key=row["key"] in main,
            label=row["name"],
            unit=row["unit"],
            value=float(row["value"]),
            min=float(row["min"]),
            max=float(row["max"]),
            hint=row["note"],
            source=row["source"],
            trust=row["rating"],
            range_source=RANGE_SOURCE,
        )
        for row in fields(facility_id)
        if _is_number(row["value"]) and row["min"] and row["max"]
    ]


def conditions(facility_id: str) -> list[FacilityCondition]:
    """Условия объекта словами: СКУД, сертификация, режим работы. Их не ввести числом, показываем как есть."""
    return [
        FacilityCondition(label=row["name"], value=row["value"], source=row["source"], trust=row["rating"])
        for row in fields(facility_id)
        if not _is_number(row["value"])
    ]


def solutions(facility_id: str, operation_ids: list[str], overrides: dict[str, float]) -> FacilitySolutions:
    """Решения под выбранные задачи: почему подходит, что мешает, чего не знаем, характеристики с источником."""
    values = {row["key"]: float(row["value"]) for row in fields(facility_id) if _is_number(row["value"])}
    prefix = f"{facility_id}."
    values |= {path[len(prefix) :]: value for path, value in overrides.items() if path.startswith(prefix)}
    picked = [
        _solution(row, facility_id, values)
        for row in _solutions()
        if row["facility"] == facility_id and row["operation"] in operation_ids
    ]
    order = {operation_id: index for index, operation_id in enumerate(operation_ids)}
    picked.sort(key=lambda item: (order[item.operation], STATUS_ORDER[item.status], len(item.missing)))
    return FacilitySolutions(solutions=picked, conditions=conditions(facility_id))


def _solution(row: dict[str, str], facility_id: str, values: dict[str, float]) -> FacilitySolution:
    solution_id = row["catalog_id"]
    operation = BY_KEY[(facility_id, row["operation"])]
    checks = [_availability(row)] + _rules(solution_id, facility_id, row["operation"], values)
    specs = [_spec(solution_id, field) for field in SPEC_LABELS if (solution_id, field) in _specs()]
    missing = [
        SPEC_LABELS[field] for field in operation.needs if field in SPEC_LABELS and _rating(solution_id, field) == "F"
    ]
    price, price_source = _price(solution_id)
    outcomes = {check.outcome for check in checks}
    status = (
        "excluded" if "blocks" in outcomes else "needs_check" if "unknown" in outcomes or missing else "recommended"
    )
    return FacilitySolution(
        id=solution_id,
        product=row["product"],
        vendor=_best(solution_id, "manufacturer") or "",
        from_catalog=not solution_id.startswith("ext-"),
        source=row["source"],
        operation=row["operation"],
        operation_name=operation.label,
        process=row["process"],
        why=row["why"],
        limits=row["limits"],
        availability=row["status"],
        status=status,
        checks=checks,
        specs=specs,
        missing=missing,
        price_rub=price,
        price_source=price_source,
        photo_url=photo_url(solution_id),
    )


def _availability(row: dict[str, str]) -> Check:
    outcome, detail = AVAILABILITY.get(row["status"], ("unknown", row["status"]))
    if row["status"] == "справочно":
        detail = f"{detail}: {row['limits']}"
    return Check(label="Можно ли купить", outcome=outcome, detail=detail)


def _rules(solution_id: str, facility_id: str, operation_id: str, values: dict[str, float]) -> list[Check]:
    """Проверки по параметрам объекта. Каждая сравнивает одно число датасета с одной характеристикой."""
    wanted = RULE_FIELDS.get((facility_id, operation_id), [])
    checks = []
    if "apron_winter_temp_c" in wanted:
        checks.append(_cold(solution_id, values["apron_winter_temp_c"]))
    if "corridor_width_m" in wanted:
        checks.append(_corridor(solution_id, values["corridor_width_m"]))
    if "floors" in wanted:
        checks.append(_elevator(solution_id, values["floors"]))
    if "meal_cart_mass_kg" in wanted:
        checks.append(_cart(solution_id, max(values["meal_cart_mass_kg"], values["linen_container_mass_kg"])))
    if operation_id == "cleaning":
        area_key = "robot_cleaning_area_m2" if facility_id == "airport" else "floor_area_m2"
        checks.append(_cleaning(solution_id, values[area_key], area_key))
    return checks


def _cold(solution_id: str, winter_c: float) -> Check:
    label = "Мороз на перроне"
    lowest = _lowest_temperature(solution_id)
    if lowest is None:
        return Check(
            label=label,
            outcome="unknown",
            detail=f"на перроне зимой до {_number(winter_c)} °C, диапазон температур не опубликован",
        )
    temperature, source = lowest
    if temperature <= winter_c:
        return Check(
            label=label,
            outcome="fits",
            detail=f"работает от {_number(temperature)} °C ({source}), на перроне зимой до {_number(winter_c)} °C",
        )
    return Check(
        label=label,
        outcome="blocks",
        detail=f"работает от {_number(temperature)} °C ({source}), а на перроне зимой до {_number(winter_c)} °C",
    )


def _lowest_temperature(solution_id: str) -> tuple[float, str] | None:
    """Нижняя граница из "условий работы": "от -40 до +50 °C". Берем источник, которому верим больше."""
    for row in _ranked(solution_id, "operating_conditions"):
        found = re.search(r"от\s*([-−–]?\d+)", row["value"])
        if found:
            return float(found.group(1).replace("−", "-").replace("–", "-")), row["source_type"]
    return None


def _corridor(solution_id: str, corridor_m: float) -> Check:
    label = "Ширина коридора"
    need = _first_number(_value(solution_id, "min_aisle_width_mm"))
    if need is None:
        return Check(label=label, outcome="unknown", detail="какой проход нужен роботу, производитель не публикует")
    corridor_mm = corridor_m * 1000
    detail = f"коридор {_number(corridor_m)} м, роботу нужно {_number(need / 1000)} м"
    return Check(label=label, outcome="fits" if need <= corridor_mm else "blocks", detail=detail)


def _elevator(solution_id: str, floors: float) -> Check:
    label = "Этажи и лифт"
    if floors <= 1:
        return Check(label=label, outcome="fits", detail="здание в один этаж, лифт не нужен")
    rows = _ranked(solution_id, "elevator_door_integration")
    if rows:
        return Check(
            label=label, outcome="fits", detail=f"этажей {_number(floors)}, робот ездит на лифте: {rows[0]['value']}"
        )
    return Check(
        label=label,
        outcome="unknown",
        detail=f"этажей {_number(floors)}, а про поездки на лифте производитель не пишет",
    )


def _cart(solution_id: str, heaviest_kg: float) -> Check:
    label = "Масса тележки"
    payload = _first_number(_value(solution_id, "payload_kg"))
    if payload is None:
        return Check(label=label, outcome="unknown", detail="грузоподъемность не опубликована")
    detail = f"везет до {_number(payload)} кг, самая тяжелая тележка по датасету {_number(heaviest_kg)} кг"
    return Check(label=label, outcome="fits" if payload >= heaviest_kg else "blocks", detail=detail)


def _cleaning(solution_id: str, area_m2: float, area_key: str) -> Check:
    """Сколько часов работы одного робота уходит на всю площадь. Это деление, а не расчет парка:
    сколько часов в сутки робот моет, мы не знаем, поэтому число роботов не называем."""
    label = "Площадь уборки"
    speed = _numbers(_value(solution_id, "throughput"))
    where = "убирают роботы по датасету" if area_key == "robot_cleaning_area_m2" else "общая площадь здания"
    if not speed:
        return Check(label=label, outcome="unknown", detail="производительность не опубликована")
    low, high = min(speed), max(speed)
    hours = f"{_number(area_m2 / high)}-{_number(area_m2 / low)}" if low != high else _number(area_m2 / low)
    detail = (
        f"{_number(area_m2)} м2 ({where}) при {_value(solution_id, 'throughput')} это {hours} ч работы одного робота"
    )
    return Check(label=label, outcome="fits", detail=detail)


def _spec(solution_id: str, field: str) -> SourcedSpec:
    row = _specs()[(solution_id, field)]
    rows = [item for item in _sources().get((solution_id, field), []) if item["current"] != "устарело"]
    dates = sorted(item["retrieved"] for item in rows if item["retrieved"])
    # единицу ставим только к числу: "до недели на одной зарядке ч" читается как ошибка
    unit = (row["unit"] or SPEC_UNITS.get(field, "")) if NUMERIC.fullmatch(row["value"]) else ""
    return SourcedSpec(
        field=field,
        label=SPEC_LABELS[field],
        value=f"{row['value']} {unit}".strip() if row["value"] else "",
        trust=row["rating"],
        trust_name=row["rating_name"],
        sources=row["source_types"] or "нет источника",
        date=dates[-1] if dates else "",
        note=row["reason"],
    )


def _price(solution_id: str) -> tuple[float | None, str]:
    for row in _ranked(solution_id, "price_rub"):
        value = _first_number(row["value"])
        if value:
            return value, f"{row['source_type']}, {_day(row['retrieved'])}"
    return None, "цену не нашли ни в каталоге, ни у продавцов"


def _ranked(solution_id: str, field: str) -> list[dict[str, str]]:
    """Значения поля без устаревших и без "не найдено", сначала те источники, которым верим больше."""
    rows = [
        row
        for row in _sources().get((solution_id, field), [])
        if row["current"] not in ("устарело", "аналог") and row["value"] and row["value"] != NOT_FOUND
    ]
    rank = {name: index for index, name in enumerate(SOURCE_ORDER)}
    return sorted(rows, key=lambda row: rank.get(row["source_type"], len(rank)))


def _best(solution_id: str, field: str) -> str | None:
    rows = _ranked(solution_id, field)
    return rows[0]["value"] if rows else None


def _value(solution_id: str, field: str) -> str:
    row = _specs().get((solution_id, field))
    return row["value"] if row else ""


def _rating(solution_id: str, field: str) -> str:
    row = _specs().get((solution_id, field))
    return row["rating"] if row else "F"


def _numbers(text: str) -> list[float]:
    return [float(item.replace(" ", "").replace(",", ".")) for item in re.findall(r"\d[\d ]*(?:[.,]\d+)?", text)]


def _first_number(text: str) -> float | None:
    found = _numbers(text)
    return found[0] if found else None


def _day(iso: str) -> str:
    """2026-09-15 -> 15.09.2026"""
    return ".".join(reversed(iso.split("-")))


def _is_number(text: str) -> bool:
    try:
        float(text)
    except ValueError:
        return False
    return True


def _number(value: float) -> str:
    """Число по-русски: 51 000, 2,4, -25."""
    rounded = round(value, 1)
    if rounded == int(rounded):
        return f"{int(rounded):,}".replace(",", " ")
    return f"{rounded:,.1f}".replace(",", " ").replace(".", ",")
