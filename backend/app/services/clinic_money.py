"""Итог медучреждения в мастере: прогон смены на корпусе с шага плана и деньги трех сценариев.

Корпус рисует человек на шаге плана; нет корпуса: считаем на типовом (4 этажа, 9 постов). Объем
заявок из датасета с правками шага параметров. План с ошибками проверки не считаем. Числа денег из трех мест, как у прогона:
    data/facilities/clinic.csv   зарплата санитара, начисления, горизонт
    config/clinic.yaml, money    часы в году, рост зарплат и цен, обслуживание и аренда роботов
    каталог                      цены роботов с источником
"""

from __future__ import annotations

import math
import time
from dataclasses import asdict
from functools import lru_cache

from app.engine.clinic import money, processes
from app.engine.clinic.building import ROOM, WARD
from app.engine.clinic.optimization import service
from app.engine.model_config import value_by_path
from app.errors import NotFound
from app.schemas import clinic as schema
from app.services import clinic, facility_catalog
from app.services.clinic_contract import _search, checked_overrides, from_schema

# Чего в деньгах нет. Пишем словами под итогом, чтобы никто не принял ноль за "бесплатно"
NOT_COUNTED = [
    "Кредит: ставка, аванс и страховка сценарные до получения договора. Банковские комиссии и штрафы за досрочное погашение не оценены; замена парка оплачивается своими деньгами",
    "Автономность упрощена до бюджета активного движения и операций: энергопотребление ожидания и простоя, старение батареи и реальный профиль разряда не измерены",
    "Учтено только заданное окно прогона, повторяемое по дням работы (по умолчанию сутки). Непрогнанные часы суток не домножаются автоматически; состояние очередей и батарей между сутками не переносится",
    "Доплата за ночные часы (ТК РФ ст. 154) и больничные в ручной базе не учтены: стоимость ручной работы занижена",
    "Интеграция, электричество, химия, вода и лицензии требуют сметы: нули в дополнительных затратах означают неизвестную цену",
    "Отказы, ремонтные простои, ограниченный ресурс помощников, раздельные чистые и грязные потоки, холодовая цепь и подтверждение санитарного режима не моделируются",
    "Ставка санитара используется для доставки; работа фармацевта и медсестры может стоить иначе. Укажите фактическую ставку уборщицы отдельно",
    "NPV учитывает введенную ставку дисконтирования; налоговый учет и доход от продажи роботов не рассчитаны. Остаток срока службы парка на конец горизонта вычтен из итога отдельной строкой, в срок окупаемости не входит",
]
# Наши числа денег словами для "Откуда цифры"; путь в config/clinic.yaml остается в источнике
MONEY_NAMES = {
    "discount_rate": "Ставка дисконтирования",
    "delivery_hour_rub": "Стоимость часа доставки с начислениями",
    "manual_delivery_min_per_job": "Замер ручной доставки, мин/заявку",
    "manual_cleaning_m2_per_hour": "Замер ручной уборки, м²/ч",
    "delivery_staff_per_shift": "Сотрудников доставки в окне",
    "cleaning_staff_per_shift": "Сотрудников уборки в окне",
    "cash_saving_cap_rub_year": "Предельное сокращение расходов в первый год",
    "loan_enabled": "Добавлен кредит: 1 да, 0 нет",
    "loan_rate": "Сценарная ставка кредита, доля в год",
    "loan_months": "Срок кредита, месяцев",
    "loan_own_share": "Доля цены оборудования своими деньгами",
    "loan_insurance_share": "Страхование оборудования, доля цены в год кредита",
    "annual_work_hours": "Рабочих часов в году на ставку",
    "paid_leave_hours": "Оплачиваемый отпуск, часов в год на ставку",
    "whole_positions_released": "Бюджет сокращают целые высвобожденные ставки: 1 да, 0 нет",
    "days_per_year": "Дней работы в году",
    "shifts_counted": "Окон прогона в сутки, которые берем в деньги",
    "wage_growth": "Рост зарплат в год",
    "inflation": "Рост цен на обслуживание и аренду в год",
    "cleaning_m2_per_hour": "Сколько уборщица моет вручную, м2 в час",
    "maintenance_share_year": "Обслуживание в год, доля цены робота",
    "service_life_years": "Срок службы робота, лет",
    "commissioning_share": "Пусконаладка, доля цены робота",
    "rent_month_rub": "Аренда робота в месяц, руб",
    "rent_first_month_rub": "Аренда за первый месяц, руб",
    "rent_year_rub": "Аренда при годовой оплате, руб/год",
    "rent_first_year_rub": "Аренда при годовой оплате за первый год, руб",
    "commissioning_rub": "Пусконаладка одного робота, руб",
    "maintenance_rub_year": "Сервис одного робота по фиксированному тарифу, руб/год",
    "rent_service_included": "Сервис входит в аренду: 1 да, 0 не подтверждено",
    "cash_realization_share": "Доля высвобождения, сокращающая бюджет",
    "cleaning_time_saving_share": "Сценарная доля сокращения ручного времени уборки",
    "delivery_support_min_per_job": "Дополнительная помощь доставщику, мин/заявку",
    "cleaner_support_min_per_shift": "Подготовка и контроль уборщика, мин/смену",
    "manual_door_assist_s": "Активная помощь у ручной двери, с/проход",
    "integration_rub": "Дополнительная интеграция и обучение, руб",
    "extra_annual_rub": "Дополнительная эксплуатация, руб/год",
}
# Числа модели смены словами для "Откуда цифры": название, единица. Все числа config/clinic.yaml
# вне money; путь в файле остается в источнике. Тест не пропустит число без названия
MODEL_NAMES = {
    "staff.min_aisle_width_mm": ("Условный габарит человека с тележкой для ручного маршрута", "мм"),
    "building.floor_height_m": ("Высота этажа", "м"),
    "building.corridor_width_m": ("Ширина коридора отделения", "м"),
    "building.ward_door_mm": ("Проем двери палаты", "мм"),
    "building.office_door_mm": ("Проем двери кабинета", "мм"),
    "building.lab_door_mm": ("Проем двери лаборантской", "мм"),
    "lift.speed_m_s": ("Скорость лифта", "м/с"),
    "lift.acceleration_m_s2": ("Ускорение лифта", "м/с2"),
    "lift.door_open_s": ("Двери кабины открываются", "с"),
    "lift.door_close_s": ("Двери кабины закрываются", "с"),
    "lift.board_s": ("Робот въезжает в кабину или выезжает", "с"),
    "lift.cabin_w_mm": ("Ширина кабины лифта", "мм"),
    "lift.cabin_d_mm": ("Глубина кабины лифта", "мм"),
    "lift.door_mm": ("Двери кабины лифта", "мм"),
    "lift.robots_per_ride": ("Роботов за один рейс лифта", "шт"),
    "lift.people_calls_per_hour": ("Люди вызывают лифт", "раз в час"),
    "doors.auto_open_s": ("Автоматическая дверь открывается", "с"),
    "doors.manual_wait_s": ("Робот ждет у ручной двери", "с"),
    "delivery.speed_share": ("Средняя скорость доставщика, доля максимальной", ""),
    "delivery.load_s": ("Погрузка заказа в аптеке", "с"),
    "delivery.handover_s": ("Передача заказа на посту", "с"),
    "delivery.supplies_pick_s": ("Сборка доставки расходников", "с"),
    "delivery.routine_deadline_min": ("Срок плановой заявки", "мин"),
    "delivery.stat_deadline_min": ("Срок срочной заявки", "мин"),
    "delivery.battery_reserve": ("Доставщик едет заряжаться с остатка", ""),
    "delivery.robots_per_charger": ("Доставщиков на одну зарядку", "шт"),
    "delivery.on_time_target": ("Цель подбора парка: доля заявок вовремя", ""),
    "demand.peak_share": ("Доля заявок в часы пик", ""),
    "demand.shift_start_h": ("Начало смены", "ч"),
    "demand.shift_hours": ("Длина смены", "ч"),
    "cleaning.passes_per_day": ("Уборок коридора в сутки", "раз"),
    "cleaning.passes_per_shift": ("Уборок коридора за окно прогона", "раз"),
    "cleaning.travel_speed_m_s": ("Скорость переезда уборщика", "м/с"),
    "cleaning.battery_reserve": ("Уборщик едет заряжаться с остатка", ""),
    "staff.walk_speed_m_s": ("Скорость санитара с тележкой", "м/с"),
    "staff.handover_s": ("Санитар отдает заказ на посту", "с"),
    "staff.lift_wait_s": ("Санитар ждет лифт", "с"),
}
NO_SOURCE = "Источника нет, это допущение команды"

