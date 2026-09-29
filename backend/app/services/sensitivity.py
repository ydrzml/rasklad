"""Что будет, если (ТЗ, п. 3.5.6): одно число сдвигаем на -20, -10, +10 и +20%, остальные держим
и считаем заново окупаемость и стоимость владения покупки и аренды.

Две таблицы. Главная: четыре-пять чисел, которые чаще всего оказываются другими (зарплаты, цена
робота, объем, аренда, внедрение). Полная: каждое число с источником, которое участвует в расчете,
по одному, по убыванию силы влияния на выгоду за горизонт.

Парк. Экран берет парк из прогона смены, а прогон на каждый сдвиг не гоняем: он идет секунды,
а сдвигов сотни. Парк из прогона меняем во столько раз, во сколько по формуле меняется потребность
в роботах: скорость +20% по формуле дает 9,38 / 1,2 = 7,82 робота вместо 9,38, прогон давал 9,
значит 9 * 7,82 / 9,38 = 7,5, вверх 8. Для объема это то же, что парк растет вместе со спросом.
Без прогона парк заново считает формула.
"""

from __future__ import annotations

import copy
import math
from collections.abc import Callable

from app.engine.economics import BASELINE
from app.engine.economics.facility import FacilityResult, Task, evaluate_facility
from app.reports import names
from app.schemas.economics import (
    CalculationRequest,
    SensitivityAll,
    SensitivityCell,
    SensitivityOutcome,
    SensitivityParam,
    SensitivityResult,
    SensitivitySwing,
)
from app.services.calculation import (
    Impossible,
    Prepared,
    _by_id,
    _other_task,
    _prepare,
    _run,
    _set_by_path,
    _source_names,
    _used_paths,
    _value_by_path,
    check_possible,
)

DELTAS = (-0.2, -0.1, 0.0, 0.1, 0.2)

# В полный список не берем. Проверки "подходит или нет" решают, годится ли робот, а не сколько
# он стоит. Правила счета (горизонт, границы оценки, дисконт) это не данные объекта. Настройки
# прогона смены работают только в прогоне, а его на сдвиг не гоняем.
SKIP_PARTS = (".constraints.", "engine.selection.", "engine.simulation.")
SKIP_PATHS = (
    "economics.horizon_years",
    "economics.payback_bands_years",
    "economics.discount_rate",
    # выбор способа оплаты и порог покрытия долга: это не числа, которые бывают на 10% другими
    "financing.method",
    "financing.debt_cover_min",
)
# Целые числа, у которых 10% не бывает: 2 смены плюс 10% это не 2,2 смены
WHOLE = (
    # сроки кредита, лизинга, займа и выхода на режим в месяцах, отметка меры 0 или 1, порог проекта
    "months",
    "chosen",
    "min_project_rub",
    "schedule.shifts",
    "schedule.days_per_year",
    "contract_months",
    "service_life_years",
    "battery_life_years",
    "robots_per_charger",
    "min_operator_posts",
    "ops_per_trip",
    "slotted_by_turnover",
    "people_from_volume",
    # занятые места двигаются вместе с людьми в штате, отдельной строкой их нет
    ".filled",
)
# Прогон смены видит не все числа формулы. Загрузку робота он считает сам, очередями и зарядкой,
# а маршрут берет с плана: с прогоном эти два числа парк не двигают, и сдвигать их значит показать
# влияние, которого нет (журнал решений, раздел про допущения робота). Зато парк по прогону делится
# на долю роботов в строю, и ее двигаем только с прогоном: формула ее не читает.
FORMULA_ONLY = (".utilization", "engine.geometry.route_factor")
SHIFT_ONLY = ("engine.simulation.availability",)

# Доли не бывают больше единицы: 95% посильной роботам работы плюс 10% это 100%, а не 104,5%
CAPPED = ("_share", "utilization", "availability")


