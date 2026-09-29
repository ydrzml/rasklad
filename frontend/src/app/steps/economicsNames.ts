/* Названия статей затрат на экране: ключи те же, что в ответе сервера */

export const CAPEX_NAMES: Record<string, string> = {
  hardware: "Роботы",
  chargers: "Зарядные станции",
  software: "ПО управления парком",
  stations: "Станции комплектации",
  integration: "Интеграция с WMS",
  infrastructure: "Инфраструктура",
  commissioning: "Пусконаладка",
  retraining: "Переобучение операторов",
  hiring: "Подбор операторов",
  reserve: "Резерв",
};

export const OPEX_NAMES: Record<string, string> = {
  electricity: "Электроэнергия",
  communications: "Связь",
  operators: "Операторы роботов",
  maintenance: "ТО и ремонт",
  licenses: "Лицензии ПО",
  battery: "Расходники: замена АКБ",
  raas_fee: "Плата за аренду",
  damage: "Ответственность за порчу",
};

/* Слагаемые стоимости владения, кроме статей затрат на роботов */
export const TCO_NAMES: Record<string, string> = {
  start: "Вложения на старте",
  later: "Обновление парка",
  staff: "Люди, которые остались на операции",
  ramp: "Люди до выхода роботов на режим",
  financing: "Платежи по кредиту или лизингу",
  insurance: "Страховка залога или предмета лизинга",
  support: "Господдержка",
};

/* Название сценария словами: покупку в кредит и в лизинг так и называем, как сервер */
export function scenarioWord(scenario: { id: string; name: string }): string {
  if (scenario.id === "raas") return "Аренда";
  if (scenario.id === "baseline") return "Без роботов";
  return scenario.name;
}

export function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const last = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}

/* Миллионы с двумя знаками: в статьях и формулах, чтобы сумма сходилась с итогом при проверке руками */
export function mln2(value: number): string {
  return (value / 1_000_000).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// IRR словами. Выше 100% пишем "больше 100%": вложения возвращаются быстрее, чем за год, и точная
// ставка ничего не добавляет. Выше 1000% сервер ставку не ищет и отдает пустой, при NPV > 0 это тот же случай
export function irrText(irr: number | null | undefined, npv: number | null | undefined, investment: number): string {
  if (investment <= 0) return "вложений нет";
  if (irr === null || irr === undefined) return (npv ?? 0) > 0 ? "больше 100%" : "не окупается";
  return irr > 1 ? "больше 100%" : `${Math.round(irr * 100)}%`;
}

/* Какой сценарий с роботами раскрыть в сводке сначала: всегда покупку. Аренда переключателем
   рядом, плитка «дешевле за 5 лет» и так помечена, а бюджет говорит строкой над ответом, что можно
   взять аренду или кредит. Раньше сначала открывался тот, что дешевле за горизонт, и когда это была
   аренда, казалось, что расчет выбрал за человека. Аренду и бюджет функция больше не смотрит */
type Choice = { id: string; tco_rub: number; investment_year0_rub: number };

export function firstScenario<T extends Choice>(purchase: T): T {
  return purchase;
}

/* Покупка больше бюджета на старте. В кредит и в лизинг на старте платим только свои деньги,
   их сервер и отдает вложениями на старте */
export function overBudget(purchase: Choice, budget: number | null | undefined): boolean {
  return Boolean(budget) && purchase.investment_year0_rub > (budget ?? 0);
}

/* Строка на задачу: сколько роботов покупкой влезает в бюджет и какую часть работы смены они
   сделают. «Перевозка паллет: на бюджет можно купить 2 робота из 9 нужных, они сделают 44% работы смены» */
type BudgetRow = { operation_name: string; fleet_fits: number; fleet_needed: number; done_share?: number | null };

export function budgetLine(row: BudgetRow): string {
  const robots = (count: number) => `${count} ${plural(count, "робота", "робота", "роботов")}`;
  if (row.fleet_fits === 0)
    return `${row.operation_name}: на бюджет не купить ни одного робота, подготовка объекта под роботов уже дороже`;
  if (row.fleet_fits >= row.fleet_needed)
    return row.fleet_needed === 1
      ? `${row.operation_name}: на бюджет можно купить нужного робота`
      : `${row.operation_name}: на бюджет можно купить все ${robots(row.fleet_needed)}, сколько нужно`;
  const head = `${row.operation_name}: на бюджет можно купить ${robots(row.fleet_fits)} из ${row.fleet_needed} нужных`;
  if (row.done_share === null || row.done_share === undefined) return head;
  const they = row.fleet_fits === 1 ? "он сделает" : "они сделают";
  return `${head}, ${they} ${Math.round(row.done_share * 100)}% работы смены`;
}

/* Вывод кривой парка одной строкой: сколько роботов вытягивают спрос смены и что будет с одним
   меньше. Числа из прогона сервера: needed это парк, найденный поиском, null значит "не вытянуть".
   Строка стоит в панели "Парк" у смены, а сама кривая в блоке "Откуда цифры" */
export function fleetVerdict({
  needed,
  fleet,
  demand,
  washing,
}: {
  needed: number | null;
  fleet: number;
  demand: number;
  washing: boolean;
}): string {
  const per = washing ? " м²" : "";
  const asked = demand.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
  if (needed === null)
    return `Спрос ${asked}${per} в час не вытянуть и 250 роботами: парк упирается в проезды, ворота или станции`;
  if (needed !== fleet)
    return `На этом плане спрос ${asked}${per} в час вытягивают ${needed} ${plural(needed, "робот", "робота", "роботов")}. Экономика пересчитается с ним`;
  if (washing)
    return `${fleet} ${plural(fleet, "робот успевает", "робота успевают", "роботов успевают")} площадь смены, это ${asked} м² в час с запасом${fleet > 1 ? `, ${fleet - 1} уже нет` : ""}`;
  return `${fleet} ${plural(fleet, "робот", "робота", "роботов")} вытягивают спрос ${asked} в час${fleet > 1 ? `, ${fleet - 1} уже не хватает` : ""}`;
}
