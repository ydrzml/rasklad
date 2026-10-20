import type { ClinicFit, ClinicRobots, FacilitySolution } from "../../api/client.ts";

export const DELIVERY = "floor_delivery";
export const CLEANING = "cleaning";
export const DEFAULT_DELIVERY = "ext-pudu-flashbot-max";
export const DEFAULT_CLEANER = "f31223c1-44c8-4410-8381-6356e2158b61";
export const CLINIC_TASKS = [DELIVERY, CLEANING];

const SPEC_NAMES: Record<string, string> = {
  max_speed_m_s: "скорость",
  runtime_h: "время работы",
  charge_time_h: "время зарядки",
  dimensions_mm: "габариты",
  min_aisle_width_mm: "ширина прохода",
  throughput: "производительность",
};

export const UNFIT = "Не подходит этому корпусу";

/** Почему робот этому корпусу не подходит совсем, словами сервера (POST /api/clinic/fit), или null */
export function unfitReason(item: FacilitySolution, fit: ClinicFit | null | undefined): string | null {
  const reasons = item.operation === DELIVERY ? fit?.delivery : item.operation === CLEANING ? fit?.cleaning : undefined;
  return reasons?.[item.id] ?? null;
}

export function selectionProblem(
  item: FacilitySolution,
  robots: ClinicRobots | null,
  fit?: ClinicFit | null,
): string | null {
  if (!CLINIC_TASKS.includes(item.operation)) return "Для этой задачи пока нет расчетной модели";
  if (item.status === "excluded")
    return item.checks.find((check) => check.outcome === "blocks")?.detail || "Не подходит условиям объекта";
  if (!robots) return "Проверяем характеристики для прогона";
  const robot = [...robots.delivery, ...robots.cleaning].find(
    (one) => one.id === item.id && one.operation === item.operation,
  );
  if (!robot) return "Робот недоступен для прогона этой задачи";
  if (robot.missing.length) return `Нет данных: ${robot.missing.map((field) => SPEC_NAMES[field] ?? field).join(", ")}`;
  if (!item.price_rub || item.price_rub <= 0) return "Нет цены для расчета экономики";
  if (unfitReason(item, fit)) return UNFIT;
  return null;
}

export function clinicChoices(
  taskIds: string[],
  choices: Record<string, string>,
  solutions: FacilitySolution[],
  robots: ClinicRobots | null,
  fit?: ClinicFit | null,
): Record<string, string> {
  return Object.fromEntries(
    taskIds.flatMap((task) => {
      const item = solutions.find((one) => one.operation === task && one.id === choices[task]);
      return item && selectionProblem(item, robots, fit) === null ? [[task, item.id]] : [];
    }),
  );
}
