"""Где работает решение и что делает: объекты, операции и правило, которое раскладывает каталог организатора.

Решение попадает в подбор объекта, только если у него есть подтвержденная операция этого объекта.
Привязки приходят тремя путями:
- data/catalog/uses.csv: решения, которые мы разобрали руками, сразу подтверждены;
- правило по сценарию организатора: предложение, администратор подтверждает или отклоняет;
- администратор добавляет сам в карточке решения.
Отклоненное предложение остается в базе, поэтому повторная загрузка выгрузки его не вернет."""

import csv
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.settings import settings
from app.storage.models import CatalogChange, Solution, SolutionUse, User


@dataclass(frozen=True)
class Operation:
    facility: str
    id: str
    label: str
    needs: tuple[str, ...]  # характеристики, без которых решение для этой операции не проверить


FACILITIES = {"warehouse": "Склад", "airport": "Аэропорт", "clinic": "Медучреждение"}

MOVE = ("payload_kg", "max_speed_m_s", "runtime_h", "charge_time_h", "navigation_type")
OPERATIONS = [
    Operation("warehouse", "pallet_transport", "Перевозка паллет", MOVE + ("min_aisle_width_mm", "throughput")),
    Operation("warehouse", "stacking", "Работа на ярусах", MOVE + ("min_aisle_width_mm", "lift_height_mm")),
    Operation("warehouse", "piece_picking", "Отбор товара", MOVE + ("min_aisle_width_mm", "throughput")),
    Operation("warehouse", "sorting", "Сортировка", ("payload_kg", "throughput", "runtime_h", "charge_time_h")),
    Operation("warehouse", "storage", "Автоматическое хранение", ("payload_kg", "throughput", "lift_height_mm")),
    Operation(
        "warehouse",
        "inventory",
        "Инвентаризация",
        ("max_speed_m_s", "runtime_h", "charge_time_h", "navigation_type", "min_aisle_width_mm", "throughput"),
    ),
    Operation(
        "warehouse",
        "cleaning",
        "Уборка",
        ("throughput", "runtime_h", "charge_time_h", "min_aisle_width_mm", "navigation_type"),
    ),
    Operation("airport", "baggage_transport", "Перевозка багажа и грузов на перроне", MOVE),
    Operation(
        "airport",
        "cleaning",
        "Уборка терминала",
        ("throughput", "runtime_h", "charge_time_h", "min_aisle_width_mm", "navigation_type"),
    ),
    Operation(
        "airport",
        "patrol",
        "Охрана и патрулирование",
        ("max_speed_m_s", "runtime_h", "charge_time_h", "navigation_type"),
    ),
    Operation("airport", "passenger_help", "Помощь пассажирам", ("runtime_h", "charge_time_h", "navigation_type")),
    Operation("clinic", "floor_delivery", "Доставка по этажам", MOVE + ("min_aisle_width_mm",)),
    Operation("clinic", "campus_delivery", "Доставка между корпусами", MOVE),
    Operation("clinic", "cart_transport", "Перевозка тележек", MOVE + ("min_aisle_width_mm",)),
    Operation(
        "clinic", "disinfection", "Обеззараживание", ("throughput", "runtime_h", "charge_time_h", "navigation_type")
    ),
    Operation(
        "clinic",
        "cleaning",
        "Уборка помещений",
        ("throughput", "runtime_h", "charge_time_h", "min_aisle_width_mm", "navigation_type"),
    ),
]
BY_KEY = {(op.facility, op.id): op for op in OPERATIONS}

# Правило: сценарий организатора -> какие операции предложить. Сценарии, которых здесь нет
# (дроны, агро, ТЭК, подводные работы), к нашим объектам не относятся, решение остается «не привязано»
CLEANING = [("warehouse", "cleaning"), ("airport", "cleaning"), ("clinic", "cleaning")]
RULES: dict[str, list[tuple[str, str]]] = {
    "Внутрискладская логистика": [("warehouse", "pallet_transport")],
    "Внутрипроизводственная логистика": [("warehouse", "pallet_transport")],
    "Перемещение грузов": [("warehouse", "pallet_transport")],
    "Перевозка грузов на закрытых площадках": [("warehouse", "pallet_transport")],
    "Сортировка грузов": [("warehouse", "sorting")],
    "Сортировка грузов на производстве": [("warehouse", "sorting")],
    "Сборка товаров": [("warehouse", "piece_picking")],
    "Инвентаризация склада": [("warehouse", "inventory")],
    "Уборка помещений": CLEANING,
    "Патрулирование территории": [("airport", "patrol")],
    "Мониторинг и патрулирование": [("airport", "patrol")],
    "Администрирование торгового зала": [("airport", "passenger_help")],
    "Доставка биоматериалов": [("clinic", "campus_delivery")],
}
# Подтип, по которому к перевозке паллет добавляем работу на ярусах
LIFTING = ("штабел", "fmr", "погрузчик")


class NotFound(Exception):
    pass


