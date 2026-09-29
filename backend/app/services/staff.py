"""Штат объекта для формы: справочник ролей, строки по умолчанию и проверка введенного.

Считает бэкенд, интерфейс только показывает. Проверки ничего не правят: если данные
пользователя не сходятся между собой, мы говорим об этом и считаем дальше по его числам.
"""

from __future__ import annotations

from functools import lru_cache

from app.engine.economics import staff as engine
from app.engine.economics.scenarios import by_id
from app.engine.model_config import Provenance, load_model
from app.schemas.staff import (
    DefaultStaffLine,
    Role,
    RoleSummary,
    StaffForm,
    StaffLine,
    StaffNote,
    StaffRescale,
    StaffReview,
    StaffReviewRequest,
)
from app.services.calculation import apply_staff, model_with_overrides
from app.settings import settings

GROUP_NAMES = {"floor": "Линейный персонал", "support": "Учет и обслуживание"}
ROBOT_GROUP = "robots"  # роли, которые появляются после роботизации: их пользователь не вводит


@lru_cache(maxsize=1)
def _roles() -> tuple[list[dict], dict[str, Provenance]]:
    raw, provenance = load_model(settings.config_dir / "roles.yaml")
    return raw["roles"], provenance


def roles() -> list[Role]:
    """Из чего пользователь набирает штат. Роли после роботизации сюда не попадают."""
    raw, provenance = _roles()
    return [_role(item, provenance) for item in raw if item["group"] != ROBOT_GROUP]


def _role(item: dict, provenance: dict[str, Provenance]) -> Role:
    salary = provenance[f"roles.{item['id']}.salary_month"]
    low, high = item.get("salary_range") or (None, None)
    productivity = provenance.get(f"roles.{item['id']}.productivity")
    return Role(
        id=item["id"],
        name=item["name"],
        what=item["what"],
        group=item["group"],
        group_name=GROUP_NAMES.get(item["group"], item["group"]),
        salary_month=item["salary_month"],
        salary_source=salary.source,
        salary_trust=salary.trust,
        salary_min=low,
        salary_max=high,
        productivity=item.get("productivity"),
        productivity_unit=item.get("productivity_unit", ""),
        productivity_source=productivity.source if productivity else "",
        productivity_trust=productivity.trust if productivity else "",
        no_productivity_note=_no_productivity_note(item),
    )


def _no_productivity_note(item: dict) -> str:
    if item.get("productivity"):
        return ""
    return item.get("productivity_note") or "Выработки этой роли мы не нашли, объем в ставки по ней не переводится."


def form(facility_id: str, operation_ids: list[str], overrides: dict[str, float] | None = None) -> StaffForm:
    """Справочник и штат по умолчанию: строки тех ролей, у которых выбранные задачи забирают работу.

    Штат по умолчанию это численность склада из данных организатора под его объем (100 000 строк
    отбора в сутки, 2 000 паллет). Если человек поправил объем задачи или рабочие дни, а штат еще
    не трогал, строки пересчитываются под его объем пропорционально: та же выработка на человека,
    те же роли и оклады. Иначе клиент с 15 000 строк получал бы 100 отборщиков склада датасета.
    """
    model, provenance = model_with_overrides({})
    facility = by_id(model["facilities"], facility_id)
    names = {role_id: role["name"] for role_id, role in model["roles"].items()}
    operations = engine.selected_operations(facility, operation_ids)
    at_work = engine.roles_at_work(operations)
    factors, changed = _volume_factors(facility_id, operations, overrides or {})
    lines = []
    for role_id in at_work:
        for line in engine.lines_of_role(facility, role_id):
            source = provenance[f"facilities.{facility_id}.staff.{line.id}.headcount"]
            parts = factors.get(line.role)
            factor = sum(parts) / len(parts) if parts else 1.0
            headcount = _people(line.headcount * factor) if abs(factor - 1) > 1e-6 else line.headcount
            filled = min(headcount, _people(line.filled * factor)) if abs(factor - 1) > 1e-6 else line.filled
            lines.append(
                DefaultStaffLine(
                    id=line.id,
                    role=line.role,
                    role_name=names.get(line.role, line.role),
                    headcount=headcount,
                    filled=filled,
                    salary_month=line.salary_month,
                    contractor=line.contractor,
                    source=source.source if abs(factor - 1) < 1e-6 else f"{source.source}, пересчитано под ваш объем",
                    trust=source.trust,
                )
            )
    volumes = ", ".join(
        f"{_fmt(op['volume_per_day'])} {str(op.get('unit', '')).split('/')[0].strip()} в сутки" for op in operations
    )
    if changed:
        note = (
            f"Численность склада из данных организатора ({volumes}) пересчитана под ваш объем при той же "
            "выработке на человека. Введите свою, если она другая"
        )
    else:
        note = f"Это численность склада из данных организатора на {volumes}. Введите свою"
    return StaffForm(roles=roles(), lines=lines, note=note)


