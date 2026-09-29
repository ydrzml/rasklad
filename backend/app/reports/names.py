"""Понятные названия значений модели для отчета. Путь в модели остается в Excel отдельной колонкой,
а на бумаге человек видит, что это за число. Робот и задача в пути заменены звездочкой."""

import re

GROUPS = {
    "robots": "Решение",
    "economics": "Деньги, налоги, цены",
    "facilities": "Объект и задачи",
    "engine": "Допущения модели",
    "financing": "Как платим за покупку",
    "subsidies": "Господдержка",
    "ramp_up": "Выход на режим",
}

NAMES = {
    "ramp_up.simple.first_month_share": "Выход на режим: эффект в первый месяц, перевозка и уборка",
    "ramp_up.simple.months": "Выход на режим: месяцев до полного эффекта, перевозка и уборка",
    "ramp_up.station.first_month_share": "Выход на режим: эффект в первый месяц, товар к человеку",
    "ramp_up.station.months": "Выход на режим: месяцев до полного эффекта, товар к человеку",
    "financing.method": "Способ оплаты покупки",
    "financing.loan.rate": "Ставка кредита",
    "financing.loan.term_months": "Срок кредита",
    "financing.loan.own_share": "Свои деньги при кредите, доля вложений",
    "financing.leasing.rate": "Внутренняя ставка лизинга",
    "financing.leasing.term_months": "Срок лизинга",
    "financing.leasing.advance_share": "Аванс по лизингу, доля цены оборудования",
    "subsidies.msp-1764.chosen": "Льготный кредит МСП 1764 отмечен",
    "subsidies.msp-1764.rate": "Ставка по программе 1764",
    "subsidies.frp-leasing.chosen": "Заем ФРП на аванс лизинга отмечен",
    "subsidies.frp-leasing.rate": "Ставка займа ФРП",
    "subsidies.frp-leasing.price_share": "Заем ФРП, предел от цены оборудования",
    "subsidies.frp-leasing.advance_share": "Заем ФРП, предел от аванса",
    "subsidies.frp-leasing.term_months": "Срок займа ФРП",
    "subsidies.frp-leasing.min_project_rub": "Заем ФРП, проект от",
    "subsidies.minpromtorg-robotics.chosen": "Возврат затрат Минпромторга отмечен",
    "subsidies.minpromtorg-robotics.share": "Возврат затрат Минпромторга, доля",
    "subsidies.minpromtorg-robotics.cap_rub": "Возврат затрат Минпромторга, не больше",
    "economics.annual_work_hours": "Рабочих часов в году на ставку",
    "economics.capex_reserve_share": "Резерв на непредвиденное, доля вложений",
    "economics.discount_rate": "Ставка дисконтирования",
    "economics.energy_price_rub_kwh": "Тариф на электроэнергию",
    "economics.energy_price_growth": "Рост цены электроэнергии в год",
    "economics.horizon_years": "Горизонт расчета",
    "economics.inflation": "Инфляция в год",
    "economics.payback_bands_years": "Границы оценки окупаемости, лет",
    "economics.payroll.hire_cost_months": "Найм одного человека, окладов",
    "economics.payroll.injury_insurance_rate": "Взнос от несчастных случаев",
    "economics.payroll.insurance_base_limit_rub": "Предельная база страховых взносов",
    "economics.payroll.insurance_rate": "Страховые взносы",
    "economics.payroll.insurance_rate_above_limit": "Взносы сверх предельной базы",
    "economics.payroll.turnover_rate": "Текучесть персонала в год",
    "economics.payroll.workwear_rub_year": "Спецодежда на человека в год",
    "economics.peak_reserve_share": "Запас парка на пик",
    "economics.wage_growth": "Рост зарплат в год",
    "engine.geometry.route_factor": "Поправка маршрута на повороты и объезды",
    "engine.geometry.picking_m2_per_robot": "Площадь робозоны на робота отбора",
    "engine.selection.stacking_lift_mm": "Запас высоты подъема над ярусом",
    "engine.simulation.availability": "Готовность робота к работе",
    "engine.simulation.peak_hours": "Часов пика в смене",
    "engine.simulation.robots_per_aisle": "Роботов в одном проезде",
    "facilities.*.active_area_m2": "Площадь зоны работы роботов",
    "facilities.*.sku_count": "Активных SKU",
    "facilities.*.constraints.aisle_width_mm": "Ширина проезда между рядами",
    "facilities.*.constraints.ceiling_m": "Высота потолка",
    "facilities.*.constraints.floor_flatness_mm": "Ровность пола",
    "facilities.*.constraints.main_aisle_width_mm": "Ширина главного проезда",
    "facilities.*.fast_picks_share": "Доля отборов ходового товара",
    "facilities.*.fast_share": "Доля ходового товара",
    "facilities.*.picking_zone_share": "Часть склада под отбор роботами",
    "facilities.*.implementation.communications_rub_year": "Связь и сеть в год",
    "facilities.*.implementation.hiring_rub_per_person": "Подбор оператора",
    "facilities.*.implementation.infrastructure_rub": "Инфраструктура объекта",
    "facilities.*.implementation.integration_rub": "Интеграция с WMS",
    "facilities.*.implementation.retraining_rub_per_person": "Переобучение одного человека",
    "facilities.*.min_operator_posts": "Минимум операторов в смене",
    "facilities.*.operator_salary_premium": "Надбавка оператору роботов",
    "facilities.*.operations.*.automatable_share": "Доля работы, посильная роботам",
    "facilities.*.operations.*.implementation.infrastructure_rub": "Инфраструктура под задачу",
    "facilities.*.operations.*.implementation.integration_rub": "Интеграция под задачу",
    "facilities.*.operations.*.ops_per_trip": "Операций за один рейс",
    "facilities.*.operations.*.volume_per_day": "Объем задачи в сутки",
    "facilities.*.operations.*.load_kg": "Вес груза",
    "facilities.*.operations.*.productivity_after": "Выработка человека с роботом",
    "facilities.*.operations.*.productivity_before": "Выработка человека сейчас",
    "facilities.*.peak_factor": "Пиковый коэффициент нагрузки",
    "facilities.*.schedule.days_per_year": "Рабочих дней в году",
    "facilities.*.schedule.shift_hours": "Продолжительность смены",
    "facilities.*.schedule.shifts": "Смен в сутки",
    "facilities.*.slotted_by_turnover": "Товар разложен по ходовости",
    "facilities.*.staff_loss_share": "Потери рабочего времени",
    "robots.*.area_per_trip_m2": "Участок уборки за рейс",
    "robots.*.avg_power_kw": "Средняя мощность",
    "robots.*.avg_speed_m_s": "Средняя скорость",
    "robots.*.battery_life_years": "Срок службы аккумулятора",
    "robots.*.battery_price_rub": "Цена аккумулятора",
    "robots.*.charge_time_h": "Время зарядки",
    "robots.*.charger_price_rub": "Цена зарядной станции",
    "robots.*.commissioning_share": "Пусконаладка, доля цены",
    "robots.*.handling_s": "Погрузка и выгрузка за рейс",
    "robots.*.license_rub_year": "Лицензия ПО в год",
    "robots.*.maintenance_share_year": "Обслуживание в год, доля цены",
    "robots.*.nominal_trips_per_hour": "Рейсов в час по паспорту",
    "robots.*.operator_attention_min_per_hour": "Внимание оператора, минут в час",
    "robots.*.price_rub": "Цена робота",
    "robots.*.raas.contract_months": "Срок договора аренды",
    "robots.*.raas.damage_share_year": "Ответственность за порчу в аренде",
    "robots.*.raas.fee_rub_month": "Аренда в месяц",
    "robots.*.raas.support_share": "Присмотр за парком в аренде",
    "robots.*.refill_s": "Слив и налив воды на базе за рейс",
    "robots.*.robots_per_charger": "Роботов на одну зарядку",
    "robots.*.run_time_h": "Работа от одной зарядки",
    "robots.*.service_life_years": "Срок службы робота",
    "robots.*.software_rub": "ПО управления парком",
    "robots.*.station_price_rub": "Цена станции комплектации",
    "robots.*.utilization": "Загрузка робота",
    "facilities.*.staff.*.headcount": "Мест в штате",
    "facilities.*.staff.*.filled": "Занято людьми",
    "facilities.*.staff.*.salary_month": "Оклад в месяц",
    "facilities.*.staff.*.contractor": "Люди подрядчика",
}


