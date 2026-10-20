"""Что входит в отчет. Одно содержимое на PDF и Excel: файлы только раскладывают его по-своему.

Все числа берем из того же расчета, что показывает шаг экономики, поэтому отчет и экран не расходятся.
Состав по ТЗ (п. 3.8): параметры, решение и состав оборудования, экономика, ограничения, источники,
дата, версия модели и пометка «предварительная оценка».
"""

from dataclasses import asdict, dataclass, field, replace
from datetime import datetime
from zoneinfo import ZoneInfo

from app.reports import names
from app.reports.words import about_years
from app.schemas.catalog import Facility, Operation, Parameter, Solution
from app.schemas.economics import (
    CalculationRequest,
    CalculationResult,
    PartScenario,
    ScenarioResult,
    SensitivityAll,
    SensitivityResult,
    TaskPart,
)
from app.schemas.plan import Measures
from app.schemas.readiness import ReadinessRequest, ReadinessResult, ReadinessRobot, ReadinessTask
from app.services import calculation
from app.services import catalog as catalog_service
from app.services import plan as plan_service
from app.services import selection as selection_service
from app.services import sensitivity as sensitivity_service
from app.services import staff as staff_service
from app.services.versions import readable_note

NAMES = {"baseline": "Без роботов", "purchase": "Покупка", "raas": "Аренда"}

CAPEX_NAMES = {
    "hardware": "Роботы",
    "chargers": "Зарядные станции",
    "software": "ПО управления парком",
    "stations": "Станции комплектации",
    "integration": "Интеграция с WMS",
    "infrastructure": "Инфраструктура",
    "commissioning": "Пусконаладка",
    "retraining": "Переобучение операторов",
    "hiring": "Подбор операторов",
    "reserve": "Резерв",
}

OPEX_NAMES = {
    "electricity": "Электроэнергия",
    "communications": "Связь",
    "operators": "Операторы роботов",
    "maintenance": "ТО и ремонт",
    "licenses": "Лицензии ПО",
    "battery": "Расходники: замена АКБ",
    "raas_fee": "Плата за аренду",
    "damage": "Ответственность за порчу",
}

MARK = "Предварительная оценка, не коммерческое предложение"
MOSCOW = ZoneInfo("Europe/Moscow")
# начало риска про план, которого человек не чертил (services/calculation.py, _verdict)
NOT_DRAWN = "План объекта вы не чертили"


@dataclass(frozen=True)
class Saved:
    """Сохраненная версия проекта, по которой собран отчет: цифры из нее, без пересчета (ТЗ, п. 3.1.5)"""

    project: str
    number: int
    saved_at: datetime
    same_data: bool


@dataclass
class StaffRow:
    role: str
    headcount: float
    filled: float
    salary_month: float
    contractor: bool


@dataclass
class ShiftSummary:
    """Итоги прогона смены на плане клиента тем парком, что в расчете: то же, что справа от плеера"""

    fleet: int
    hours: float
    design_demand: float
    done: int
    ops_per_hour: float
    busy_share: float
    waiting_share: float
    charging_share: float
    avg_cycle_s: float
    bottleneck: str
    plan_known: bool


@dataclass
class TaskReport:
    """Задача объекта в отчете: что за работа, какое решение на нее выбрали, его парк и смена"""

    operation: Operation
    robot: Solution | None
    part: TaskPart
    shift: ShiftSummary | None = None

    @property
    def robot_name(self) -> str:
        """Название решения, а при смешанном парке с долей объема: «Ronavi H1500, 70% объема»"""
        name = self.robot.product if self.robot else self.part.robot_id
        return f"{name}, {self.part.share:.0%} объема" if self.part.share < 1 else name

    @property
    def title(self) -> str:
        """Заголовок части: задача, а при смешанном парке задача с долей, чтобы колонки различались"""
        return f"{self.operation.name} ({self.part.share:.0%})" if self.part.share < 1 else self.operation.name

    @property
    def unit(self) -> str:
        """Единица задачи без «в сутки»: паллет, строк, м2. В ней итоги смены, как на экране"""
        return self.operation.unit.split("/")[0].strip() or "операций"

    def scenario(self, scenario_id: str) -> PartScenario | None:
        return next((one for one in self.part.scenarios if one.id == scenario_id), None)


