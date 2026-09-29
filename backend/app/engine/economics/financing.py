"""Как платим за покупку и что дает господдержка. Аренду не трогаем: у нее своя плата в месяц.

Способы (Дополнения к ТЗ, п. 2.1):
свои деньги  все вложения на старте из своих, так считает ТЗ по умолчанию
кредит       часть вложений берем в долг. Тело гасим равными долями каждый месяц, проценты с остатка:
             так по умолчанию у Сбера. Залог (купленные роботы) страхуем, пока долг не погашен
лизинг       лизинговая компания покупает роботов, зарядки и ПО, мы платим аванс и равные платежи
             и страхуем предмет лизинга. Интеграцию, инфраструктуру, пусконаладку и резерв она не
             финансирует, их платим сами

Две окупаемости, как в методических рекомендациях по оценке инвестпроектов (ВК 477, 1999):
с учетом долга   когда накопленный поток покрыл и свои деньги, и остаток долга. Главная: ее можно
                 сравнивать с покупкой за свои деньги и с арендой
своих денег      когда вернулся первый взнос. Показываем отдельной строкой: при маленьком взносе она
                 всегда короткая и сама по себе вводит в заблуждение

Поток своих денег: на старте вложения минус долг, дальше экономия минус платежи и страховка. От него
NPV и IRR своих денег; IRR проекта считается как у покупки за свои деньги. Проценты и страховка
входят в стоимость владения. CAPEX и простой срок окупаемости по ТЗ не меняются.

Если срок долга длиннее горизонта, остаток гасим в последний год горизонта: иначе часть долга
выпала бы из стоимости владения и сравнение с арендой стало бы нечестным.
Налог на прибыль и НДС не считаем ни в одном способе: если добавлять, то всем одинаково, иначе
"экономия на налогах" лизинга выглядела бы выгодой, а это разница во времени вычетов.
Формулы и пример руками в docs/calculation.md, раздел "Кредит, лизинг и господдержка".
"""

from __future__ import annotations

from dataclasses import dataclass, field

OWN, LOAN, LEASING = "own", "loan", "leasing"
METHODS = {0: OWN, 1: LOAN, 2: LEASING}
# статьи вложений, которые берет лизинговая компания: оборудование и лицензия
LEASED_ITEMS = ("hardware", "chargers", "software")
# что страхуем как залог или предмет лизинга: то, что можно потрогать, лицензию не страхуют
INSURED_ITEMS = ("hardware", "chargers")
# статьи, которые не считаем затратами на роботизацию при возврате части затрат: резерв это запас
# на непредвиденное, а не потраченные деньги, люди это не оборудование и не внедрение
NOT_REFUNDED = ("reserve", "retraining", "hiring")
# виды мер, которые считает этот модуль; capex_grant (доля вложений на старте) считает scenarios.subsidy_grant
KINDS = {"loan_rate", "leasing_advance_loan", "capex_refund"}
# как гасится тело долга
ANNUITY, EQUAL, GRACE = "annuity", "equal", "grace"


@dataclass
class Support:
    """Мера господдержки: отмечена ли, сработала ли, а если нет, почему. rub: сколько дала денег:
    возврат затрат, сэкономленные проценты или заем ФРП. blocked: мера недоступна нашим объектам."""

    id: str
    name: str
    kind: str
    chosen: bool
    applied: bool = False
    reason: str | None = None
    rub: float = 0.0
    blocked: str | None = None


@dataclass
class Financing:
    method: str
    rate: float = 0.0
    term_months: int = 0
    base_rub: float = 0.0  # что финансируем: вложения за вычетом гранта или оборудование в лизинг
    own_start_rub: float = 0.0  # свои деньги на старте по этому долгу: доля своих или аванс
    principal_rub: float = 0.0  # взяли в долг
    payments_rub: list[float] = field(default_factory=list)  # платежи по годам горизонта
    interest_rub: float = 0.0  # переплата: проценты или удорожание сверх цены
    advance_loan_rub: float = 0.0  # заем ФРП на аванс лизинга
    advance_loan_payments_rub: list[float] = field(default_factory=list)
    debt_left_rub: list[float] = field(default_factory=list)  # остаток всех долгов на конец года
    insurance_rub: list[float] = field(default_factory=list)  # страхование залога или предмета лизинга
    supports: list[Support] = field(default_factory=list)
    # годы, где экономия покрывает платежи по долгу меньше, чем нужно банку
    weak_cover_years: list[int] = field(default_factory=list)
    debt_cover: list[float | None] = field(default_factory=list)
    cover_min: float = 0.0
    # та же покупка за свои деньги и без мер: с чем сравнивать кредит, лизинг и поддержку
    plain_payback: float | None = None
    plain_npv: float | None = None
    plain_irr: float | None = None
    plain_tco: float = 0.0
    how: str = ANNUITY  # как гасится основной долг: равным платежом или телом равными долями

    @property
    def month_payments(self) -> tuple[float, float]:
        """Платеж в месяц по основному долгу, первый и последний, по той же формуле, что график."""
        return month_payments(self.principal_rub, self.rate, self.term_months, self.how)

    @property
    def markup_year(self) -> float | None:
        """Удорожание лизинга в год: (аванс + платежи) / цена - 1, деленное на срок в годах."""
        if self.method != LEASING or self.base_rub <= 0 or self.term_months <= 0:
            return None
        paid = self.own_start_rub + sum(self.payments_rub)
        return (paid / self.base_rub - 1) / (self.term_months / 12)


