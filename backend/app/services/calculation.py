"""Сборка расчета для API: берем модель, применяем правки пользователя, считаем, объясняем результат."""

from __future__ import annotations

import copy
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache, partial

import yaml

from app.engine.economics import BASELINE, PURCHASE, RAAS, Comparison, Scenario, ramp
from app.engine.economics.facility import FacilityResult, Task, evaluate_facility
from app.engine.economics.financing import LEASING, LOAN, method_of
from app.engine.economics.financing import METHODS as PAY_METHODS
from app.engine.economics.fleet import peak_demand
from app.engine.economics.scenarios import buyout_share
from app.engine.model_config import Provenance, load_full_model, weak_values
from app.reports import names
from app.schemas.economics import (
    Amortization,
    CalculationRequest,
    CalculationResult,
    FinancingResult,
    PartScenario,
    PaymentProblem,
    PickingZone,
    ScenarioResult,
    SharedPart,
    Sizing,
    SourceInfo,
    SupportResult,
    TaskChoice,
    TaskPart,
    TcoPart,
    Verdict,
    YearRow,
)
from app.schemas.staff import StaffLine
from app.services import catalog_prices
from app.settings import settings

NAMES = {BASELINE: "Без роботизации", PURCHASE: "Покупка", RAAS: "Роботы как услуга"}
SLOW_PAYBACK_YEARS = 3
# Наша граница, не из данных: дальше 30 лет не живет ни робот, ни договор аренды
MAX_HORIZON_YEARS = 30
# Если за горизонт не окупается, досчитываем до верхней границы горизонта в датасете (лист «Склад»,
# 5 лет, от 3 до 10): человек видит, окупится ли позже. Замену изношенных роботов движок уже учитывает
LATER_HORIZON_YEARS = 10
# Потолок правки. Границы полей из датасета мягкие: за ними мы только предупреждаем (ТЗ, п. 3.2.4).
# Жесткий потолок нужен против чисел вроде 1e308, с которыми расчет переполняется или считает
# бессмыслицу: правка не больше чем в тысячу раз выше значения модели и не больше 100 млрд в любом случае.
# Настоящему складу этого хватает с запасом: площадь 20 000 м2 можно поднять до 20 млн м2
MAX_OVERRIDE_FACTOR = 1000
MAX_OVERRIDE_ABS = 1e11


class UnknownPath(ValueError):
    """Пользователь прислал правку для значения, которого в модели нет."""


class Impossible(ValueError):
    """Правки дают объект, которого не бывает: например, 30 часов работы в сутки."""


@lru_cache(maxsize=1)
def _model() -> tuple[dict, dict[str, Provenance]]:
    return load_full_model(settings.config_dir)


def model_with_overrides(overrides: dict[str, float], copy_always: bool = False) -> tuple[dict, dict[str, Provenance]]:
    """Модель с правками пользователя. copy_always нужен тем, кто будет менять модель дальше, например штатом."""
    # нормативы и цена робота из каталога: их правит администратор, остальное из конфига.
    # Импорт здесь: нормативы тянут импорт файлов, каталог и подбор, а подбор тянет этот модуль.
    # Помощник прогона на Windows (spawn) начинал импорт с прогона и падал на этом кольце
    from app.services import norms  # noqa: PLC0415

    model, provenance = catalog_prices.apply(*norms.apply(*_model()))
    if not overrides and not copy_always:
        return model, provenance
    changed = copy.deepcopy(model)
    wrong_financing = False
    for path, value in overrides.items():
        if path not in provenance:
            raise UnknownPath(path)
        # Условия оплаты, меры и выход на режим правятся на шаге экономики. Неверное значение там не
        # валит весь расчет: его не берем, а расчет говорит о нем у поля (payment_problems)
        if path.startswith(PAYMENT_ROOTS) and payment_problem(path, value, _get_by_path(model, path)):
            wrong_financing = wrong_financing or path.startswith("financing.")
            continue
        if not math.isfinite(value):  # JSON с NaN и Infinity тоже читается
            raise Impossible(f"{names.name(path, {})}: нужно обычное число")
        if value < 0:
            raise Impossible(f"{names.name(path, {})}: меньше нуля быть не может")
        limit = _override_limit(_get_by_path(model, path))
        if value > limit:
            most = f"{limit:,.0f}".replace(",", " ")
            raise Impossible(f"{names.name(path, {})}: слишком большое число, нужно не больше {most}")
        wrong = robot_problem(path, value)
        if wrong:
            raise Impossible(f"{names.name(path, {})}: {wrong}")
        # правки приходят дробными (3.0), а годы и штуки дальше считаются целыми
        if path.rsplit(".", 1)[-1] in WHOLE_NUMBERS:
            value = int(value)
        _set_by_path(changed, path, value)
    if wrong_financing and changed.get("financing"):
        # условия кредита или лизинга неверные: покупку считаем за свои деньги, а не на условиях по умолчанию
        changed["financing"]["method"] = 0
    check_possible(changed)
    return changed, provenance


# Числа робота, от которых расчет делит или считает по целым годам. Ноль или дробь здесь раньше
# давали 500 "На сервере что-то сломалось" вместо отказа с именем поля
WHOLE_YEARS = ("service_life_years", "battery_life_years")
POSITIVE = ("avg_speed_m_s", "run_time_h")
WHOLE_NUMBERS = (*WHOLE_YEARS, "robots_per_charger", "contract_months")


def robot_problem(path: str, value: float) -> str | None:
    """Что не так с правкой числа робота. Годы службы целые: расчет идет по годам, и 3,5 года
    не дают ни года обновления парка, ни года замены батарей."""
    tail = path.rsplit(".", 1)[-1]
    if path.startswith("robots."):
        if tail in WHOLE_YEARS and (value != int(value) or value < 1):
            return "нужно целое число лет, не меньше 1"
        if tail == "robots_per_charger" and (value != int(value) or value < 1):
            return "нужно целое число, не меньше 1"
        if tail == "contract_months" and (value < 12 or value % 12):
            return "нужно число месяцев, кратное 12: расчет идет по годам"
        if tail in POSITIVE and value <= 0:
            return "нужно больше нуля"
    if path == "engine.simulation.availability" and not 0 < value <= 1:
        return "нужна доля больше нуля и не больше 1"
    if tail == "picking_zone_share" and not PICKING_ZONE_SHARE[0] <= value <= PICKING_ZONE_SHARE[1]:
        return "нужна доля от 0,05 до 1: от 5% склада до всего склада"
    return None


PAYMENT_ROOTS = ("financing.", "subsidies.", "ramp_up.")
# Границы части склада под робозону отбора: меньше 5% станции уже не встают, больше всего склада не бывает
PICKING_ZONE_SHARE = (0.05, 1.0)