def sensitivity(request: CalculationRequest) -> SensitivityResult:
    """Главная таблица: зарплаты, цена робота, объем, аренда и внедрение."""
    run = _Runner(request)
    model = run.model
    choices = request.choices()
    facility = _by_id(model["facilities"], request.facility_id)
    operation_ids = list(dict.fromkeys(choice.operation_id for choice in choices))
    operations = [_by_id(facility["operations"], operation_id) for operation_id in operation_ids]
    robot_ids = list(dict.fromkeys(choice.robot_id for choice in choices))
    robots = [_by_id(model["robots"], robot_id) for robot_id in robot_ids]
    several = len(choices) > 1

    def wages(m: dict, k: float) -> None:
        for line in _by_id(m["facilities"], request.facility_id).get("staff", []):
            line["salary_month"] *= k

    def price(m: dict, k: float) -> None:
        for robot_id in robot_ids:
            _by_id(m["robots"], robot_id)["price_rub"] *= k

    def volume(m: dict, k: float) -> None:
        for operation_id in operation_ids:
            _by_id(_by_id(m["facilities"], request.facility_id)["operations"], operation_id)["volume_per_day"] *= k

    def fee(m: dict, k: float) -> None:
        for robot_id in robot_ids:
            robot = _by_id(m["robots"], robot_id)
            if robot.get("raas"):
                robot["raas"]["fee_rub_month"] *= k

    def implementation(m: dict, k: float) -> None:
        f = _by_id(m["facilities"], request.facility_id)
        # внедрение задачи сдвигаем один раз, даже если у нее два решения
        nodes = [f["implementation"]] + [
            _by_id(f["operations"], operation_id).get("implementation", {}) for operation_id in operation_ids
        ]
        for node in nodes:
            for key in ("integration_rub", "infrastructure_rub"):
                if key in node:
                    node[key] *= k

    def station_rate(m: dict, k: float) -> None:
        for operation in _by_id(m["facilities"], request.facility_id)["operations"]:
            if operation.get("productivity_after") and operation["id"] in operation_ids:
                operation["productivity_after"] *= k

    # интеграция и инфраструктура объекта это максимум по задачам (engine/economics/facility.py)
    impl = [{**facility["implementation"], **operation.get("implementation", {})} for operation in operations]
    impl_rub = max(one["integration_rub"] for one in impl) + max(one["infrastructure_rub"] for one in impl)
    params: list[tuple[str, str, str, str, Callable[[dict, float], None]]] = [
        (
            "wages",
            "Зарплаты",
            "оклады всех ролей в штате",
            "Дороже люди на операции без роботов и операторы роботов с ними: окупаемость лучше",
            wages,
        ),
        (
            "robot_price",
            "Цена робота",
            "цены роботов всех задач сразу" if several else f"{_grouped(robots[0]['price_rub'])} ₽ за робота",
            "С ценой меняются вложения, пусконаладка, ТО, выкуп после аренды и ответственность за порчу",
            price,
        ),
        (
            "volume",
            "Объем задачи",
            "объемы всех задач сразу" if several else f"{_grouped(operations[0]['volume_per_day'])} операций в сутки",
            "Больше работы, больше роботов. Людей на операции столько, сколько в штате: "
            "штат вы ввели сами, и от объема он не меняется",
            volume,
        ),
        (
            "implementation",
            "Внедрение",
            f"интеграция и инфраструктура {_grouped(impl_rub)} ₽",
            "Разовые затраты на старте: связь с учетной системой и переделка объекта. Цифр рынка нет, это оценка",
            implementation,
        ),
    ]
    # выработка на станции после роботизации: только у задач «товар к человеку», людей она двигает сильнее всего
    speedups = [op for op in operations if op.get("productivity_after")]
    if speedups:
        params.append(
            (
                "station_rate",
                "Выработка на станции",
                f"{_grouped(speedups[0]['productivity_after'])} операций в час на человека после роботизации",
                "Сколько людей остается на станциях: у производителей выработка в 2-3 раза выше нынешней, мы взяли осторожно",
                station_rate,
            )
        )
    if any(robot.get("raas") for robot in robots):
        params.insert(
            3,
            (
                "raas_fee",
                "Плата за аренду",
                "плата за аренду роботов всех задач сразу"
                if several
                else f"{_grouped(robots[0]['raas']['fee_rub_month'])} ₽ в месяц за робота",
                "Меняет только аренду: покупка от нее не зависит",
                fee,
            ),
        )

    return SensitivityResult(
        horizon_years=model["economics"]["horizon_years"],
        deltas=list(DELTAS),
        params=[
            SensitivityParam(id=pid, name=name, base=base_text, what=what, cells=run.cells(change))
            for pid, name, base_text, what, change in params
        ],
    )