def _volume_factors(
    facility_id: str, operations: list[dict], overrides: dict[str, float]
) -> tuple[dict[str, list[float]], bool]:
    """Во сколько раз годовой объем задач с правками отличается от объема из данных организатора,
    разложено по ролям, которые эти задачи делают. Второе значение: сдвинулось ли хоть что-то."""
    if not overrides:
        return {}, False
    model, _ = model_with_overrides(overrides)
    facility = by_id(model["facilities"], facility_id)
    base_model, _ = model_with_overrides({})
    base = by_id(base_model["facilities"], facility_id)
    days = facility["schedule"]["days_per_year"] / base["schedule"]["days_per_year"]
    factors: dict[str, list[float]] = {}
    changed = False
    for operation in operations:
        now = by_id(facility["operations"], operation["id"])["volume_per_day"]
        ratio = now / operation["volume_per_day"] * days if operation["volume_per_day"] else 1.0
        if abs(ratio - 1) > 1e-6:
            changed = True
        for role_id in operation.get("performed_by", []):
            factors.setdefault(role_id, []).append(ratio)
    return factors, changed


def review(request: StaffReviewRequest) -> StaffReview:
    """Что не сходится во введенном штате, нормативы по ролям и фонд оплаты."""
    model, _ = model_with_overrides(request.overrides, copy_always=True)
    apply_staff(model, request.facility_id, request.staff)
    facility = by_id(model["facilities"], request.facility_id)
    roles_by_id = model["roles"]
    hours = model["economics"]["annual_work_hours"]
    payroll = model["economics"]["payroll"]

    found = engine.review(facility, roles_by_id, request.operation_ids, hours)
    operations = engine.selected_operations(facility, request.operation_ids)
    lines = engine.staff_lines(facility)
    return StaffReview(
        notes=[_note(item, roles_by_id, operations) for item in found],
        roles=_role_summaries(facility, roles_by_id, operations, hours),
        headcount_total=sum(line.headcount for line in lines),
        filled_total=sum(line.filled for line in lines),
        payroll_rub_year=sum(engine.line_cost(line, payroll) * line.filled for line in lines),
        rescale=_rescale(facility, operations, request),
    )


def _rescale(facility: dict, operations: list[dict], request: StaffReviewRequest) -> StaffRescale | None:
    """Штат ввели руками под один объем, а объем потом поменяли: людей столько же, и «без роботов»
    считает, что те же люди сделают больше работы. Предлагаем пересчитать штат пропорционально
    годовому объему: те же роли и оклады, та же выработка на человека, что у введенного штата.
    Норматив из справочника не подставляем: он спорит с численностью клиента и без всякого объема.

    Пример руками: было 2 000 паллет в сутки и 25 водителей, стало 3 000: объем вырос в 1,5 раза,
    людей нужно 25 * 1,5 = 37,5, около 38. Рабочие дни в году тоже входят в годовой объем.
    """
    basis = request.staff_basis
    if not basis or not request.staff:
        return None
    prefix = f"facilities.{facility['id']}"
    days = facility["schedule"]["days_per_year"]
    old_days = basis.get(f"{prefix}.schedule.days_per_year", days)
    ratios: dict[str, float] = {}
    changes: list[str] = []
    for operation in operations:
        key = f"{prefix}.operations.{operation['id']}.volume_per_day"
        if key not in basis or basis[key] <= 0 or old_days <= 0:
            continue
        ratio = operation["volume_per_day"] * days / (basis[key] * old_days)
        if abs(ratio - 1) < 1e-6:
            continue
        ratios[operation["id"]] = ratio
        unit = str(operation.get("unit", "")).split("/")[0].strip()
        what = f"объем задачи «{operation['name']}»" if len(operations) > 1 else "объем"
        if abs(operation["volume_per_day"] - basis[key]) > 1e-9:
            where = f"{_fmt(basis[key])} -> {_fmt(operation['volume_per_day'])} {unit} в сутки"
        else:
            where = f"рабочих дней в году {_fmt(old_days)} -> {_fmt(days)}"
        changes.append(
            f"{what[0].upper()}{what[1:]} {'вырос' if ratio > 1 else 'упал'} на {abs(ratio - 1):.0%} ({where})"
        )
    if not ratios:
        return None

    factors: dict[str, float] = {}
    for operation in operations:
        for role_id in operation.get("performed_by", []):
            factors.setdefault(role_id, []).append(ratios.get(operation["id"], 1.0))  # type: ignore[arg-type]
    scaled: list[StaffLine] = []
    before = after = filled_before = filled_after = 0.0
    for line in request.staff:
        parts = factors.get(line.role)
        factor = sum(parts) / len(parts) if parts else 1.0
        if abs(factor - 1) < 1e-6:
            scaled.append(line)
            continue
        headcount = _people(line.headcount * factor)
        filled = min(headcount, _people(line.filled * factor))
        before += line.headcount
        after += headcount
        filled_before += line.filled
        filled_after += filled
        scaled.append(line.model_copy(update={"headcount": headcount, "filled": filled}))
    if before == after:
        return None
    # места и люди названы так же, как в таблице: масштабируем и то, и другое
    text = (
        f"{'. '.join(changes)}, а штат прежний: {_fmt(before)} мест, из них работает {_fmt(filled_before)} человек. "
        f"Без роботов такую работу при той же выработке делают около {_fmt(after)} мест "
        f"({_fmt(filled_after)} человек). Пересчитать штат под новый объем?"
    )
    return StaffRescale(text=text, headcount_before=before, headcount_after=after, lines=scaled)


