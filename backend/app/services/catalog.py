"""Справочники для интерфейса. Берем из конфигурации модели, чтобы данные и расчет не разошлись."""

from __future__ import annotations

from functools import lru_cache

import yaml

from app.engine.economics import staff
from app.engine.economics.scenarios import by_id
from app.engine.model_config import Provenance, load_model
from app.errors import NotFound
from app.schemas.catalog import CatalogMatches, Facility, Operation, Parameter
from app.services import facility_catalog
from app.services.calculation import model_with_overrides
from app.services.selection import catalog as solution_catalog
from app.settings import settings

NO_SOLUTIONS = "В каталоге пока нет решений для этой задачи"


@lru_cache(maxsize=1)
def _form_fields() -> dict[str, list[dict]]:
    return yaml.safe_load((settings.config_dir / "parameters.yaml").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _facility_types() -> tuple[list[dict], dict[str, Provenance]]:
    """Витрина первого шага: типы объектов, их теги над каталогом и честные пометки о готовности."""
    types, provenance = load_model(settings.config_dir / "facility_types.yaml")
    return types["facility_types"], provenance


def facilities() -> list[Facility]:
    """Типы объектов для первого шага. Задачи есть только у тех, кто заведен в расчетной модели."""
    model, provenance = model_with_overrides({})
    modeled = {f["id"]: f for f in model["facilities"]}
    specs, type_provenance = _facility_types()
    return [
        Facility(
            id=spec["id"],
            name=spec["name"],
            status=spec["status"],
            note=spec["note"],
            next=spec.get("next", []),
            catalog=_catalog_matches(spec, type_provenance),
            operations=_facility_operations(spec["id"], modeled, model["roles"], provenance),
            active_area_m2=modeled.get(spec["id"], {}).get("active_area_m2"),
            picking_zone_share=modeled.get(spec["id"], {}).get("picking_zone_share"),
        )
        for spec in specs
    ]


def _facility_operations(
    facility_id: str, modeled: dict[str, dict], roles: dict[str, dict], provenance: dict[str, Provenance]
) -> list[Operation]:
    """Задачи есть у склада из расчетной модели и у аэропорта с больницей из датасета организатора."""
    if facility_id in modeled:
        return _operations(modeled[facility_id], roles, provenance)
    if facility_catalog.has_solutions(facility_id):
        return facility_catalog.operations(facility_id)
    return []


def operations(facility_id: str) -> list[Operation]:
    if facility_catalog.has_solutions(facility_id):
        return facility_catalog.operations(facility_id)
    model, provenance = model_with_overrides({})
    return _operations(by_id(model["facilities"], facility_id), model["roles"], provenance)


def _catalog_matches(spec: dict, provenance: dict[str, Provenance]) -> CatalogMatches:
    """Сколько решений стоит на карточке объекта и что это число значит.

    У склада считаем по своему отобранному каталогу, у аэропорта и больницы по разобранному
    списку решений: это факт о файле, а не оценка. У "другого" число посчитано по выгрузке
    организатора и записано в конфиге с источником.
    """
    catalog = spec["catalog"]
    if facility_catalog.has_solutions(spec["id"]):
        return CatalogMatches(
            count=facility_catalog.solutions_count(spec["id"]),
            note=catalog["note"],
            source="Наш разбор каталога и открытых источников, data/facilities/solutions.csv",
        )
    if "count" not in catalog:
        return CatalogMatches(
            count=len(solution_catalog(spec["id"])),
            note=catalog["note"],
            source="Каталог решений в базе: решения с подтвержденной задачей объекта",
        )
    prov = provenance[f"facility_types.{spec['id']}.catalog.count"]
    return CatalogMatches(count=catalog["count"], note=catalog["note"], source=prov.source, trust=prov.trust)


def _operations(facility: dict, roles: dict[str, dict], provenance: dict[str, Provenance]) -> list[Operation]:
    return [_operation(facility, operation, roles, provenance) for operation in facility["operations"]]


def _operation(facility: dict, operation: dict, roles: dict[str, dict], provenance: dict[str, Provenance]) -> Operation:
    processes = operation.get("processes", [])
    found = _solutions_count(facility["id"], operation["id"])
    volume = provenance[f"facilities.{facility['id']}.operations.{operation['id']}.volume_per_day"]
    return Operation(
        id=operation["id"],
        name=operation["name"],
        volume_per_day=operation["volume_per_day"],
        unit=operation.get("unit", "операций/сут"),
        steady=bool(operation.get("steady")),
        volume_source=volume.source,
        volume_trust=volume.trust,
        processes=processes,
        performed_by=[roles[role]["name"] for role in operation.get("performed_by", [])],
        takeover=staff.mode(operation),
        solutions_count=found,
        available=found > 0,
        unavailable_reason=None if found else NO_SOLUTIONS,
    )


def _solutions_count(facility_id: str, operation_id: str) -> int:
    """Решения каталога, которые делают задачу по нашей разметке, как в подборе.
    Подходят ли они по ограничениям, разбирается на шаге подбора."""
    return sum(1 for item in solution_catalog(facility_id) if operation_id in item["uses"])


def parameters(facility_id: str, operation_ids: list[str] | None = None) -> list[Parameter]:
    """Поля формы второго шага: сначала поля объекта, потом поля каждой выбранной задачи.

    Задачи идут в том порядке, в каком их выбрал пользователь, и у каждого поля видно,
    в каком блоке оно стоит: объект или конкретная задача. У аэропорта и больницы поля
    из листа датасета, блоки по разделам листа.
    """
    if facility_catalog.has_solutions(facility_id):
        return facility_catalog.parameters(facility_id, operation_ids or [])
    model, provenance = model_with_overrides({})
    facility = by_id(model["facilities"], facility_id)
    # на опечатку в адресе отвечаем 404, а не пустотой
    names = {facility_id: "Объект"} | {
        operation_id: by_id(facility["operations"], operation_id)["name"] for operation_id in operation_ids or []
    }
    fields = _form_fields()
    out = []
    for group in [facility_id] + list(operation_ids or []):
        # у задачи может не быть своих полей: тогда остаются только поля объекта
        for field in fields.get(group, []):
            path = field["path"]
            prov = provenance[path]
            out.append(
                Parameter(
                    path=path,
                    group=group,
                    group_name=names[group],
                    key=bool(field.get("key", False)),
                    ours=bool(field.get("ours", False)),
                    yes_no=bool(field.get("yes_no", False)),
                    label=field["label"],
                    unit=field["unit"],
                    value=_value(model, path),
                    min=field["min"],
                    max=field["max"],
                    hint=field["hint"],
                    source=prov.source,
                    trust=prov.trust,
                    range_source=field["src"],
                )
            )
    return out


def robot_parameters(robot_ids: list[str]) -> list[Parameter]:
    """Поля выбранных роботов для списка допущений на шаге экономики: цена, обслуживание, срок службы.

    У каждого робота свой блок. Цена берется из каталога, как ее видит расчет, и источник у нее
    тот же: выгрузка организатора или правка администратора. Границы у цены свои у каждого робота,
    поэтому в config/parameters.yaml они записаны долями от значения по умолчанию.
    """
    model, provenance = model_with_overrides({})
    robots = {robot["id"]: robot for robot in model["robots"]}
    out = []
    for robot_id in dict.fromkeys(robot_ids):
        robot = robots.get(robot_id)
        if robot is None:
            raise NotFound(f"Нет решения {robot_id}")
        for field in _form_fields().get("robot", []):
            path = field["path"].format(robot=robot_id)
            prov = provenance[path]
            value = _value(model, path)
            scale = value if field.get("relative") else 1
            out.append(
                Parameter(
                    path=path,
                    group=f"robot:{robot_id}",
                    group_name=f"Робот {robot['vendor']} {robot['model']}",
                    ours=True,
                    label=field["label"],
                    unit=field["unit"],
                    value=value,
                    min=field["min"] * scale,
                    max=field["max"] * scale,
                    hint=field["hint"],
                    source=prov.source,
                    trust=prov.trust,
                    range_source=field["src"],
                )
            )
    return out


def _value(model: dict, path: str) -> float:
    node = model
    for key in path.split("."):
        node = node[key] if isinstance(node, dict) and key in node else by_id(node, key)
    return node