def payment_problem(path: str, value: float, default: object = None) -> str | None:
    """Что не так с правкой оплаты, мер или выхода на режим. Те же границы, что в check_possible."""
    tail = path.rsplit(".", 1)[-1]
    if not math.isfinite(value) or value < 0:
        return "Нужно обычное число не меньше нуля"
    if value > _override_limit(default):
        return "Слишком большое число"
    if path == "financing.method" and value not in (0, 1, 2):
        return "Способ оплаты: 0 свои деньги, 1 кредит, 2 лизинг"
    if path.startswith("financing.") and tail == "rate" and value > 1:
        return "Ставка задается долей в год: 15% это 0,15"
    if tail in ("own_share", "advance_share") and value >= 1:
        return "Доля своих денег или аванса должна быть меньше 100%"
    if tail == "term_months" and (value != int(value) or not 1 <= value <= MAX_HORIZON_YEARS * 12):
        return f"Срок задается целым числом месяцев от 1 до {MAX_HORIZON_YEARS * 12}"
    if path.startswith("subsidies.") and tail == "chosen" and value not in (0, 1):
        return "Мера поддержки отмечается 1 или снимается 0"
    if path.startswith("ramp_up.") and tail == "first_month_share" and value > 1:
        return "Доля эффекта в первый месяц не больше 100%"
    if path.startswith("ramp_up.") and tail == "months" and (value != int(value) or value > 12):
        return "Выход на режим задается целым числом месяцев, не больше 12"
    return None


def payment_problems(overrides: dict[str, float]) -> list[PaymentProblem]:
    """Правки шага экономики, которые расчет не взял: поле и что с ним не так, для экрана."""
    model, _ = model_with_overrides({})
    return [
        PaymentProblem(path=path, message=message)
        for path, value in overrides.items()
        if path.startswith(PAYMENT_ROOTS)
        and (message := payment_problem(path, value, _get_by_path(model, path))) is not None
    ]


def _short(value: float) -> str:
    """Число без лишних нулей и с запятой: 3, 12,5"""
    return f"{value:g}".replace(".", ",")


def _shifts_word(count: float) -> str:
    if count != int(count):
        return "смены"
    whole = int(count)
    if whole % 10 == 1 and whole % 100 != 11:
        return "смена"
    if whole % 10 in (2, 3, 4) and whole % 100 not in (12, 13, 14):
        return "смены"
    return "смен"


def check_possible(model: dict) -> None:
    """Выход за границы датасета мы только помечаем, а невозможное не считаем совсем.

    Три смены по 12 часов человек мог ввести по ошибке, и расчет с 36 часами в сутках
    выдал бы окупаемость и ROI, которые выглядят как цифры, но ничего не значат.
    """
    econ = model["economics"]
    horizon = econ["horizon_years"]
    if horizon != int(horizon) or not 1 <= horizon <= MAX_HORIZON_YEARS:
        raise Impossible(f"Горизонт расчета задается целым числом лет от 1 до {MAX_HORIZON_YEARS}")
    # Правки приходят дробными (10.0), а годы перебираются по одному
    econ["horizon_years"] = int(horizon)
    _check_financing(model)
    for facility in model["facilities"]:
        schedule = facility.get("schedule")
        if not schedule:
            continue
        shifts, hours = schedule["shifts"], schedule["shift_hours"]
        days = schedule.get("days_per_year", 365)
        if shifts <= 0 or hours <= 0 or days <= 0:
            raise Impossible("Смены, их длина и рабочие дни должны быть больше нуля. Поправьте их на шаге параметров")
        if shifts * hours > 24:
            raise Impossible(
                f"{_short(shifts)} {_shifts_word(shifts)} по {_short(hours)} ч дают {_short(shifts * hours)} ч работы "
                "в сутки, "
                "а в сутках 24. "
                "Поправьте смены или их длину на шаге параметров"
            )
        if days > 366:
            raise Impossible(f"В году не бывает {days:g} рабочих дней. Поправьте их на шаге параметров")


def _check_financing(model: dict) -> None:
    """Способ оплаты, отметки мер и выход на режим: только то, что бывает."""
    fin = model.get("financing")
    if fin:
        if fin["method"] not in (0, 1, 2):
            raise Impossible("Способ оплаты: 0 свои деньги, 1 кредит, 2 лизинг")
        fin["method"] = int(fin["method"])
        for part, share in (("loan", "own_share"), ("leasing", "advance_share")):
            terms = fin[part]
            if terms["rate"] > 1:
                raise Impossible("Ставка задается долей в год: 15% это 0,15")
            if terms[share] >= 1:
                raise Impossible("Доля своих денег или аванса должна быть меньше 100%")
            months = terms["term_months"]
            if months != int(months) or not 1 <= months <= MAX_HORIZON_YEARS * 12:
                raise Impossible(
                    f"Срок кредита или лизинга задается целым числом месяцев от 1 до {MAX_HORIZON_YEARS * 12}"
                )
            terms["term_months"] = int(months)
    for measure in model.get("subsidies", []):
        if measure.get("chosen") not in (None, 0, 1):
            raise Impossible("Мера поддержки отмечается 1 или снимается 0")
    for curve in (model.get("ramp_up") or {}).values():
        if curve["first_month_share"] > 1:
            raise Impossible("Доля эффекта в первый месяц не больше 100%")
        if curve["months"] != int(curve["months"]) or curve["months"] > 12:
            raise Impossible("Выход на режим задается целым числом месяцев, не больше 12")
        curve["months"] = int(curve["months"])


def apply_staff(model: dict, facility_id: str, lines: list[StaffLine]) -> dict:
    """Ставит в модель штат, который ввел пользователь: он замещает штат из конфигурации целиком.

    Пустой список означает, что штата нет, а не что его не прислали: тогда забирать роботам не у кого.
    """
    facility = _by_id(model["facilities"], facility_id)
    facility["staff"] = [
        {
            "id": line.id,
            "role": line.role,
            "headcount": line.headcount,
            "filled": line.filled,
            "salary_month": line.salary_month,
            "contractor": line.contractor,
        }
        for line in lines
    ]
    return model


def _override_limit(default: object) -> float:
    base = abs(default) if isinstance(default, int | float) and not isinstance(default, bool) else 0.0
    return min(MAX_OVERRIDE_ABS, base * MAX_OVERRIDE_FACTOR) if base else MAX_OVERRIDE_ABS


def _get_by_path(model: dict, path: str) -> object:
    node: object = model
    for key in path.split("."):
        if isinstance(node, dict):
            node = node.get(key)
        elif isinstance(node, list):
            node = next((item for item in node if isinstance(item, dict) and item.get("id") == key), None)
        else:
            return None
    return node