@dataclass
class Report:
    created: datetime
    request: CalculationRequest
    result: CalculationResult
    facility: Facility
    tasks: list[TaskReport]
    parameters: list[Parameter]
    staff: list[StaffRow]
    measures: Measures | None
    labels: dict[str, str] = field(default_factory=dict)
    sensitivity: SensitivityResult | None = None
    # все числа по силе влияния: только в Excel, в PDF это еще страницы мелких строк
    sensitivity_all: SensitivityAll | None = None
    # строка штата -> роль словами: у значений штата в списке источников в конце стоит роль
    staff_names: dict[str, str] = field(default_factory=dict)
    # что подготовить на складе до роботов: тот же список, что на экране, отдельным разделом
    readiness: ReadinessResult | None = None
    # на каких данных посчитано: отпечаток для сверки (в конце отчета) и словами, без служебных номеров
    data_version: str = ""
    data_note: str = ""
    # отчет по сохраненной версии из кабинета или по ссылке, а не по свежему расчету
    saved: Saved | None = None
    # отчет по готовому разбору (/cases): pallets, picking или cleaning
    case_id: str | None = None

    @property
    def scenarios(self) -> list[ScenarioResult]:
        return self.result.scenarios

    def scenario(self, scenario_id: str) -> ScenarioResult:
        return next(s for s in self.result.scenarios if s.id == scenario_id)

    @property
    def cheaper(self) -> ScenarioResult:
        """Какой из сценариев с роботами дешевле за горизонт"""
        purchase, raas = self.scenario("purchase"), self.scenario("raas")
        return purchase if purchase.tco_rub <= raas.tco_rub else raas

    @property
    def risks(self) -> list[str]:
        seen: list[str] = []
        for s in self.scenarios:
            for risk in s.verdict.risks if s.verdict else []:
                # в разборе план типовой у всех, гость его и не должен был чертить: страница разбора этот пункт тоже не пишет
                if self.case_id and risk.startswith(NOT_DRAWN):
                    continue
                if risk not in seen:
                    seen.append(risk)
        return seen

    def source_name(self, path: str) -> str:
        return names.name(path, self.labels, {o.id: o.name for o in self.facility.operations}, self.staff_names)

    @property
    def several(self) -> bool:
        return len(self.tasks) > 1

    @property
    def work(self) -> str:
        """Задачи словами: «перевозка паллет между зонами, уборка полов и проездов»"""
        return ", ".join(dict.fromkeys(task.operation.name.lower() for task in self.tasks))

    @property
    def robot_name(self) -> str:
        """Решения всех задач через запятую, без повторов"""
        return ", ".join(dict.fromkeys(task.robot_name for task in self.tasks))

    @property
    def file_stem(self) -> str:
        if self.case_id:
            return f"razbor-{self.case_id}-{self.created:%Y-%m-%d}"
        version = f"-v{self.saved.number}" if self.saved else ""
        return f"otsenka-{self.request.facility_id}{version}-{self.created:%Y-%m-%d}"

    @property
    def stamp(self) -> str:
        """Когда и на чем посчитано, одной строкой для шапки листа. Отпечаток данных сюда не ставим:
        это служебный номер, он стоит один раз в конце отчета"""
        version = f"версия {self.saved.number} · " if self.saved else ""
        return f"{version}расчет от {self.created:%d.%m.%Y %H:%M} мск · модель {self.result.model_version}"

    @property
    def skipped(self) -> str | None:
        """Почему в отчете по старой версии нет чувствительности, смены и подготовки склада"""
        if self.saved is None or self.saved.same_data:
            return None
        return (
            "Нормативы обновились после расчета. Цифры отчета такие, какими их сохранили. Что будет, если, "
            "смена на плане и подготовка склада считаются по текущим нормативам, поэтому здесь их нет. "
            "Посчитать на текущих можно в кабинете: Пересчитать как новую версию."
        )


class NotFeasible(Exception):
    """Расчет не сошелся: отчет по нему не собрать, причину отдаем как есть"""


