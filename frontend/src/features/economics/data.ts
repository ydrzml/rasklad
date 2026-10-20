import type { CalculationRequest, CalculationResult, SensitivityAll } from "../../api/client";

// Демо-расчет из документации (docs/documentation.md, раздел 6.10): склад датасета, перевозка паллет
// роботом Ronavi H1500 на типовом плане "С одной стороны", прогон смены. План строит сервер по
// шаблону, он совпадает с docs/example/request.json. Все числа страницы приходят в ответах сервера
export const DEMO = {
  facility_id: "warehouse",
  operation_id: "pallet_transport",
  robot_id: "ronavi-h1500",
  template_id: "one_side",
} as const;

// Способ оплаты покупки в модели: 0 свои деньги, 1 кредит, 2 лизинг (config/model.yaml, financing.method)
export const PAY_METHODS = [
  { id: "own", name: "Свои деньги", method: 0 },
  { id: "loan", name: "Кредит", method: 1 },
  { id: "leasing", name: "Лизинг", method: 2 },
] as const;

export function demoRequest(plan: CalculationRequest["plan"], method = 0): CalculationRequest {
  return {
    facility_id: DEMO.facility_id,
    operation_id: DEMO.operation_id,
    robot_id: DEMO.robot_id,
    tasks: [{ operation_id: DEMO.operation_id, robot_id: DEMO.robot_id, share: 1 }],
    overrides: method ? { "financing.method": method } : {},
    plan,
    raas_buyout: false,
    use_simulation: true,
  };
}

export type Source = NonNullable<CalculationResult["sources"]>[number];

/* Допущения по группам. Путь значения ищем по концу: у робота и объекта в начале пути стоит их id */
export const ASSUMPTION_GROUPS: { id: string; title: string; note: string; paths: string[] }[] = [
  {
    id: "time",
    title: "Деньги во времени",
    note: "как растут цены и чего стоит рубль через год",
    paths: [
      "economics.discount_rate",
      "economics.wage_growth",
      "economics.inflation",
      "economics.energy_price_growth",
      "economics.horizon_years",
    ],
  },
  {
    id: "people",
    title: "Люди",
    note: "сколько стоит ставка сверх оклада",
    paths: [
      "payroll.insurance_rate",
      "payroll.insurance_rate_above_limit",
      "payroll.insurance_base_limit_rub",
      "payroll.injury_insurance_rate",
      "economics.annual_work_hours",
      "staff_loss_share",
    ],
  },
  {
    id: "robot",
    title: "Робот при покупке",
    note: "цена и что платим за него каждый год",
    paths: [
      "price_rub",
      "maintenance_share_year",
      "service_life_years",
      "amortization_years",
      "battery_life_years",
      "battery_price_rub",
      "license_rub_year",
      "software_rub",
      "charger_price_rub",
      "avg_power_kw",
      "economics.energy_price_rub_kwh",
    ],
  },
  {
    id: "start",
    title: "Внедрение",
    note: "разовые затраты на старте, в обоих сценариях с роботами",
    paths: [
      "implementation.integration_rub",
      "implementation.infrastructure_rub",
      "commissioning_share",
      "implementation.retraining_rub_per_person",
      "economics.capex_reserve_share",
      "implementation.communications_rub_year",
    ],
  },
  {
    id: "raas",
    title: "Аренда",
    note: "условия аренды, выкуп отдельным кейсом",
    paths: ["raas.fee_rub_month", "raas.contract_months", "raas.damage_share_year", "raas.support_share"],
  },
  {
    id: "ramp",
    title: "Выход на режим",
    note: "первые месяцы роботы дают не весь эффект",
    paths: ["ramp_up.simple.first_month_share", "ramp_up.simple.months"],
  },
  {
    id: "debt",
    title: "Кредит и лизинг",
    note: "только если покупку оплачивают не своими деньгами",
    paths: [
      "financing.loan.rate",
      "financing.loan.own_share",
      "financing.loan.term_months",
      "financing.leasing.rate",
      "financing.leasing.advance_share",
      "financing.leasing.term_months",
      "financing.insurance_share_year",
    ],
  },
];

function matches(path: string, pattern: string): boolean {
  return path === pattern || path.endsWith(`.${pattern}`);
}

/* Значения из ответов нескольких расчетов одним списком, без повторов: кредит и лизинг добавляют
   свои условия к общим значениям */
