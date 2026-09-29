/* Ряды стеллажей в редакторе. Ряд это вещь racks толщиной ровно в один блок стеллажей: у
   фронтального две рамы спиной к спине, у мобильного несколько рядов вплотную. Ряды, которые
   поставили вместе инструментом «Ряды», носят общую группу: щелчок выбирает их все, двойной
   щелчок один ряд. Дальше каждый ряд сам по себе, группа только помогает двигать и править их
   разом.

   Это не расчет. Проезды, маршрут и места у стеллажей считает сервер. Здесь только раскладка:
   куда встанут ряды, если протянуть прямоугольник или поменять число в колонке справа.

   Координаты как у движка: метры, ноль в левом нижнем углу, y растет на север. На экране север
   сверху, поэтому «верхний левый угол» листа это запад и север. */
import type { PlanItem } from "../../api/client";
import type { Point, Rect } from "./geometry";

export type Axis = "x" | "y";

/* Толщина ряда поперек: у мобильного стеллажа это несколько рядов вплотную */
export function bandOf(item: Pick<PlanItem, "row_m" | "block_rows">, fallback: number): number {
  return (item.row_m || fallback) * Math.max(1, item.block_rows);
}

/* Длина ряда вдоль и толщина поперек */
export function lengthOf(item: Rect & { rows: string }): number {
  return item.rows === "x" ? item.w : item.h;
}

export function rowsOf(items: PlanItem[], group: string): PlanItem[] {
  return group ? items.filter((item) => item.kind === "racks" && item.group === group) : [];
}

export function frame(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((one) => one.x));
  const y = Math.min(...rects.map((one) => one.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((one) => one.x + one.w)) - x,
    h: Math.max(...rects.map((one) => one.y + one.h)) - y,
  };
}

/* Сколько рядов целиком встанет поперек: ряд, проезд, ряд. Хотя бы один */
export function countIn(extent: number, band: number, aisle: number): number {
  return Math.max(1, Math.floor((extent + aisle + 1e-6) / (band + aisle)));
}

/* Сколько места поперек займут count рядов с проездами между ними */
export function spanOf(count: number, band: number, aisle: number): number {
  return count * band + Math.max(0, count - 1) * aisle;
}

/* Один ряд по протяжке: тянется вдоль той оси, вдоль которой тянули больше. Поперек он стоит
   так, чтобы линия протяжки шла по его середине, край на целом метре. */
export function rowByDrag(from: Point, to: Point, band: number): Rect & { rows: Axis } {
  const rows: Axis = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? "x" : "y";
  if (rows === "x") {
    const x1 = Math.floor(Math.min(from.x, to.x));
    const x2 = Math.max(x1 + 1, Math.ceil(Math.max(from.x, to.x)));
    return { x: x1, y: Math.round(from.y - band / 2), w: x2 - x1, h: band, rows };
  }
  const y1 = Math.floor(Math.min(from.y, to.y));
  const y2 = Math.max(y1 + 1, Math.ceil(Math.max(from.y, to.y)));
  return { x: Math.round(from.x - band / 2), y: y1, w: band, h: y2 - y1, rows };
}

/* Как лягут ряды в протянутом прямоугольнике: вдоль длинной стороны, первый ряд у того края,
   с которого начали тянуть. Лишнее место остается у дальнего края, ряды не растягиваются.

   Ряд может быть разрезан поперечными проездами на куски: так их кладет типовая схема. Куски
   одного ряда стоят на одной линии, и для числа рядов, проезда и длины это один ряд. */
export type Layout = {
  rows: Axis;
  count: number; // рядов, то есть линий поперек
  aisle: number;
  band: number;
  length: number; // от начала первого куска до конца последнего
  /* с какого края встают ряды поперек: low это запад или юг, high восток или север */
  from: "low" | "high";
  /* край, от которого отсчитываем: координата поперек и начало вдоль */
  edge: number;
  start: number;
  pieces: number; // кусков в ряду между поперечными проездами
  cross: number; // ширина поперечного проезда
};

export function layoutIn(box: Rect, from: Point, band: number, aisle: number, rows?: Axis): Layout {
  const axis: Axis = rows ?? (box.w >= box.h ? "x" : "y");
  const extent = axis === "x" ? box.h : box.w;
  const count = countIn(extent, band, aisle);
  const base = { rows: axis, count, aisle, band, pieces: 1, cross: 0 };
  if (axis === "x") {
    const high = from.y > box.y + box.h / 2;
    return { ...base, length: box.w, from: high ? "high" : "low", edge: high ? box.y + box.h : box.y, start: box.x };
  }
  const high = from.x > box.x + box.w / 2;
  return { ...base, length: box.h, from: high ? "high" : "low", edge: high ? box.x + box.w : box.x, start: box.y };
}

/* Прямоугольники рядов по раскладке: по порядку от того края, с которого встают, в ряду куски
   по порядку вдоль. Куски одного ряда одной длины, между ними поперечный проезд */