def _set_by_path(model: dict, path: str, value: float) -> None:
    """Путь вида facilities.warehouse.staff.pickers.salary_month."""
    node = model
    keys = path.split(".")
    for key in keys[:-1]:
        node = node[key] if isinstance(node, dict) else _by_id(node, key)
    node[keys[-1]] = value


def _by_id(items: list, item_id: str):
    for item in items:
        if isinstance(item, dict) and item.get("id") == item_id:
            return item
    raise UnknownPath(item_id)


NO_STATION_DATA = "У этого робота нет данных станции отбора: выберите систему товар к человеку (Ronavi M)"


def _without_station_data(request: CalculationRequest) -> TaskChoice | None:
    """Решение, выбранное на отбор «товар к человеку», у которого в config нет станции отбора:
    без ее цены и выработки экономику отбора не посчитать, а молча взять ноль было бы обманом."""
    check_choices(request.choices())
    model = _model()[0]
    robots = {robot["id"]: robot for robot in model["robots"]}
    operations = _by_id(model["facilities"], request.facility_id).get("operations", [])
    for choice in request.choices():
        operation = next((one for one in operations if one.get("id") == choice.operation_id), {})
        if operation.get("productivity_after") and not robots.get(choice.robot_id, {}).get("station_price_rub"):
            return choice
    return None


def calculate(request: CalculationRequest) -> CalculationResult:
    if _without_station_data(request):
        model = _model()[0]
        return CalculationResult(
            feasible=False,
            cause="solution",
            message=NO_STATION_DATA,
            model_version=str(model["meta"]["version"]),
            facility_id=request.facility_id,
            operation_id=request.choices()[0].operation_id,
            robot_id=request.choices()[0].robot_id,
            horizon_years=model["economics"]["horizon_years"],
            applied_overrides=request.overrides,
        )
    prepared = _prepare(request)
    if prepared.refused:
        return CalculationResult(
            feasible=False,
            cause="plan",
            message=prepared.refused,
            model_version=str(prepared.model["meta"]["version"]),
            facility_id=request.facility_id,
            operation_id=request.choices()[0].operation_id,
            robot_id=request.choices()[0].robot_id,
            horizon_years=prepared.model["economics"]["horizon_years"],
            applied_overrides=request.overrides,
        )
    result = _run(request, prepared, prepared.model)
    # Геометрию берем и у сгенерированного плана: она все равно честнее квадрата со стороной
    # из корня площади. А вот сказать, что планировку человек подтвердил, мы можем только
    # про нарисованный или построенный по его анкете: типовой мы придумали сами.
    answer = _to_schema(
        prepared.model,
        prepared.provenance,
        request,
        result,
        bool(prepared.curves),
        bool(prepared.drawn and prepared.drawn.known),
        prepared.stations,
        prepared.places,
    )
    answer.picking_zones = list(prepared.zones.values())
    _add_later_payback(answer, request, prepared, result)
    if prepared.aisle_note:
        # проезд впритык: робот проходит, но запаса нет, и это риск каждого сценария с роботами
        for scenario in answer.scenarios:
            if scenario.verdict:
                scenario.verdict.risks.append(prepared.aisle_note)
    if request.budget_rub:
        from app.services import budget  # импорт здесь: бюджет опирается на этот модуль

        answer.budget = budget.check(
            request, prepared, result, lambda fleets: _run(request, prepared, prepared.model, fleets)
        )
    return answer


def _add_later_payback(
    answer: CalculationResult, request: CalculationRequest, prepared: Prepared, result: FacilityResult
) -> None:
    """Сценарии, которые не окупаются за горизонт, пересчитываем на LATER_HORIZON_YEARS лет тем же парком.

    Горизонт в ответе не меняется: главные цифры остаются за горизонт расчета, досчет только отвечает,
    на каком году вложения вернутся. Горизонт и так не короче: досчитывать нечего.
    """
    if not answer.feasible or prepared.model["economics"]["horizon_years"] >= LATER_HORIZON_YEARS:
        return
    late = [one for one in answer.scenarios if one.id != BASELINE and one.payback_cumulative_years is None]
    if not late:
        return
    model = copy.deepcopy(prepared.model)
    model["economics"]["horizon_years"] = LATER_HORIZON_YEARS
    # парк от горизонта не зависит, берем тот же, что в ответе: с бюджетом и прогоном смены он мог быть задан
    fleets = {key: own.sizing.fleet for key, own in result.own.items()}
    longer = _run(request, prepared, model, fleets)
    if not longer.feasible:
        return
    answer.later_horizon_years = LATER_HORIZON_YEARS
    for one in late:
        one.payback_later_years = longer.scenarios[one.id].payback_cumulative


@dataclass
class Prepared:
    """Модель с правками и штатом, маршрут с плана и кривые парка из прогона: все, что нужно расчету."""

    model: dict
    provenance: dict[str, Provenance]
    drawn: object | None
    route_m: float | None
    # кривая парка по прогону смены у каждой задачи: операция -> пропускная способность по размеру парка
    curves: dict[str, list[float]] = field(default_factory=dict)
    # станций отбора на плане клиента: без них отбор «товар к человеку» не сходится, и причина в плане
    stations: int | None = None
    # мест у стеллажей, до которых робот доезжает, на плане клиента: без них заданиям неоткуда браться
    places: int | None = None
    # почему план считать нельзя: проезд между рядами уже каталожного минимума робота. Пусто: можно
    refused: str = ""
    # проезд уже того, что мы закладываем, но робот проходит: строка в риски. Пусто: нечего сказать
    aisle_note: str = ""
    # задачи отбора, которые считали по робозоне вместо плана человека под погрузчик
    zones: dict[str, PickingZone] = field(default_factory=dict)


def _run(
    request: CalculationRequest, prepared: Prepared, model: dict, fleets: dict[str, int] | None = None
) -> FacilityResult:
    """Все задачи объекта вместе: дежурные и внедрение общие (engine/economics/facility.py)."""
    return evaluate_facility(
        model,
        request.facility_id,
        [Task(choice.operation_id, choice.robot_id, choice.share) for choice in request.choices()],
        tuple(request.subsidy_ids),
        request.raas_buyout,
        prepared.curves or None,
        prepared.route_m,
        fleets,
        registry=_in_registry(model, request.choices()),
    )