def annuity(principal: float, rate: float, months: int) -> float:
    """Равный платеж в месяц: долг * i / (1 - (1 + i)^-n), i = ставка / 12. Без ставки долг делим поровну."""
    if principal <= 0 or months <= 0:
        return 0.0
    i = rate / 12
    if i == 0:
        return principal / months
    return principal * i / (1 - (1 + i) ** -months)


def month_payments(principal: float, rate: float, months: int, how: str = ANNUITY) -> tuple[float, float]:
    """Первый и последний платеж в месяц по тем же формулам, что amortize.

    annuity  оба равны: долг * i / (1 - (1 + i)^-n), i = ставка / 12
    equal    тело долг / n каждый месяц, проценты с остатка: первый долг / n + долг * ставка / 12,
             последний долг / n + (долг / n) * ставка / 12, в последний месяц остаток равен одной доле тела
    Сколько платежей попадет в горизонт, здесь не важно: это то, что человек увидит в договоре."""
    if principal <= 0 or months <= 0:
        return 0.0, 0.0
    if how == ANNUITY:
        payment = annuity(principal, rate, months)
        return payment, payment
    body = principal / months
    return body + principal * rate / 12, body + body * rate / 12


def amortize(
    principal: float, rate: float, months: int, horizon: int, how: str = ANNUITY, grace: int = 0
) -> tuple[list[float], list[float]]:
    """Платежи по годам и остаток долга на конец каждого года.

    annuity  равный платеж каждый месяц
    equal    тело равными долями каждый месяц, проценты с остатка (дифференцированный график)
    grace    первые grace месяцев только проценты, дальше тело равными долями
    Долг за горизонтом гасим в последний год горизонта."""
    payment = annuity(principal, rate, months)
    repay_months = max(months - grace, 1)
    years, left = [0.0] * horizon, [0.0] * horizon
    balance = principal
    for year in range(horizon):
        for month in range(year * 12, year * 12 + 12):
            if month >= months or balance <= 1e-9:
                continue
            interest = balance * rate / 12
            if how == ANNUITY:
                body = payment - interest
            elif how == GRACE and month < grace:
                body = 0.0
            else:
                body = principal / (months if how == EQUAL else repay_months)
            body = min(body, balance)
            balance -= body
            years[year] += body + interest
        left[year] = balance
    if horizon and left[-1] > 1e-6:
        years[-1] += left[-1]
        left[-1] = 0.0
    return years, left


def schedule(principal: float, rate: float, months: int, horizon: int, how: str = ANNUITY) -> list[float]:
    """Только платежи по годам горизонта."""
    return amortize(principal, rate, months, horizon, how)[0]


def chosen_supports(model: dict, subsidy_ids: tuple[str, ...]) -> set[str]:
    """Отмеченные меры: из запроса (subsidy_ids) и правкой chosen = 1 на шаге экономики."""
    return set(subsidy_ids) | {s["id"] for s in model.get("subsidies", []) if s.get("chosen")}


def method_of(model: dict) -> str:
    value = model.get("financing", {}).get("method", 0)
    if value not in METHODS:
        raise ValueError("Способ оплаты: 0 свои деньги, 1 кредит, 2 лизинг")
    return METHODS[int(value)]


