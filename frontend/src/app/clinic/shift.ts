/* Смена в корпусе для проигрывателя: где робот в момент t и на каком этаже, где кабина лифта.
   Не расчет: лог отрезками отдал сервер (POST /api/clinic/runs, docs/medical.md "Ответ прогона").
   Робот на ломаной по доле времени отрезка, как у склада (shift/replay.ts), плюс этаж: в кабине
   этажа нет, робот виден в шахте. Модуль без браузера: npm test */

import { spotAt } from "../shift/replay.ts";

export type ClinicSegment = {
  robot: number;
  role: "delivery" | "cleaning";
  floor: number | null;
  from_s: number;
  to_s: number;
  action: string;
  path: [number, number][];
  lift: string;
};

export type LiftSegment = {
  lift: string;
  from_s: number;
  to_s: number;
  action: string;
  from_floor: number;
  to_floor: number;
  robots: number[];
};

type Leg = ClinicSegment & { cum: number[]; from: number; to: number };
export type Track = { robot: number; role: ClinicSegment["role"]; legs: Leg[] };
export type Spot = {
  robot: number;
  role: ClinicSegment["role"];
  floor: number | null;
  lift: string;
  x: number;
  y: number;
  action: string;
};

export function tracksOf(segments: ClinicSegment[]): Track[] {
  const byRobot = new Map<number, Leg[]>();
  for (const part of segments) {
    const cum = [0];
    for (let k = 1; k < part.path.length; k++)
      cum.push(cum[k - 1] + Math.hypot(part.path[k][0] - part.path[k - 1][0], part.path[k][1] - part.path[k - 1][1]));
    const legs = byRobot.get(part.robot) ?? [];
    legs.push({ ...part, cum, from: part.from_s, to: part.to_s });
    byRobot.set(part.robot, legs);
  }
  return [...byRobot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([robot, legs]) => {
      const sorted = [...legs].sort((a, b) => a.from_s - b.from_s);
      return { robot, role: sorted[0].role, legs: sorted };
    });
}

/* Отрезок, который идет в момент t: лог без дыр, ищем делением пополам */
function legAt(legs: Leg[], t: number): Leg | null {
  if (!legs.length) return null;
  let low = 0;
  let high = legs.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (legs[mid].from_s <= t) low = mid;
    else high = mid - 1;
  }
  return legs[low];
}

export function spotOf(track: Track, t: number): Spot | null {
  const leg = legAt(track.legs, t);
  if (!leg) return null;
  const base = { robot: track.robot, role: track.role, floor: leg.floor, lift: leg.lift, action: leg.action };
  if (!leg.path.length) return { ...base, x: 0, y: 0 };
  // Движение по ломаной считает тот же проигрыватель, что и у склада.
  return { ...base, ...spotAt([leg], t)! };
}

/* Кабина в момент t: этаж дробный, пока едет. Нет отрезка: кабина стоит там, где кончился прошлый */
export function cabinAt(segments: LiftSegment[], lift: string, t: number): { floor: number; robots: number[] } | null {
  let last: LiftSegment | null = null;
  for (const one of segments) {
    if (one.lift !== lift) continue;
    if (one.from_s <= t && t < one.to_s) {
      const share = one.to_s > one.from_s ? (t - one.from_s) / (one.to_s - one.from_s) : 1;
      return { floor: one.from_floor + (one.to_floor - one.from_floor) * share, robots: one.robots };
    }
    if (one.to_s <= t && (!last || one.to_s > last.to_s)) last = one;
  }
  return last ? { floor: last.to_floor, robots: [] } : null;
}