def build(request: CalculationRequest, case_id: str | None = None) -> Report:
    """Отчет по свежему расчету: мастер, гость, ссылка без сохраненного результата, готовый разбор"""
    from app.services import versions

    result = calculation.calculate(request)
    if not result.feasible or not result.sizing:
        raise NotFeasible(result.message or "Расчет не сошелся")
    report = _assemble(
        request,
        result,
        created=datetime.now(MOSCOW),
        data=(versions.data_version(), versions.data_note()),
        saved=None,
    )
    return replace(report, case_id=case_id) if case_id else report


def build_saved(
    request: CalculationRequest, result: CalculationResult, saved: Saved, data_version: str, data_note: str
) -> Report:
    """Отчет по сохраненной версии: цифры из сохраненного результата, расчет не повторяем.
    Чувствительность, смену и подготовку склада сохранение не хранит, их считаем заново, только
    пока нормативы те же: иначе в одном отчете сошлись бы цифры на разных данных."""
    if not result.feasible or not result.sizing:
        raise NotFeasible(result.message or "Расчет в этой версии не сошелся")
    return _assemble(
        request, result, created=saved.saved_at.astimezone(MOSCOW), data=(data_version, data_note), saved=saved
    )


def _assemble(
    request: CalculationRequest,
    result: CalculationResult,
    created: datetime,
    data: tuple[str, str],
    saved: Saved | None,
) -> Report:
    # сохраненная версия на других нормативах: досчитывать к ней разделы по текущим нельзя
    extras = saved is None or saved.same_data
    facility = next(f for f in catalog_service.facilities() if f.id == request.facility_id)
    choices = request.choices()
    operation_ids = list(dict.fromkeys(choice.operation_id for choice in choices))

    measures = None
    plan_numbers = None
    if request.plan is not None:
        drawn = plan_service.resolve(plan_service.from_dict(request.plan.model_dump()))
        measures = Measures(**asdict(plan_service.measure(drawn)))
        plan_numbers = {
            "aisle_mm": measures.aisle_m * 1000,
            "rack_top_mm": measures.rack_top_m * 1000,
            "ramps": measures.ramps,
            "closed_racks": measures.closed_racks,
        }

    tasks = []
    for choice, part in zip(choices, result.tasks, strict=True):
        # масса груза с шага параметров, как на экране: без нее подбор берет среднюю из датасета
        load_kg = request.overrides.get(f"facilities.{request.facility_id}.operations.{choice.operation_id}.load_kg")
        solutions = selection_service.solutions(request.facility_id, choice.operation_id, plan_numbers, load_kg)
        tasks.append(
            TaskReport(
                operation=next(o for o in facility.operations if o.id == choice.operation_id),
                robot=next((s for s in solutions if s.robot_id == choice.robot_id), None),
                part=part,
                shift=_shift(request, choice.operation_id, choice.robot_id, part.sizing.fleet, choice.share)
                if extras
                else None,
            )
        )

    parameters = catalog_service.parameters(request.facility_id, operation_ids)
    # у сохраненной версии значения и источники берем из ее результата: каталог мог с тех пор поменяться
    used = {one.path: one for one in result.sources} if saved else {}
    for one in parameters:
        if one.path in request.overrides:
            one.value = request.overrides[one.path]
        elif isinstance(getattr(used.get(one.path), "value", None), int | float):
            source = used[one.path]
            one.value, one.source, one.trust = float(source.value), source.source, source.trust

    roles = {role.id: role.name for role in staff_service.roles()}
    lines = request.staff
    if lines is None:
        lines = list(staff_service.form(request.facility_id, operation_ids).lines)
    staff = [
        StaffRow(
            role=roles.get(line.role, line.role),
            headcount=line.headcount,
            filled=line.filled,
            salary_month=line.salary_month,
            contractor=line.contractor,
        )
        for line in lines
    ]

    return Report(
        sensitivity=sensitivity_service.sensitivity(request) if extras else None,
        sensitivity_all=sensitivity_service.sensitivity_all(request) if extras else None,
        created=created,
        request=request,
        result=result,
        facility=facility,
        tasks=tasks,
        parameters=parameters,
        staff=staff,
        measures=measures,
        labels={one.path: one.label for one in parameters},
        staff_names={line["id"]: roles.get(line["role"], line["role"]) for line in _config_staff(request.facility_id)},
        readiness=_readiness(request, result) if extras else None,
        data_version=data[0],
        data_note=readable_note(data[1]),
        saved=saved,
    )