# Единицы значений: в модели они записаны не у каждого числа, поэтому держим их здесь рядом
# с названиями. Доли пишем долями, как они лежат в модели: 0,15 это 15%.
UNITS = {
    "ramp_up.simple.first_month_share": "доля",
    "ramp_up.simple.months": "мес.",
    "ramp_up.station.first_month_share": "доля",
    "ramp_up.station.months": "мес.",
    "financing.method": "0 свои, 1 кредит, 2 лизинг",
    "financing.loan.rate": "доля в год",
    "financing.loan.term_months": "мес.",
    "financing.leasing.rate": "доля в год",
    "financing.leasing.term_months": "мес.",
    "subsidies.msp-1764.chosen": "1 да, 0 нет",
    "subsidies.msp-1764.rate": "доля в год",
    "subsidies.frp-leasing.chosen": "1 да, 0 нет",
    "subsidies.frp-leasing.rate": "доля в год",
    "subsidies.frp-leasing.term_months": "мес.",
    "subsidies.minpromtorg-robotics.chosen": "1 да, 0 нет",
    "economics.annual_work_hours": "ч в год",
    "economics.capex_reserve_share": "доля",
    "economics.discount_rate": "доля в год",
    "economics.energy_price_growth": "доля в год",
    "economics.energy_price_rub_kwh": "₽ за кВт·ч",
    "economics.horizon_years": "лет",
    "economics.inflation": "доля в год",
    "economics.payback_bands_years": "лет",
    "economics.payroll.hire_cost_months": "окладов",
    "economics.payroll.injury_insurance_rate": "доля оклада",
    "economics.payroll.insurance_base_limit_rub": "₽ в год",
    "economics.payroll.insurance_rate": "доля оклада",
    "economics.payroll.insurance_rate_above_limit": "доля оклада",
    "economics.payroll.turnover_rate": "доля в год",
    "economics.payroll.workwear_rub_year": "₽ в год",
    "economics.peak_reserve_share": "доля",
    "economics.wage_growth": "доля в год",
    "engine.geometry.route_factor": "от стороны зоны",
    "engine.geometry.picking_m2_per_robot": "м²",
    "engine.selection.stacking_lift_mm": "мм",
    "engine.simulation.availability": "доля",
    "engine.simulation.peak_hours": "ч",
    "engine.simulation.robots_per_aisle": "роботов",
    "facilities.*.active_area_m2": "м²",
    "facilities.*.sku_count": "SKU",
    "facilities.*.constraints.aisle_width_mm": "мм",
    "facilities.*.constraints.ceiling_m": "м",
    "facilities.*.constraints.floor_flatness_mm": "мм",
    "facilities.*.constraints.main_aisle_width_mm": "мм",
    "facilities.*.fast_picks_share": "доля",
    "facilities.*.fast_share": "доля",
    "facilities.*.picking_zone_share": "доля",
    "facilities.*.implementation.communications_rub_year": "₽ в год",
    "facilities.*.implementation.hiring_rub_per_person": "₽ на человека",
    "facilities.*.implementation.infrastructure_rub": "₽",
    "facilities.*.implementation.integration_rub": "₽",
    "facilities.*.implementation.retraining_rub_per_person": "₽ на человека",
    "facilities.*.min_operator_posts": "человек в смену",
    "facilities.*.operator_salary_premium": "доля",
    "facilities.*.operations.*.automatable_share": "доля",
    "facilities.*.operations.*.implementation.infrastructure_rub": "₽",
    "facilities.*.operations.*.implementation.integration_rub": "₽",
    "facilities.*.operations.*.ops_per_trip": "операций",
    "facilities.*.operations.*.volume_per_day": "в сутки",
    "facilities.*.operations.*.load_kg": "кг",
    "facilities.*.operations.*.productivity_after": "в час",
    "facilities.*.operations.*.productivity_before": "в час",
    "facilities.*.peak_factor": "раза",
    "facilities.*.schedule.days_per_year": "дней",
    "facilities.*.schedule.shift_hours": "ч",
    "facilities.*.schedule.shifts": "смен",
    "facilities.*.slotted_by_turnover": "1 да, 0 нет",
    "facilities.*.staff.*.headcount": "человек",
    "facilities.*.staff.*.salary_month": "₽ в месяц",
    "facilities.*.staff_loss_share": "доля",
    "robots.*.avg_power_kw": "кВт",
    "robots.*.avg_speed_m_s": "м/с",
    "robots.*.battery_life_years": "лет",
    "robots.*.battery_price_rub": "₽",
    "robots.*.charge_time_h": "ч",
    "robots.*.charger_price_rub": "₽",
    "robots.*.commissioning_share": "доля цены робота",
    "robots.*.handling_s": "с",
    "robots.*.license_rub_year": "₽ в год на робота",
    "robots.*.maintenance_share_year": "доля цены в год",
    "robots.*.nominal_trips_per_hour": "рейсов в час",
    "robots.*.operator_attention_min_per_hour": "мин в час",
    "robots.*.price_rub": "₽",
    "robots.*.raas.contract_months": "мес.",
    "robots.*.raas.damage_share_year": "доля цены в год",
    "robots.*.raas.fee_rub_month": "₽ в месяц за робота",
    "robots.*.raas.support_share": "доля",
    "robots.*.robots_per_charger": "роботов",
    "robots.*.run_time_h": "ч",
    "robots.*.service_life_years": "лет",
    "robots.*.software_rub": "₽",
    "robots.*.station_price_rub": "₽",
    "robots.*.utilization": "доля",
}


