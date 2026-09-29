/* Проигрыватель смены: где робот в момент t, сколько роботов работает, где копились очереди.

   Это не расчет. Смену посчитал сервер и отдал лог отрезками: кто, с какой секунды по какую,
   что делал и по какой ломаной ехал. Здесь только читаем лог: робота ставим на ломаную по доле
   времени отрезка, как фишку на карте. Координаты как у плана: метры, ноль в левом нижнем углу. */
import type { ShiftPlace, ShiftSegment } from "../../api/client";

export type Action = "едет" | "ждет" | "грузит" | "моет" | "меняет воду" | "заряжается" | "без задания";

/* Цвет действия: токены из tokens.css. Желтого нет и здесь: желтый только в тепловой карте */
export const ACTION_COLOR: Record<string, string> = {
  едет: "var(--act-move)",
  грузит: "var(--act-load)",
  // уборщик груза не возит: у места моет, на базе сливает и наливает воду. Цвет как у погрузки
  моет: "var(--act-load)",
  "меняет воду": "var(--act-load)",
  ждет: "var(--act-wait)",
  заряжается: "var(--act-charge)",
  "без задания": "var(--act-idle)",
};

export const ACTIONS: { id: Action; name: string }[] = [
  { id: "едет", name: "едет" },
  { id: "грузит", name: "грузит" },
  { id: "моет", name: "моет" },
  { id: "меняет воду", name: "меняет воду" },
  { id: "ждет", name: "ждет в очереди" },
  { id: "заряжается", name: "заряжается" },
  { id: "без задания", name: "без задания" },
];

/* Действия, которые есть в этой смене: в легенде у перевозки нет "моет", у уборщика "грузит" */
export function actionsOf(replay: Replay): { id: Action; name: string }[] {
  const seen = new Set(replay.robots.flat().map((leg) => leg.action));
  const found = ACTIONS.filter((one) => seen.has(one.id));
  return found.length ? found : ACTIONS;
}

/* Отрезок с длинами кусков ломаной: чтобы не считать их на каждом кадре */
type Leg = { from: number; to: number; action: string; path: [number, number][]; cum: number[] };

export type Replay = { robots: Leg[][]; hours: number };

export function replayOf(segments: ShiftSegment[], hours: number): Replay {
  const robots: Leg[][] = [];
  for (const part of segments) {
    const path = part.path as [number, number][];
    const cum = [0];
    for (let k = 1; k < path.length; k++)
      cum.push(cum[k - 1] + Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]));
    (robots[part.robot] ??= []).push({ from: part.from_s, to: part.to_s, action: part.action, path, cum });
  }
  for (const legs of robots) legs?.sort((a, b) => a.from - b.from);
  return { robots: robots.map((legs) => legs ?? []), hours };
}

/* Отрезок робота, который идет в момент t. Лог без дыр, поэтому ищем делением пополам */
function legAt(legs: Leg[], t: number): Leg | null {
  if (!legs.length) return null;
  let low = 0;
  let high = legs.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (legs[mid].from <= t) low = mid;
    else high = mid - 1;
  }
  return legs[low];
}

export type Spot = { robot: number; x: number; y: number; action: string };

/* Где стоит робот в момент t: на ломаной по доле времени отрезка, у стоячих в единственной точке */
export function spotAt(legs: Leg[], t: number): { x: number; y: number; action: string } | null {
  const leg = legAt(legs, t);
  if (!leg) return null;
  const { path, cum } = leg;
  const total = cum[cum.length - 1];
  if (path.length < 2 || total <= 0 || leg.to <= leg.from) return { x: path[0][0], y: path[0][1], action: leg.action };
  const share = Math.min(1, Math.max(0, (t - leg.from) / (leg.to - leg.from)));
  const along = share * total;
  let k = 1;
  while (k < cum.length - 1 && cum[k] < along) k++;
  const piece = cum[k] - cum[k - 1] || 1;
  const f = (along - cum[k - 1]) / piece;
  return {
    x: path[k - 1][0] + (path[k][0] - path[k - 1][0]) * f,
    y: path[k - 1][1] + (path[k][1] - path[k - 1][1]) * f,
    action: leg.action,
  };
}