export function rectsOf(layout: Layout): Rect[] {
  const { rows, count, aisle, band, length, from, edge, start } = layout;
  const pieces = Math.max(1, layout.pieces);
  const cross = pieces > 1 ? layout.cross : 0;
  const piece = (length - (pieces - 1) * cross) / pieces;
  const found: Rect[] = [];
  for (let index = 0; index < count; index++) {
    const offset = index * (band + aisle);
    const across = round(from === "low" ? edge + offset : edge - offset - band);
    for (let part = 0; part < pieces; part++) {
      const along = round(start + part * (piece + cross));
      found.push(
        rows === "x"
          ? { x: along, y: across, w: round(piece), h: band }
          : { x: across, y: along, w: band, h: round(piece) },
      );
    }
  }
  return found;
}

/* Линии рядов группы: куски на одной линии поперек это один ряд. По порядку от нуля поперек */
function linesOf(rows: PlanItem[]): PlanItem[][] {
  const axis = rows[0]?.rows === "x" ? "x" : "y";
  const lines = new Map<number, PlanItem[]>();
  for (const row of rows) {
    const key = Math.round((axis === "x" ? row.y : row.x) * 100);
    lines.set(key, [...(lines.get(key) ?? []), row]);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, line]) => line.sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y)));
}

/* Раскладка группы, которая уже стоит на плане. Числа правят в колонке справа, и группа держится
   за верхний левый угол листа: ряды поперек листа добавляются вправо, вдоль листа вниз. Так
   правка числа ничего не двигает, кроме того, что правили. */
export function layoutOf(rows: PlanItem[], fallback: number): Layout {
  const box = frame(rows);
  const first = rows[0];
  const band = bandOf(first, fallback);
  const axis: Axis = first.rows === "x" ? "x" : "y";
  const lines = linesOf(rows);
  const [a, b] = [lines[0][0], lines[1]?.[0]];
  const gap = b ? (axis === "x" ? b.y - (a.y + a.h) : b.x - (a.x + a.w)) : first.aisle_m;
  const line = lines[0];
  const pieces = line.length;
  const cross =
    pieces > 1 ? (axis === "x" ? line[1].x - (line[0].x + line[0].w) : line[1].y - (line[0].y + line[0].h)) : 0;
  const base = { rows: axis, count: lines.length, aisle: round(Math.max(0, gap)), band, pieces, cross: round(cross) };
  return axis === "x"
    ? { ...base, length: box.w, from: "high", edge: box.y + box.h, start: box.x }
    : { ...base, length: box.h, from: "low", edge: box.x, start: box.y };
}

/* Новая длина группы: верхний конец рядов вдоль листа стоит на месте, у рядов поперек листа
   стоит на месте левый конец */
export function withLength(layout: Layout, length: number): Layout {
  if (layout.rows === "x") return { ...layout, length };
  return { ...layout, start: layout.start + layout.length - length, length };
}

/* Ряды группы по раскладке: те, что были, сохраняют имя и свойства, новые берут свойства первого.
   Порядок от угла, за который держится группа: ряд за рядом, в ряду куски вдоль */
export function relay(rows: PlanItem[], layout: Layout, group: string, id: (index: number) => string): PlanItem[] {
  const lines = linesOf(rows);
  if (layout.from === "high") lines.reverse();
  const sorted = lines.flat();
  return rectsOf(layout).map((rect, index) => {
    const like = sorted[index] ?? sorted[0];
    return { ...like, ...rect, rows: layout.rows, id: sorted[index]?.id ?? id(index), group, aisle_m: layout.aisle };
  });
}

/* Ряд одной правкой: длина держит верхний конец у ряда вдоль листа и левый у ряда поперек,
   толщина держит левый край у ряда вдоль листа и верхний у ряда поперек */
export function resizeRow(row: PlanItem, change: { length?: number; band?: number }): Rect {
  const x = row.x;
  let { y, w, h } = row;
  if (row.rows === "x") {
    if (change.length) w = change.length;
    if (change.band) [y, h] = [y + h - change.band, change.band];
  } else {
    if (change.length) [y, h] = [y + h - change.length, change.length];
    if (change.band) w = change.band;
  }
  return { x, y: round(y), w, h };
}

/* Сколько рядов и сколько метров, для подписи: «7 рядов по 40 м» */
export function rowsText(count: number, length: number): string {
  const tens = count % 100;
  const last = count % 10;
  const word = tens >= 11 && tens <= 14 ? "рядов" : last === 1 ? "ряд" : last >= 2 && last <= 4 ? "ряда" : "рядов";
  // метры до 0,1 с запятой, как meters() в meters.ts: этот файл проверяют без сборщика, импорт не берем
  return `${count} ${word} по ${String(Math.round(length * 10) / 10).replace(".", ",")} м`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