def _in_registry(model: dict, choices: list[TaskChoice]) -> bool:
    """Все выбранные роботы в реестре российской промышленной продукции (постановление 719).
    Отметку ведет каталог: ее ставит выгрузка организатора и правит администратор. Нет каталога: нет."""
    robots = {robot["id"]: robot for robot in model["robots"]}
    # неизвестного робота здесь не ловим: про него скажет сам расчет
    ids = {robots.get(choice.robot_id, {}).get("catalog_id") for choice in choices}
    if None in ids:
        return False
    try:
        from sqlalchemy import select

        from app.services import selection
        from app.storage.models import Solution

        with selection.sessions() as session:
            marked = set(session.scalars(select(Solution.id).where(Solution.id.in_(ids), Solution.registry_719)))
    except Exception:  # noqa: BLE001 - без базы каталога мера просто недоступна, расчет идет дальше
        return False
    return marked == ids


def check_choices(choices: list[TaskChoice]) -> None:
    """На задачу одно решение или два с долями объема, которые в сумме дают единицу."""
    shares: dict[str, float] = {}
    for choice in choices:
        shares[choice.operation_id] = shares.get(choice.operation_id, 0.0) + choice.share
    if len({choice.key for choice in choices}) != len(choices):
        raise Impossible("Одно решение выбрано на задачу дважды")
    counts: dict[str, int] = {}
    for choice in choices:
        counts[choice.operation_id] = counts.get(choice.operation_id, 0) + 1
    for operation_id, count in counts.items():
        if count > 2:
            raise Impossible(f"На задачу {operation_id} выбрано {count} решения, а можно не больше двух")
    for operation_id, total in shares.items():
        if abs(total - 1.0) > 1e-6:
            raise Impossible(
                f"Доли решений задачи {operation_id} в сумме дают {total:.0%}, а должны 100%: "
                "поправьте долю объема на шаге решения"
            )


def _prepare(request: CalculationRequest) -> Prepared:
    choices = request.choices()
    check_choices(choices)
    model, provenance = model_with_overrides(request.overrides, copy_always=request.staff is not None)
    if request.staff is not None:
        # Штат ввел пользователь, значит он замещает штат из конфигурации целиком,
        # вместе с ролями, которых там не было. Источники строк из конфигурации при этом
        # снимаем: под введенной вручную цифрой не должен стоять чужой источник.
        apply_staff(model, request.facility_id, request.staff)
        staff_paths = f"facilities.{request.facility_id}.staff."
        provenance = {path: prov for path, prov in provenance.items() if not path.startswith(staff_paths)}
    # План с третьего шага дает длину маршрута и места у ворот. Если его не прислали,
    # маршрут остается оценкой по площади: зона квадратная, ворота посередине стороны.
    drawn = None
    route_m = None
    # Штучный отбор «товар к человеку» считаем по робозоне при любом плане: так такие системы и ставят.
    # Остальные задачи остаются на плане человека (docs/decisions.md, «Отбор по робозоне»)
    zones: dict[str, PickingZone] = {}
    zoned: set[str] = set()
    if request.plan is not None:
        from app.services import plan as plan_service
        from app.services import simulation

        drawn = plan_service.from_dict(request.plan.model_dump())
        measured = plan_service.measure(drawn)
        route_m = measured.route_m
        stations = measured.stations
        places = measured.task_points - measured.unreachable_points
        zoned = {
            choice.operation_id
            for choice in choices
            if simulation.picking_on_zone(request.facility_id, choice.operation_id)
        }
        on_plan = [choice for choice in choices if choice.operation_id not in zoned]
        # проезды плана человека проверяем только у тех, кто по нему ездит
        refused, aisle_note = plan_aisles(drawn, model, on_plan) if on_plan else ("", "")
        if refused:
            # Прогон смены повез бы робота там, где он не пройдет: не гоняем его и не считаем
            return Prepared(model, provenance, drawn, route_m, {}, stations, places, refused)
        area = plan_service.picking_zone_m2(_by_id(model["facilities"], request.facility_id))
        # строку на шаге 5 даем, когда план человека не робозона: отбор посчитан не по нему
        if not plan_service.fits_picking(drawn):
            zones = {operation_id: PickingZone(operation_id=operation_id, area_m2=area) for operation_id in zoned}

    curves: dict[str, list[float]] = {}
    if request.use_simulation:
        from app.services import simulation  # импорт здесь, чтобы расчет без симуляции не тянул ее за собой

        facility = _by_id(model["facilities"], request.facility_id)
        # Парк по прогону смены на каждую задачу: самый маленький, который вытянул спрос на всех seed.
        # Задачи гоняем по плану клиента, каждую своими роботами, а отбор всегда по робозоне
        for choice in choices:
            run = partial(
                simulation.curve_for,
                request.facility_id,
                choice.operation_id,
                choice.robot_id,
                by_turnover=simulation.slotted(facility),
                overrides=request.overrides,
                share=choice.share,
            )
            by_plan = simulation.task_plan(request.facility_id, choice.operation_id, drawn, request.overrides)
            curves[choice.key] = run(plan=by_plan)
    if request.plan is None:
        return Prepared(model, provenance, drawn, route_m, curves)
    return Prepared(model, provenance, drawn, route_m, curves, stations, places, aisle_note=aisle_note, zones=zones)


def plan_aisles(drawn, model: dict, choices: list[TaskChoice]) -> tuple[str, str]:
    """Проезд между рядами и выбранные роботы: почему считать нельзя и что сказать в рисках.

    Уже каталожного минимума робота (min_aisle_width_mm) проезд не проходит: на сетке в метр он
    то исчезает, то становится проезжим, и расчет вышел бы по дороге, которой нет. Тогда первая
    строка, причина для шага экономики. Если минимума нет в данных, не блокируем: не знаем.
    Между минимумом и тем, что мы закладываем (aisle_robot_zone_m, оценка F), расчет идет, а вторая
    строка ложится в риски. Пустые строки: все в порядке."""
    from app.engine import plan as plan_engine
    from app.engine.selection import number
    from app.services import plan as plan_service
    from app.services.selection import catalog

    constants = plan_service.constants()
    tight = plan_engine.narrow_aisles(drawn.of(plan_engine.RACKS), constants)
    if not tight:
        return "", ""
    width = tight[0]
    rows = {row.get("id"): row for row in catalog()}
    unknown = []
    for choice in choices:
        robot = _by_id(model["robots"], choice.robot_id)
        row = rows.get(robot.get("catalog_id"), {})
        least_mm = number(row.get("min_aisle_width_mm"))
        if not least_mm:
            unknown.append(row.get("product", "").split(" (")[0] or robot.get("model", ""))
        if least_mm and width < least_mm / 1000 - AISLE_EPS_M:
            # название как в каталоге, без пояснения в скобках: "Ronavi H1500 (грузоподъемность ...)"
            name = (row.get("product") or "").split(" (")[0] or f"{robot.get('vendor', '')} {robot.get('model', '')}"
            return (
                f"Между рядами {_meters(width)} м, а {name} нужно не меньше {_meters(least_mm / 1000, 2)} м: "
                "раздвиньте ряды. Робот там не проедет, и считать парк не по чему",
                "",
            )
    need = plan_engine.robot_aisle_m(constants)
    if unknown:
        return "", (
            f"Между рядами {_meters(width)} м, а мы закладываем {_meters(need)} м. Сколько нужно "
            f"{', '.join(unknown)}, производитель не публикует: проверьте у поставщика, что робот проедет"
        )
    return (
        "",
        f"Между рядами {_meters(width)} м: робот проедет, но запаса почти нет. Мы советуем не меньше {_meters(need)} м",
    )