def sensitivity_all(request: CalculationRequest) -> SensitivityAll:
    """Полная таблица: каждое число с источником по одному, по убыванию силы влияния.

    Сила влияния это размах выгоды за горизонт (насколько дешевле, чем без роботов) между
    вариантами от -20% до +20%, в рублях, у каждого сценария с роботами своя. Окупаемость для
    сортировки не годится: она бывает "не окупается" и у многих чисел одна и та же.
    """
    run = _Runner(request)
    model = run.model
    facility = _by_id(model["facilities"], request.facility_id)
    names_of = _source_names(facility)
    robot_ids = list(dict.fromkeys(choice.robot_id for choice in request.choices()))
    models = {robot_id: _by_id(model["robots"], robot_id)["model"] for robot_id in robot_ids}

    def label(path: str) -> str:
        # у двух решений свои цены и скорости: без названия робота строки не различить
        parts = path.split(".")
        if parts[0] == "robots" and len(models) > 1:
            return f"{names_of(path)}, {models.get(parts[1], parts[1])}"
        return names_of(path)

    moving: list[SensitivityParam] = []
    flat: list[str] = []
    zeros: list[str] = []
    for path in _paths(request, run.prepared, facility):
        value = _value_by_path(model, path)
        name = _label(path, label)
        if value == 0:
            zeros.append(name)
            continue
        param = SensitivityParam(
            id=path,
            name=name,
            base=_value_text(path, value),
            what="",
            cells=run.cells(_shift(path, value, request.facility_id)),
            values=[_shifted(path, value, 1 + delta) for delta in DELTAS],
        )
        param.swings = _swings(param.cells)
        if any(swing.rub > 1 for swing in param.swings):
            moving.append(param)
        else:
            flat.append(name)
    # по покупке: она есть всегда, а аренда только у тех, кто ее публикует. Экран сортирует по открытому сценарию
    moving.sort(key=lambda param: -max((s.rub for s in param.swings), default=0))
    return SensitivityAll(
        horizon_years=model["economics"]["horizon_years"],
        deltas=list(DELTAS),
        params=moving,
        flat=flat,
        zeros=zeros,
    )


class _Runner:
    """Основной расчет один раз, дальше сдвиги по одному с парком по правилу из шапки файла."""

    def __init__(self, request: CalculationRequest):
        self.request = request
        self.prepared: Prepared = _prepare(request)
        if self.prepared.refused:
            raise Impossible(self.prepared.refused)
        self.model = self.prepared.model
        self.base = _run(request, self.prepared, self.model)
        if not self.base.feasible:
            raise Impossible("Расчет не сошелся, менять в нем нечего")
        self.fleets = {key: task.sizing.fleet for key, task in self.base.tasks.items()}
        self.need = self._need(self.model) if self.prepared.curves else None

    def cells(self, change: Callable[[dict, float], None]) -> list[SensitivityCell]:
        return [_cell(delta, self.base if delta == 0 else self._shifted(change, 1 + delta)) for delta in DELTAS]

    def _shifted(self, change: Callable[[dict, float], None], k: float) -> FacilityResult:
        changed = copy.deepcopy(self.model)
        change(changed, k)
        try:
            check_possible(changed)
        except Impossible:
            # сдвиг дал невозможный объект, например больше 24 часов работы в сутки: считать нечего
            return FacilityResult(feasible=False)
        return _run(self.request, self.prepared, changed, self._fleets(changed))

    def _need(self, model: dict) -> dict[str, float] | None:
        """Потребность в роботах по формуле, дробью: спрос с резервом на производительность робота."""
        result = evaluate_facility(
            model,
            self.request.facility_id,
            [Task(choice.operation_id, choice.robot_id, choice.share) for choice in self.request.choices()],
            tuple(self.request.subsidy_ids),
            self.request.raas_buyout,
            None,
            self.prepared.route_m,
        )
        if not result.feasible:
            return None
        return {
            key: task.sizing.design_demand / task.sizing.effective_rate
            for key, task in result.tasks.items()
            if task.sizing and task.sizing.effective_rate > 0
        }

    def _fleets(self, model: dict) -> dict[str, int] | None:
        if not self.need:
            return None  # без прогона парк считает формула
        need = self._need(model)
        if need is None:
            return None
        # парк по прогону это работающие роботы, деленные на долю в строю: 0,9 -> 0,8 дает 9 * 0,9 / 0,8
        available = _availability(self.model) / _availability(model)
        out = {}
        for key, fleet in self.fleets.items():
            if key in need and self.need.get(key):
                # 1e-6: отношение 1,0000000001 не должно добавлять робота
                out[key] = max(1, math.ceil(fleet * need[key] / self.need[key] * available - 1e-6))
        return out


def _availability(model: dict) -> float:
    return model["engine"]["simulation"]["availability"]


