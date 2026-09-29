"""Выгрузка каталога в формате организатора с нашими колонками и загрузка такого файла обратно.

Первые колонки те же, что в catalog_export организатора, в том же порядке. Справа наши: процесс склада,
отметки ФЦ БАС и реестра 719, по каждой характеристике значение, оценка и источник, и подтвержденные
объекты с задачами. Такой файл открывается в Excel, его можно дополнить и загрузить обратно той же
кнопкой, что и выгрузку организатора: пустая ячейка ничего не меняет, заполненная пишется в карточку
и в журнал правок.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.services import catalog_admin, catalog_uses
from app.services.catalog_import import ORGANIZER_COLUMNS
from app.storage.models import CatalogChange, Solution, SolutionSpec, SolutionUse, User

RATINGS = set("SABCDEF")
PROCESS, TESTED, REGISTRY, USES = "Процесс склада", "Протестировано ФЦ БАС", "Реестр 719", "Объекты и задачи"
YES = {"да", "1", "true", "yes"}


def _value_header(field: catalog_admin.schemas.FieldInfo) -> str:
    return f"{field.label}, {field.unit}" if field.unit else field.label


# Наши колонки характеристик: заголовок -> (поле, что в колонке)
SPEC_COLUMNS: dict[str, tuple[str, str]] = {}
for _field in catalog_admin.FIELDS:
    SPEC_COLUMNS[_value_header(_field)] = (_field.id, "value")
    SPEC_COLUMNS[f"{_field.label}: оценка"] = (_field.id, "rating")
    SPEC_COLUMNS[f"{_field.label}: источник"] = (_field.id, "source")
OUR_COLUMNS = [PROCESS, TESTED, REGISTRY, *SPEC_COLUMNS, USES]


# Ячейка, которая начинается с = + - @ или таба, в Excel откроется формулой: =HYPERLINK или вызов
# программы сработали бы у того, кто открыл файл. Такой текст пишем с апострофом в начале, Excel
# показывает его как текст. Числа вроде -20 не трогаем, при загрузке апостроф снимаем
DANGER = ("=", "+", "-", "@", "\t", "\r")
NUMBER = re.compile(r"[-+]?\d[\d ]*(?:[.,]\d+)?")


def cell(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(DANGER) and not NUMBER.fullmatch(value):
        return "'" + value
    return value


def uncell(value: str | None) -> str | None:
    if value and value.startswith("'") and value[1:].startswith(DANGER):
        return value[1:]
    return value


def has_our_columns(fieldnames: list[str] | None) -> bool:
    return any(name in OUR_COLUMNS for name in fieldnames or [])


def export(session: Session) -> bytes:
    solutions = session.scalars(
        select(Solution).options(selectinload(Solution.specs), selectinload(Solution.uses))
    ).all()
    # Комплектации одного номера подряд, основная первой: при загрузке в пустую базу номер
    # организатора достается первой строке, и решения получают те же номера, что были
    solutions = sorted(
        solutions, key=lambda s: (s.name.casefold(), s.organizer_id or s.id, s.id != (s.organizer_id or s.id))
    )
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\n")
    writer.writerow([*ORGANIZER_COLUMNS, *OUR_COLUMNS])
    for solution in solutions:
        specs = {spec.field: spec for spec in solution.specs}
        row: list[Any] = []
        for attr in ORGANIZER_COLUMNS.values():
            if attr == "id":
                # номер организатора: у комплектаций с другой ценой свой номер выводится из него при загрузке
                row.append(solution.organizer_id or solution.id)
            elif attr == "price_rub":
                row.append("" if solution.price_rub is None else f"{solution.price_rub:.2f}".replace(".", ","))
            else:
                value = getattr(solution, attr)
                row.append("" if value is None else value)
        row += [solution.process, "да" if solution.tested_fcbas else "", "да" if solution.registry_719 else ""]
        for field_id, part in SPEC_COLUMNS.values():
            spec = specs.get(field_id)
            row.append(getattr(spec, part) if spec else "")
        row.append("; ".join(_use_label(use) for use in solution.uses if use.status == "confirmed"))
        writer.writerow([cell(value) for value in row])
    # BOM: так Excel сам понимает, что файл в UTF-8
    return ("\ufeff" + out.getvalue()).encode("utf-8")


def _use_label(use: SolutionUse) -> str:
    operation = catalog_uses.BY_KEY.get((use.facility, use.operation))
    facility = catalog_uses.FACILITIES.get(use.facility, use.facility)
    return f"{facility}: {operation.label if operation else use.operation}"


def read_row(row: dict[str, str]) -> dict[str, Any]:
    """Наши колонки строки. Пустые ячейки пропускаем: они ничего не меняют. Ошибка значения -> ValueError."""
    ours: dict[str, Any] = {}
    if (row.get(PROCESS) or "").strip():
        ours["process"] = row[PROCESS].strip()
    for header, attr in ((TESTED, "tested_fcbas"), (REGISTRY, "registry_719")):
        if header in row and row[header] is not None:
            ours[attr] = row[header].strip().lower() in YES
    specs: dict[str, dict[str, str]] = {}
    for header, (field_id, part) in SPEC_COLUMNS.items():
        raw = (row.get(header) or "").strip()
        if not raw:
            continue
        if part == "rating" and raw.upper() not in RATINGS:
            raise ValueError(f'оценка "{raw}" в колонке "{header}" не из шкалы S, A-F')
        specs.setdefault(field_id, {})[part] = raw.upper() if part == "rating" else raw
    if specs:
        ours["specs"] = specs
    raw_uses = (row.get(USES) or "").strip()
    if raw_uses:
        ours["uses"] = [_parse_use(part.strip()) for part in raw_uses.split(";") if part.strip()]
    return ours


def _parse_use(text: str) -> tuple[str, str]:
    """Задача строкой: "Склад: Перевозка паллет" или код warehouse/pallet_transport."""
    for (facility, operation), op in catalog_uses.BY_KEY.items():
        label = f"{catalog_uses.FACILITIES[facility]}: {op.label}"
        if text.casefold() in (label.casefold(), f"{facility}/{operation}"):
            return facility, operation
    raise ValueError(f'объект и задача "{text}" не из списка, например "Склад: Перевозка паллет"')


def apply(session: Session, user: User | None, solution: Solution, ours: dict[str, Any]) -> int:
    """Пишет наши колонки в решение. Возвращает, сколько значений поменялось; правки идут в журнал."""
    changes: dict[str, list[Any]] = {}
    for attr in ("process", "tested_fcbas", "registry_719"):
        if attr in ours and getattr(solution, attr) != ours[attr]:
            changes[attr] = [getattr(solution, attr), ours[attr]]
            setattr(solution, attr, ours[attr])
    specs = {spec.field: spec for spec in solution.specs}
    for field_id, parts in ours.get("specs", {}).items():
        spec = specs.get(field_id)
        if spec is None:
            spec = SolutionSpec(field=field_id)
            solution.specs.append(spec)
        for part, value in parts.items():
            if getattr(spec, part) != value:
                changes[f"{field_id}.{part}"] = [getattr(spec, part), value]
                setattr(spec, part, value)
    for facility, operation in ours.get("uses", []):
        use = next((u for u in solution.uses if (u.facility, u.operation) == (facility, operation)), None)
        if use is None:
            use = SolutionUse(facility=facility, operation=operation, source="admin", note="из загруженного файла")
            solution.uses.append(use)
        if use.status != "confirmed":
            changes[f"{facility}/{operation}"] = [use.status, "confirmed"]
            use.status = "confirmed"
    if changes:
        session.add(
            CatalogChange(
                user_id=user.id if user else None,
                user_email=user.email if user else "",
                action="file_edit",
                solution_id=solution.id,
                solution_name=solution.name,
                changes=changes,
                note="наши колонки из загруженного файла",
            )
        )
    return len(changes)
