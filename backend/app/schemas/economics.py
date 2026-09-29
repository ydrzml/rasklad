"""Модели данных API расчета. Деньги в рублях, единица видна в названии поля."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.budget import BudgetCheck
from app.schemas.plan import Plan
from app.schemas.staff import MAX_STAFF_LINES, StaffLine


class SourceInfo(BaseModel):
    path: str = Field(description="Путь к значению в модели, например robots.ronavi-h1500.price_rub")
    value: float | list[float] = Field(description="Число, а у интервалов вывода пара чисел")
    source: str
    date: str | None
    trust: str = Field(description="Оценка доверия от S до F, см. docs/data-sources.md")
    unit: str = Field(default="", description="Единица значения: ₽, ₽ в месяц, доля, лет. Пусто у счетных величин")
    name: str = Field(default="", description='Название значения словами, как в отчете: "Ставка дисконтирования"')


class TaskChoice(BaseModel):
    """Задача объекта и решение, которое на нее выбрали.

    share: какая доля объема задачи отдана этому решению. Смешанный парк: одна задача встречается
    в списке дважды с разными роботами, доли в сумме дают единицу. У одного решения доля 1."""

    operation_id: str
    robot_id: str
    share: float = Field(default=1.0, gt=0, le=1, description="Доля объема задачи у этого решения, 0..1")

    @property
    def key(self) -> str:
        return f"{self.operation_id}:{self.robot_id}"


class CalculationRequest(BaseModel):
    facility_id: str = "warehouse"
    operation_id: str = Field(
        default="pallet_transport", description="Одна задача, старый вид запроса. Если есть tasks, не читается"
    )
    robot_id: str = Field(default="ronavi-h1500", description="Решение для operation_id. Если есть tasks, не читается")
    tasks: list[TaskChoice] = Field(
        default_factory=list,
        description=(
            "Задачи объекта с решением на каждую. Считаются вместе: дежурные операторы и внедрение общие "
            "на объект. Если список пустой, считаем одну задачу operation_id с решением robot_id"
        ),
    )
    overrides: dict[str, float] = Field(
        default_factory=dict,
        description="Значения, которые пользователь поправил вручную: путь к значению и новое число",
    )
    staff: list[StaffLine] | None = Field(
        default=None,
        max_length=MAX_STAFF_LINES,
        description=(
            "Штат объекта, который набрал пользователь. Замещает штат из конфигурации целиком. "
            "Если не прислан, считаем по отраслевым данным"
        ),
    )
    plan: Plan | None = Field(
        default=None,
        description=(
            "План объекта с третьего шага. От него берутся длина маршрута, места у ворот и ширина "
            "проезда. Если плана нет, маршрут оценивается по площади, и расчет получается грубее"
        ),
    )
    subsidy_ids: list[str] = Field(default_factory=list)
    raas_buyout: bool = Field(default=True, description="Выкупить роботов в конце контракта или продлить аренду")
    budget_rub: float | None = Field(
        default=None,
        gt=0,
        description="Бюджет на старте, если клиент его назвал: в ответе появится budget. Пусто: ничего не меняет",
    )
    use_simulation: bool = Field(
        default=False,
        description=(
            "Брать размер парка из прогона смены, а не из формулы: самый маленький парк, который вытянул "
            "спрос на всех seed. Приложение считает так всегда, формулу показывает рядом проверкой"
        ),
    )

    def choices(self) -> list[TaskChoice]:
        """Что считаем: список задач, а у старых запросов одна задача из operation_id и robot_id."""
        return self.tasks or [TaskChoice(operation_id=self.operation_id, robot_id=self.robot_id)]


class Sizing(BaseModel):
    """Парк и люди. По объекту из нескольких задач числа складываются, а спрос, маршрут и
    производительность у каждой задачи свои, в своих единицах: их смотрят в tasks, здесь они пустые."""

    fleet_source: str = Field(description="Откуда размер парка: формула или прогон смены")
    peak_demand_ops_per_hour: float | None
    design_demand_ops_per_hour: float | None
    route_m: float | None
    robot_ops_per_hour: float | None
    fleet: int
    formula_fleet: int = Field(
        default=0, description="Парк по формуле: спрос на рейсы робота с коэффициентом загрузки. Проверка руками"
    )
    fleet_capacity_ops_per_hour: float | None
    chargers: int
    stations: int
    operator_posts: int = Field(description="Сколько операторов на объекте одновременно, в каждую смену")
    operators_fte: float
    fte_per_post: float
    fte_before: float
    fte_after: float
    released_fte: float
    retrained_fte: float
    operators_short_fte: float = Field(description="На сколько операторов высвобожденных людей не хватило")
    vacancies_closed_fte: float = Field(description="Сколько незанятых ставок роботы закрыли вместо найма")
    people_freed_fte: float = Field(description="Живые ставки, которые высвобождаются: только они дают экономию")
    released_net_fte: float
    people_per_shift_before: float
    people_per_shift_after: float
    worker_cost_rub_year: float
    operator_cost_rub_year: float


class YearRow(BaseModel):
    year: int
    staff_cost_rub: float
    opex_rub: dict[str, float]
    opex_total_rub: float
    effect_rub: float
    investment_rub: float
    cash_flow_rub: float = Field(description="Поток своих денег: эффект - вложения - платежи по долгу + господдержка")
    amortization_rub: float
    financing_rub: float = Field(default=0.0, description="Платежи по кредиту или лизингу в этом году")
    support_rub: float = Field(default=0.0, description="Господдержка, пришедшая в этом году: возврат части затрат")
    insurance_rub: float = Field(default=0.0, description="Страховка залога или предмета лизинга, пока есть долг")
    ramp_rub: float = Field(
        default=0.0,
        description="Часть staff_cost_rub: люди, которых отпускают не сразу, пока роботы выходят на режим",
    )


class Amortization(BaseModel):
    """Как списываются стартовые вложения. В стоимость владения амортизация отдельно не входит:
    вложения там уже стоят целиком в год 0, иначе они посчитались бы дважды."""

    method: str = Field(default="линейная", description="Способ: равными долями по годам")
    base_rub: float = Field(description="Что списываем: стартовые вложения до господдержки")
    years: int | None = Field(
        description=(
            "На сколько лет: срок службы робота, а при аренде срок договора. Пусто, когда задач несколько "
            "и у их роботов сроки разные: каждая задача списывается на свой"
        )
    )
    per_year_rub: float = Field(description="Сколько в год: base_rub / years")
    after_buyout_base_rub: float | None = Field(
        default=None, description="Аренда с выкупом: цена выкупа, ее списываем на остаток срока службы"
    )
    after_buyout_years: int | None = None
    after_buyout_per_year_rub: float | None = None


class TcoPart(BaseModel):
    """Слагаемое стоимости владения за горизонт. Сумма слагаемых равна tco_rub."""

    id: str = Field(
        description=(
            "start: вложения на старте; later: выкуп и обновление парка; staff: люди, которые остались на "
            "операции; ramp: люди до выхода роботов на режим; financing: платежи по долгу; insurance: "
            "страховка залога или предмета лизинга; support: минус "
            "господдержка; остальное статьи затрат на роботов из opex_rub, сложенные за все годы"
        )
    )
    rub: float


class SupportResult(BaseModel):
    """Мера господдержки: условия, отмечена ли, сработала ли и сколько дала."""

    id: str
    name: str
    kind: str = Field(
        description="loan_rate: льготная ставка кредита; leasing_advance_loan: заем на аванс лизинга; "
        "capex_refund: возврат части затрат через год"
    )
    operator: str
    conditions: str
    chosen: bool = Field(description="Пользователь отметил меру")
    applied: bool = Field(description="Мера сработала в этом расчете")
    reason: str | None = Field(default=None, description="Почему отмеченная мера не сработала")
    rub: float = Field(default=0.0, description="Сколько дала: возврат, сэкономленные проценты или сумма займа")
    blocked: str | None = Field(default=None, description="Почему мера недоступна нашим объектам. Отметить ее нельзя")


class FinancingResult(BaseModel):
    """Как платим за покупку. Считает сервер, экран только раскладывает (docs/calculation.md)."""

    method: str = Field(description="own: свои деньги, loan: кредит, leasing: лизинг")
    rate: float = Field(default=0.0, description="Ставка в год: кредита (с льготой, если она сработала) или лизинга")
    term_months: int = 0
    base_rub: float = Field(default=0.0, description="Что финансируем: вложения за вычетом гранта или оборудование")
    own_start_rub: float = Field(default=0.0, description="Свои деньги по долгу на старте: доля своих или аванс")
    principal_rub: float = Field(default=0.0, description="Взяли в долг")
    payments_rub: list[float] = Field(default_factory=list, description="Платежи по долгу по годам горизонта")
    interest_rub: float = Field(default=0.0, description="Переплата сверх долга: проценты или удорожание")
    month_first_rub: float = Field(
        default=0.0,
        description=(
            "Платеж в месяц по основному долгу, первый. У лизинга равный платеж, у кредита тело равными долями "
            "и проценты с остатка, поэтому первый платеж самый большой"
        ),
    )
    month_last_rub: float = Field(default=0.0, description="Платеж в месяц по основному долгу, последний")
    term_max_months: int = Field(
        default=0, description="Самый долгий срок кредита или лизинга в предложениях банков, граница ползунка"
    )
    rate_max: float = Field(default=0.0, description="Граница ползунка ставки, доля в год")
    markup_year: float | None = Field(default=None, description="Удорожание лизинга в год, доля")
    advance_loan_rub: float = Field(default=0.0, description="Заем ФРП на аванс лизинга")
    supports: list[SupportResult] = Field(default_factory=list)
    plain_payback_years: float | None = Field(default=None, description="Та же покупка за свои деньги и без мер")
    plain_npv_rub: float | None = None
    plain_irr: float | None = Field(default=None, description="IRR проекта: покупка за свои деньги и без мер")
    debt_left_rub: list[float] = Field(default_factory=list, description="Остаток долга на конец каждого года")
    debt_cover: list[float | None] = Field(
        default_factory=list, description="Поток до платежей по долгу / платежи, по годам (DSCR). Пусто: платежей нет"
    )
    weak_cover_years: list[int] = Field(
        default_factory=list, description="Годы, где экономия покрывает платежи меньше, чем ждет банк"
    )
    debt_cover_min: float = Field(default=0.0, description="Порог покрытия, ниже которого банк может не дать кредит")
    plain_tco_rub: float = 0.0


class Verdict(BaseModel):
    band: str = Field(description="Интервал окупаемости: до 3 лет, 3-5 лет, более 5 лет или не окупается")
    text: str
    risks: list[str]


class ScenarioResult(BaseModel):
    id: str
    name: str
    capex_rub: dict[str, float]
    capex_total_rub: float
    grant_rub: float
    investment_year0_rub: float
    investment_total_rub: float
    years: list[YearRow]
    annual_effect_year1_rub: float | None
    effect_total_rub: float | None = Field(
        default=None, description="Экономия против работы без роботов, сложенная за все годы горизонта"
    )
    payback_simple_years: float | None = Field(description="По формуле ТЗ: вложения / эффект первого года")
    payback_cumulative_years: float | None = Field(
        description="По накопленному потоку, с ростом цен и выкупом. В кредит и в лизинг с учетом остатка долга"
    )
    payback_own_years: float | None = Field(
        default=None, description="Когда вернулся первый взнос своих денег. Без долга равна payback_cumulative_years"
    )
    payback_later_years: float | None = Field(
        default=None,
        description=(
            "Окупаемость на горизонте later_horizon_years, с заменой изношенных роботов. Считаем, только "
            "если за горизонт расчета не окупается. Пусто: не считали или не окупается и там"
        ),
    )
    roi_tz: float | None = Field(description="Накопленный эффект / вложения, как в ТЗ")
    roi_net: float | None = Field(description="(Накопленный эффект - вложения) / вложения")
    tco_rub: float
    cumulative_cost_rub: list[float] = Field(
        default_factory=list,
        description="Накопленные затраты на конец каждого года: первая точка это вложения на старте, последняя равна TCO",
    )
    running_cost_rub: float = Field(
        default=0.0,
        description="Затраты за горизонт без вложений на старте: люди, операторы, обслуживание, энергия, аренда, докупки",
    )
    saving_rub: float | None = Field(
        default=None, description="На сколько сценарий дешевле работы без роботов за горизонт: разница TCO"
    )
    npv_rub: float | None
    irr: float | None
    verdict: Verdict | None
    tco_parts: list[TcoPart] = Field(default_factory=list, description="Из чего сложилась стоимость владения")
    amortization: Amortization | None = Field(default=None, description="У сценария без роботов вложений нет")
    capex_after_grant_rub: float | None = Field(
        default=None, description="Вложения проекта на старте за вычетом гранта, как бы за них ни платили"
    )
    financing: FinancingResult | None = Field(default=None, description="Только у покупки: способ оплаты и меры")


class PartScenario(BaseModel):
    """Сценарий одной части объекта: задачи или общего на объект. Сумма частей равна объекту."""

    id: str
    investment_year0_rub: float = Field(description="Вложения на старте")
    capex_rub: dict[str, float] = Field(default_factory=dict, description="Статьи вложений на старте")
    opex_year1_rub: float = Field(description="Затраты на роботов за первый год, вместе с операторами")
    opex_year1_items_rub: dict[str, float] = Field(
        default_factory=dict, description="Те же затраты первого года по статьям: энергия, аренда, операторы"
    )
    staff_year1_rub: float = Field(description="Люди, которые остались на операции, за первый год")
    effect_year1_rub: float = Field(description="Экономия первого года против работы без роботов")
    tco_rub: float = Field(description="Стоимость владения за горизонт")
    payback_years: float | None = Field(
        default=None,
        description="Окупаемость части по накопленному потоку сама по себе, без общего на объект; пусто: не окупается",
    )
    saving_rub: float | None = Field(
        default=None, description="На сколько часть дешевле работы без роботов за горизонт; отрицательное: дороже"
    )


class TaskPart(BaseModel):
    """Задача объекта сама по себе: ее роботы и люди, без общих затрат на объект.
    При смешанном парке частей у задачи две, по одной на решение, каждая со своей долей объема."""

    operation_id: str
    operation_name: str
    robot_id: str
    share: float = Field(default=1.0, description="Доля объема задачи у этого решения")
    sizing: Sizing = Field(description="Парк задачи. Дежурных тут нет, они общие на объект")
    scenarios: list[PartScenario]


class SharedPart(BaseModel):
    """Общее на объект: интеграция с учетной системой, переделка инфраструктуры, связь и дежурные
    операторы с их переобучением. Делается один раз, сколько бы задач ни выбрали."""

    operator_posts: int = Field(description="Дежурных на объекте одновременно, на весь парк")
    operators_fte: float
    retrained_fte: float
    scenarios: list[PartScenario]


class PaymentProblem(BaseModel):
    path: str = Field(description="Правка шага экономики, которую расчет не взял")
    message: str = Field(description="Что с ней не так, словами для поля")


class PickingZone(BaseModel):
    """Отбор «товар к человеку» посчитан по робозоне, а не по плану человека под погрузчик."""

    operation_id: str
    area_m2: float = Field(description="Площадь робозоны, по которой считали отбор")
    fleet_on_plan: int | None = Field(
        default=None,
        description=(
            "Сколько роботов отбора понадобилось бы на плане человека по прогону смены. Пусто: прогон не "
            "гоняли (расчет по формуле) или на плане человека спрос не вытянуть и самым большим парком"
        ),
    )
    covered_on_plan: bool = Field(
        default=True, description="На плане человека парк вообще сходится. false: не сошелся и самым большим"
    )


class CalculationResult(BaseModel):
    model_version: str
    facility_id: str
    operation_id: str = Field(description="Первая задача расчета, как в старых ответах")
    robot_id: str = Field(description="Решение первой задачи")
    horizon_years: int
    later_horizon_years: int | None = Field(
        default=None,
        description="На сколько лет пересчитали сценарии, которые не окупаются за горизонт. Пусто: не пересчитывали",
    )
    feasible: bool
    message: str | None = None
    cause: Literal["plan", "solution"] | None = Field(
        default=None,
        description="Почему расчет не сошелся: plan, если причина в плане объекта, solution, если в решении",
    )
    sizing: Sizing | None = None
    scenarios: list[ScenarioResult] = Field(default_factory=list)
    sources: list[SourceInfo] = Field(default_factory=list)
    applied_overrides: dict[str, float] = Field(
        default_factory=dict, description="Что пользователь поправил вручную (ТЗ, п. 3.5.4)"
    )
    weak_value_paths: list[str] = Field(
        default_factory=list, description="Значения без подтвержденного источника или со спорными источниками"
    )
    budget: BudgetCheck | None = Field(
        default=None, description="Проверка бюджета на старте, только если клиент назвал budget_rub"
    )
    tasks: list[TaskPart] = Field(
        default_factory=list, description="Разбивка по задачам: сумма задач и shared дает объект целиком"
    )
    shared: SharedPart | None = Field(default=None, description="Общее на объект, одно на все задачи")
    picking_zones: list[PickingZone] = Field(
        default_factory=list,
        description="Задачи отбора, которые посчитали по робозоне: план человека под погрузчик. Пусто: все по плану",
    )
    notes: list[str] = Field(default_factory=list, description="Что расчет по объекту не смог сложить и почему")
    payment_problems: list[PaymentProblem] = Field(
        default_factory=list,
        description=(
            "Неверные условия оплаты, мер или выхода на режим. Расчет их не взял и посчитал без них, "
            "при неверном кредите или лизинге покупку за свои деньги"
        ),
    )


class SensitivityOutcome(BaseModel):
    scenario_id: str
    payback_years: float | None = Field(description="Окупаемость по накопленному потоку, None: не окупается")
    tco_rub: float
    saving_rub: float = Field(description="Насколько дешевле работы без роботов за горизонт, в этом же варианте")


class SensitivityCell(BaseModel):
    delta: float = Field(description="Сдвиг параметра: -0.2 это на 20% меньше")
    fleet: int = Field(description="Парк в этом варианте")
    baseline_tco_rub: float | None = Field(
        description="Работа без роботов за горизонт в этом варианте. None и пустые outcomes: парк не сходится"
    )
    outcomes: list[SensitivityOutcome]


class SensitivitySwing(BaseModel):
    scenario_id: str
    rub: float = Field(description="Размах выгоды за горизонт между вариантами от -20% до +20%, в рублях")


class SensitivityParam(BaseModel):
    id: str = Field(
        description="wages, robot_price, volume, raas_fee, implementation; в полном списке путь значения в модели"
    )
    name: str
    base: str = Field(description="От какого значения сдвигаем, словами с единицей")
    what: str = Field(description="Что меняется в расчете вместе с параметром")
    cells: list[SensitivityCell]
    values: list[float] = Field(
        default_factory=list,
        description="Каким число стало в каждом варианте, только в полном списке: доля выше 100% не поднимается",
    )
    swings: list[SensitivitySwing] = Field(
        default_factory=list, description="Сила влияния по сценариям, только в полном списке"
    )


class SensitivityResult(BaseModel):
    horizon_years: int
    deltas: list[float]
    params: list[SensitivityParam]


class SensitivityAll(BaseModel):
    horizon_years: int
    deltas: list[float]
    params: list[SensitivityParam] = Field(description="Числа, которые двигают итог, по убыванию силы влияния")
    flat: list[str] = Field(description="Названия чисел, которые при сдвиге до 20% итог не поменяли")
    zeros: list[str] = Field(description="Названия чисел, равных нулю: в процентах их не сдвинуть")