def _paths(request: CalculationRequest, prepared: Prepared, facility: dict) -> list[str]:
    """Числа, которые двигаем: с источником из конфигурации, правки человека и его штат."""
    used = _used_paths(request, prepared.model)
    paths = [
        path
        for path in sorted(prepared.provenance)
        if path.startswith(used)
        and not _other_task(path, request)
        and _wanted(path, bool(prepared.curves))
        and _numeric(_value_by_path(prepared.model, path))
    ]
    # Штат человек вводит сам, и источника у него нет, но это тоже данные: оклад и людей на роли
    for line in facility.get("staff", []):
        base = f"facilities.{request.facility_id}.staff.{line['id']}"
        for key in ("salary_month", "headcount"):
            if f"{base}.{key}" not in paths and _numeric(line.get(key)):
                paths.append(f"{base}.{key}")
    return paths


def _wanted(path: str, with_shift: bool) -> bool:
    """Двигаем ли число: не правило счета, не целое, и расчет с прогоном или без его видит."""
    if path in SKIP_PATHS or any(path.endswith(tail) for tail in WHOLE):
        return False
    if path in SHIFT_ONLY:
        return with_shift
    if with_shift and any(path.endswith(tail) for tail in FORMULA_ONLY):
        return False
    return not any(part in f".{path}." for part in SKIP_PARTS)


def _numeric(value) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _shifted(path: str, value: float, k: float) -> float:
    """Каким число стало в варианте: людей целым, доли не выше единицы."""
    if path.endswith(".headcount"):
        return _whole(value * k)
    if any(part in path.rsplit(".", 1)[-1] for part in CAPPED) and value <= 1:
        return min(value * k, 1.0)
    return value * k


def _shift(path: str, value: float, facility_id: str) -> Callable[[dict, float], None]:
    def change(m: dict, k: float) -> None:
        if path.endswith(".headcount"):
            # людей целым числом, и занятые места вместе с ними: 25 человек -10% это 23, а не 22,5
            line_id = path.split(".")[-2]
            line = _by_id(_by_id(m["facilities"], facility_id)["staff"], line_id)
            line["headcount"] = _whole(line["headcount"] * k)
            if line.get("filled") is not None:
                line["filled"] = min(line["headcount"], _whole(line["filled"] * k))
            return
        _set_by_path(m, path, _shifted(path, value, k))

    return change


def _whole(value: float) -> int:
    return math.floor(value + 0.5)


def _swings(cells: list[SensitivityCell]) -> list[SensitivitySwing]:
    by_scenario: dict[str, list[float]] = {}
    for cell in cells:
        for outcome in cell.outcomes:
            by_scenario.setdefault(outcome.scenario_id, []).append(outcome.saving_rub)
    return [SensitivitySwing(scenario_id=sid, rub=max(v) - min(v)) for sid, v in by_scenario.items()]


def _label(path: str, label: Callable[[str], str]) -> str:
    if path == "engine.simulation.availability":
        return "Роботов в строю"  # так поле названо на шаге экономики
    if path.endswith(".headcount"):
        return label(path).replace("Мест в штате", "Людей в штате", 1)
    return label(path)


def _value_text(path: str, value: float) -> str:
    unit = names.unit(path)
    if unit.startswith("доля"):
        rest = unit.removeprefix("доля").strip()
        return f"{value * 100:g}%".replace(".", ",") + (f" {rest}" if rest else "")
    number = _grouped(value) if abs(value) >= 100 else f"{value:g}".replace(".", ",")
    return f"{number} {unit}".strip()


def _cell(delta: float, result: FacilityResult) -> SensitivityCell:
    if not result.feasible:
        # объем вырос, и парк не сходится: сценариев с роботами в этом варианте нет
        return SensitivityCell(delta=delta, fleet=0, baseline_tco_rub=None, outcomes=[])
    baseline = result.scenarios[BASELINE].tco
    return SensitivityCell(
        delta=delta,
        fleet=sum(task.sizing.fleet for task in result.tasks.values() if task.sizing),
        baseline_tco_rub=baseline,
        outcomes=[
            SensitivityOutcome(
                scenario_id=scenario_id,
                payback_years=scenario.payback_cumulative,
                tco_rub=scenario.tco,
                saving_rub=baseline - scenario.tco,
            )
            for scenario_id, scenario in result.scenarios.items()
            if scenario_id != BASELINE
        ],
    )


def _grouped(value: float) -> str:
    return f"{value:,.0f}".replace(",", " ")