def _shift(
    request: CalculationRequest, operation_id: str, robot_id: str, fleet: int, share: float = 1.0
) -> ShiftSummary | None:
    """Прогон смены задачи тем парком, что в расчете. Без лога для проигрывателя он идет около секунды
    даже на отборе с двумя сотнями роботов, поэтому считаем здесь, а не берем цифры с экрана"""
    if not request.use_simulation:
        return None
    from app.services import simulation

    # при смешанном парке смена и спрос считаются для доли задачи, отданной этому решению
    overrides = simulation.with_share(request.overrides, request.facility_id, operation_id, share)
    model, _ = calculation.model_with_overrides(overrides)
    facility = next(f for f in model["facilities"] if f["id"] == request.facility_id)
    operation = next(o for o in facility["operations"] if o["id"] == operation_id)
    plan = simulation.plan_for(
        request.facility_id, operation_id, request.plan.model_dump() if request.plan else None, request.overrides
    )
    run = simulation.run(
        request.facility_id,
        operation_id,
        robot_id,
        fleet,
        plan,
        False,
        simulation.slotted(facility),
        overrides,
    )
    kpi = run.kpi
    # у уборщика рейс это участок в квадратных метрах, у отбора несколько строк: итоги переводим в единицы задачи, как на экране
    size = simulation.per_trip(next(r for r in model["robots"] if r["id"] == robot_id), operation)
    return ShiftSummary(
        fleet=fleet,
        hours=model["engine"]["simulation"]["hours"],
        design_demand=simulation.design_demand(model, facility, operation),
        done=round(kpi.done * size),
        ops_per_hour=kpi.ops_per_hour * size,
        busy_share=kpi.busy_share,
        waiting_share=kpi.waiting_share,
        charging_share=kpi.charging_share,
        avg_cycle_s=kpi.avg_cycle_s,
        bottleneck=kpi.bottleneck,
        plan_known=plan.known,
    )


# Числа по-русски: неразрывный пробел между разрядами и запятая
def _readiness(request: CalculationRequest, result: CalculationResult) -> ReadinessResult:
    """Список подготовки склада тем же парком и по тому же плану, что расчет и экран"""
    from app.services import readiness

    return readiness.readiness(
        ReadinessRequest(
            facility_id=request.facility_id,
            tasks=[
                ReadinessTask(operation_id=operation, robots=robots)
                for operation, robots in _robots_by_task(result).items()
            ],
            plan=request.plan,
            overrides=request.overrides,
        )
    )


def _robots_by_task(result: CalculationResult) -> dict[str, list[ReadinessRobot]]:
    """Решения по задачам. В ответе расчета часть на каждое решение каждой задачи: у смешанного
    парка на одну задачу их несколько, у обычного одна"""
    found: dict[str, list[ReadinessRobot]] = {}
    for part in result.tasks:
        found.setdefault(part.operation_id, []).append(
            ReadinessRobot(robot_id=part.robot_id, fleet=part.sizing.fleet, share=part.share)
        )
    return found


def _config_staff(facility_id: str) -> list[dict]:
    """Штат объекта из конфигурации: у его строк свои номера, по ним находим роль"""
    model, _ = calculation.model_with_overrides({})
    facility = next((f for f in model["facilities"] if f["id"] == facility_id), {})
    return facility.get("staff", [])


def rub(value: float | None) -> str:
    if value is None:
        return "—"
    if abs(value) >= 1_000_000:
        return f"{mln(value)}\u00a0млн\u00a0₽"
    return f"{grouped(value)}\u00a0₽"


def unit_price(value: float) -> str:
    """Цена одной операции: до ста рублей с копейками, дальше целыми"""
    return f"{grouped(value, 1 if abs(value) < 100 else 0)} ₽"


def mln(value: float) -> str:
    return f"{value / 1_000_000:,.1f}".replace(",", "\u00a0").replace(".", ",")


def grouped(value: float, digits: int = 0) -> str:
    return f"{value:,.{digits}f}".replace(",", "\u00a0").replace(".", ",")