def plural(count: int, one: str, few: str, many: str) -> str:
    """Слово при числе: 1 робот, 3 робота, 11 роботов."""
    if count % 10 == 1 and count % 100 != 11:
        return one
    if count % 10 in (2, 3, 4) and count % 100 not in (12, 13, 14):
        return few
    return many


def _pattern(path: str) -> str:
    parts = path.split(".")
    if parts[0] == "robots" and len(parts) > 2:
        parts[1] = "*"
    if parts[0] == "facilities" and len(parts) > 2:
        parts[1] = "*"
        if len(parts) > 4 and parts[2] in ("operations", "staff"):
            parts[3] = "*"
    return ".".join(parts)


def unit(path: str) -> str:
    """Единица значения. Если в словаре нет, по хвосту пути: _rub это рубли, _share доля."""
    found = UNITS.get(_pattern(path))
    if found is not None:
        return found
    tail = path.rsplit(".", 1)[-1]
    for suffix, name in (("_rub", "₽"), ("_share", "доля"), ("_years", "лет"), ("_mm", "мм"), ("_m", "м")):
        if tail.endswith(suffix):
            return name
    return ""


def name(
    path: str, known: dict[str, str], operations: dict[str, str] | None = None, staff: dict[str, str] | None = None
) -> str:
    """Название значения: из полей формы, из словаря выше, иначе последний кусок пути словами.
    У значений задачи в конце название задачи: объем уборки и объем перевозки это разные числа.
    У строки штата в конце роль: оклад отборщика и оклад оператора погрузчика тоже разные."""
    if path in known:
        return known[path]
    found = NAMES.get(_pattern(path)) or re.sub(r"[_.]", " ", path.split(".")[-1]).capitalize()
    parts = path.split(".")
    if parts[0] == "facilities" and len(parts) > 4 and parts[2] == "operations":
        found += f", {(operations or {}).get(parts[3], parts[3]).lower()}"
    if parts[0] == "facilities" and len(parts) > 4 and parts[2] == "staff":
        found += f", {(staff or {}).get(parts[3], parts[3]).lower()}"
    return found


def group(path: str) -> str:
    return GROUPS.get(path.split(".")[0], "Прочее")