# Проезд с листа до сантиметра, минимум робота в миллиметрах: сантиметр разницы не решает
AISLE_EPS_M = 0.005


def _meters(value: float, digits: int = 1) -> str:
    """Метры для человека с запятой: 0,5 и 0,75, без лишнего нуля на конце"""
    text = f"{value:.{digits}f}"
    if digits > 1:
        text = text.rstrip("0")
        text = text + "0" if text.endswith(".") else text
    return text.replace(".", ",")


def _to_schema(
    model: dict,
    provenance: dict[str, Provenance],
    request: CalculationRequest,
    result: FacilityResult,
    from_simulation: bool = False,
    from_plan: bool = False,
    stations: int | None = None,
    places: int | None = None,
) -> CalculationResult:
    choices = request.choices()
    problems = payment_problems(request.overrides)
    facility = _by_id(model["facilities"], request.facility_id)
    common = {
        "model_version": str(model["meta"]["version"]),
        "facility_id": request.facility_id,
        "operation_id": choices[0].operation_id,
        "robot_id": choices[0].robot_id,
        "horizon_years": model["economics"]["horizon_years"],
        "applied_overrides": request.overrides,
    }
    if not result.feasible:
        if result.failed_operation_id is None:
            return CalculationResult(feasible=False, message=result.message, **common)
        failed = _by_id(facility["operations"], result.failed_operation_id)
        # Называем задачу и решение: на экране расчета их не видно, и без них сообщение читалось
        # как про другую покупку. Решение то, на котором не сошелся парк, а не первое в запросе
        robot = _by_id(model["robots"], result.failed_robot_id or choices[0].robot_id)
        demand = f"{'спрос' if failed.get('steady') else 'пик'} {peak_demand(failed, facility):.0f} операций в час"
        head = f"{failed['name']}, {robot['model']}: "
        if places == 0:
            # План без стеллажей или с отрезанными стеллажами: прогону смены некуда везти груз,
            # и не сходится любой робот. Причина в плане, а не в решении
            return CalculationResult(
                feasible=False,
                cause="plan",
                message=(
                    f"{head}парк не покрывает {demand}, потому что план не заполнен: "
                    "на нем нет стеллажей, до которых робот может доехать. "
                    "Вернитесь к плану и поставьте стеллажи или выберите типовую планировку"
                ),
                **common,
            )
        # отбор «товар к человеку» на плане без станций отбора не сходится из-за плана, а не робота:
        # до стеллажей по проездам под погрузчик в пять раз дальше, чем в робозоне
        if failed.get("productivity_after") and stations == 0:
            return CalculationResult(
                feasible=False,
                cause="plan",
                message=(
                    f"{head}парк не покрывает {demand}: на вашем плане нет станций отбора. "
                    "Для этой задачи нужна робозона со станциями: выберите на шаге плана "
                    "типовую планировку «товар к человеку» или поставьте станции"
                ),
                **common,
            )
        return CalculationResult(
            feasible=False,
            cause="solution",
            message=f"{head}парк не покрывает {demand}. Нужны роботы производительнее или другая схема работы",
            **common,
        )

    used = _used_paths(request, model)
    source_name = _source_names(facility)
    robots = [_by_id(model["robots"], choice.robot_id) for choice in choices]
    sizing = _facility_sizing(result, choices, from_simulation)
    baseline_tco = result.scenarios[BASELINE].tco
    return CalculationResult(
        feasible=True,
        sizing=sizing,
        scenarios=[
            _scenario(
                scenario_id,
                result.scenarios[scenario_id],
                baseline_tco,
                None
                if scenario_id == BASELINE
                else _verdict(
                    scenario_id, result.scenarios[scenario_id], baseline_tco, sizing, from_simulation, from_plan
                ),
                None
                if scenario_id == BASELINE
                else _amortization(scenario_id, result, choices, robots, request.raas_buyout),
                model,
            )
            for scenario_id in (BASELINE, PURCHASE, RAAS)
            if scenario_id in result.scenarios
        ],
        sources=[
            SourceInfo(
                path=path,
                value=_value_by_path(model, path),
                source=p.source,
                date=p.date,
                trust=p.trust,
                unit=names.unit(path),
                name=source_name(path),
            )
            for path, p in sorted(provenance.items())
            if path.startswith(used) and not _other_task(path, request)
        ],
        weak_value_paths=[
            path for path in weak_values(provenance) if path.startswith(used) and not _other_task(path, request)
        ],
        tasks=[
            TaskPart(
                operation_id=choice.operation_id,
                operation_name=_by_id(facility["operations"], choice.operation_id)["name"],
                robot_id=choice.robot_id,
                share=choice.share,
                sizing=_sizing(result.own[choice.key], from_simulation),
                scenarios=[
                    _part(result.own[choice.key].scenarios[sid], result.own[choice.key].scenarios[BASELINE].tco)
                    for sid in result.scenarios
                ],
            )
            for choice in choices
        ],
        shared=_shared(result, choices),
        notes=result.notes
        + (
            ["Условия кредита или лизинга неверные, покупку считаем за свои деньги"]
            if any(problem.path.startswith("financing.") for problem in problems)
            else []
        ),
        payment_problems=problems,
        **common,
    )


def _source_names(facility: dict) -> Callable[[str], str]:
    """Названия значений для "Откуда цифры", те же, что в отчете: у задачи и строки штата в конце
    их название, иначе оклад отборщика и оклад оператора погрузчика не различить."""
    # здесь, а не наверху файла: сервис штата сам берет отсюда расчет
    from app.services import staff as staff_service

    roles = {role.id: role.name for role in staff_service.roles()}
    operations = {one["id"]: one["name"] for one in facility.get("operations", [])}
    staff = {line["id"]: roles.get(line["role"], line["role"]) for line in facility.get("staff", [])}
    return lambda path: names.name(path, {}, operations, staff)