def buyout_cell(scenario) -> str:
    """Выкуп в конце договора аренды одной ячейкой: цена, год и через сколько окупится."""
    buyout = getattr(scenario, "buyout", None)
    if buyout is None:
        return "—"
    payback = "не окупается" if buyout.payback_years is None else f"окупится за {term(buyout.payback_years)}"
    return f"{rub(buyout.price_rub)} в конце {buyout.year} года, {payback}"


def term(value: float | None) -> str:
    if value is None:
        return "не окупается"
    rounded = round(value, 1)
    shown = f"{rounded:g}".replace(".", ",")
    if rounded != int(rounded):
        return f"{shown} года"
    whole = int(rounded)
    return f"{shown} {'год' if whole == 1 else 'года' if 2 <= whole <= 4 else 'лет'}"


def payback_words(scenario, horizon: int) -> str:
    """Окупаемость одной строкой, одинаково в PDF, Excel и сравнении (docs/decisions.md, "Срок службы
    и амортизация"): до горизонта срок как есть; дольше горизонта, но в пределах досчета до
    economics.later_payback_years, примерно в целых годах с пометкой; дальше "не окупается"."""
    within = scenario.payback_cumulative_years
    if within is not None:
        return term(within)
    later = getattr(scenario, "payback_later_years", None)
    if later is None:
        return "не окупается"
    return f"примерно {about_years(later, horizon)}, дольше горизонта расчета в {horizon} лет"


def percent(value: float | None) -> str:
    return "—" if value is None else f"{round(value * 100)}%"


def times(value: float | None) -> str:
    """Во сколько раз экономия за горизонт больше вложений: 3,9 раза. Не процентами, чтобы не путать с ROI."""
    return "—" if value is None else f"{value:.1f} раза".replace(".", ",")


def scenario_name(scenario) -> str:
    """Покупку в кредит и в лизинг так и называем, как сервер: "Покупка в кредит"."""
    financing = getattr(scenario, "financing", None)
    if scenario.id == "purchase" and financing is not None and financing.method != "own":
        return scenario.name
    return NAMES.get(scenario.id, scenario.name)


METHOD_NAMES = {"own": "свои деньги", "loan": "кредит", "leasing": "лизинг"}


def financed(scenario) -> bool:
    """Покупка в кредит или в лизинг: у нее две окупаемости и два IRR."""
    financing = getattr(scenario, "financing", None)
    return financing is not None and financing.method != "own"


def project_irr(scenario) -> tuple[float | None, float | None, float]:
    """IRR проекта: у покупки в кредит или лизинг как у покупки за свои деньги, без схемы оплаты."""
    if financed(scenario):
        plan = scenario.financing
        return plan.plain_irr, plan.plain_npv_rub, scenario.capex_after_grant_rub or 0.0
    return scenario.irr, scenario.npv_rub, scenario.investment_year0_rub


def irr_text(irr: float | None, npv: float | None, investment: float) -> str:
    """IRR словами. Выше 100% пишем "больше 100%": вложения возвращаются быстрее, чем за год,
    и точная ставка (у аренды на эталоне 209%) ничего не добавляет к окупаемости. Ставку выше
    1000% сервер не ищет и отдает пустой, при положительном NPV это тот же случай"""
    if investment <= 0:
        return "вложений нет"
    if irr is None:
        return "больше 100%" if npv is not None and npv > 0 else "не окупается"
    return "больше 100%" if irr > 1 else percent(irr)


def delta(value: float) -> str:
    """Сдвиг параметра в чувствительности: -20%, как сейчас, +10%"""
    if value == 0:
        return "как сейчас"
    return f"{'+' if value > 0 else '-'}{abs(value) * 100:.0f}%"


def valued(value: float | list[float], unit: str) -> str:
    """Число из списка источников с единицей. Переключатель хранится как 1 или 0, пишем словом"""
    if isinstance(value, list):
        text = " - ".join(number(v, 3) for v in value)
    elif unit.startswith("1 да"):
        return "да" if value else "нет"
    else:
        text = number(value, 3)
    return f"{text}\u00a0{unit}" if unit else text


def number(value: float, digits: int = 1) -> str:
    text = f"{value:,.{digits}f}".replace(",", "\u00a0").replace(".", ",")
    return text.rstrip("0").rstrip(",") if "," in text else text
