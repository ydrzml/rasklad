"""Перебор медицинских парков с проверкой на новых потоках.

Уборщики в текущей модели не конкурируют с доставщиками за ресурсы: их компоненты
прогоняются отдельно, фактические трудозатраты складываются. Параметры не подгоняются.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, replace
from itertools import product

from app.engine.clinic.optimization import efficient_counts, failures, rank, service, worst
from app.errors import NotFound
from app.schemas import clinic as schema
from app.services import clinic, clinic_conditions, clinic_money, facility_catalog
from app.services.clinic_contract import checked_overrides, from_schema

VALIDATION_SEEDS = (101, 307, 907)
MIN_CASH_GAIN_RUB = 0.01


def payback(accounts, payment):
    """Плюс в деньгах и устойчивый возврат вложений на каждом прогоне, без подгонки входов."""
    scenarios = [next(s for s in account.scenarios if s.id == payment) for account in accounts]
    terms = [one.payback_years for one in scenarios]
    term = max(terms) if terms and all(value is not None for value in terms) else None
    horizon = accounts[0].horizon_years
    gain = min(one.saving_rub for one in scenarios)
    reasons = []
    if gain <= MIN_CASH_GAIN_RUB:
        reasons.append(f"Нет положительной денежной экономии за {horizon} лет: худший результат {gain:,.0f} ₽")
    if term is None or term > horizon:
        reasons.append(f"Устойчивая окупаемость за {horizon} лет не достигнута во всех прогонах")
    return term, reasons


def worst_payback(before, after):
    return max(before, after) if before is not None and after is not None else None


class BudgetReached(Exception):
    pass


@dataclass
class Component:
    runner: clinic.Prepared
    fleet: int
    cleaners: dict[int, int]


def merge(delivery: clinic.Outcome | None, cleaning: clinic.Outcome | None) -> clinic.Outcome:
    if delivery is None:
        return cleaning
    if cleaning is None:
        return delivery
    return replace(
        delivery,
        cleaner=cleaning.cleaner,
        cleaners=cleaning.cleaners,
        checks=delivery.checks + cleaning.checks,
        kpi=replace(delivery.kpi, cleaned_m2=cleaning.kpi.cleaned_m2, cleaning=cleaning.kpi.cleaning),
        result=replace(
            delivery.result,
            cleaning=cleaning.result.cleaning,
            cleaners=cleaning.result.cleaners,
            manual_door_assists=delivery.result.manual_door_assists + cleaning.result.manual_door_assists,
            cleaner_door_assists=cleaning.result.cleaner_door_assists,
        ),
    )


class Search:
    def __init__(self, request: schema.OptimizationRequest):
        self.request = request
        self.start = time.perf_counter()
        self.deadline = self.start + request.time_budget_s * 0.55
        self.training = tuple(clinic.config()["engine"]["seeds"])
        unused = [seed for seed in VALIDATION_SEEDS if seed not in self.training]
        fallback = 10001
        while len(unused) < 3:
            if fallback not in self.training and fallback not in unused:
                unused.append(fallback)
            fallback += 1
        self.validation = tuple(unused[:3])
        self.building = from_schema(request.building) if request.building else clinic.demo()
        self.overrides = checked_overrides(request.overrides)
        self.tasks = [one for one in schema.TASKS if one in request.operation_ids]
        if not self.tasks:
            raise clinic.BadInput("Подбор доступен для доставки и уборки коридоров")
        self.cache: dict[tuple, clinic.Outcome] = {}
        self.simulations = 0
        self.excluded: list[str] = []
        self.complete = True
        self.physical: dict[str, tuple[Component | None, Component | None]] = {}
        self.conditions: dict[str, list[str]] = {}
        self.profiles = [schema.StressProfile(id="nominal", name="Исходные условия"), *request.stress_profiles]
        self.adjusted: dict[tuple[int, str], Component] = {}

    def budget(self):
        if time.perf_counter() >= self.deadline:
            self.complete = False
            raise BudgetReached

    def run(self, component: Component, seed: int):
        runner = component.runner
        key = (
            runner.condition_id,
            runner.robot.id if runner.delivering else "",
            runner.cleaner.id if runner.cleaning else "",
            component.fleet,
            tuple(sorted(component.cleaners.items())),
            seed,
        )
        if key not in self.cache:
            self.budget()
            self.cache[key] = runner.run(component.fleet, component.cleaners, seed)
            self.simulations += 1
        return self.cache[key]

    def component(self, base, profile):
        if base is None or profile.id == "nominal":
            return base
        key = (id(base.runner), profile.id)
        if key not in self.adjusted:
            self.adjusted[key] = Component(clinic_conditions.prepare(base.runner, profile), 0, {})
        return replace(self.adjusted[key], fleet=base.fleet, cleaners=base.cleaners)

    def trials(self, component, seeds):
        for profile in self.profiles:
            adjusted = self.component(component, profile)
            for seed in seeds:
                yield profile, self.run(adjusted, seed)

    def options(self, task, ids):
        catalog = clinic.robots(task)
        details = {r.id: r for r in facility_catalog.solutions(clinic.FACILITY, [task], self.overrides).solutions}
        if ids is not None and (not ids or set(ids) - {r.id for r in catalog}):
            raise clinic.BadInput("В списке подбора нет доступных моделей этой задачи")
        runners = []
        for robot in catalog:
            if ids is not None and robot.id not in ids:
                continue
            if robot.spec is None or facility_catalog.price(robot.id)[0] is None:
                self.excluded.append(f"{robot.product}: нет характеристик или цены")
                continue
            self.budget()
            try:
                row = details[robot.id]
                self.conditions[robot.id] = [f"{robot.product}: {row.limits}"] if row.limits else []
                if row.status == "needs_check":
                    self.conditions[robot.id].append(f"{robot.product}: условия внедрения требуют проверки по каталогу")
                runner = clinic.Prepared(
                    self.building,
                    robot_id=robot.id if task == clinic.DELIVERY else clinic.DEFAULT_DELIVERY,
                    cleaner_id=robot.id if task == clinic.CLEANING else None,
                    overrides=self.overrides,
                    operation_ids=[task],
                )
            except (clinic.BadInput, NotFound) as error:
                self.excluded.append(f"{robot.product}: {error}")
                continue
            if (
                task == clinic.DELIVERY
                and runner.has_demand
                and any(c.code in ("ward_unreachable", "process_unreachable") for c in runner.checks)
            ):
                self.excluded.append(f"{robot.product}: часть постов недоступна по плану")
                continue
            runners.append(runner)
        return runners

    def delivery(self):
        if clinic.DELIVERY not in self.tasks:
            return [None]
        found = []
        runners = self.options(clinic.DELIVERY, self.request.delivery_ids)
        try:
            for count, runner in product(range(1, self.request.max_delivery_fleet + 1), runners):
                if not runner.has_demand and count > 1:
                    continue
                component = Component(runner, count if runner.has_demand else 0, {})
                scores = [service(out) for _, out in self.trials(component, self.training)]
                if not failures(worst(scores), self.request):
                    found.append(component)
        except BudgetReached:
            pass
        return found

    def cleaning(self):
        if clinic.CLEANING not in self.tasks:
            return [None]
        found = []
        try:
            for runner in self.options(clinic.CLEANING, self.request.cleaner_ids):
                options = []
                defaults = clinic.config()["money"]
                given = self.request.assumptions.model_dump(exclude_none=True)
                preparation = given.get("cleaner_support_min_per_shift", defaults["cleaner_support_min_per_shift"])
                door = given.get("manual_door_assist_s", defaults["manual_door_assist_s"])
                for floor, area in runner.areas.items():
                    if area <= 0:
                        continue
                    feasible = []
                    for count in range(1, self.request.max_cleaners_per_floor + 1):
                        component = Component(runner, 0, {floor: count})
                        values = []
                        support = []
                        for profile, out in self.trials(component, self.training):
                            row = next(one for one in out.kpi.cleaning if one.floor == floor)
                            values.append(row.done_m2 / row.area_m2)
                            support.append(
                                (count * preparation / 60 + out.result.cleaner_door_assists * door / 3600)
                                * profile.support_factor
                            )
                        if min(values) + 1e-9 >= self.request.cleaning_target:
                            feasible.append((count, tuple(support)))
                    if not feasible:
                        break
                    options.append([(floor, one[0]) for one in efficient_counts(feasible)])
                if len(options) != sum(area > 0 for area in runner.areas.values()):
                    self.excluded.append(
                        f"{runner.cleaner.product}: требуемая уборка недостижима при ограничении парка"
                    )
                    continue
                for distribution in product(*options):
                    component = Component(runner, 0, dict(distribution))
                    if not failures(
                        worst([service(out) for _, out in self.trials(component, self.training)]), self.request
                    ):
                        found.append(component)
        except BudgetReached:
            pass
        return found

    def outcomes(self, d, c, seeds, profile=None):
        if profile:
            d, c = self.component(d, profile), self.component(c, profile)
        return [merge(self.run(d, seed) if d else None, self.run(c, seed) if c else None) for seed in seeds]

    def accounts(self, d, c, outcomes, profile=None):
        request = schema.MoneyRequest(
            operation_ids=self.tasks,
            building=self.request.building,
            overrides=self.overrides,
            robot_id=d.runner.robot.id if d else clinic.DEFAULT_DELIVERY,
            cleaner_id=c.runner.cleaner.id if c else clinic.DEFAULT_CLEANER,
            assumptions=self.request.assumptions,
            quotes=self.request.quotes,
        )
        if profile:
            request = clinic_conditions.accounts(request, profile)
        accounts = []
        for outcome in outcomes:
            self.budget()
            accounts.append(clinic_money.estimate(request, outcome=outcome, include_sources=False))
        return accounts

    @staticmethod
    def balance(account):
        return (
            account.people.hours_per_year
            - account.people.extra_hours_per_shift
            * account.assumptions["days_per_year"]
            * clinic.config()["money"]["shifts_counted"]
        )

    def assessment(self, profile, score, accounts, payment):
        values = [-next(s for s in account.scenarios if s.id == payment).saving_rub for account in accounts]
        balances = [self.balance(account) for account in accounts]
        return schema.CaseAssessment(
            profile=profile,
            training=score,
            incremental_cost_range_rub=(min(values), max(values)),
            labour_balance_range_hours=(min(balances), max(balances)),
            payback_years=payback(accounts, payment)[0],
            runs=len(accounts),
        )

    def financial_conditions(self, account):
        values = account.assumptions
        result = []
        entered = self.request.assumptions.model_dump(exclude_none=True)
        if "integration_rub" not in entered or "extra_annual_rub" not in entered:
            result.append(
                "Смета неполная: интеграция или дополнительная эксплуатация не оценены. Диапазон затрат не учитывает неизвестные сметы"
            )
        if values["cash_realization_share"] > 0 and "cash_realization_share" not in entered:
            result.append(
                "Бюджет сокращают только целые высвобожденные ставки, без увольнений за счет текучести; подтвердите это штатным планом учреждения"
            )
        elif values["cash_realization_share"] > 0:
            result.append(
                "Сокращение бюджета задано допущением пользователя; опубликованные кейсы не подтверждают сокращение штата этого учреждения"
            )
        else:
            result.append(
                "Зарплатный бюджет сохраняется. Стоимость высвобожденного времени не считается денежной экономией"
            )
        return result

    def candidates(self, ds, cs):
        found = []
        try:
            for index, (d, c) in enumerate(product(ds, cs)):
                groups = []
                for profile in self.profiles:
                    outcomes = self.outcomes(d, c, self.training, profile)
                    groups.append(
                        (profile, worst([service(out) for out in outcomes]), self.accounts(d, c, outcomes, profile))
                    )
                score = worst([score for _, score, _ in groups])
                accounts = [account for _, _, group in groups for account in group]
                for payment in dict.fromkeys(self.request.payment_ids):
                    scenarios = [next(s for s in out.scenarios if s.id == payment) for out in accounts]
                    if not all(one.available for one in scenarios):
                        continue
                    upfront = max(one.start_rub for one in scenarios)
                    if self.request.max_upfront_rub is not None and upfront > self.request.max_upfront_rub:
                        continue
                    costs = [-one.saving_rub for one in scenarios]
                    term, _ = payback(accounts, payment)
                    ident = f"{index}:{payment}"
                    self.physical[ident] = (d, c)
                    found.append(
                        schema.OptimizationCandidate(
                            id=ident,
                            robot_id=d.runner.robot.id if d else clinic.DEFAULT_DELIVERY,
                            cleaner_id=c.runner.cleaner.id if c else clinic.DEFAULT_CLEANER,
                            robot_name=d.runner.robot.product if d and d.fleet else "",
                            cleaner_name=c.runner.cleaner.product if c and sum(c.cleaners.values()) else "",
                            fleet=d.fleet if d else 0,
                            cleaners=c.cleaners if c else {},
                            payment_id=payment,
                            upfront_rub=upfront,
                            incremental_cost_rub=max(costs),
                            incremental_npv_cost_rub=max(
                                -s.npv_rub for account in accounts for s in account.scenarios if s.id == payment
                            ),
                            incremental_cost_range_rub=(min(costs), max(costs)),
                            released_hours_year=min(self.balance(out) for out in accounts),
                            training=score,
                            payback_years=term,
                            payback_why_not=[
                                f"{profile.name}: {reason}"
                                for profile, _, group in groups
                                for reason in payback(group, payment)[1]
                            ],
                            assessments=[
                                self.assessment(profile, score, group, payment) for profile, score, group in groups
                            ],
                            conditions=(self.conditions.get(d.runner.robot.id, []) if d and d.fleet else [])
                            + (self.conditions.get(c.runner.cleaner.id, []) if c and sum(c.cleaners.values()) else [])
                            + self.financial_conditions(accounts[0]),
                        )
                    )
        except BudgetReached:
            pass
        return found

    def validate(self, candidate):
        d, c = self.physical[candidate.id]
        # Публикуем проверку атомарно: лимит посреди последнего условия не означает успех.
        groups = []
        for profile in self.profiles:
            outcomes = self.outcomes(d, c, self.validation, profile)
            groups.append((profile, worst([service(out) for out in outcomes]), self.accounts(d, c, outcomes, profile)))
        candidate.validation = worst([score for _, score, _ in groups])
        candidate.why_not = [
            f"{profile.name}: {reason}" for profile, score, _ in groups for reason in failures(score, self.request)
        ]
        candidate.validated = not candidate.why_not
        accounts = [account for _, _, group in groups for account in group]
        candidate.payback_years = worst_payback(candidate.payback_years, payback(accounts, candidate.payment_id)[0])
        candidate.payback_why_not = list(
            dict.fromkeys(
                [
                    *candidate.payback_why_not,
                    *[
                        f"{profile.name}: {reason}"
                        for profile, _, group in groups
                        for reason in payback(group, candidate.payment_id)[1]
                    ],
                ]
            )
        )
        candidate.payback_met = not candidate.payback_why_not
        costs = [-next(s for s in out.scenarios if s.id == candidate.payment_id).saving_rub for out in accounts]
        lower, upper = candidate.incremental_cost_range_rub
        candidate.incremental_cost_range_rub = (min(lower, *costs), max(upper, *costs))
        candidate.incremental_cost_rub = candidate.incremental_cost_range_rub[1]
        candidate.incremental_npv_cost_rub = max(
            candidate.incremental_npv_cost_rub,
            *[-s.npv_rub for account in accounts for s in account.scenarios if s.id == candidate.payment_id],
        )
        candidate.released_hours_year = min(candidate.released_hours_year, *(self.balance(out) for out in accounts))
        for assessment, (_, score, accounts) in zip(candidate.assessments, groups, strict=True):
            assessment.validation = score
            costs = [
                -next(s for s in account.scenarios if s.id == candidate.payment_id).saving_rub for account in accounts
            ]
            balances = [self.balance(account) for account in accounts]
            lo, hi = assessment.incremental_cost_range_rub
            assessment.incremental_cost_range_rub = (min(lo, *costs), max(hi, *costs))
            lo, hi = assessment.labour_balance_range_hours
            assessment.labour_balance_range_hours = (min(lo, *balances), max(hi, *balances))
            assessment.payback_years = worst_payback(
                assessment.payback_years, payback(accounts, candidate.payment_id)[0]
            )
            assessment.payback_met = (
                assessment.incremental_cost_range_rub[1] < -MIN_CASH_GAIN_RUB
                and assessment.payback_years is not None
                and assessment.payback_years <= accounts[0].horizon_years
            )
            assessment.runs += len(accounts)

    def execute(self):
        try:
            cleaners = self.cleaning()
            deliveries = self.delivery()
        except BudgetReached:
            cleaners, deliveries = [], []
        self.deadline = self.start + self.request.time_budget_s * 0.75
        candidates = self.candidates(deliveries, cleaners)
        self.deadline = self.start + self.request.time_budget_s
        try:
            for candidate in sorted(candidates, key=lambda c: rank(c, self.request.objective)):
                self.validate(candidate)
        except BudgetReached:
            pass
        checked = sorted((c for c in candidates if c.validated), key=lambda c: rank(c, self.request.objective))
        other = sorted(
            (c for c in candidates if not c.validated),
            key=lambda c: rank(c, self.request.objective),
        )
        return schema.OptimizationResult(
            objective=self.request.objective,
            horizon_years=int(clinic.dataset(self.overrides)["payback_horizon_years"]),
            training_seeds=list(self.training),
            validation_seeds=list(self.validation),
            targets={
                "on_time_share": self.request.on_time_target,
                "urgent_on_time_share": self.request.urgent_on_time_target,
                "completion_share": self.request.completion_target,
                "cleaning_coverage": self.request.cleaning_target,
                "payback_horizon_years": int(clinic.dataset(self.overrides)["payback_horizon_years"]),
            },
            candidates=(checked + other)[:8],
            recommended_id=checked[0].id if checked else None,
            configurations_checked=len(candidates),
            simulations=self.simulations,
            fully_enumerated=self.complete,
            stopped="Заданный диапазон перебран"
            if self.complete
            else "Лимит времени: показаны только проверенные варианты",
            elapsed_s=round(time.perf_counter() - self.start, 3),
            excluded=self.excluded,
            stress_profiles=self.request.stress_profiles,
            notes=[
                "Окупаемость: справочный результат, а не ограничение выбора. Лучший проверенный парк по выбранной цели может быть убыточным; показываются денежный результат, срок возврата вложений и причины отсутствия экономии. Прибыльность условна и зависит от введенных затрат и реализации экономии; простые денежные потоки без дисконтирования",
                "Проверены исходные условия и дополнительные сценарные условия"
                if self.request.stress_profiles
                else "Дополнительные условия не заданы: проверены только случайные потоки при исходных параметрах. Устойчивость к ошибкам предположений не подтверждена",
                "Внутри каждого набора условий все парки получают один и тот же спрос и корпус. Дополнительные расходы считаются против ручного эквивалента выполненных работ; стоимость времени отдельно от сокращения бюджета",
                "Вовремя и завершение оцениваются по фиксированной когорте: срок заявки наступил внутри смены. Более поздние заявки показаны как перенос, не как выполненные",
                "Перебираются однородные модели доставщиков и распределение уборщиков по этажам. Для уборки отсекаются варианты с не меньшим числом роботов и не меньшей помощью персонала на каждом подборочном прогоне",
                "Отдельные проверочные seed защищают от выбора удачного потока, но не заменяют проверку по журналам реальной больницы",
                "Все заданные условия проверяются одним и тем же парком. Стоимость ранжируется по худшему условию; значения между условиями: сценарный диапазон, не доверительный интервал и не вероятность успеха",
                "Срочные заявки проверяются отдельно: общий процент вовремя не может скрыть провал срочных доставок. Цели заданы сценарием и не являются медицинскими нормативами",
                "Множители нагрузки, производительности, задержек и помощи персонала: допущения пользователя с оценкой F. Ограниченное число помощников, отказы и переход очередей между сутками по-прежнему не моделируются",
                "Автономность: упрощенный бюджет активного времени. Энергопотребление ожидания и простоя, старение батарей и реальный разряд пока не подтверждены измерениями",
                "Не оптимизируются расписание, пакетные рейсы, смешанный парк доставщиков и число помощников: их условия пока не заданы и не моделируются",
                "Лучший роботизированный вариант может быть дороже ручной работы. Отказ от роботов и достаточность ручного штата здесь не оптимизируются",
                "Баланс времени вычитает дополнительную нагрузку из высвобождения. Отрицательный баланс означает больше работы для людей. Условия применения моделей из каталога не подтверждаются симуляцией",
            ],
        )


def optimize(request: schema.OptimizationRequest):
    return Search(request).execute()