def _part(scenario: Scenario, baseline_tco: float | None = None) -> PartScenario:
    """Часть объекта в одном сценарии. Окупаемость части считается по ее собственному потоку:
    так видно, какая из задач не окупается, даже когда объект целиком окупается."""
    first = scenario.years[0]
    return PartScenario(
        id=scenario.id,
        # вложения части до способа оплаты: долг и проценты общие на объект, они уходят в "общее"
        investment_year0_rub=scenario.capex_total - scenario.grant,
        capex_rub=scenario.capex,
        opex_year1_rub=first.opex_total,
        opex_year1_items_rub=first.opex,
        staff_year1_rub=first.staff_cost,
        effect_year1_rub=first.effect,
        tco_rub=scenario.tco,
        payback_years=scenario.payback_cumulative if scenario.id != BASELINE else None,
        saving_rub=baseline_tco - scenario.tco if baseline_tco is not None and scenario.id != BASELINE else None,
    )


def _shared(result: FacilityResult, choices: list[TaskChoice]) -> SharedPart:
    """Общее на объект: объект минус сумма задач. Так в него попадает и грант, который считается
    от вложений объекта целиком. Считаем здесь, браузер не складывает."""
    scenarios = []
    for scenario_id, total in result.scenarios.items():
        whole = _part(total)
        parts = [_part(result.own[choice.key].scenarios[scenario_id]) for choice in choices]
        capex = {
            item: value - sum(part.capex_rub.get(item, 0.0) for part in parts)
            for item, value in whole.capex_rub.items()
        }
        scenarios.append(
            PartScenario(
                id=scenario_id,
                investment_year0_rub=whole.investment_year0_rub - sum(p.investment_year0_rub for p in parts),
                # копейки от округления в разнице статьей не считаем
                capex_rub={item: value for item, value in capex.items() if abs(value) > 0.5},
                opex_year1_rub=whole.opex_year1_rub - sum(p.opex_year1_rub for p in parts),
                opex_year1_items_rub={
                    item: value - sum(part.opex_year1_items_rub.get(item, 0.0) for part in parts)
                    for item, value in whole.opex_year1_items_rub.items()
                    if abs(value - sum(part.opex_year1_items_rub.get(item, 0.0) for part in parts)) > 0.5
                },
                staff_year1_rub=whole.staff_year1_rub - sum(p.staff_year1_rub for p in parts),
                effect_year1_rub=whole.effect_year1_rub - sum(p.effect_year1_rub for p in parts),
                tco_rub=whole.tco_rub - sum(p.tco_rub for p in parts),
            )
        )
    return SharedPart(
        operator_posts=result.shared.posts,
        operators_fte=result.shared.operators_fte,
        retrained_fte=result.shared.retrained_fte,
        scenarios=scenarios,
    )


def _used_paths(request: CalculationRequest, model: dict) -> tuple[str, ...]:
    """Разделы модели, которые участвуют в этом расчете: общие, выбранные роботы и объект,
    способ оплаты с условиями только выбранного способа и отмеченные меры поддержки."""
    robots = tuple(f"robots.{choice.robot_id}" for choice in request.choices())
    # При неверных условиях расчет идет за свои деньги, а условия выбранного способа все равно
    # нужны экрану: у поля с ошибкой стоят остальные числа этого способа, а не нули
    asked = PAY_METHODS.get(request.overrides.get("financing.method"))
    methods = {method_of(model), asked} & {LOAN, LEASING}
    paying = (
        "financing.method",
        *(f"financing.{one}" for one in sorted(methods)),
        *(("financing.insurance_share_year", "financing.debt_cover_min") if methods else ()),
    )
    chosen = set(request.subsidy_ids) | {one["id"] for one in model.get("subsidies", []) if one.get("chosen")}
    measures = tuple(f"subsidies.{sid}." for sid in sorted(chosen))
    facility = next(one for one in model["facilities"] if one["id"] == request.facility_id)
    operations = {one["id"]: one for one in facility.get("operations", [])}
    kinds = tuple(
        f"ramp_up.{ramp.kind(operations[choice.operation_id])}."
        for choice in request.choices()
        if choice.operation_id in operations
    )
    return ("economics", "engine", *robots, f"facilities.{request.facility_id}", *paying, *measures, *kinds)


def _other_task(path: str, request: CalculationRequest) -> bool:
    """Значение задачи, которую не выбрали: объем уборки не участвует в расчете перевозки паллет,
    и в списке источников и в отчете его быть не должно."""
    parts = path.split(".")
    chosen = {choice.operation_id for choice in request.choices()}
    return len(parts) > 3 and parts[0] == "facilities" and parts[2] == "operations" and parts[3] not in chosen


def _value_by_path(model: dict, path: str) -> float:
    node = model
    for key in path.split("."):
        node = node[key] if isinstance(node, dict) else _by_id(node, key)
    return node


def _sizing(result: Comparison, from_simulation: bool) -> Sizing:
    s = result.sizing
    return Sizing(
        fleet_source="прогон смены" if from_simulation else "формула",
        peak_demand_ops_per_hour=s.peak_demand,
        design_demand_ops_per_hour=s.design_demand,
        route_m=s.route_m,
        robot_ops_per_hour=s.effective_rate,
        fleet=s.fleet,
        # формулой: спрос с резервом на рейсы робота в час с коэффициентом загрузки, вверх
        formula_fleet=_formula_fleet(s),
        fleet_capacity_ops_per_hour=s.fleet_capacity,
        chargers=s.chargers,
        stations=s.stations,
        operator_posts=s.operator_posts,
        operators_fte=s.operators_fte,
        fte_per_post=s.fte_per_post,
        fte_before=s.fte_before,
        fte_after=s.fte_after,
        released_fte=s.released_fte,
        retrained_fte=s.retrained_fte,
        operators_short_fte=s.operators_short_fte,
        vacancies_closed_fte=s.vacancies_closed_fte,
        people_freed_fte=s.people_freed_fte,
        released_net_fte=s.released_net_fte,
        people_per_shift_before=s.people_per_shift_before,
        people_per_shift_after=s.people_per_shift_after,
        worker_cost_rub_year=s.worker_cost,
        operator_cost_rub_year=s.operator_cost,
    )


def _formula_fleet(s) -> int:
    return math.ceil(s.design_demand / s.effective_rate - 1e-9) if s.effective_rate > 0 else 0


