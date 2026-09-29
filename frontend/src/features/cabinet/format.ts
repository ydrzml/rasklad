import { mln, money, number, term } from "../../app/format";
import type { CompareRow } from "../../api/projects";

// Даты, числа и слова кабинета. Время московское, как в отчетах: часы у компьютера бывают любые

const dateTime = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

const dateOnly = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });

export function when(value: string): string {
  return dateTime.format(new Date(value));
}

export function day(value: string): string {
  return dateOnly.format(new Date(value));
}

/* Число со словом в нужной форме: 1 сохранение, 3 сохранения, 11 сохранений. */
export function counted(count: number, [one, few, many]: [string, string, string]): string {
  const tail = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;
  if (tail === 1 && !teen) return `${count} ${one}`;
  if (tail >= 2 && tail <= 4 && !teen) return `${count} ${few}`;
  return `${count} ${many}`;
}

export const SAVES: [string, string, string] = ["сохранение", "сохранения", "сохранений"];
export const PROJECTS: [string, string, string] = ["проект", "проекта", "проектов"];

export function problem(error: unknown): string {
  return error instanceof Error ? error.message : "Что-то пошло не так, попробуйте еще раз";
}

type Value = CompareRow["values"][number];

// Единица для экрана: в данных площадь записана как м2, на экране м²
export function unitText(unit: string): string {
  return unit.replace(/м2/g, "м²");
}

// Значение в ячейке сравнения: деньги в миллионах, сроки в годах, остальное числом с единицей
export function shown(value: Value, unit: string): string {
  if (value === null || value === undefined) return "нет";
  if (typeof value === "string") return value;
  if (unit === "₽") return money(value);
  if (unit === "лет") return term(value);
  // единица с формы параметров «смен» после 2 звучит плохо: 2 смены, 5 смен
  if (unit === "смен") return `${number(value)} ${counted(value, ["смена", "смены", "смен"]).split(" ")[1]}`;
  return unit ? `${number(value)} ${unitText(unit)}` : number(value);
}

// На сколько колонка отличается от первой. Пусто, если сравнивать нечего или разницы нет
export function delta(value: Value, base: Value, unit: string): string | null {
  if (typeof value !== "number" || typeof base !== "number") return null;
  const diff = value - base;
  if (Math.abs(diff) < (unit === "₽" ? 50_000 : 0.05)) return null;
  const sign = diff > 0 ? "+" : "−";
  if (unit === "₽") return `${sign}${mln(Math.abs(diff))} млн ₽`;
  if (unit === "лет") return `${sign}${term(Math.abs(diff))}`;
  return `${sign}${number(Math.abs(diff))}${unit ? ` ${unitText(unit)}` : ""}`;
}

// Какая колонка в строке лучшая: у стоимости и сроков меньшая. Если все равны, никакая
export function best(row: CompareRow): number | null {
  if (!row.better || !row.differs) return null;
  const numbers = row.values.map((value) => (typeof value === "number" ? value : null));
  const present = numbers.filter((value): value is number => value !== null);
  if (present.length < 2) return null;
  const target = row.better === "low" ? Math.min(...present) : Math.max(...present);
  const hits = numbers.filter((value) => value === target).length;
  return hits === 1 ? numbers.indexOf(target) : null;
}

// Адрес сравнения: /projects?compare=12,15.2: номер проекта, через точку версия
export function compareUrl(items: { project_id: number; version?: number | null }[]): string {
  const list = items.map((item) => (item.version ? `${item.project_id}.${item.version}` : `${item.project_id}`));
  return `/projects?compare=${list.join(",")}`;
}

export function compareItems(search: string): { project_id: number; version: number | null }[] {
  const raw = new URLSearchParams(search).get("compare") ?? "";
  return raw
    .split(",")
    .map((part) => part.trim().split("."))
    .map(([id, version]) => ({ project_id: Number(id), version: version ? Number(version) : null }))
    .filter((item) => Number.isInteger(item.project_id) && item.project_id > 0)
    .map((item) => ({ ...item, version: Number.isInteger(item.version) && item.version! > 0 ? item.version : null }));
}
