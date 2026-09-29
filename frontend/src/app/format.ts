import { groupDigits, unitText } from "../ui/digits";
import { plural } from "./steps/economicsNames";

const ru = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) >= 1_000_000) return `${mln(value)} млн ₽`;
  return `${ru.format(value)} ₽`;
}

// Миллионы с одной цифрой после запятой, по-русски: 111,3
export function mln(value: number): string {
  return (value / 1_000_000).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// Срок в годах с запятой и правильным словом: 1,2 года, 5 лет
export function term(value: number | null | undefined): string {
  if (value === null || value === undefined) return "не окупается";
  const rounded = Math.round(value * 10) / 10;
  const shown = rounded.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  if (!Number.isInteger(rounded)) return `${shown} года`;
  const word = rounded === 1 ? "год" : rounded >= 2 && rounded <= 4 ? "года" : "лет";
  return `${shown} ${word}`;
}

export function number(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("ru-RU", { maximumFractionDigits: digits });
}

export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

// Оценка доверия к цифре: S закон, A проверено, B два источника, C один источник,
// D только организатор или СМИ, E источники расходятся, F источника нет.
export const TRUST_TITLES: Record<string, string> = {
  S: "закон или норматив",
  A: "производитель и независимая проверка",
  B: "сходятся два типа источников",
  C: "один источник",
  D: "только организатор или СМИ",
  E: "источники расходятся",
  F: "источника нет, наше допущение",
};

// Смены и их длина по отдельности бывают в норме, а вместе дают больше суток: 5 смен по 11 ч.
// Такое сервер не считает, поэтому, пока человек не поправит, план и штат у него не спрашиваем
export function overDay(
  parameters: { path: string; value: number }[],
  overrides: Record<string, number>,
): string | null {
  const pick = (suffix: string) => {
    const field = parameters.find((item) => item.path.endsWith(suffix));
    return field ? (overrides[field.path] ?? field.value) : null;
  };
  const shifts = pick("schedule.shifts");
  const hours = pick("schedule.shift_hours");
  if (shifts === null || hours === null || shifts * hours <= 24) return null;
  const word = Number.isInteger(shifts) ? plural(shifts, "смена", "смены", "смен") : "смены";
  return `${number(shifts)} ${word} по ${number(hours)} ч дают ${number(shifts * hours)} ч работы в сутки, а в сутках 24`;
}

/* Значение вне отраслевых границ: коротко, без названия источника, иначе строка ломала высоту
   плитки. Откуда границы, видно в расшифровке буквы оценки (sourceTitle) */
export function rangeWarning(field: { min: number; max: number; unit: string }): string {
  const unit = field.unit && field.unit !== "доля" && !/\d/.test(field.unit) ? ` ${unitText(field.unit)}` : "";
  return `Обычно от ${groupDigits(field.min)} до ${groupDigits(field.max)}${unit}, проверьте`;
}

export function sourceTitle(field: { trust: string; source: string; range_source?: string }): string {
  const range = field.range_source ? ` Границы: ${field.range_source}` : "";
  return `${TRUST_TITLES[field.trust] ?? field.trust}. Источник значения: ${field.source}.${range}`;
}
