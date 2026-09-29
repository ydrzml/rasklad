"""Каталог для администратора: список, карточка решения, правка полей и характеристик.
Каждая правка пишется в журнал: кто, когда, какое поле, что было и что стало."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.schemas import admin_catalog as schemas
from app.services import catalog_uses
from app.services.catalog_import import ORGANIZER_FIELDS, parse_price
from app.storage.models import CatalogChange, Solution, SolutionSpec, SolutionUse, User

# Характеристики, которые мы собираем. Порядок как в карточке решения
FIELDS: list[schemas.FieldInfo] = [
    schemas.FieldInfo(id="payload_kg", label="Грузоподъемность", unit="кг"),
    schemas.FieldInfo(id="lift_height_mm", label="Высота подъема", unit="мм"),
    schemas.FieldInfo(id="min_aisle_width_mm", label="Минимальная ширина проезда", unit="мм"),
    schemas.FieldInfo(id="max_speed_m_s", label="Скорость", unit="м/с"),
    schemas.FieldInfo(id="throughput", label="Производительность", unit=""),
    schemas.FieldInfo(id="runtime_h", label="Работа от одного заряда", unit="ч"),
    schemas.FieldInfo(id="charge_time_h", label="Время зарядки", unit="ч"),
    schemas.FieldInfo(id="navigation_type", label="Навигация", unit=""),
    schemas.FieldInfo(id="positioning_accuracy_mm", label="Точность позиционирования", unit="мм"),
    schemas.FieldInfo(id="dimensions_mm", label="Габариты", unit="мм"),
    schemas.FieldInfo(id="robot_mass_kg", label="Масса робота", unit="кг"),
]
FIELD_IDS = {f.id for f in FIELDS}
CONFIRMED = {"S", "A", "B"}
SOLUTION_FIELDS = (
    "name company kind status description type subtype scenario cases trl market_potential "
    "region industry price_rub process tested_fcbas registry_719"
).split()
SPEC_FIELDS = "value unit rating source source_type quote retrieved note".split()


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


def list_solutions(session: Session, query: schemas.ListQuery) -> schemas.SolutionPage:
    """Каталог небольшой, пара сотен решений: фильтруем в памяти, так проще считать заполненность
    по операциям решения и счетчики для фильтров."""
    solutions = session.scalars(
        select(Solution).options(
            selectinload(Solution.photo), selectinload(Solution.specs), selectinload(Solution.uses)
        )
    ).all()
    facets = {key: 0 for key in (*catalog_uses.FACILITIES, "none", "to_check", "incomplete")}
    for solution in solutions:
        for facility in _facilities(solution, confirmed_only=False):
            facets[facility] += 1
        facets["none"] += not catalog_uses.active(solution)
        facets["to_check"] += any(u.status == "suggested" for u in solution.uses)
        facets["incomplete"] += bool(catalog_uses.missing(solution))

    search = query.search.strip().casefold()
    found = [
        solution
        for solution in solutions
        if (not search or search in solution.name.casefold() or search in solution.company.casefold())
        and (not query.kind or solution.kind == query.kind)
        and (not query.status or solution.status == query.status)
        and (not query.origin or solution.origin == query.origin)
        and (not query.with_specs or any(spec.value for spec in solution.specs))
        and _matches_facility(solution, query.facility)
        and (not query.to_check or any(u.status == "suggested" for u in solution.uses))
        and (not query.incomplete or bool(catalog_uses.missing(solution)))
    ]
    order = {
        "name": lambda s: (s.name.casefold(), s.id),
        "updated": lambda s: (-s.updated_at.timestamp(), s.id),
        "price": lambda s: (s.price_rub is None, -(s.price_rub or 0), s.id),
    }[query.sort]
    found.sort(key=order)
    page = found[query.offset : query.offset + query.limit]
    return schemas.SolutionPage(
        total=len(found),
        facets=facets,
        items=[
            schemas.SolutionRow(
                **_basics(solution),
                specs_filled=sum(1 for spec in solution.specs if spec.value != ""),
                specs_total=len(solution.specs),
                specs_confirmed=sum(1 for spec in solution.specs if spec.rating in CONFIRMED),
            )
            for solution in page
        ],
    )


def _facilities(solution: Solution, confirmed_only: bool = True) -> list[str]:
    uses = [u for u in catalog_uses.active(solution) if u.status == "confirmed" or not confirmed_only]
    return [facility for facility in catalog_uses.FACILITIES if any(u.facility == facility for u in uses)]


def _matches_facility(solution: Solution, facility: str) -> bool:
    if not facility:
        return True
    if facility == "none":
        return not catalog_uses.active(solution)
    return facility in _facilities(solution, confirmed_only=False)


def set_use(
    session: Session, user: User, solution_id: str, facility: str, operation: str, body: schemas.UseSet
) -> schemas.SolutionCard:
    solution = _solution(session, solution_id)
    try:
        catalog_uses.set_use(session, user, solution, facility, operation, body.status, body.note.strip())
    except catalog_uses.NotFound as error:
        raise NotFound(str(error)) from error
    _touch(solution)
    session.commit()
    return get(session, solution_id)


def get(session: Session, solution_id: str) -> schemas.SolutionCard:
    solution = _solution(session, solution_id)
    history = session.scalars(
        select(CatalogChange)
        .where(CatalogChange.solution_id == solution_id)
        .order_by(CatalogChange.at.desc(), CatalogChange.id.desc())
        .limit(50)
    ).all()
    return schemas.SolutionCard(
        **_basics(solution),
        **{name: getattr(solution, name) for name in ("description", "scenario", "cases", "market_potential")},
        organizer_values=solution.organizer_values or {},
        photo=_photo(solution),
        specs=[_spec(spec) for spec in solution.specs],
        uses=[_use(use) for use in solution.uses],
        missing=catalog_uses.missing(solution),
        history=[_change(change) for change in history],
    )


def create(session: Session, user: User, body: schemas.SolutionCreate) -> schemas.SolutionCard:
    solution = Solution(id=str(uuid.uuid4()), origin="team", **body.model_dump())
    session.add(solution)
    session.flush()
    _log(session, user, "create", solution, {k: [None, _plain(v)] for k, v in body.model_dump().items() if v})
    session.commit()
    return get(session, solution.id)


def update(session: Session, user: User, solution_id: str, body: schemas.SolutionUpdate) -> schemas.SolutionCard:
    solution = _solution(session, solution_id)
    changes = {}
    for name, value in body.model_dump(exclude_unset=True).items():
        old = getattr(solution, name)
        if old != value:
            changes[name] = [_plain(old), _plain(value)]
            setattr(solution, name, value)
    if changes:
        # Поле организатора, поправленное руками, помечаем: повторная загрузка выгрузки его не тронет
        if solution.origin == "organizer":
            manual = [name for name in changes if name in ORGANIZER_FIELDS]
            solution.manual_fields = sorted(set(solution.manual_fields or []) | set(manual))
        solution.updated_at = datetime.now(UTC)
        _log(session, user, "update", solution, changes)
        session.commit()
    return get(session, solution_id)


def reset(session: Session, user: User, solution_id: str, name: str) -> schemas.SolutionCard:
    """Вернуть поле к значению из последней загруженной выгрузки и снять пометку «вручную»."""
    solution = _solution(session, solution_id)
    if name not in (solution.manual_fields or []):
        raise NotFound(f"ручная правка поля {name}")
    if name not in (solution.organizer_values or {}):
        raise Conflict("у организатора этого значения нет: загрузите выгрузку, потом возвращайте")
    raw = solution.organizer_values[name]
    value: Any = parse_price(str(raw)) if name == "price_rub" and raw is not None else raw
    old = getattr(solution, name)
    setattr(solution, name, value)
    solution.manual_fields = [field for field in solution.manual_fields if field != name]
    _touch(solution)
    _log(session, user, "reset", solution, {name: [_plain(old), _plain(value)]})
    session.commit()
    return get(session, solution_id)


def delete(session: Session, user: User, solution_id: str) -> None:
    """Удаляем вместе с характеристиками. В журнале остается, что это было за решение."""
    solution = _solution(session, solution_id)
    snapshot = {name: [_plain(getattr(solution, name)), None] for name in SOLUTION_FIELDS if getattr(solution, name)}
    _log(session, user, "delete", solution, snapshot, note=f"характеристик было {len(solution.specs)}")
    session.delete(solution)
    session.commit()


def add_spec(session: Session, user: User, solution_id: str, body: schemas.SpecCreate) -> schemas.SolutionCard:
    solution = _solution(session, solution_id)
    if any(spec.field == body.field for spec in solution.specs):
        raise Conflict(body.field)
    spec = SolutionSpec(solution_id=solution_id, **body.model_dump())
    session.add(spec)
    _touch(solution)
    _log(session, user, "spec_add", solution, {f"{body.field}.{k}": [None, _plain(v)] for k, v in _spec_values(spec)})
    session.commit()
    return get(session, solution_id)


def update_spec(
    session: Session, user: User, solution_id: str, spec_id: int, body: schemas.SpecUpdate
) -> schemas.SolutionCard:
    solution = _solution(session, solution_id)
    spec = _own_spec(solution, spec_id)
    changes = {}
    for name, value in body.model_dump(exclude_unset=True).items():
        old = getattr(spec, name)
        if old != value:
            changes[f"{spec.field}.{name}"] = [_plain(old), _plain(value)]
            setattr(spec, name, value)
    if changes:
        _touch(solution)
        _log(session, user, "spec_edit", solution, changes)
        session.commit()
    return get(session, solution_id)


def delete_spec(session: Session, user: User, solution_id: str, spec_id: int) -> schemas.SolutionCard:
    solution = _solution(session, solution_id)
    spec = _own_spec(solution, spec_id)
    _log(
        session, user, "spec_delete", solution, {f"{spec.field}.{k}": [_plain(v), None] for k, v in _spec_values(spec)}
    )
    solution.specs.remove(spec)
    _touch(solution)
    session.commit()
    return get(session, solution_id)


def changes(session: Session, limit: int = 100) -> list[schemas.Change]:
    rows = session.scalars(
        select(CatalogChange).order_by(CatalogChange.at.desc(), CatalogChange.id.desc()).limit(limit)
    )
    return [_change(change) for change in rows]


def _solution(session: Session, solution_id: str) -> Solution:
    solution = session.get(Solution, solution_id)
    if solution is None:
        raise NotFound(f"решение {solution_id}")
    return solution


def _own_spec(solution: Solution, spec_id: int) -> SolutionSpec:
    spec = next((s for s in solution.specs if s.id == spec_id), None)
    if spec is None:
        raise NotFound(f"характеристика {spec_id}")
    return spec


def _touch(solution: Solution) -> None:
    solution.updated_at = datetime.now(UTC)


def _log(
    session: Session, user: User, action: str, solution: Solution, changes: dict[str, Any], note: str = ""
) -> None:
    session.add(
        CatalogChange(
            user_id=user.id,
            user_email=user.email,
            action=action,
            solution_id=solution.id,
            solution_name=solution.name,
            changes=changes,
            note=note,
        )
    )


def _plain(value: Any) -> Any:
    """Значение для журнала: JSON не умеет Decimal и даты, пишем их строкой."""
    if isinstance(value, Decimal):
        return str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def _spec_values(spec: SolutionSpec) -> list[tuple[str, Any]]:
    return [(name, getattr(spec, name)) for name in SPEC_FIELDS if getattr(spec, name)]


def photo_url(solution: Solution) -> str | None:
    """Адрес фото с отметкой времени загрузки: после замены браузер не покажет старое из кеша."""
    if solution.photo is None:
        return None
    return f"/api/catalog/photos/{solution.id}?v={int(solution.photo.uploaded_at.timestamp())}"


def _photo(solution: Solution) -> schemas.PhotoInfo | None:
    photo = solution.photo
    if photo is None:
        return None
    return schemas.PhotoInfo(
        url=photo_url(solution) or "",
        content_type=photo.content_type,
        size_bytes=photo.size_bytes,
        source_url=photo.source_url,
        owner=photo.owner,
        license=photo.license,
        uploaded_by=photo.uploaded_by,
        uploaded_at=photo.uploaded_at,
    )


def _basics(solution: Solution) -> dict[str, Any]:
    names = (
        "id organizer_id name company kind status type subtype trl region industry price_rub process "
        "tested_fcbas registry_719 origin manual_fields updated_at"
    ).split()
    needs = catalog_uses.needs(solution)
    return {
        "photo_url": photo_url(solution),
        "facilities": _facilities(solution),
        "tasks": [
            f"{catalog_uses.FACILITIES[u.facility]}: {catalog_uses.BY_KEY[(u.facility, u.operation)].label}"
            for u in solution.uses
            if u.status == "confirmed" and (u.facility, u.operation) in catalog_uses.BY_KEY
        ],
        "to_check": sum(1 for use in solution.uses if use.status == "suggested"),
        "needs_total": len(needs),
        "needs_filled": len(needs) - len(catalog_uses.missing(solution)),
        **{name: getattr(solution, name) for name in names},
    }


def _use(use: SolutionUse) -> schemas.UseInfo:
    operation = catalog_uses.BY_KEY.get((use.facility, use.operation))
    return schemas.UseInfo(
        facility=use.facility,
        facility_label=catalog_uses.FACILITIES.get(use.facility, use.facility),
        operation=use.operation,
        label=operation.label if operation else use.operation,
        status=use.status,
        source=use.source,
        note=use.note,
    )


def operations() -> list[schemas.OperationInfo]:
    return [
        schemas.OperationInfo(
            facility=op.facility,
            facility_label=catalog_uses.FACILITIES[op.facility],
            id=op.id,
            label=op.label,
            needs=list(op.needs),
        )
        for op in catalog_uses.OPERATIONS
    ]


def _spec(spec: SolutionSpec) -> schemas.CatalogSpec:
    known = next((f for f in FIELDS if f.id == spec.field), None)
    return schemas.CatalogSpec(
        id=spec.id,
        field=spec.field,
        label=known.label if known else spec.field,
        confirmed=spec.rating in CONFIRMED,
        **{name: getattr(spec, name) for name in SPEC_FIELDS},
    )


def _change(change: CatalogChange) -> schemas.Change:
    return schemas.Change(
        id=change.id,
        at=change.at,
        user_email=change.user_email,
        action=change.action,
        solution_id=change.solution_id,
        solution_name=change.solution_name,
        changes=change.changes,
        note=change.note,
    )


NO_INDUSTRY, NO_FACILITY, NO_TASK, NO_TYPE = (
    "Отрасль не указана",
    "Объект не выбран",
    "Задача не выбрана",
    "Тип не указан",
)


def tree(session: Session) -> list[schemas.TreeNode]:
    """Каталог деревом, как в ТЗ: отрасль -> тип объекта -> задача -> тип решения -> решение.
    Отрасль берем из выгрузки организатора (их бывает несколько через ";"), объект и задачу из привязок:
    подтвержденных и предложенных, отклоненные не показываем. Решение без привязки стоит в ветке
    "Объект не выбран". Одно решение может встретиться в нескольких ветках, как в самом каталоге."""
    solutions = session.scalars(select(Solution).options(selectinload(Solution.uses))).all()
    root: dict = {}
    for solution in solutions:
        industries = [part.strip() for part in solution.industry.split(";") if part.strip()] or [NO_INDUSTRY]
        places = [
            (
                catalog_uses.FACILITIES.get(use.facility, use.facility),
                catalog_uses.BY_KEY[(use.facility, use.operation)].label
                if (use.facility, use.operation) in catalog_uses.BY_KEY
                else use.operation,
            )
            for use in catalog_uses.active(solution)
        ] or [(NO_FACILITY, NO_TASK)]
        for industry in industries:
            for facility, task in places:
                branch = root.setdefault(industry, {}).setdefault(facility, {}).setdefault(task, {})
                branch.setdefault(solution.type or NO_TYPE, {})[solution.id] = solution.name
    return _nodes(root)


def _nodes(level: dict) -> list[schemas.TreeNode]:
    last = {NO_INDUSTRY, NO_FACILITY, NO_TASK, NO_TYPE}
    nodes = []
    for name in sorted(level, key=lambda n: (n in last, (level[n] if isinstance(level[n], str) else n).casefold())):
        value = level[name]
        if isinstance(value, str):  # лист: номер решения -> название
            nodes.append(schemas.TreeNode(name=value, count=1, solution_id=name))
            continue
        children = _nodes(value)
        ids = set(_ids(children))
        nodes.append(schemas.TreeNode(name=name, count=len(ids), children=children))
    return nodes


def _ids(nodes: list[schemas.TreeNode]):
    for node in nodes:
        if node.solution_id:
            yield node.solution_id
        yield from _ids(node.children)