export function mergeSources(lists: (Source[] | undefined)[]): Source[] {
  const seen = new Map<string, Source>();
  lists.forEach((list) => list?.forEach((one) => seen.has(one.path) || seen.set(one.path, named(one))));
  return [...seen.values()];
}

// У страховки в config/model.yaml нет названия и единицы, сервер отдает путь: подписываем сами
const NAMED: Record<string, Pick<Source, "name" | "unit">> = {
  "financing.insurance_share_year": { name: "Страховка залога или предмета лизинга", unit: "доля цены в год" },
};

function named(one: Source): Source {
  const fix = NAMED[one.path];
  return fix && (!one.unit || !one.name || one.name === one.path) ? { ...one, ...fix } : one;
}

export function groupSources(sources: Source[]) {
  return ASSUMPTION_GROUPS.map((group) => ({
    ...group,
    items: group.paths.flatMap((pattern) => sources.filter((one) => matches(one.path, pattern))),
  })).filter((group) => group.items.length > 0);
}

// Число по-русски: 2 979 000, 15,1. Свое, а не из app/format: тот модуль в тестах node не грузится
function number(value: number, digits: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: digits });
}

/* Значение с единицей по-человечески: доля 0,07 "в год" это 7% в год, 1972 "ч в год" так и остается */
export function valueText(source: Pick<Source, "value" | "unit">): string {
  const raw = Array.isArray(source.value) ? source.value : [source.value];
  const unit = source.unit ?? "";
  if (unit.startsWith("доля")) {
    const rest = unit.slice("доля".length).trim();
    const shown = raw.map((one) => number(one * 100, 1)).join("-");
    return rest ? `${shown}% ${rest}` : `${shown}%`;
  }
  const shown = raw.map((one) => number(one, 3)).join("-");
  return unit ? `${shown} ${unit}` : shown;
}

// "2026-09" это сентябрь 2026 года: так дата источника стоит в config/*.yaml
export function dateText(date: string | null | undefined): string {
  if (!date) return "без даты";
  const [year, month] = date.split("-");
  return month ? `${month}.${year}` : year;
}

/* Чего нет в источниках и что до уточнения стоит нулем: строка "нет данных" это не "бесплатно" */
const ZERO_UNKNOWN = [
  "payroll.turnover_rate",
  "payroll.workwear_rub_year",
  "payroll.hire_cost_months",
  "operator_salary_premium",
  "raas.support_share",
];

export function zeroUnknowns(sources: Source[]): Source[] {
  return sources.filter(
    (one) => one.value === 0 && one.trust === "F" && ZERO_UNKNOWN.some((pattern) => matches(one.path, pattern)),
  );
}

// Сколько значений расчета с какой оценкой: S лучше всего, F это наше допущение
export function trustCounts(sources: Source[]): { level: string; count: number }[] {
  return ["S", "A", "B", "C", "D", "E", "F"].map((level) => ({
    level,
    count: sources.filter((one) => one.trust === level).length,
  }));
}

export type Impact = {
  key: string;
  name: string;
  base: string;
  low: number | null;
  high: number | null;
  min: number;
  max: number;
  swing: number;
};

/* Что сильнее всего двигает выгоду сценария: порядок и размах дает сервер, здесь только первые строки */
export function topImpacts(all: SensitivityAll, scenario: string, limit: number): { base: number; rows: Impact[] } {
  const saving = (cell: SensitivityAll["params"][number]["cells"][number] | undefined) =>
    cell?.outcomes.find((one) => one.scenario_id === scenario)?.saving_rub ?? null;
  const swing = (param: SensitivityAll["params"][number]) =>
    (param.swings ?? []).find((one) => one.scenario_id === scenario)?.rub ?? 0;
  const rows = [...all.params]
    .sort((a, b) => swing(b) - swing(a))
    .slice(0, limit)
    .map((param) => {
      const values = param.cells.map(saving).filter((value): value is number => value !== null);
      return {
        key: param.id,
        name: param.name,
        base: param.base,
        low: saving(param.cells[0]),
        high: saving(param.cells[param.cells.length - 1]),
        min: Math.min(...values),
        max: Math.max(...values),
        swing: swing(param),
      };
    });
  return { base: saving(all.params[0]?.cells[2]) ?? 0, rows };
}