def _facility_sizing(result: FacilityResult, choices: list[TaskChoice], from_simulation: bool) -> Sizing:
    """Парк и люди объекта. Роботы, зарядки и ставки складываются по задачам, дежурные берутся
    из общего блока на весь парк. У одной задачи спрос, маршрут и производительность ее, у нескольких
    пустые: у каждой задачи они в своих единицах (паллеты в час, квадратные метры в час), они лежат в tasks."""
    parts = [result.tasks[choice.key].sizing for choice in choices]
    one = parts[0] if len(parts) == 1 else None
    shared = result.shared
    before = sum(s.fte_before for s in parts)
    return Sizing(
        fleet_source="прогон смены" if from_simulation else "формула",
        peak_demand_ops_per_hour=one.peak_demand if one else None,
        design_demand_ops_per_hour=one.design_demand if one else None,
        route_m=one.route_m if one else None,
        robot_ops_per_hour=one.effective_rate if one else None,
        fleet=sum(s.fleet for s in parts),
        formula_fleet=sum(_formula_fleet(s) for s in parts),
        fleet_capacity_ops_per_hour=one.fleet_capacity if one else None,
        chargers=sum(s.chargers for s in parts),
        stations=sum(s.stations for s in parts),
        operator_posts=shared.posts,
        operators_fte=shared.operators_fte,
        fte_per_post=parts[0].fte_per_post,
        fte_before=before,
        fte_after=sum(s.fte_after for s in parts),
        released_fte=sum(s.released_fte for s in parts),
        retrained_fte=shared.retrained_fte,
        operators_short_fte=shared.operators_short_fte,
        vacancies_closed_fte=sum(s.vacancies_closed_fte for s in parts),
        people_freed_fte=sum(s.people_freed_fte for s in parts),
        released_net_fte=sum(s.released_fte for s in parts) - shared.retrained_fte,
        people_per_shift_before=sum(s.people_per_shift_before for s in parts),
        # у задач дежурных нет, они общие: прибавляем посты объекта один раз
        people_per_shift_after=sum(s.people_per_shift_after for s in parts) + shared.posts,
        worker_cost_rub_year=sum(s.worker_cost * s.fte_before for s in parts) / before if before else 0.0,
        operator_cost_rub_year=shared.operator_cost,
    )


def _scenario(
    scenario_id: str,
    scenario: Scenario,
    baseline_tco: float,
    verdict: Verdict | None = None,
    amortization: Amortization | None = None,
    model: dict | None = None,
) -> ScenarioResult:
    baseline = scenario_id == BASELINE
    return ScenarioResult(
        id=scenario_id,
        name=scenario_name(scenario_id, scenario),
        capex_rub=scenario.capex,
        capex_total_rub=scenario.capex_total,
        grant_rub=scenario.grant,
        investment_year0_rub=scenario.investment_year0,
        investment_total_rub=scenario.investment_total,
        years=[
            YearRow(
                year=y.t,
                staff_cost_rub=y.staff_cost,
                opex_rub=y.opex,
                opex_total_rub=y.opex_total,
                effect_rub=y.effect,
                investment_rub=y.investment,
                cash_flow_rub=y.cash_flow,
                amortization_rub=y.amortization,
                financing_rub=y.financing,
                support_rub=y.support,
                insurance_rub=y.insurance,
                ramp_rub=y.ramp,
            )
            for y in scenario.years
        ],
        annual_effect_year1_rub=None if baseline else scenario.years[0].effect,
        effect_total_rub=None if baseline else scenario.effect_total,
        payback_simple_years=scenario.payback_simple,
        payback_cumulative_years=scenario.payback_cumulative,
        payback_own_years=scenario.payback_own,
        roi_tz=scenario.roi_tz,
        roi_net=scenario.roi_net,
        tco_rub=scenario.tco,
        cumulative_cost_rub=_cumulative(scenario),
        running_cost_rub=scenario.tco - scenario.investment_year0,
        saving_rub=None if baseline else baseline_tco - scenario.tco,
        npv_rub=scenario.npv,
        irr=scenario.irr,
        verdict=verdict,
        tco_parts=_tco_parts(scenario),
        amortization=amortization,
        capex_after_grant_rub=None if baseline else scenario.capex_total - scenario.grant,
        financing=_financing(scenario, model) if scenario.financing and model else None,
    )


def scenario_name(scenario_id: str, scenario: Scenario) -> str:
    """Покупка в кредит и в лизинг называется так везде: на экране, в отчете и в таблицах."""
    method = scenario.financing.method if scenario.financing else None
    return {LOAN: "Покупка в кредит", LEASING: "Покупка в лизинг"}.get(method, NAMES[scenario_id])


@lru_cache(maxsize=1)
def _payment_limits() -> dict[str, dict]:
    """Границы ползунков срока и ставки из config/parameters.yaml, раздел financing. В расчет не входят."""
    raw = yaml.safe_load((settings.config_dir / "parameters.yaml").read_text(encoding="utf-8"))
    return {field["path"]: field for field in raw.get("financing", [])}


def _financing(scenario: Scenario, model: dict) -> FinancingResult:
    plan = scenario.financing
    measures = {one["id"]: one for one in model.get("subsidies", [])}
    return FinancingResult(
        method=plan.method,
        rate=plan.rate,
        term_months=plan.term_months,
        base_rub=plan.base_rub,
        own_start_rub=plan.own_start_rub,
        principal_rub=plan.principal_rub,
        payments_rub=plan.payments_rub,
        interest_rub=plan.interest_rub,
        month_first_rub=plan.month_payments[0],
        month_last_rub=plan.month_payments[1],
        term_max_months=int(_payment_limits().get(f"financing.{plan.method}.term_months", {}).get("max", 0)),
        rate_max=float(_payment_limits().get(f"financing.{plan.method}.rate", {}).get("max", 0.0)),
        markup_year=plan.markup_year,
        advance_loan_rub=plan.advance_loan_rub,
        plain_payback_years=plan.plain_payback,
        plain_npv_rub=plan.plain_npv,
        plain_irr=plan.plain_irr,
        debt_left_rub=plan.debt_left_rub,
        debt_cover=plan.debt_cover,
        weak_cover_years=plan.weak_cover_years,
        debt_cover_min=plan.cover_min,
        plain_tco_rub=plan.plain_tco,
        supports=[
            SupportResult(
                id=one.id,
                name=one.name,
                kind=one.kind,
                operator=measures[one.id].get("operator", ""),
                conditions=measures[one.id].get("conditions", ""),
                chosen=one.chosen,
                applied=one.applied,
                reason=one.reason,
                rub=one.rub,
                blocked=one.blocked,
            )
            for one in plan.supports
        ],
    )