def suggestions(solution: Solution) -> list[tuple[str, str, str]]:
    """Что правило предлагает по сценарию и подтипу: (объект, операция, почему)."""
    found: dict[tuple[str, str], str] = {}
    scenarios = [part.strip() for chunk in solution.scenario.split(";") for part in chunk.split(",")]
    for scenario in scenarios:
        # у организатора встречается опечатка «Доставка биоматериаловм»
        key = next((rule for rule in RULES if scenario.startswith(rule)), None)
        if key is None:
            continue
        for use in RULES[key]:
            found.setdefault(use, f"сценарий организатора «{scenario}»")
        if ("warehouse", "pallet_transport") in RULES[key] and any(w in solution.subtype.lower() for w in LIFTING):
            found.setdefault(("warehouse", "stacking"), f"подтип «{solution.subtype}»")
    return [(facility, operation, why) for (facility, operation), why in found.items()]


def suggest(session: Session, solutions: list[Solution]) -> int:
    """Добавляет предложения правила решениям, у которых еще нет ни одной подтвержденной привязки.
    Где человек уже разобрался, правило молчит: сценарий организатора грубее, например сортировщику
    с «Внутрискладской логистикой» оно предложило бы перевозку паллет. Отклоненное не предлагаем снова."""
    added = 0
    for solution in solutions:
        if any(use.status == "confirmed" for use in solution.uses):
            continue
        have = {(use.facility, use.operation) for use in solution.uses}
        for facility, operation, why in suggestions(solution):
            if (facility, operation) in have:
                continue
            solution.uses.append(
                SolutionUse(facility=facility, operation=operation, status="suggested", source="rule", note=why)
            )
            added += 1
    return added


def bind(session: Session, solutions: list[Solution]) -> tuple[int, int]:
    """Сначала наши привязки из data/catalog/uses.csv, потом предложения правила. Зовем при запуске
    и после каждой загрузки выгрузки: решения для аэропорта и медучреждения появляются в базе только
    вместе с выгрузкой. Предложение правила, которое мы уже разобрали, становится подтвержденным;
    подтвержденное и отклоненное администратором не трогаем. Возвращает (подтверждено, предложено)."""
    path = settings.data_dir / "catalog" / "uses.csv"
    rows = []
    if path.exists():
        with path.open(encoding="utf-8-sig", newline="") as file:
            rows = list(csv.DictReader(file, delimiter=";"))
    by_id = {s.id: s for s in solutions}
    confirmed = 0
    for row in rows:
        solution = by_id.get(row["solution_id"])
        if solution is None or (row["facility"], row["operation"]) not in BY_KEY:
            continue
        use = next((u for u in solution.uses if (u.facility, u.operation) == (row["facility"], row["operation"])), None)
        if use is None:
            use = SolutionUse(facility=row["facility"], operation=row["operation"])
            solution.uses.append(use)
        elif use.status != "suggested":
            continue
        use.status, use.source, use.note = "confirmed", "team", row.get("note", "")
        confirmed += 1
    return confirmed, suggest(session, solutions)


def seed_uses(session: Session) -> int:
    """Запуск: привязки и предложения для всего каталога. Повторный запуск ничего не меняет."""
    confirmed, suggested = bind(session, list(session.scalars(select(Solution))))
    if confirmed or suggested:
        session.add(
            CatalogChange(
                action="uses_seed",
                changes={"confirmed": confirmed, "suggested": suggested},
                note=f"Объекты и операции: из data/ {confirmed}, предложено правилом {suggested}",
            )
        )
        session.commit()
    return confirmed + suggested


def set_use(
    session: Session, user: User, solution: Solution, facility: str, operation: str, status: str, note: str = ""
) -> None:
    """Подтвердить, отклонить или добавить привязку. Правка пишется в журнал."""
    if (facility, operation) not in BY_KEY:
        raise NotFound(f"операция {facility}/{operation}")
    use = next((u for u in solution.uses if u.facility == facility and u.operation == operation), None)
    old = use.status if use else None
    if use is None:
        use = SolutionUse(facility=facility, operation=operation, source="admin", note=note)
        solution.uses.append(use)
    elif note:
        use.note = note
    use.status = status
    if old != status:
        session.add(
            CatalogChange(
                user_id=user.id,
                user_email=user.email,
                action="use_set",
                solution_id=solution.id,
                solution_name=solution.name,
                changes={f"{facility}/{operation}": [old, status]},
            )
        )


def active(solution: Solution) -> list[SolutionUse]:
    """Привязки, которые учитываем: подтвержденные и еще не разобранные."""
    return [u for u in solution.uses if u.status != "rejected"]


def needs(solution: Solution) -> list[str]:
    """Какие характеристики нужны решению для его операций, без повторов и в порядке операций."""
    fields: dict[str, None] = {}
    for use in active(solution):
        for field in BY_KEY[(use.facility, use.operation)].needs:
            fields.setdefault(field)
    return list(fields)


def missing(solution: Solution) -> list[str]:
    filled = {spec.field for spec in solution.specs if spec.value.strip()}
    return [field for field in needs(solution) if field not in filled]
