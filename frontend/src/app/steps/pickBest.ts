import type { Solution } from "../../api/client";

/* Выбор решения на шаге 4: какое поставить заранее и что написать на карточке. Только то, что
   подбор уже посчитал, ничего от себя */

// Проверка подбора с условием, при котором решение подходит задаче (производитель его не подтвердил)
export const CONDITION = "Условие";

// Пояснение из подбора словами для строки после двоеточия: с маленькой буквы и с запятой в числе
export function lower(text: string): string {
  const ru = text.replace(/(\d)\.(\d)/g, "$1,$2");
  return ru ? ru[0].toLowerCase() + ru.slice(1) : ru;
}

// Решение для другой задачи: проверка "Процесс" не проходит, считать его на эту задачу нельзя
export function forOtherTask(solution: Solution): boolean {
  return solution.checks.some((check) => check.label === "Процесс" && check.outcome === "blocks");
}

/* Лучшее решение задачи для выбора заранее: из подходящих, которые считаются. Порядок тот же, что
   у карточек "сначала лучшие": с запасом по грузу выше тех, что впритык, дальше по баллу.
   Если подходящих нет, ничего не выбираем: человек решает сам */
export function bestToPick(solutions: Solution[]): string | null {
  const fit = solutions
    .filter((one) => one.status === "recommended" && one.can_calculate && one.robot_id && !forOtherTask(one))
    .sort((a, b) => Number(a.at_limit ?? false) - Number(b.at_limit ?? false) || b.score - a.score);
  return fit[0]?.robot_id ?? null;
}

/* Две строки карточки: кому подходит и когда не брать. Из проверок подбора: что подходит, что не
   проходит, чего не хватает для проверки */
export function fitLines(solution: Solution): { suits: string; avoid: string } {
  const fits = solution.checks.filter((check) => check.outcome === "fits");
  const blocks = solution.checks.filter((check) => check.outcome === "blocks");
  const unknown = solution.checks.filter((check) => check.outcome === "unknown");
  // "Процесс" только говорит, что решение для этой задачи, а "Условие" идет слабым местом: кому оно подходит,
  // это не объясняет
  const suits = fits
    .filter((check) => check.label !== "Процесс" && check.label !== CONDITION)
    .slice(0, 2)
    .map((check) => lower(check.detail))
    .join("; ");
  const avoid = [
    ...blocks.slice(0, 2).map((check) => lower(check.detail)),
    ...(unknown.length ? [`нет данных: ${unknown.map((check) => lower(check.label)).join(", ")}`] : []),
  ].join("; ");
  return { suits, avoid };
}

// Балл подбора на карточке из 100: сервер считает от 0 до 1 (backend/app/engine/selection.py)
export function scoreOf(score: number): number {
  return Math.round(score * 100);
}

/* Слабое место подходящего решения одной строкой: груз впритык, пилот, нет независимой проверки
   или нет аренды. Только из того, что подбор уже отдал. Нет слабого места, пустая строка */
export function weakSpot(solution: Solution): string {
  if (solution.status !== "recommended") return "";
  const condition = solution.checks.find((check) => check.label === CONDITION);
  if (condition) return `при условии: ${lower(condition.detail)}`;
  if (solution.at_limit) return "груз впритык, запас меньше 10%: среди лучших идет после решений с запасом";
  const pilot = solution.checks.find((check) => check.label === "Зрелость" && check.detail.startsWith("Пилот"));
  if (pilot) return lower(pilot.detail);
  const unverified = solution.factors.find((factor) => factor.label === "Независимая проверка" && !factor.contribution);
  if (unverified) return lower(unverified.detail);
  if (!solution.raas_fee_rub_month) return "цены аренды в каталоге нет";
  return "";
}