export function spotsAt(replay: Replay, t: number): Spot[] {
  const found: Spot[] = [];
  replay.robots.forEach((legs, robot) => {
    const spot = spotAt(legs, t);
    if (spot) found.push({ robot, ...spot });
  });
  return found;
}

/* Шкала смены по минутам: сколько роботов в работе и сколько ждут в очереди. В работе значит
   едет, грузит (моет, меняет воду) или ждет: робот занят заданием. Без задания и на зарядке не в работе */
export type Minute = { busy: number; waiting: number };

export function minutesOf(replay: Replay): Minute[] {
  const count = Math.ceil(replay.hours * 60);
  const busy = new Float64Array(count);
  const waiting = new Float64Array(count);
  for (const legs of replay.robots)
    for (const leg of legs) {
      const work = leg.action !== "без задания" && leg.action !== "заряжается";
      if (!work) continue;
      // доля минуты, которую отрезок в ней занимает: так короткие отрезки не теряются
      for (let m = Math.floor(leg.from / 60); m < count && m * 60 < leg.to; m++) {
        const part = (Math.min(leg.to, (m + 1) * 60) - Math.max(leg.from, m * 60)) / 60;
        if (part <= 0) continue;
        busy[m] += part;
        if (leg.action === "ждет") waiting[m] += part;
      }
    }
  return Array.from({ length: count }, (_, m) => ({ busy: busy[m], waiting: waiting[m] }));
}

/* Смесь действий по минутам: какая доля парка едет, грузит, ждет, заряжается и стоит без задания.
   Шкала смены показывает ее полосой над строками роботов: двести строк по точке не читаются */
export function mixOf(replay: Replay): Record<string, number>[] {
  const count = Math.ceil(replay.hours * 60);
  const found = Array.from({ length: count }, () => ({}) as Record<string, number>);
  const robots = Math.max(1, replay.robots.length);
  for (const legs of replay.robots)
    for (const leg of legs)
      for (let m = Math.floor(leg.from / 60); m < count && m * 60 < leg.to; m++) {
        const part = (Math.min(leg.to, (m + 1) * 60) - Math.max(leg.from, m * 60)) / 60 / robots;
        if (part > 0) found[m][leg.action] = (found[m][leg.action] ?? 0) + part;
      }
  return found;
}

/* Выводы над строками роботов словами: когда пик, какая доля парка занята в пик и вне его,
   сколько роботов заряжается одновременно. Это не расчет, а сводка лога, который отдал сервер:
   те же минуты, что на шкале. В работе значит едет, грузит или ждет в очереди */
export type ScoreSummary = {
  peakFrom: number;
  peakTo: number;
  peakBusy: number;
  offBusy: number;
  charging: number;
};

