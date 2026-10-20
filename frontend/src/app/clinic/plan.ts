import type { Building } from "./building.ts";
import type { Underlay } from "../plan/underlay.ts";

export type ClinicPlan = {
  source: "template" | "custom" | "upload";
  title: string;
  revision: string;
  underlays: Record<string, Underlay>;
};
export type ClinicDimensions = {
  layout?: "linear" | "mixed";
  width_m: number;
  length_m: number;
  floors: number;
  wards_per_floor: number;
  lifts: number;
  furnished: boolean;
  floor_height_m: number;
};
// Режим работы из отраслевого датасета, лист «Медучреждение»: стационар 24/7/365, амбулатория
// 5/2 с 08:00 до 20:00 (247 рабочих дней по производственному календарю 2026). Уборка дважды в сутки
// по СП 2.1.3678-20 в пределах этого режима
const INPATIENT = { shift_start_h: 7, shift_hours: 24, cleaning_passes: 2, days_per_year: null };
const DAYTIME = { shift_start_h: 8, shift_hours: 12, cleaning_passes: 2, days_per_year: 247 };
export const CLINIC_TEMPLATES = [
  {
    id: "outpatient",
    name: "Поликлиника",
    about: "Прием и кабинеты на одном этаже, общие точки отправки",
    width_m: 44,
    length_m: 24,
    floors: 1,
    wards_per_floor: 4,
    lifts: 0,
    layout: "linear",
    schedule: DAYTIME,
  },
  {
    id: "day-hospital",
    name: "Дневной стационар",
    about: "Приемный этаж и отделение меньшей глубины, общий лифт",
    width_m: 72,
    length_m: 32,
    floors: 2,
    wards_per_floor: 4,
    lifts: 1,
    layout: "mixed",
    schedule: DAYTIME,
  },
  {
    id: "hospital",
    name: "Больничный корпус",
    about: "Четыре разных этажа, аптека и расходники внизу, два лифта",
    width_m: 96,
    length_m: 40,
    floors: 4,
    wards_per_floor: 6,
    lifts: 2,
    layout: "mixed",
    schedule: INPATIENT,
  },
  {
    id: "compact",
    name: "Компактный стационар",
    about: "Три этажа разной глубины и состава помещений, один лифт",
    width_m: 60,
    length_m: 28,
    floors: 3,
    wards_per_floor: 4,
    lifts: 1,
    layout: "mixed",
    schedule: INPATIENT,
  },
] as const;

export function dimensionsProblem(value: ClinicDimensions): string {
  if (![value.width_m, value.length_m, value.floors, value.wards_per_floor, value.lifts].every(Number.isInteger))
    return "Размеры и количество задайте целыми числами";
  if (value.width_m < 10 || value.width_m > 200 || value.length_m < 10 || value.length_m > 200)
    return "Сторона этажа: от 10 до 200 м";
  if (value.floors < 1 || value.floors > 20) return "В корпусе может быть от 1 до 20 этажей";
  if (value.width_m * value.length_m * value.floors > 200_000)
    return "Суммарная площадь участков этажей: до 200 000 м²";
  if (!Number.isFinite(value.floor_height_m) || value.floor_height_m <= 2 || value.floor_height_m > 8)
    return "Высота этажа должна быть больше 2 и не больше 8 м";
  if (value.wards_per_floor < 1 || value.wards_per_floor > 8 || value.lifts < 0 || value.lifts > 12)
    return "Укажите от 1 до 8 постов на этаж и от 0 до 12 лифтов";
  if (value.furnished && value.lifts > 2 && value.length_m < 8 + 3 * value.lifts)
    return "Увеличьте глубину этажа: для группы лифтов нужно 8 + 3 × число лифтов, м";
  if (value.furnished && (value.width_m < 36 || value.length_m < 18))
    return "Для расстановки помещений нужен этаж от 36 × 18 м. Для меньшего выберите чистый лист";
  if (value.furnished && value.floors > 1 && value.lifts === 0) return "Добавьте хотя бы один лифт между этажами";
  return "";
}

export function cleanUnderlays(raw: unknown, building: Building): Record<string, Underlay> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Underlay> = {};
  for (const floor of building.floors) {
    const value = (raw as Record<string, Partial<Underlay>>)[String(floor.number)];
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.src !== "string" ||
      value.src.length > 300_000 ||
      !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(value.src)
    )
      continue;
    if (
      ![value.x, value.y, value.w, value.h, value.opacity].every(
        (one) => typeof one === "number" && Number.isFinite(one),
      )
    )
      continue;
    if (
      value.w! <= 0 ||
      value.h! <= 0 ||
      value.w! > 500 ||
      value.h! > 500 ||
      Math.abs(value.x!) > 500 ||
      Math.abs(value.y!) > 500
    )
      continue;
    out[String(floor.number)] = {
      src: value.src,
      x: value.x!,
      y: value.y!,
      w: value.w!,
      h: value.h!,
      opacity: Math.min(1, Math.max(0.1, value.opacity!)),
      label: typeof value.label === "string" ? value.label.slice(0, 120) : "План этажа",
    };
  }
  return out;
}

export function restoreClinicPlan(raw: unknown, building: Building | null): ClinicPlan | null {
  if (!building) return null;
  if (raw === undefined)
    return { source: "template", title: "Сохраненный корпус", revision: "restored", underlays: {} };
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ClinicPlan>;
  if (!["template", "custom", "upload"].includes(value.source ?? "")) return null;
  return {
    source: value.source!,
    title: typeof value.title === "string" ? value.title.slice(0, 120) : "Мой корпус",
    revision: typeof value.revision === "string" ? value.revision : "restored",
    underlays: cleanUnderlays(value.underlays, building),
  };
}

export function parseClinicDocument(text: string): { building: unknown; underlays: unknown } {
  if (text.length > 4 * 1024 * 1024) throw new Error("JSON больше 4 МБ");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Не удалось прочитать JSON. Загрузите файл корпуса, сохраненный из редактора");
  }
  if (!raw || typeof raw !== "object") throw new Error("В JSON нет корпуса");
  const doc = raw as { building?: unknown; version?: unknown; floors?: unknown; underlays?: unknown };
  const building = doc.building ?? raw;
  if (!building || typeof building !== "object" || !Array.isArray((building as Building).floors))
    throw new Error("Нужен JSON корпуса с этажами, помещениями и лифтами");
  return { building, underlays: doc.underlays };
}

export function clinicDocument(building: Building, plan: ClinicPlan): string {
  return JSON.stringify({ version: 1, building, underlays: cleanUnderlays(plan.underlays, building) }, null, 2);
}