def plan(
    model: dict,
    capex: dict[str, float],
    capex_total: float,
    grant: float,
    horizon: int,
    chosen: set[str],
    registry: bool,
) -> tuple[Financing, list[float]]:
    """Способ оплаты с платежами по годам и деньги господдержки по годам (возврат затрат приходит позже)."""
    fin = model.get("financing") or {"method": 0}
    method = method_of(model)
    result = Financing(method)
    support_by_year = [0.0] * horizon
    measures = {s["id"]: s for s in model.get("subsidies", []) if s.get("kind") in KINDS}
    supports = {
        sid: Support(sid, s["name"], s["kind"], sid in chosen, blocked=s.get("blocked")) for sid, s in measures.items()
    }
    for support in supports.values():
        if support.chosen and support.blocked:
            support.reason = f"недоступна: {support.blocked}"
    result.supports = list(supports.values())
    equipment = sum(capex.get(item, 0.0) for item in LEASED_ITEMS)
    loan_left = [0.0] * horizon
    frp_left = [0.0] * horizon

    if method == LOAN:
        loan = fin["loan"]
        rate = loan["rate"]
        cheap = _pick(measures, supports, "loan_rate")
        if cheap is not None:
            # льготная ставка вместо рыночной, экономию считаем ниже, когда посчитан платеж
            rate = measures[cheap.id]["rate"]
        result.rate, result.term_months = rate, int(loan["term_months"])
        result.base_rub = max(capex_total - grant, 0.0)
        result.own_start_rub = result.base_rub * loan["own_share"]
        result.principal_rub = result.base_rub - result.own_start_rub
        result.how = EQUAL
        result.payments_rub, loan_left = amortize(result.principal_rub, rate, result.term_months, horizon, EQUAL)
        if cheap is not None:
            market = schedule(result.principal_rub, loan["rate"], result.term_months, horizon, EQUAL)
            cheap.applied, cheap.rub = True, sum(market) - sum(result.payments_rub)
    elif method == LEASING:
        lease = fin["leasing"]
        result.rate, result.term_months = lease["rate"], int(lease["term_months"])
        result.base_rub = equipment
        result.own_start_rub = equipment * lease["advance_share"]
        result.principal_rub = equipment - result.own_start_rub
        result.payments_rub, loan_left = amortize(result.principal_rub, result.rate, result.term_months, horizon)
        frp = _pick(measures, supports, "leasing_advance_loan")
        if frp is not None:
            terms = measures[frp.id]
            if not registry:
                frp.reason = "роботов нет в реестре российской промышленной продукции (постановление 719)"
            elif equipment < terms["min_project_rub"]:
                frp.reason = f"оборудование дешевле {terms['min_project_rub'] / 1e6:g} млн руб"
            else:
                loan_rub = min(result.own_start_rub * terms["advance_share"], equipment * terms["price_share"])
                # заем не дольше договора лизинга, тело в последние два года, до того только проценты
                months = min(int(terms["term_months"]), result.term_months)
                grace = min(int(terms.get("grace_months", 0)), months - 1)
                result.advance_loan_rub = loan_rub
                result.advance_loan_payments_rub, frp_left = amortize(
                    loan_rub, terms["rate"], months, horizon, GRACE, grace
                )
                frp.applied, frp.rub = True, loan_rub
    result.interest_rub = (
        sum(result.payments_rub)
        - result.principal_rub
        + sum(result.advance_loan_payments_rub)
        - result.advance_loan_rub
    )
    result.debt_left_rub = [a + b for a, b in zip(loan_left, frp_left, strict=True)]
    result.insurance_rub = _insurance(fin, capex, result, horizon)

    refund = _pick(measures, supports, "capex_refund")
    if refund is not None:
        others = [one for one in result.supports if one.applied and one is not refund]
        if others:
            refund.reason = f"не совмещается с другими мерами на тех же роботов: {others[0].name}"
        else:
            terms = measures[refund.id]
            base = capex_total - sum(capex.get(item, 0.0) for item in NOT_REFUNDED)
            rub = min(max(base, 0.0) * terms["share"], terms["cap_rub"])
            # возмещают уже оплаченные затраты: деньги приходят после запуска, плюс к потоку первого года
            support_by_year[0] += rub
            refund.applied, refund.rub = True, rub

    # мера отмечена, но способ оплаты не тот: говорим, почему она не сработала
    for support in result.supports:
        if support.chosen and not support.applied and support.reason is None:
            support.reason = {
                "loan_rate": "работает только с кредитом",
                "leasing_advance_loan": "работает только с лизингом",
            }.get(support.kind)
    return result, support_by_year


def _insurance(fin: dict, capex: dict[str, float], result: Financing, horizon: int) -> list[float]:
    """Страховка залога или предмета лизинга: доля цены роботов и зарядок в год, пока долг есть на начало года.
    За свои деньги страховку никто не требует, ее не считаем."""
    if result.method == OWN or result.principal_rub <= 0:
        return [0.0] * horizon
    insured = sum(capex.get(item, 0.0) for item in INSURED_ITEMS)
    share = fin.get("insurance_share_year", 0.0)
    owed = [result.principal_rub, *result.debt_left_rub[:-1]]  # долг на начало каждого года
    return [insured * share if start > 1e-6 else 0.0 for start in owed]


def cover(fin: dict, cash_before_debt: list[float], payments: list[float], result: Financing) -> None:
    """Покрытие долга по годам: поток до платежей по долгу / платежи. Банк смотрит на него при выдаче
    кредита: ниже порога (1,2 по Альт-Инвест) кредит могут не дать. Считаем только годы с платежами."""
    minimum = fin.get("debt_cover_min", 0.0) if fin else 0.0
    result.cover_min = minimum
    result.debt_cover = [
        cash / paid if paid > 1e-6 else None for cash, paid in zip(cash_before_debt, payments, strict=True)
    ]
    result.weak_cover_years = [
        t for t, ratio in enumerate(result.debt_cover, 1) if ratio is not None and ratio < minimum
    ]


def _pick(measures: dict, supports: dict[str, Support], kind: str) -> Support | None:
    """Первая отмеченная и доступная мера этого вида. Две льготные ставки к одному кредиту не складываются."""
    return next(
        (
            supports[sid]
            for sid, s in measures.items()
            if s["kind"] == kind and supports[sid].chosen and not supports[sid].blocked
        ),
        None,
    )
