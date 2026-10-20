"""Три сценария по ТЗ: без роботизации, покупка, роботы как услуга (аренда с возможностью выкупа).

Здесь только расчеты, без чтения файлов. Формулы и эталонный пример описаны в docs/calculation.md.
Если меняете формулу, обновите docs/calculation.md и пересчитайте эталон в Excel вручную,
не копируя то, что выдал код.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.engine.economics import metrics, ramp
from app.engine.economics.financing import KINDS, Financing
from app.engine.economics.fleet import (
    linear_throughput_curve,
    peak_demand,
    required_fleet,
    robot_ops_per_hour,
    route_length_m,
    station_service_s,
    work_share,
)
from app.engine.economics.staff import (
    Take,
    employee_full_cost,
    fte_per_post,
    line_cost,
    normative_fte,
    nothing_taken,
    robot_volume_per_day,
    scale_takes,
    takes_on_operation,
)
from app.errors import NotFound

BASELINE, PURCHASE, RAAS = "baseline", "purchase", "raas"


@dataclass
class Year:
    t: int
    staff_cost: float  # люди, которые остались на операции
    opex: dict[str, float]  # затраты на роботов, включая операторов
    effect: float  # экономия относительно сценария без роботов
    investment: float  # выкуп или обновление парка в этом году
    cash_flow: float  # effect - investment - financing + support
    amortization: float
    financing: float = 0.0  # платежи по кредиту или лизингу в этом году
    insurance: float = 0.0  # страховка залога или предмета лизинга: ее требует кредитор, это затрата способа оплаты
    support: float = 0.0  # господдержка, которая пришла в этом году, например возврат части затрат
    ramp: float = 0.0  # часть staff_cost: люди, которых отпускают не сразу, пока роботы выходят на режим

    @property
    def opex_total(self) -> float:
        return sum(self.opex.values())


@dataclass
class Scenario:
    id: str
    capex: dict[str, float] = field(default_factory=dict)
    capex_total: float = 0.0
    grant: float = 0.0
    years: list[Year] = field(default_factory=list)
    payback_simple: float | None = None
    payback_cumulative: float | None = None
    payback_band: str = ""
    roi_tz: float | None = None  # накопленный эффект / вложения, как в ТЗ
    roi_net: float | None = None  # (накопленный эффект - вложения) / вложения
    tco: float = 0.0
    npv: float | None = None
    irr: float | None = None
    financed: float = 0.0  # сколько вложений на старте взяли в долг или в лизинг
    debt_left: list[float] = field(default_factory=list)  # остаток долга на конец каждого года
    payback_own: float | None = None  # когда вернулся первый взнос; без долга равна payback_cumulative
    financing: Financing | None = None

    @property
    def investment_year0(self) -> float:
        """Свои деньги на старте: вложения минус грант минус то, что взяли в долг."""
        return self.capex_total - self.grant - self.financed

    @property
    def investment_total(self) -> float:
        """Все свои деньги на роботов за горизонт: старт, докупки и платежи по долгу, минус господдержка."""
        return self.investment_year0 + sum(y.investment + y.financing + y.insurance - y.support for y in self.years)

    @property
    def effect_total(self) -> float:
        return sum(y.effect for y in self.years)


@dataclass
class Sizing:
    """Общая часть для сценариев с роботами: спрос, парк, люди."""

    peak_demand: float
    design_demand: float
    route_m: float
    robot_rate: float  # операций в час в работе
    effective_rate: float  # с учетом коэффициента загрузки
    fleet: int
    fleet_capacity: float
    chargers: int
    stations: int
    operator_posts: float  # присмотр за роботами в постах, доля человека на объекте одновременно, в каждую смену
    operators_fte: float
    retrained_fte: float  # операторов роботов берем из высвобожденных людей
    operators_short_fte: float  # на сколько операторов высвобожденных не хватило
    fte_per_post: float
    fte_before: float
    fte_after: float
    takes: list[Take]  # что роботы забрали у каждой строки штата
    vacancies_closed_fte: float  # из забранного приходится на незанятые ставки
    people_freed_fte: float  # живые ставки, которые действительно высвобождаются
    worker_cost: float
    operator_cost: float
    # Упаковка у станций "товар к человеку": люди на ней те же до роботов и после, роботы эту работу
    # не забирают. В деньги идут в обе стороны, на эффект не влияют (docs/calculation.md, раздел 12.6)
    packing_fte: float = 0.0
    packing_places: int = 0
    packing_cost: float = 0.0

    @property
    def packing_per_shift(self) -> float:
        """Сколько человек на упаковке одновременно, в каждую смену, до роботов и после."""
        return self.packing_fte / self.fte_per_post if self.fte_per_post else 0.0

    @property
    def released_fte(self) -> float:
        """Сколько ставок освобождают роботы, до перевода части людей в операторы."""
        return self.fte_before - self.fte_after

    @property
    def people_per_shift_before(self) -> float:
        """Сколько человек делали эту работу одновременно, в каждую смену."""
        return self.fte_before / self.fte_per_post

    @property
    def people_per_shift_after(self) -> float:
        return self.fte_after / self.fte_per_post + self.operator_posts

    @property
    def released_net_fte(self) -> float:
        """Сколько ставок уходит с объекта: высвобожденные минус те, кто стал оператором роботов."""
        return self.released_fte - self.retrained_fte


@dataclass
class Comparison:
    feasible: bool
    peak_demand: float
    sizing: Sizing | None = None
    scenarios: dict[str, Scenario] = field(default_factory=dict)


def by_id(items: list[dict], item_id: str) -> dict:
    for item in items:
        if item["id"] == item_id:
            return item
    raise NotFound(f"Не нашли {item_id} в справочнике")


def growth(rate: float, t: int) -> float:
    return (1 + rate) ** (t - 1)


# --- Размер парка и люди ------------------------------------------------------


def size(
    model: dict,
    facility: dict,
    operation: dict,
    robot: dict,
    curve: list[float] | None,
    posts: int | None = None,
    route_m: float | None = None,
    fleet: int | None = None,
    share: float = 1.0,
) -> Sizing | None:
    """Парк и люди одной задачи или ее части.

    share: доля объема задачи у этого решения при смешанном парке. Спрос части это доля спроса
    задачи, а люди это доля того, что роботы забирают у штата на всей задаче."""
    econ = model["economics"]
    demand = peak_demand(operation, facility) * share
    design = demand * (1 + econ["peak_reserve_share"])
    route = route_length_m(operation, facility, model["engine"]["geometry"], route_m)
    rate = robot_ops_per_hour(robot, route, operation.get("ops_per_trip", 1), station_service_s(operation))
    effective = rate * work_share(robot)
    if fleet is not None:
        # Парк задан снаружи: так считают чувствительность к объему, где новый прогон смены
        # на каждый вариант шел бы минуту. Потолок тогда по формуле, он нужен только для подписи
        curve = linear_throughput_curve(effective, max(fleet, 1))
    elif curve is None:
        curve = linear_throughput_curve(effective, model["engine"]["max_fleet"])
    fleet = fleet if fleet is not None else required_fleet(design, curve)
    if fleet is None:
        return None

    hours = econ["annual_work_hours"]
    per_post = fte_per_post(facility, hours)
    payroll = econ["payroll"]
    takes = scale_takes(takes_on_operation(facility, model.get("roles", {}), operation, hours), share)
    if fleet == 0:
        # Ноль роботов: подбор или пользователь не дал ни одного. Работу делают люди, как раньше,
        # дежурные и станции не нужны (docs/decisions.md, "Ноль роботов")
        takes = [nothing_taken(t) for t in takes]
        posts = 0
    # В деньги идут только живые люди: незанятая ставка, которую закрыли роботы, зарплату не получала,
    # поэтому ни в базу "без роботов", ни в экономию она не входит. Ее работу роботы делают,
    # это видно в vacancies_closed_fte (docs/decisions.md, "Вакансии не деньги").
    before = sum(t.people_released for t in takes)
    after = sum(t.people_left for t in takes)
    productivity_after = operation.get("productivity_after")
    stations = (
        math.ceil(design / productivity_after) if fleet and productivity_after and robot.get("station_price_rub") else 0
    )
    # Когда задач несколько, дежурных считают на объект целиком и передают сюда готовое число.
    posts = operator_posts(facility, robot, fleet) if posts is None else posts
    operators = posts * per_post
    # Операторов роботов берем только из высвобожденных людей: своей ставки у этой роли нет,
    # нанимать ее с рынка модель не умеет (см. config/roles.yaml, robot_operator).
    freed = sum(t.people_freed for t in takes)
    retrained = min(operators, freed)
    packing_fte, packing_places, packing_cost = packing(model, facility, operation, design, share)
    return Sizing(
        peak_demand=demand,
        design_demand=design,
        route_m=route,
        robot_rate=rate,
        effective_rate=effective,
        fleet=fleet,
        fleet_capacity=curve[fleet],
        chargers=math.ceil(fleet / robot["robots_per_charger"]),
        stations=stations,
        operator_posts=posts,
        operators_fte=operators,
        retrained_fte=retrained,
        operators_short_fte=operators - retrained,
        fte_per_post=per_post,
        fte_before=before,
        fte_after=after,
        takes=takes,
        vacancies_closed_fte=sum(t.vacancies_closed for t in takes),
        people_freed_fte=freed,
        worker_cost=weighted_worker_cost(takes, payroll, people_only=True),
        operator_cost=weighted_worker_cost(takes, payroll, facility["operator_salary_premium"]),
        packing_fte=packing_fte,
        packing_places=packing_places,
        packing_cost=packing_cost,
    )


def packing(model: dict, facility: dict, operation: dict, design: float, share: float) -> tuple[float, int, float]:
    """Упаковка собранных строк у станций: ставки по норме, места под пик и стоимость ставки.

    Штук в сутки = строк, которые берут роботы, * штук на строку. Ставки по той же формуле, что
    у отборщиков (объем / выработка / фонд времени с потерями). Мест упаковки столько, чтобы пиковый
    поток с резервом, тот же, что у станций, успевал упаковываться. Нет блока packing: упаковки нет.
    """
    pack = operation.get("packing")
    if not pack:
        return 0.0, 0, 0.0
    econ = model["economics"]
    per_line = pack["pieces_per_line"]
    pieces_year = robot_volume_per_day(operation) * share * per_line * facility["schedule"]["days_per_year"]
    fte = normative_fte(pieces_year, pack["productivity"], econ["annual_work_hours"], facility["staff_loss_share"])
    places = math.ceil(design * per_line / pack["productivity"])
    salary = model.get("roles", {}).get(pack["role"], {}).get("salary_month", 0.0)
    return fte, places, employee_full_cost(salary, econ["payroll"])


def packing_staff_cost(model: dict, s: Sizing, t: int) -> float:
    """Упаковщики: одни и те же в базе и с роботами."""
    return s.packing_fte * s.packing_cost * growth(model["economics"]["wage_growth"], t)


def weighted_worker_cost(takes: list[Take], payroll: dict, premium: float = 0.0, people_only: bool = False) -> float:
    """Средняя стоимость ставки по тем строкам штата, у которых роботы забирают работу.

    Взвешиваем по забранным ставкам: если роботы взяли 20 ставок у одной роли и 3 у другой,
    средний оклад должен быть ближе к первой. people_only: вес только по живым людям, без закрытых
    вакансий, так стоимость сходится со ставками "без роботов". Если людей нет совсем, берем все забранное.
    """
    weights = [t.people_released if people_only else t.fte_taken for t in takes]
    if sum(weights) <= 0:
        weights = [t.fte_taken for t in takes]
    total = sum(weights)
    if total <= 0:
        return 0.0
    costs = 0.0
    for take, weight in zip(takes, weights, strict=True):
        line = StaffLineView(take.salary_month * (1 + premium), take.contractor)
        costs += weight * line_cost(line, payroll)
    return costs / total


@dataclass(frozen=True)
class StaffLineView:
    """Минимум, который нужен для стоимости ставки: оклад и признак подрядчика."""

    salary_month: float
    contractor: bool


def operator_posts(facility: dict, robot: dict, fleet: int) -> float:
    """Присмотр за роботами в постах: доля человека на объекте одновременно, в каждую смену.

    Робот ездит сам, человек нужен на разбор сбоев: робот встал, уронил груз, перегорожен проезд.
    Считаем от нагрузки, минут внимания на робота в час, и не округляем вверх: 9 роботов это 0,225
    поста, часть работы начальника смены или оператора соседней зоны, а не отдельный человек.
    Минимум дежурных на объекте выбирает пользователь, по умолчанию 0.
    """
    load_minutes = fleet * robot["operator_attention_min_per_hour"]
    return max(facility["min_operator_posts"], load_minutes / 60)


# --- CAPEX ----------------------------------------------------------------------


def implementation_costs(facility: dict, operation: dict) -> dict:
    """Затраты на внедрение: общие для объекта, но задача может их переопределить.

    Интеграция с WMS нужна транспортным роботам и не нужна уборочным, поэтому одна цифра
    на весь объект завышала бы стоимость простых задач в разы.
    """
    return {**facility["implementation"], **operation.get("implementation", {})}


def capex_items(
    model: dict, facility: dict, robot: dict, s: Sizing, scenario: str, operation: dict, shared: bool = True
) -> dict[str, float]:
    """Разовые затраты в год 0. При аренде роботы, зарядки и ПО входят в абонентскую плату.

    shared: считать ли общие для объекта затраты. Интеграция с учетной системой и переделка
    инфраструктуры делаются один раз, сколько бы задач клиент ни выбрал. Когда задач несколько,
    их несет первая, а остальные идут без них, иначе объект заплатит за интеграцию дважды.
    """
    impl = implementation_costs(facility, operation)
    hardware = s.fleet * robot["price_rub"]
    # постоянные статьи от размера проекта: у пилота на 1-2 робота они меньше, чем у проекта на 10
    scale = fixed_scale(facility, s.fleet)
    items = {
        "hardware": hardware if scenario == PURCHASE else 0.0,
        "chargers": s.chargers * robot["charger_price_rub"] if scenario == PURCHASE else 0.0,
        # ПО управления парком одно на производителя: у одной задачи оно ее, у нескольких задач
        # его считает блок общего на объект, по разу на каждого производителя
        "software": robot["software_rub"] * scale if scenario == PURCHASE and shared else 0.0,
        "stations": s.stations * robot.get("station_price_rub", 0),
        "integration": impl["integration_rub"] * scale if shared else 0.0,
        "infrastructure": impl["infrastructure_rub"] * scale if shared else 0.0,
        "commissioning": hardware * robot["commissioning_share"],
        "retraining": s.retrained_fte * impl["retraining_rub_per_person"],
    }
    items = without_vat(model, items)
    items["reserve"] = sum(items.values()) * model["economics"]["capex_reserve_share"]
    if not s.fleet:
        return dict.fromkeys(items, 0.0)  # роботов нет, внедрять нечего
    return items


def subsidy_grant(model: dict, subsidy_ids: tuple[str, ...], capex_total: float) -> float:
    total = 0.0
    for subsidy_id in subsidy_ids:
        subsidy = by_id(model["subsidies"], subsidy_id)
        if subsidy["kind"] in KINDS:
            continue  # эти меры считает financing.plan: они меняют ставку, аванс или приходят позже
        if subsidy["kind"] != "capex_grant":
            raise NotImplementedError(f"вид поддержки {subsidy['kind']!r} пока не поддержан")
        total += min(capex_total * subsidy["share"], subsidy["cap_rub"])
    return min(total, capex_total)


# --- Годы -----------------------------------------------------------------------


def running_costs(
    model: dict, facility: dict, robot: dict, s: Sizing, t: int, operator_share: float = 1.0, shared: bool = True
) -> dict[str, float]:
    """Затраты на роботов, которые есть в любом сценарии с роботами: энергия, связь, операторы.

    operator_share: сколько присмотра за парком остается на клиенте. При аренде часть берет поставщик.
    shared: связь и дежурные операторы общие на объект, а не на каждую задачу. Дежурный,
    который следит за транспортными роботами, следит и за уборочным, нанимать второго не нужно.
    """
    econ = model["economics"]
    schedule = facility["schedule"]
    hours = schedule["shifts"] * schedule["shift_hours"] * schedule["days_per_year"]
    costs = {
        "electricity": s.fleet
        * robot["avg_power_kw"]
        * hours
        * econ["energy_price_rub_kwh"]
        * growth(econ["energy_price_growth"], t),
        "communications": communications(facility, s.fleet) * growth(econ["inflation"], t) if shared else 0.0,
        "operators": s.operators_fte * s.operator_cost * growth(econ["wage_growth"], t) * operator_share
        if shared
        else 0.0,
    }
    return without_vat(model, costs)


def owner_costs(model: dict, robot: dict, s: Sizing, t: int, age: int, horizon: int) -> dict[str, float]:
    """Затраты владельца роботов: ТО и ремонт, лицензии, замена АКБ."""
    inflation = growth(model["economics"]["inflation"], t)
    hardware = s.fleet * robot["price_rub"]
    battery_due = age % robot["battery_life_years"] == 0 and age < robot["service_life_years"] and t < horizon
    return without_vat(
        model,
        {
            "maintenance": hardware * robot["maintenance_share_year"] * inflation,
            "licenses": s.fleet * robot["license_rub_year"] * inflation,
            "battery": s.fleet * robot["battery_price_rub"] * inflation if battery_due else 0.0,
        },
    )


# --- НДС, связь, масштаб постоянных вложений, пик и ночь людям ---------------------------------


def vat_factor(model: dict, item: str) -> float:
    """Во сколько раз статья меньше без НДС. Цены в модели с НДС; компания на общей системе налогов
    его возвращает, и статьи из economics.vat_items делим на 1 + ставка. Клиент без НДС (упрощенка)
    ставит economics.vat.with_vat = 1, тогда цены как есть (docs/decisions.md, «Цены без НДС»)."""
    econ = model["economics"]
    vat = econ.get("vat") or {}
    if not vat or vat.get("with_vat", 0) >= 0.5 or item not in econ.get("vat_items", ()):
        return 1.0
    return 1 / (1 + vat["rate"])


def without_vat(model: dict, items: dict[str, float]) -> dict[str, float]:
    return {key: value * vat_factor(model, key) for key, value in items.items()}


def fixed_scale(facility: dict, fleet: float) -> float:
    """Доля постоянных вложений (интеграция, инфраструктура, ПО парка) у проекта на fleet роботов.
    Даны для проекта около scale_ref_fleet роботов, у пилота меньше, но не меньше scale_min_share.
    Пример: 1 робот при 10 и минимуме 0,2 это 0,2, 13 роботов это 1, больше не растут."""
    impl = facility["implementation"]
    ref = impl.get("scale_ref_fleet")
    if not ref or not fleet:
        return 1.0 if fleet else 0.0
    return min(1.0, max(impl.get("scale_min_share", 0.0), fleet / ref))


def communications(facility: dict, fleet: float) -> float:
    """Связь роботов в год без индексации: от числа роботов, на робота communications_rub_year / scale_ref_fleet.
    При парке меньше communications_min_fleet не берем: на 1-2 робота хватает Wi-Fi склада."""
    impl = facility["implementation"]
    if not fleet or fleet < impl.get("communications_min_fleet", 0):
        return 0.0
    ref = impl.get("scale_ref_fleet")
    return impl["communications_rub_year"] * fleet / ref if ref else impl["communications_rub_year"]


def night_hours(model: dict, facility: dict) -> float:
    """Ночных часов в сутки (22:00-06:00, ТК РФ ст. 154): работа сверх дневного окна от начала первой смены до 22:00."""
    schedule = facility["schedule"]
    start = (model["economics"].get("peak_staffing") or {}).get("day_start_h", 6)
    return max(0.0, schedule["shifts"] * schedule["shift_hours"] - (22 - start))


def peak_and_night_cost(model: dict, facility: dict, operation: dict, s: Sizing, fte: float, t: int) -> float:
    """Сколько в год стоят людям пик и ночь сверх средней ставки (docs/calculation.md, раздел 4.4).

    Пик: людей держат под средний час, а в пиковые часы нужно в k_p раз больше. Часы сверх среднего
    закрывают временным персоналом: (k_p - 1) * людей в смену * часов пика * дней * ставка часа.
    У ровных задач (уборка) пика нет. Ночь: доля ночных часов в сутках * доплата * стоимость людей."""
    econ = model["economics"]
    peak = econ.get("peak_staffing") or {}
    if not peak or fte <= 0:
        return 0.0
    schedule = facility["schedule"]
    wages = growth(econ["wage_growth"], t)
    cost = 0.0
    if not operation.get("steady"):
        per_shift = fte / s.fte_per_post if s.fte_per_post else 0.0
        hours = model["engine"]["simulation"]["peak_hours"]
        extra = (facility["peak_factor"] - 1) * per_shift * hours * schedule["days_per_year"]
        cost += extra * peak["temp_rate_rub_hour"] * wages
    day = schedule["shifts"] * schedule["shift_hours"]
    if day > 0:
        night = peak["night_surcharge"] * night_hours(model, facility) / day
        cost += fte * own_staff_share(s) * s.worker_cost * wages * night
    return cost


def own_staff_share(s: Sizing) -> float:
    """Доля своих людей среди тех, у кого роботы забирают работу. Доплату за ночь (ТК РФ ст. 154) платит
    работодатель, а людям подрядчика мы платим цену договора за час, где все уже есть, как и взносы
    (staff.contractor_full_cost). Уборку отдают подряду, поэтому ночь ей не начисляем."""
    total = sum(t.people_released for t in s.takes)
    if total <= 0:
        return 0.0 if s.takes and all(t.contractor for t in s.takes) else 1.0
    return sum(t.people_released for t in s.takes if not t.contractor) / total


def baseline_staff_cost(
    model: dict, s: Sizing, t: int, facility: dict | None = None, operation: dict | None = None
) -> float:
    robots_take = s.fte_before * s.worker_cost * growth(model["economics"]["wage_growth"], t)
    extra = peak_and_night_cost(model, facility, operation, s, s.fte_before, t) if facility and operation else 0.0
    return robots_take + extra + packing_staff_cost(model, s, t)


def build_years(
    model: dict,
    facility: dict,
    robot: dict,
    s: Sizing,
    scenario: str,
    raas_buyout: bool,
    operation: dict,
    shared: bool = True,
) -> list[Year]:
    econ = model["economics"]
    horizon = econ["horizon_years"]
    # парк меняем по физическому сроку службы, а списываем по сроку амортизации: это разные сроки
    life = robot["service_life_years"]
    written_off = robot["amortization_years"]
    hardware = s.fleet * robot["price_rub"]
    raas = robot.get("raas") or {}
    term = raas.get("contract_months", 0) // 12
    if raas.get("contract_months", 0) % 12:
        raise ValueError("срок контракта аренды должен быть кратен 12 месяцам: расчет идет по годам")

    years = []
    for t in range(1, horizon + 1):
        inflation = growth(econ["inflation"], t)
        age = (t - 1) % life + 1  # возраст парка с учетом обновления
        renewal = hardware * inflation * vat_factor(model, "renewal") if t % life == 0 and t < horizon else 0.0
        rented = scenario == RAAS and not (raas_buyout and t > term)
        operator_share = 1 - raas["support_share"] if rented else 1.0
        opex = running_costs(model, facility, robot, s, t, operator_share, shared)
        investment = 0.0
        owned = scenario == PURCHASE or (raas_buyout and t > term)

        if owned:
            opex.update(owner_costs(model, robot, s, t, age, horizon))
            investment += renewal
            if scenario == PURCHASE:
                amortization = hardware_amortization(model, facility, robot, s, t, operation, shared)
            else:
                amortization = (
                    s.fleet * robot["price_rub"] * buyout_share(robot) / (written_off - term)
                    if t <= written_off
                    else 0.0
                )
        else:
            # Плата фиксирована на срок контракта, при продлении индексируется на инфляцию.
            renewal_index = (1 + econ["inflation"]) ** (term * ((t - 1) // term))
            opex["raas_fee"] = s.fleet * raas["fee_rub_month"] * 12 * renewal_index * vat_factor(model, "raas_fee")
            opex["damage"] = hardware * raas["damage_share_year"] * inflation * vat_factor(model, "damage")
            amortization = raas_setup_amortization(model, facility, robot, s, t, term, operation, shared)

        if scenario == RAAS and raas_buyout and t == term and term < horizon:
            investment += s.fleet * robot["price_rub"] * buyout_share(robot) * vat_factor(model, "buyout")
            # Физический срок службы кончился ровно к выкупу (договор 36 месяцев при сроке 3 года): роботов
            # выкупили изношенными, за 0, и владелец сразу обновляет парк, как при покупке.
            # Год выкупа еще аренда, поэтому обновление выше его не видит
            investment += renewal

        # люди, которые остались на операции, тоже работают в пик и ночью
        staff = (
            s.fte_after * s.worker_cost * growth(econ["wage_growth"], t)
            + peak_and_night_cost(model, facility, operation, s, s.fte_after, t)
            + packing_staff_cost(model, s, t)
        )
        base = baseline_staff_cost(model, s, t, facility, operation)
        # выход на режим: в первый год роботы дают не весь эффект, часть людей еще на операции
        waiting = (base - staff) * (1 - ramp.first_year_share(model, operation)) if t == 1 else 0.0
        staff += waiting
        effect = base - staff - sum(opex.values())
        row = Year(t, staff, opex, effect, investment, effect - investment, amortization)
        row.ramp = waiting
        years.append(row)
    return years


def buyout_share(robot: dict) -> float:
    """Выкуп по остаточной стоимости: цена * (1 - срок контракта / срок амортизации)."""
    return max(0.0, 1 - robot["raas"]["contract_months"] / 12 / robot["amortization_years"])


def hardware_amortization(
    model: dict, facility: dict, robot: dict, s: Sizing, t: int, operation: dict, shared: bool = True
) -> float:
    """Линейная амортизация всех вложений года 0 на срок амортизации робота."""
    life = robot["amortization_years"]
    capex = sum(capex_items(model, facility, robot, s, PURCHASE, operation, shared).values())
    return capex / life if t <= life else 0.0


def raas_setup_amortization(
    model: dict, facility: dict, robot: dict, s: Sizing, t: int, term: int, operation: dict, shared: bool = True
) -> float:
    """Разовый платеж за внедрение при аренде списываем линейно за срок контракта."""
    capex = sum(capex_items(model, facility, robot, s, RAAS, operation, shared).values())
    return capex / term if t <= term else 0.0


# --- Сборка -----------------------------------------------------------------------


def finish(model: dict, scenario: Scenario) -> Scenario:
    econ = model["economics"]
    cash = [-scenario.investment_year0] + [y.cash_flow for y in scenario.years]
    invested = scenario.investment_total
    # простой срок по ТЗ это показатель проекта: вложения целиком, как бы за них ни платили
    scenario.payback_simple = metrics.simple_payback(scenario.capex_total - scenario.grant, scenario.years[0].effect)
    scenario.payback_own = metrics.cumulative_payback(cash)
    # главная окупаемость с учетом долга: иначе кредит с маленьким взносом выглядел бы выгоднее своих денег
    scenario.payback_cumulative = (
        metrics.payback_with_debt(cash, [scenario.financed, *scenario.debt_left])
        if scenario.debt_left
        else scenario.payback_own
    )
    scenario.payback_band = metrics.payback_band(scenario.payback_cumulative, econ["payback_bands_years"])
    if invested > 0:
        scenario.roi_tz = scenario.effect_total / invested
        scenario.roi_net = (scenario.effect_total - invested) / invested
    scenario.tco = invested + sum(y.staff_cost + y.opex_total for y in scenario.years)
    scenario.npv = metrics.npv(econ["discount_rate"], cash)
    scenario.irr = metrics.irr(cash)
    return scenario


def evaluate(
    model: dict,
    facility_id: str,
    operation_id: str,
    robot_id: str,
    subsidy_ids: tuple[str, ...] = (),
    raas_buyout: bool = True,
    curve: list[float] | None = None,
    posts: int | None = None,
    shared: bool = True,
    route_m: float | None = None,
    fleet: int | None = None,
    share: float = 1.0,
) -> Comparison:
    facility = by_id(model["facilities"], facility_id)
    operation = by_id(facility["operations"], operation_id)
    robot = by_id(model["robots"], robot_id)
    s = size(model, facility, operation, robot, curve, posts, route_m, fleet, share)
    if s is None:
        return Comparison(feasible=False, peak_demand=peak_demand(operation, facility) * share)

    horizon = model["economics"]["horizon_years"]
    baseline = Scenario(BASELINE)
    for t in range(1, horizon + 1):
        baseline.years.append(Year(t, baseline_staff_cost(model, s, t, facility, operation), {}, 0.0, 0.0, 0.0, 0.0))

    baseline.tco = sum(y.staff_cost for y in baseline.years)

    result = Comparison(feasible=True, peak_demand=s.peak_demand, sizing=s, scenarios={BASELINE: baseline})
    # Аренду считаем только там, где у решения есть цена аренды. Для уборочных роботов
    # публичной цены подписки нет, и придумывать ее мы не будем: сценарий просто не выводится.
    available = (PURCHASE, RAAS) if robot.get("raas") else (PURCHASE,)
    for scenario_id in available:
        scenario = Scenario(scenario_id)
        scenario.capex = capex_items(model, facility, robot, s, scenario_id, operation, shared)
        scenario.capex_total = sum(scenario.capex.values())
        if scenario_id == PURCHASE:
            scenario.grant = subsidy_grant(model, subsidy_ids, scenario.capex_total)
        scenario.years = build_years(model, facility, robot, s, scenario_id, raas_buyout, operation, shared)
        result.scenarios[scenario_id] = finish(model, scenario)
    return result