# Числа датасета, на которых стоит итог: показываем их в "Откуда цифры"
DATASET_KEYS = (
    "drug_orders_per_day",
    "supply_trips_per_day",
    "drug_delivery_points",
    "orderly_salary_rub",
    "payroll_tax_factor",
    "payback_horizon_years",
)


def estimate(
    request: schema.MoneyRequest, *, outcome: clinic.Outcome | None = None, include_sources=True
) -> schema.MoneyResult:
    tasks = list(dict.fromkeys(one for one in request.operation_ids if one in schema.TASKS))
    if not tasks:
        raise clinic.BadInput("Деньги считаем для доставки по этажам и уборки коридоров: отметьте хотя бы одну")
    overrides = checked_overrides(request.overrides)
    data = clinic.dataset(overrides)
    delivering, cleaning = clinic.DELIVERY in tasks, clinic.CLEANING in tasks
    building = (
        outcome.building
        if outcome is not None
        else from_schema(request.building)
        if request.building
        else clinic.demo()
    )
    # план с ошибками проверки simulate не считает: отвечает 422 со списком ошибок
    outcome = (
        outcome
        if outcome is not None
        else clinic.simulate(
            building,
            request.robot_id,
            fleet=request.fleet,
            cleaner_id=request.cleaner_id if cleaning else None,
            cleaners=request.cleaners,
            overrides=overrides,
            record=False,
            operation_ids=tasks,
        )
    )
    cfg = clinic.config()["money"]
    kpi = outcome.kpi
    entered = request.assumptions.model_dump(exclude_none=True)
    assumptions = {key: cfg[key] for key in schema.MoneyAssumptions.model_fields if key in cfg} | entered
    calendar = building.scenario.get("days_per_year")
    if "days_per_year" not in entered and calendar is not None:
        assumptions["days_per_year"] = calendar
    annual = cfg["shifts_counted"] * assumptions["days_per_year"]
    # ставку оплачивают весь год, а работает она без отпуска: час работы считаем по отработанным часам
    worked = assumptions["annual_work_hours"] - assumptions["paid_leave_hours"]
    if worked <= 0:
        raise clinic.BadInput("Отпуск должен быть меньше годовых рабочих часов ставки")
    hour_rub = data["orderly_salary_rub"] * 12 * data["payroll_tax_factor"] / worked
    hour_rub = assumptions.get("delivery_hour_rub", hour_rub)
    assumptions.setdefault("cleaner_hour_rub", hour_rub)
    cleaner_hour = assumptions["cleaner_hour_rub"]
    manual_delivery = kpi.staff_hours if delivering else 0.0
    if delivering and "manual_delivery_min_per_job" in assumptions:
        manual_delivery = kpi.done * assumptions["manual_delivery_min_per_job"] / 60
    manual_cleaning = (
        kpi.cleaned_m2 / assumptions.get("manual_cleaning_m2_per_hour", cfg["cleaning_m2_per_hour"])
        if cleaning
        else 0.0
    )
    result = outcome.result
    delivery_doors = result.manual_door_assists - result.cleaner_door_assists
    support_delivery = (
        (
            result.delivery_handling_s / 3600
            + sum(job.picked_s is not None for job in result.jobs) * assumptions["delivery_support_min_per_job"] / 60
            + delivery_doors * assumptions["manual_door_assist_s"] / 3600
        )
        if delivering
        else 0.0
    )
    support_cleaning = (
        (
            sum(outcome.cleaners.values()) * assumptions["cleaner_support_min_per_shift"] / 60
            + result.cleaner_door_assists * assumptions["manual_door_assist_s"] / 3600
        )
        if cleaning
        else 0.0
    )
    remaining_cleaning = manual_cleaning * (1 - assumptions["cleaning_time_saving_share"]) + support_cleaning
    delivery_net = max(0.0, manual_delivery - support_delivery)
    cleaning_net = max(0.0, manual_cleaning - remaining_cleaning)
    extra_delivery = max(0.0, support_delivery - manual_delivery)
    extra_cleaning = max(0.0, remaining_cleaning - manual_cleaning)
    extra_cost = (extra_delivery * hour_rub + extra_cleaning * cleaner_hour) * annual
    per_shift = delivery_net + cleaning_net
    hours_year = per_shift * annual
    manual_cost = (manual_delivery * hour_rub + manual_cleaning * cleaner_hour) * annual
    released_value = (delivery_net * hour_rub + cleaning_net * cleaner_hour) * annual
    # Без доли от заказчика бюджет сокращают только целые ставки каждой роли: долю человека не снять
    positions = 0.0
    if "cash_realization_share" not in entered:
        whole = {
            role: math.floor(hours * annual / worked + 1e-9)
            for role, hours in (("d", delivery_net), ("c", cleaning_net))
        }
        positions = float(whole["d"] + whole["c"]) if cfg["whole_positions_released"] else 0.0
        cash_whole = (whole["d"] * hour_rub + whole["c"] * cleaner_hour) * worked if positions else 0.0
        assumptions["cash_realization_share"] = min(1.0, cash_whole / released_value) if released_value > 0 else 0.0
    fleets = []
    if delivering and outcome.fleet:
        fleets.append(_fleet(clinic.DELIVERY, outcome.robot, outcome.fleet, request.quotes.get(outcome.robot.id)))
    if cleaning and outcome.cleaner and sum(outcome.cleaners.values()):
        fleets.append(
            _fleet(
                clinic.CLEANING, outcome.cleaner, sum(outcome.cleaners.values()), request.quotes.get(outcome.cleaner.id)
            )
        )
    inputs = money.Inputs(
        hours_year,
        hour_rub,
        int(data["payback_horizon_years"]),
        assumptions["wage_growth"],
        assumptions["inflation"],
        [fleet for fleet, _ in fleets],
        cash_realization_share=assumptions["cash_realization_share"],
        staff_cost_year=manual_cost,
        robot_staff_cost_year=manual_cost - released_value,
        additional_staff_cost_year=extra_cost,
        integration_rub=assumptions["integration_rub"],
        extra_annual_rub=assumptions["extra_annual_rub"],
        rent_service_included=bool(assumptions["rent_service_included"]),
        loan_enabled=bool(assumptions["loan_enabled"]),
        loan_rate=assumptions["loan_rate"],
        loan_months=int(assumptions["loan_months"]),
        loan_own_share=assumptions["loan_own_share"],
        loan_insurance_share=assumptions["loan_insurance_share"],
        discount_rate=assumptions["discount_rate"],
        cash_saving_cap_rub_year=assumptions.get("cash_saving_cap_rub_year"),
    )
    scenarios = money.evaluate(inputs)
    factors = sum(money.growth(inputs.wage_growth, year) for year in range(1, inputs.horizon + 1))
    cash = released_value * assumptions["cash_realization_share"]
    if inputs.cash_saving_cap_rub_year is not None:
        cash = min(cash, inputs.cash_saving_cap_rub_year)
    yearly_cash = cash - extra_cost
    described = []
    for scenario in scenarios:
        row = schema.MoneyScenario(**asdict(scenario))
        if row.id != "baseline" and row.available:
            row.minimum_cash_saving_year_rub = row.robot_cost_rub / factors
            row.annual_gap_rub = max(0, row.minimum_cash_saving_year_rub - yearly_cash)
            row.cash_share_for_break_even = (
                (row.robot_cost_rub / factors + extra_cost) / released_value if released_value > 0 else None
            )
        described.append(row)
    required_area = sum(one.area_m2 for one in kpi.cleaning)
    coverage = min(1.0, kpi.cleaned_m2 / required_area) if required_area else None
    warnings = []
    readiness = []
    if delivering and "delivery_hour_rub" not in entered and "clinic.orderly_salary_rub" not in overrides:
        readiness.append("Стоимость часа доставки взята из отраслевой зарплаты, а не из данных заказчика")
    if cleaning and "cleaner_hour_rub" not in entered:
        readiness.append("Стоимость часа уборки оценена по аналогу, ставка заказчика не задана")
    if delivering:
        for kind, key in (("meds", "drug_orders_per_day"), ("supplies", "supply_trips_per_day")):
            settings = building.scenario.get(kind, {})
            if (
                settings.get("enabled", True)
                and settings.get("mode") != "routes"
                and settings.get("per_day") is None
                and f"clinic.{key}" not in overrides
            ):
                readiness.append(
                    f"{'Лекарства' if kind == 'meds' else 'Расходники'}: суточный объем взят из отраслевого примера"
                )
    for task, enabled, hours, staff_key in (
        ("Доставка", delivering, manual_delivery, "delivery_staff_per_shift"),
        ("Уборка", cleaning, manual_cleaning, "cleaning_staff_per_shift"),
    ):
        if not enabled:
            continue
        if staff_key not in assumptions:
            readiness.append(f"{task}: не задано число сотрудников в выбранном окне")
        elif hours > assumptions[staff_key] * outcome.result.hours + 1e-9:
            readiness.append(
                f"{task}: ручной эквивалент {hours:.1f} ч превышает ресурс сотрудников {assumptions[staff_key] * outcome.result.hours:.1f} ч; выполнение работы текущим штатом не подтверждено"
            )
    if delivering and "manual_delivery_min_per_job" not in entered:
        readiness.append("Ручная доставка оценена по маршрутам: хронометраж заказчика не задан")
    if cleaning and "manual_cleaning_m2_per_hour" not in entered:
        readiness.append("Ручная уборка оценена по аналогу: производительность заказчика не задана")
    if "days_per_year" not in entered and calendar is None:
        readiness.append("Календарь объекта не задан: используется отраслевой пример 365 дней")
    if "cash_saving_cap_rub_year" not in entered:
        readiness.append("Не задан предельный объем реально уменьшающихся расходов; доля реализации остается сценарием")
    for fleet, _ in fleets:
        ident = request.robot_id if fleet.task == clinic.DELIVERY else request.cleaner_id
        quote = request.quotes.get(ident)
        if (
            not quote
            or any(
                getattr(quote, key) is None
                for key in ("price_rub", "maintenance_rub_year", "commissioning_rub", "life_years")
            )
            or not quote.source.strip()
        ):
            readiness.append(
                f"{fleet.name}: коммерческое предложение неполное, часть условий взята по каталогу и допущениям"
            )
    if inputs.cash_saving_cap_rub_year is not None and cash < released_value * assumptions["cash_realization_share"]:
        warnings.append(
            "Денежная экономия ограничена введенным пределом сокращения расходов; стоимость свободного времени сверх него в деньги не включена"
        )
    score = service(outcome)
    if score.urgent_on_time_share is not None and score.urgent_on_time_share < 1 - 1e-9:
        warnings.append(
            "Часть срочных заявок не выполнена вовремя: общий процент доставки не подтверждает выполнение срочного задания"
        )
    if outcome.search and outcome.search.needed is None:
        warnings.append(
            "Цель доставки не достигнута: показан лучший проверенный парк, его достаточность не подтверждена"
        )
    if "cash_realization_share" not in entered:
        warnings.append(
            f"В деньги взяты только целые высвобожденные ставки: {positions:g}. Их снимают без увольнений, не замещая уходящих при текучести {data['staff_turnover_pct']:g}% в год; дробный остаток показан стоимостью времени. Подтвердите это штатным планом"
            if positions
            else "Высвобождается меньше одной ставки каждой роли: бюджет не сокращается, зарплата остается в затратах"
        )
    elif assumptions["cash_realization_share"] == 0:
        warnings.append(
            "Сокращение бюджета не подтверждено: высвобожденное время показано отдельно, зарплата остается в затратах"
        )
    else:
        warnings.append(
            "Доля сокращения бюджета задана пользователем: подтвердите ее отменой сверхурочных, вакансий, аутсорсинга или штатным планом"
        )
    if kpi.done < kpi.created:
        warnings.append(
            f"За смену выполнено {kpi.done} из {kpi.created} заявок. Эффект только от выполненного объема; оставшиеся заявки требуют персонала или следующей смены"
        )
    if coverage is not None and coverage < 0.999:
        warnings.append(
            f"Вымыто {coverage:.1%} требуемой площади: сравнение денег относится только к выполненной уборке"
        )
    if extra_delivery + extra_cleaning > 0:
        warnings.append(
            "Для части работ помощь роботам превышает ручной эквивалент: дополнительные часы увеличивают затраты"
        )
    if cleaning:
        warnings.append(
            "Уборка: только полы коридоров. Коэффициент снижения ручного времени сценарный; это не замена всей санитарной уборки"
        )
    if (
        cleaning
        and not assumptions["rent_service_included"]
        and any(fleet.rent_service_included is None for fleet, _ in fleets if fleet.task == clinic.CLEANING)
    ):
        warnings.append(
            'Включение сервиса в аренду не подтверждено: его тариф учтен отдельно. После подтверждения договора установите "Сервис включен в аренду"'
        )
    if "integration_rub" not in entered or "extra_annual_rub" not in entered:
        warnings.append("Смета неполная: заполните интеграцию и дополнительную эксплуатацию до инвестиционного решения")
    return schema.MoneyResult(
        horizon_years=inputs.horizon,
        tasks=[_label(one) for one in tasks],
        skipped=[_label(one) for one in request.operation_ids if one not in schema.TASKS],
        fleets=[
            schema.MoneyFleet(
                operation_id=one.task,
                robot_id=request.robot_id if one.task == clinic.DELIVERY else request.cleaner_id,
                task=_label(one.task),
                name=one.name,
                count=one.count,
                price_rub=one.price_rub,
                price_source=src,
            )
            for one, src in fleets
        ],
        people=schema.MoneyPeople(
            hours_per_shift=per_shift,
            hours_per_year=hours_year,
            hour_rub=hour_rub,
            fte=hours_year / worked,
            orderlies=overrides.get("clinic.orderlies"),
            manual_hours_per_shift=manual_delivery + manual_cleaning,
            manual_delivery_hours_per_shift=manual_delivery,
            manual_cleaning_hours_per_shift=manual_cleaning,
            remaining_hours_per_shift=support_delivery + remaining_cleaning,
            delivery_hours_per_shift=delivery_net,
            cleaning_hours_per_shift=cleaning_net,
            support_hours_per_shift=support_delivery + support_cleaning,
            extra_hours_per_shift=extra_delivery + extra_cleaning,
            cleaner_hour_rub=cleaner_hour,
            released_value_year_rub=released_value,
            cash_saving_year_rub=yearly_cash,
            positions_released=positions,
        ),
        shift=schema.MoneyShift(
            service=service(outcome),
            hours=outcome.result.hours,
            shift_start_h=processes.window(building, int(clinic.config()["demand"]["shift_start_h"]))[0],
            expected_jobs=sum(outcome.demand_per_hour),
            checks=[schema.CheckOut(**asdict(item)) for item in outcome.checks],
            fleet=outcome.fleet,
            cleaners=outcome.cleaners,
            search=_search(outcome.search),
            floors=len(building.floors),
            lifts=len(building.lifts),
            wards=sum(1 for floor in building.floors for room in floor.of(ROOM) if room.role == WARD),
            jobs=kpi.created,
            on_time_share=kpi.on_time_share,
            avg_delivery_min=kpi.avg_delivery_min,
            bottleneck=kpi.bottleneck,
            lift_busy_share=max((one.busy_share for one in kpi.lifts), default=None),
            cleaned_m2=kpi.cleaned_m2 if cleaning else 0.0,
            done=kpi.done,
            due=kpi.due,
            cleaning_required_m2=required_area,
            cleaning_coverage=coverage,
        ),
        scenarios=described,
        not_counted=NOT_COUNTED,
        sources=_sources(
            [one for one, _ in fleets],
            [src for _, src in fleets],
            overrides,
            cleaning,
            entered,
            cleaner_hour,
            custom_scenario=bool(building.scenario),
            quotes=request.quotes,
        )
        + _process_sources(outcome, data, delivering, cleaning)
        + [
            schema.MoneySource(
                group="Деньги",
                name=f"{MONEY_NAMES.get(key, key)} (введено)",
                value=_number(value),
                source="Ввод пользователя: требует проверки по данным объекта",
                trust="F",
            )
            for key, value in entered.items()
            if key not in cfg
        ]
        + [
            schema.MoneySource(
                group="Роботы",
                name=f"{_product(ident)}: {MONEY_NAMES.get('service_life_years' if key == 'life_years' else key, key)} (предложение)",
                value=_number(value),
                source=quote.source or "Предложение пользователя без указанного источника",
                trust="F",
            )
            for ident, quote in request.quotes.items()
            for key, value in quote.model_dump(exclude_none=True, exclude={"source"}).items()
            if ident in {request.robot_id, request.cleaner_id}
        ]
        if include_sources
        else [],
        assumptions=assumptions,
        warnings=warnings,
        readiness=readiness,
    )