def _people(value: float) -> float:
    """Людей считаем целыми, половина вверх: 37,5 это 38 человек, а не 37"""
    return float(int(value + 0.5))


def _role_summaries(facility: dict, roles_by_id: dict, operations: list[dict], hours: float) -> list[RoleSummary]:
    """Сколько ставок роли нужно по объему и выработке. Рядом со строкой это и есть объяснение предупреждения."""
    summaries = []
    for role_id in engine.roles_at_work(operations):
        lines = engine.lines_of_role(facility, role_id)
        if not lines:
            continue
        normative = engine.role_total_normative(facility, roles_by_id, role_id, hours)
        summaries.append(
            RoleSummary(
                role=role_id,
                role_name=roles_by_id[role_id]["name"],
                headcount=sum(line.headcount for line in lines),
                normative_fte=normative or None,
            )
        )
    return summaries


def _fmt(value: float | None, digits: int = 0) -> str:
    """Число так, как его читают на экране: пробел между разрядами, запятая в дробной части.

    Целое печатаем без дробной части: «25 ставок» читается, а «25,0 ставок» цепляет глаз.
    """
    if value is None:
        return "-"
    digits = 0 if round(value, digits) == round(value) else digits
    return f"{value:,.{digits}f}".replace(",", " ").replace(".", ",")


def _note(item: engine.Mismatch, roles_by_id: dict, operations: list[dict]) -> StaffNote:
    role = roles_by_id.get(item.role or "", {})
    name = role.get("name", item.role)
    texts = {
        "norm_gap": lambda: (
            f"По объему и выработке роль «{name}» должна занимать {_fmt(item.expected, 1)} человека, "
            f"а мест в штате {_fmt(item.actual, 1)}. Считаем по вашим числам, но расхождение стоит проверить: "
            "или объем другой, или выработка."
        ),
        "no_productivity": lambda: f"{_no_productivity_note(role)} Роботы у нее ничего не заберут.",
        "no_staff": lambda: (
            f"Задача «{_operation_name(operations, item.operation_id)}» выбрана, а людей, которые ее делают, "
            f"в штате нет: {_performers(operations, item.operation_id, roles_by_id)}. "
            "Экономии по этой задаче не будет, забирать нечего."
        ),
        "overfilled": lambda: (
            f"Людей больше, чем мест в штате: {_fmt(item.actual, 1)} на {_fmt(item.expected, 1)} мест."
        ),
        "vacancies": lambda: (
            f"Из {_fmt(item.expected, 1)} мест в штате людьми закрыто {_fmt(item.actual, 1)}. Роботы сначала "
            f"займут {_fmt((item.expected or 0) - (item.actual or 0), 1)} пустых, и это не экономия: "
            "этих людей и так нет."
        ),
        "salary_out_of_range": lambda: (
            f"Рынок по роли «{name}» дает {_fmt(item.low)}-{_fmt(item.high)} рублей в месяц, "
            f"а введено {_fmt(item.actual)}. Считаем по вашему числу."
        ),
        "idle_line": lambda: "Выбранные задачи работу этой роли не трогают: строка идет только в фонд оплаты.",
    }
    return StaffNote(
        kind=item.kind,
        level=item.level,
        line_id=item.line_id,
        role=item.role,
        operation_id=item.operation_id,
        text=texts[item.kind](),
    )


def _operation_name(operations: list[dict], operation_id: str | None) -> str:
    for operation in operations:
        if operation["id"] == operation_id:
            return operation["name"]
    return operation_id or ""


def _performers(operations: list[dict], operation_id: str | None, roles_by_id: dict) -> str:
    for operation in operations:
        if operation["id"] == operation_id:
            return ", ".join(roles_by_id[role]["name"].lower() for role in operation.get("performed_by", []))
    return ""