export function summaryOf(replay: Replay, demand: number[]): ScoreSummary {
  const robots = Math.max(1, replay.robots.length);
  const minutes = minutesOf(replay);
  const top = Math.max(...demand, 0);
  const peak = demand.map((value, hour) => (value >= top - 1e-9 ? hour : -1)).filter((hour) => hour >= 0);
  const inPeak = (m: number) => peak.includes(Math.floor(m / 60));
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const peakBusy = mean(minutes.filter((_, m) => inPeak(m)).map((one) => one.busy / robots));
  const offBusy = mean(minutes.filter((_, m) => !inPeak(m)).map((one) => one.busy / robots));
  // сколько заряжаются одновременно: по началам и концам зарядок, а не средним за минуту
  const events = replay.robots
    .flat()
    .filter((leg) => leg.action === "заряжается")
    .flatMap((leg) => [
      [leg.from, 1],
      [leg.to, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let charging = 0;
  for (const [, step] of events) {
    now += step;
    charging = Math.max(charging, now);
  }
  return {
    peakFrom: peak.length ? Math.min(...peak) : 0,
    peakTo: peak.length ? Math.max(...peak) + 1 : 0,
    peakBusy,
    offBusy,
    charging,
  };
}

/* Отметки очередей на шкале: подряд идущие минуты, где кто-то ждал, склеены в одну отметку */
export function queuesOf(minutes: Minute[], least = 0.05): { from: number; to: number; peak: number }[] {
  const found: { from: number; to: number; peak: number }[] = [];
  minutes.forEach((minute, m) => {
    if (minute.waiting < least) return;
    const last = found[found.length - 1];
    if (last && last.to === m) {
      last.to = m + 1;
      last.peak = Math.max(last.peak, minute.waiting);
    } else found.push({ from: m, to: m + 1, peak: minute.waiting });
  });
  return found;
}

/* Тепловая карта в ячейках. Место из ответа сервера это клетка проезда у стеллажа, откуда робот
   берет груз. Красим клетку стеллажа рядом с ним: так карта ложится на ячейки, а проезды
   остаются чистыми. Какая из соседних клеток стеллаж, говорит rackAt */
export type HeatCell = { col: number; row: number; value: number };

export function heatOf(
  places: ShiftPlace[],
  by: "share" | "visits",
  rackAt: (col: number, row: number) => boolean,
): HeatCell[] {
  const cells = new Map<string, HeatCell>();
  for (const place of places) {
    const col = Math.floor(place.x);
    const row = Math.floor(place.y);
    const value = by === "share" ? place.share : place.visits;
    const next = [
      [col - 1, row],
      [col + 1, row],
      [col, row - 1],
      [col, row + 1],
    ].find(([c, r]) => rackAt(c, r));
    const [c, r] = next ?? [col, row];
    const key = `${c}:${r}`;
    const cell = cells.get(key);
    if (cell) cell.value += value;
    else cells.set(key, { col: c, row: r, value });
  }
  return [...cells.values()];
}

/* Шкала тепловой карты: светлый, желтый, оранжевый, красный. Единственное место, где есть
   желтый: так карту читают на всех складских системах, а в остальном интерфейсе его нет */
const HEAT: [number, number, number][] = [
  [247, 243, 226],
  [247, 214, 92],
  [236, 138, 44],
  [192, 57, 43],
];

export function heatColor(share: number): string {
  const t = Math.min(1, Math.max(0, share)) * (HEAT.length - 1);
  const k = Math.min(HEAT.length - 2, Math.floor(t));
  const f = t - k;
  const mix = HEAT[k].map((v, i) => Math.round(v + (HEAT[k + 1][i] - v) * f));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

/* Где на шкале тепла стоит ячейка. Доли у мест различаются в сотни раз, а заездов за смену у
   большинства мест ноль или один: линейная шкала закрасила бы все, кроме пары ячеек, почти белым.
   Поэтому шкала по порядку: ячейка краснее, чем больше ячеек с меньшим значением. Равные
   значения встают на середину своей группы: если все места равны, вся карта одного цвета посередине
   шкалы, а не белая и не красная. Ячейка без заездов всегда светлая */
export function heatRanks(cells: HeatCell[]): Map<HeatCell, number> {
  const sorted = cells.map((cell) => cell.value).sort((a, b) => a - b);
  const below = new Map<number, number>();
  const same = new Map<number, number>();
  sorted.forEach((value, index) => {
    if (!below.has(value)) below.set(value, index);
    same.set(value, (same.get(value) ?? 0) + 1);
  });
  const n = Math.max(1, sorted.length);
  return new Map(
    cells.map((cell) => [
      cell,
      cell.value > 0 ? ((below.get(cell.value) ?? 0) + (same.get(cell.value) ?? 1) / 2) / n : 0,
    ]),
  );
}

export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