@lru_cache(maxsize=32)
def _offer(raw: str, minute: int) -> str:
    return estimate(schema.MoneyRequest.model_validate_json(raw), include_sources=False).model_dump_json()


def offers(request: schema.OfferRequest) -> schema.Offers:
    if len(request.operation_ids) != 1 or request.operation_ids[0] not in schema.TASKS:
        raise clinic.BadInput("Предварительная стоимость считается для одной задачи")
    result = schema.Offers(offers={}, errors={})
    deadline = time.perf_counter() + 25
    for robot_id in dict.fromkeys(request.robot_ids):
        if time.perf_counter() >= deadline:
            result.errors[robot_id] = "Предварительный расчет не завершен. Выберите модель для полного прогона"
            continue
        data = request.model_dump(exclude={"robot_ids", "fleet", "cleaners"})
        data["robot_id" if request.operation_ids[0] == clinic.DELIVERY else "cleaner_id"] = robot_id
        try:
            result.offers[robot_id] = schema.MoneyResult.model_validate_json(
                _offer(schema.MoneyRequest(**data).model_dump_json(), int(time.monotonic() // 60))
            )
        except (clinic.BadInput, NotFound) as error:
            result.errors[robot_id] = str(error)
    return result


def _fleet(
    task: str, robot: clinic.CatalogRobot, count: int, quote: schema.RobotQuote | None = None
) -> tuple[money.Fleet, str]:
    price, source = facility_catalog.price(robot.id)
    entered = quote.model_dump(exclude_none=True, exclude={"source"}) if quote else {}
    if "price_rub" in entered:
        price, source = entered["price_rub"], f"Предложение заказчика: {quote.source or 'источник не указан'}"
    if price is None:
        raise NotFound(f"У {robot.product} нет цены, деньги не посчитать: выберите другого робота")
    terms = _terms(robot.id) | entered
    if "life_years" in entered:
        terms["service_life_years"] = entered["life_years"]
    rent = terms.get("rent_month_rub")
    fleet = money.Fleet(
        task,
        robot.product,
        count,
        price,
        terms["maintenance_share_year"],
        terms["commissioning_share"],
        int(terms["service_life_years"]),
        float(rent) if rent is not None else None,
        terms.get("rent_first_month_rub"),
        terms.get("rent_year_rub"),
        terms.get("rent_first_year_rub"),
        terms.get("commissioning_rub"),
        terms.get("maintenance_rub_year"),
        terms.get("rent_service_included"),
    )
    return fleet, source


def _terms(robot_id: str) -> dict:
    """Обслуживание, срок службы и аренда робота; чего у робота нет, берем из default."""
    cfg = clinic.config()["money"]
    return cfg["default"] | cfg["robots"].get(robot_id, {})


def _label(operation_id: str) -> str:
    found = facility_catalog.BY_KEY.get((clinic.FACILITY, operation_id))
    return found.label if found else operation_id


def _said(source: str, trust: str) -> str:
    """У допущения без источника так и пишем, а не только буквой F."""
    said = source.lower()
    if trust == "F" and not said.startswith(("нет источника", "наша цель")) and "допущение" not in said:
        return f"{NO_SOURCE}. {source}"
    return source


def _sources(
    fleets: list[money.Fleet],
    prices: list[str],
    overrides: dict[str, float],
    cleaning: bool,
    entered: dict[str, float],
    cleaner_hour: float,
    custom_scenario: bool = False,
    quotes: dict[str, schema.RobotQuote] | None = None,
) -> list[schema.MoneySource]:
    """Откуда цифры итога: датасет, цены роботов, числа смены и денег с источником, датой и оценкой S-F."""
    rows = {row["key"]: row for row in facility_catalog.fields(clinic.FACILITY)}
    out = []
    for key in DATASET_KEYS:
        row, path = rows[key], f"{clinic.FACILITY}.{key}"
        mine = path in overrides
        out.append(
            schema.MoneySource(
                group="Объект",
                name=row["name"].replace("е", "е"),
                value=f"{_number(overrides[path] if mine else float(row['value']))} {row['unit']}".strip(),
                source="Задал пользователь" if mine else 'Отраслевой датасет, лист "Медучреждение"',
                trust="D",
            )
        )
    for fleet, source in zip(fleets, prices, strict=True):
        out.append(
            schema.MoneySource(
                group="Роботы",
                name=f"Цена {fleet.name}",
                value=f"{_number(fleet.price_rub)} ₽",
                source=source,
                trust="C",
            )
        )
    values, provenance = clinic.model()
    for path, (name, unit) in MODEL_NAMES.items():
        if path.startswith("cleaning.") and not cleaning:
            continue
        prov = provenance[path]
        out.append(
            schema.MoneySource(
                group="Смена",
                name=f"Типовая модель: {name}" if custom_scenario else name,
                value=f"{_number(value_by_path(values, path))} {unit}".strip(),
                source=_said(prov.source, prov.trust),
                date=prov.date,
                trust=prov.trust,
            )
        )
    used = {fleet.name for fleet in fleets}
    for path, prov in provenance.items():
        parts = path.split(".")
        if parts[0] != "money" or (parts[1] == "robots" and not _robot_used(parts[2], used)):
            continue
        if path == "money.cleaning_m2_per_hour" and "manual_cleaning_m2_per_hour" in entered:
            continue
        if parts[1] == "robots" and quotes and parts[2] in quotes:
            key = "life_years" if parts[-1] == "service_life_years" else parts[-1]
            if getattr(quotes[parts[2]], key, None) is not None:
                continue
        name = MONEY_NAMES.get(parts[-1], path)
        whose = (
            ""
            if parts[1] not in ("robots", "default")
            else (" (если у робота своего нет)" if parts[1] == "default" else f" ({_product(parts[2])})")
        )
        out.append(
            schema.MoneySource(
                group="Деньги",
                name=name + whose,
                value=_number(entered.get(parts[-1], value_by_path(values, path))),
                source="Допущение пользователя: сценарное условие, требует подтверждения"
                if parts[-1] in entered
                else _said(prov.source, prov.trust),
                date=prov.date,
                trust="F" if parts[-1] in entered else prov.trust,
            )
        )
    if cleaning:
        out.append(
            schema.MoneySource(
                group="Деньги",
                name="Ставка уборщицы с начислениями, руб/ч",
                value=_number(cleaner_hour),
                source="Допущение пользователя: ставка уборщицы с начислениями"
                if "cleaner_hour_rub" in entered
                else "Допущение: ставка санитара как аналог ставки уборщицы; укажите фактическую стоимость часа",
                trust="F",
            )
        )
    return out


def _process_sources(outcome, data, delivering, cleaning):
    """Показываем фактически примененные процессы рядом с исходными параметрами модели."""
    building = outcome.building
    start = processes.window(building, int(clinic.config()["demand"]["shift_start_h"]))[0]
    rows = [
        ("Окно, использованное в расчете", f"с {start:02}:00, {outcome.result.hours:g} ч"),
        (
            "Геометрия корпуса в расчете",
            f"{len(building.floors)} этажей; {_number(sum(f.width_m * f.length_m for f in building.floors))} м² участков",
        ),
    ]
    if delivering:
        for stream in processes.plan(building, data, clinic.config()["delivery"]):
            label = "Лекарства" if stream.kind == "meds" else "Расходники"
            mode = building.scenario.get(stream.kind, {}).get("mode", "per_point")
            mode_label = {"per_point": "по весам постов", "building": "на весь корпус", "routes": "по маршрутам"}[mode]
            rows.append(
                (
                    f"{label}: объем в расчете ({mode_label})",
                    f"{_number(stream.volume.per_day)} заявок/сутки; {_number(stream.volume.per_day * sum(clinic.profile(building)))} за окно",
                )
            )
            rows.append(
                (
                    f"{label}: комплектация и сроки",
                    f"комплектация {_number(stream.volume.pick_s / 60)} мин; плановая {_number(stream.volume.deadline_s / 60)} мин, срочная {_number(stream.volume.urgent_deadline_s / 60)} мин после готовности; срочных {_number(stream.volume.urgent_share * 100)}%",
                )
            )
    if cleaning:
        rows.append(
            (
                "Задание уборки в расчете",
                "; ".join(
                    f"этаж {f.number}: {_number(processes.cleaning_passes(building, f.number, clinic.config()['cleaning']['passes_per_shift']))} проходов"
                    for f in building.floors
                ),
            )
        )
    return [
        schema.MoneySource(
            group="Объект",
            name=name,
            value=value,
            source="Сценарное допущение: план и процессы пользователя на основе отраслевых параметров. Хронометраж и фактические журналы учреждения не предоставлены",
            trust="F",
        )
        for name, value in rows
    ]


def _robot_used(robot_id: str, names: set[str]) -> bool:
    return _product(robot_id) in names


def _product(robot_id: str) -> str:
    row = facility_catalog.spec_row(robot_id, "dimensions_mm")
    return row["product"] if row else robot_id


def _number(value: float) -> str:
    """1411000 -> "1 411 000", 0.067 -> "0,067"."""
    if not isinstance(value, float | int):
        return str(value)
    if float(value).is_integer():
        return f"{int(value):,}".replace(",", " ")
    return f"{value:.4g}".replace(".", ",")