def _tco_parts(scenario) -> list[TcoPart]:
    """Из чего сложилась стоимость владения: вложения, люди и каждая статья затрат за все годы.

    Считаем здесь, чтобы браузер ничего не складывал. Сумма слагаемых равна TCO: это проверяет тест.
    """
    parts = [
        TcoPart(id="start", rub=scenario.investment_year0),
        TcoPart(id="later", rub=sum(y.investment for y in scenario.years)),
        TcoPart(id="staff", rub=sum(y.staff_cost - y.ramp for y in scenario.years)),
        TcoPart(id="ramp", rub=sum(y.ramp for y in scenario.years)),
        TcoPart(id="financing", rub=sum(y.financing for y in scenario.years)),
        TcoPart(id="insurance", rub=sum(y.insurance for y in scenario.years)),
        TcoPart(id="support", rub=-sum(y.support for y in scenario.years)),
    ]
    items: dict[str, float] = {}
    for y in scenario.years:
        for item, value in y.opex.items():
            items[item] = items.get(item, 0.0) + value
    parts += [TcoPart(id=item, rub=value) for item, value in items.items()]
    return [part for part in parts if part.rub != 0 or part.id == "start"]


def _amortization(
    scenario_id: str, result: FacilityResult, choices: list[TaskChoice], robots: list[dict], raas_buyout: bool
) -> Amortization:
    """Амортизация линейная: при покупке вложения на срок службы робота, при аренде разовый платеж
    за внедрение на срок договора, а после выкупа цена выкупа на остаток срока службы.

    Когда задач несколько, каждая списывается на срок своего робота, а в год складываются суммы.
    Срок пишем, только если он у всех роботов один."""
    scenario = result.scenarios[scenario_id]
    first = scenario.years[0].amortization

    def common(values: list[int]) -> int | None:
        return values[0] if len(set(values)) == 1 else None

    if scenario_id == PURCHASE:
        return Amortization(
            base_rub=scenario.capex_total,
            years=common([robot["service_life_years"] for robot in robots]),
            per_year_rub=first,
        )
    terms = [robot["raas"]["contract_months"] // 12 for robot in robots]
    out = Amortization(base_rub=scenario.capex_total, years=common(terms), per_year_rub=first)
    horizon = len(scenario.years)
    if raas_buyout and all(term < horizon for term in terms):
        rests = [robot["service_life_years"] - term for robot, term in zip(robots, terms, strict=True)]
        prices = [
            result.tasks[choice.key].sizing.fleet * robot["price_rub"] * buyout_share(robot)
            for choice, robot in zip(choices, robots, strict=True)
        ]
        out.after_buyout_base_rub = sum(prices)
        # срок службы кончился к выкупу: списывать выкупленное не на что, срок не пишем
        out.after_buyout_years = common(rests) if all(rest > 0 for rest in rests) else None
        out.after_buyout_per_year_rub = sum(
            price / rest if rest > 0 else 0.0 for price, rest in zip(prices, rests, strict=True)
        )
    return out


def _cumulative(scenario) -> list[float]:
    """Накопленные затраты по годам для графика сценариев. Считаем здесь, а не в браузере."""
    total = scenario.investment_year0
    points = [total]
    for y in scenario.years:
        total += y.staff_cost + y.opex_total + y.investment + y.financing + y.insurance - y.support
        points.append(total)
    return points


def _ru(value: float) -> str:
    """Число в тексте вывода по-русски: 1,2 года, а не 1.2"""
    return f"{value:.1f}".replace(".", ",")


def _verdict(
    scenario_id: str,
    scenario: Scenario,
    baseline_tco: float,
    s: Sizing,
    from_simulation: bool = False,
    from_plan: bool = False,
) -> Verdict:
    """Вывод не по жесткому порогу: число, интервал, риски и что это значит (ТЗ, п. 3.5.7)."""
    saved = baseline_tco - scenario.tco
    payback = scenario.payback_cumulative

    if payback is None:
        text = (
            f"На этих данных {NAMES[scenario_id].lower()} не окупается за горизонт расчета: "
            f"стоимость операции с роботами выше на {_ru(-saved / 1e6)} млн рублей."
        )
    else:
        text = (
            f"Вложения возвращаются за {_ru(payback)} года, за горизонт операция дешевеет "
            f"на {_ru(saved / 1e6)} млн рублей."
        )

    risks = []
    if payback is not None and payback > SLOW_PAYBACK_YEARS:
        risks.append("Окупаемость дольше трех лет, результат чувствителен к росту зарплат и цен")
    if s.operators_short_fte > 0:
        risks.append(
            f"Роботам нужно больше операторов, чем высвобождается людей: не хватает {_ru(s.operators_short_fte)} ставки. "
            "Ставки оператора роботов на рынке мы не нашли, поэтому стоимость найма в расчет не заложена"
        )
    if s.vacancies_closed_fte > 0:
        risks.append(
            f"Роботы закрывают {_ru(s.vacancies_closed_fte)} незанятой ставки: работа начинает делаться, "
            "но денег это не экономит, потому что этих людей и так не было"
        )
    if s.fte_after > 0:
        risks.append(
            f"Часть людей остается на операции: {_ru(s.fte_after)} ставки из {_ru(s.fte_before)}. Эффект держится "
            "на выработке человека на станции после роботизации: у производителей она в 2-3 раза выше "
            "нынешней, мы взяли осторожно. Поправить можно в «Что мы приняли за вас», сдвиг виден в «Что будет, если»"
        )
    if not from_plan:
        risks.append(
            "План объекта вы не чертили: мы взяли типовую планировку склада, поэтому где на вашем "
            "объекте стоят ворота и зоны хранения, нам неизвестно, а от этого зависит длина маршрута"
        )
    if not from_simulation:
        risks.append("Производительность робота посчитана без очередей и ожидания, это уточнит прогон смены")
    if scenario.years and scenario.years[0].ramp > 0:
        risks.append(
            f"Выход на режим: в первый год экономия меньше на {_ru(scenario.years[0].ramp / 1e6)} млн рублей. "
            "Сколько месяцев роботы работают не на полную, никто не публикует, это наше допущение"
        )
    plan = scenario.financing
    for year in plan.weak_cover_years if plan else []:
        risks.append(
            f"Покрытие долга: в год {year} экономия покрывает платежи банку меньше чем в "
            f"{_ru(plan.cover_min)} раза, банк может не дать кредит"
        )
    for support in scenario.financing.supports if scenario.financing else []:
        if support.chosen and support.blocked:
            risks.append(f"{support.name}: для склада в Москве недоступна, {support.blocked}")
        elif support.chosen and not support.applied and support.reason:
            risks.append(f"{support.name}: не сработала, {support.reason}")
        if support.applied and support.kind == "capex_refund":
            risks.append(
                f"{support.name}: получатели только с ОКВЭД раздела C, проверьте условия отбора. "
                "Без нее окупаемость дольше"
            )
        if support.applied and support.kind == "leasing_advance_loan":
            risks.append(
                f"{support.name}: фонд проверяет производственные активы заявителя, складу могут отказать. "
                "Без займа свои деньги на старте больше"
            )
    return Verdict(band=scenario.payback_band, text=text, risks=risks)
