/* Геометрия редактора плана: клетки пола, стены, прилипание и проверка, куда можно поставить.

   Это не расчет. Длину маршрута, площади и все, что идет в экономику, считает сервер. Здесь
   только то, без чего редактор не отзовется на мышь: какая клетка под курсором, где стена,
   к чему прилипнуть и помещается ли прямоугольник.

   Координаты как у движка: метры, ноль в левом нижнем углу участка, y растет на север. */
import type { Direction, Plan, PlanItem, PlanLevel, PlanSection, RouteMap } from "../../api/client";

export const OUT = ".";
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Side = "s" | "n" | "w" | "e";

/* Пол участка: номер уровня каждой клетки, -1 вне здания, и сами уровни. Строка 0 это юг. */
export type Cells = { cols: number; rows: number; at: Int8Array; levels: PlanLevel[] };

/* Пол из секций здания, так же, как его собирает движок: секции кладутся по порядку,
   следующая закрывает предыдущую, вырез убирает пол. Старые планы с полом строками тоже читаем. */
export function cellsOf(plan: Plan): Cells {
  const cols = Math.round(plan.width_m);
  const rows = Math.round(plan.length_m);
  const at = new Int8Array(cols * rows).fill(plan.sections.length || plan.floor.length ? -1 : 0);
  if (!plan.sections.length) {
    for (let row = 0; row < rows && row < plan.floor.length; row++)
      for (let col = 0; col < cols; col++) {
        const mark = plan.floor[row][col] ?? OUT;
        at[row * cols + col] = mark === OUT ? -1 : parseInt(mark, 36);
      }
    return { cols, rows, at, levels: plan.levels };
  }
  const levels: PlanLevel[] = [];
  for (const section of plan.sections) {
    let value = -1;
    if (!section.hole) {
      value = levels.findIndex((one) => one.floor_m === section.floor_m && one.ceiling_m === section.ceiling_m);
      if (value < 0) value = levels.push({ floor_m: section.floor_m, ceiling_m: section.ceiling_m }) - 1;
    }
    // контур точками: пол это клетки, чей центр внутри контура, как у движка
    const inside = outlineOf(section) ? insideOf(section.points) : null;
    for (let row = Math.max(0, Math.round(section.y)); row < Math.min(rows, Math.round(section.y + section.h)); row++)
      for (let col = Math.max(0, Math.round(section.x)); col < Math.min(cols, Math.round(section.x + section.w)); col++)
        if (!inside || inside(col + 0.5, row + 0.5)) at[row * cols + col] = value;
  }
  return { cols, rows, at, levels };
}

/* У секции контур точками, а не прямоугольник */
export function outlineOf(section: PlanSection): boolean {
  return (section.points?.length ?? 0) >= 3;
}

/* Лежит ли точка внутри контура: луч вправо пересекает стороны нечетное число раз */
export function insideOf(points: [number, number][]): (x: number, y: number) => boolean {
  return (x, y) => {
    let hit = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[j];
      if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) hit = !hit;
    }
    return hit;
  };
}

/* Углы секции: у контура его точки, у прямоугольника четыре угла против часовой стрелки от юго-запада */
export function cornersOf(section: Rect & { points?: [number, number][] }): [number, number][] {
  if ((section.points?.length ?? 0) >= 3) return section.points ?? [];
  const { x, y, w, h } = section;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/* Контур без одной точки: соседние стены сходятся напрямую. Меньше трех точек не бывает, а
   контур тоньше двух метров не здание, тогда null и контур остается как был */
export function withoutCorner(points: [number, number][], index: number): [number, number][] | null {
  if (points.length <= 3) return null;
  const next = points.filter((_, other) => other !== index);
  const box = frameOf(next);
  return box.w < 2 || box.h < 2 ? null : next;
}

/* Рамка вокруг точек контура: ее движок и редактор берут за x, y, w, h секции */
export function frameOf(points: [number, number][]): Rect {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function levelAt(cells: Cells, x: number, y: number): number {
  // клетка по координате в метрах: дробная координата лежит в клетке, на которую приходится
  const col = Math.floor(x);
  const row = Math.floor(y);
  if (col < 0 || row < 0 || col >= cells.cols || row >= cells.rows) return -1;
  return cells.at[row * cells.cols + col];
}

export function floorAt(cells: Cells, col: number, row: number): number | null {
  const level = levelAt(cells, col, row);
  return level < 0 ? null : (cells.levels[level]?.floor_m ?? 0);
}

/* Пол для рисования: соседние клетки одного уровня сливаются в прямоугольники,
   иначе на складе в десять тысяч метров было бы десять тысяч квадратиков */
export type Patch = Rect & { level: number };

export function patches(cells: Cells): Patch[] {
  const found: Patch[] = [];
  let open = new Map<string, Patch>();
  for (let row = 0; row < cells.rows; row++) {
    const next = new Map<string, Patch>();
    let col = 0;
    while (col < cells.cols) {
      const value = cells.at[row * cells.cols + col];
      if (value < 0) {
        col++;
        continue;
      }
      const start = col;
      while (col < cells.cols && cells.at[row * cells.cols + col] === value) col++;
      const key = `${start}:${col - start}:${value}`;
      const above = open.get(key);
      if (above) {
        above.h += 1;
        next.set(key, above);
      } else {
        const patch = { x: start, y: row, w: col - start, h: 1, level: value };
        found.push(patch);
        next.set(key, patch);
      }
    }
    open = next;
  }
  return found;
}

/* Слой «далеко от ворот»: сервер отдал ступень цвета на каждую проезжую клетку, здесь только
   склеиваем клетки одной ступени в прямоугольники тем же способом, что и пол. Ступень LOST это
   клетка, до которой не доехать. Карта другого размера, чем участок, не рисуется: значит, она
   от плана, который еще не положили, и участок под ним вырос. */
export const LOST = 40;

/* Насколько густой синий у ступени: от почти белого у ворот до плотного на самом дальнем краю */
export function routeAlpha(band: number, count: number): number {
  return 0.07 + (0.83 * band) / Math.max(1, count - 1);
}

export function routePatches(map: RouteMap | undefined, cells: Cells): Patch[] {
  if (!map || map.rows.length !== cells.rows || (map.rows[0]?.length ?? 0) !== cells.cols) return [];
  const at = new Int8Array(cells.cols * cells.rows).fill(-1);
  for (let row = 0; row < cells.rows; row++)
    for (let col = 0; col < cells.cols; col++) {
      const mark = map.rows[row][col];
      if (mark === "!") at[row * cells.cols + col] = LOST;
      else if (mark !== OUT) at[row * cells.cols + col] = parseInt(mark, 36);
    }
  return patches({ cols: cells.cols, rows: cells.rows, at, levels: [] });
}

/* Стены: граница пола с улицей. Ступени: граница двух разных отметок пола. */
export type Segment = { x1: number; y1: number; x2: number; y2: number; kind: "wall" | "step" };

export function edges(cells: Cells): Segment[] {
  const found: Segment[] = [];
  const height = (col: number, row: number) => floorAt(cells, col, row);
  const kind = (a: number | null, b: number | null) =>
    (a === null) !== (b === null) ? "wall" : a !== null && a !== b ? "step" : null;
  for (let row = 0; row <= cells.rows; row++) {
    let run: Segment | null = null;
    for (let col = 0; col <= cells.cols; col++) {
      const here = col < cells.cols ? kind(height(col, row - 1), height(col, row)) : null;
      if (run && run.kind === here) run.x2 = col + 1;
      else {
        if (run) found.push(run);
        run = here ? { x1: col, y1: row, x2: col + 1, y2: row, kind: here } : null;
      }
    }
  }
  for (let col = 0; col <= cells.cols; col++) {
    let run: Segment | null = null;
    for (let row = 0; row <= cells.rows; row++) {
      const here = row < cells.rows ? kind(height(col - 1, row), height(col, row)) : null;
      if (run && run.kind === here) run.y2 = row + 1;
      else {
        if (run) found.push(run);
        run = here ? { x1: col, y1: row, x2: col, y2: row + 1, kind: here } : null;
      }
    }
  }
  return found;
}

export function bounds(cells: Cells): Rect | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (let row = 0; row < cells.rows; row++)
    for (let col = 0; col < cells.cols; col++)
      if (cells.at[row * cells.cols + col] >= 0) {
        x1 = Math.min(x1, col);
        y1 = Math.min(y1, row);
        x2 = Math.max(x2, col + 1);
        y2 = Math.max(y2, row + 1);
      }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/* Ворота живут только в наружной стене. Здесь все отрезки стены, где снаружи пусто:
   ворота скользят вдоль них и не уходят ни внутрь здания, ни за край. */
export type Run = { side: Side; line: number; from: number; to: number };

const outside = (cells: Cells, col: number, row: number) => levelAt(cells, col, row) < 0;
const inside = (cells: Cells, col: number, row: number) => levelAt(cells, col, row) >= 0;
const OPEN: Record<Side, (cells: Cells, col: number, row: number) => boolean> = {
  s: (cells, col, row) => inside(cells, col, row) && outside(cells, col, row - 1),
  n: (cells, col, row) => inside(cells, col, row) && outside(cells, col, row + 1),
  w: (cells, col, row) => inside(cells, col, row) && outside(cells, col - 1, row),
  e: (cells, col, row) => inside(cells, col, row) && outside(cells, col + 1, row),
};

export function outerRuns(cells: Cells): Run[] {
  const runs: Run[] = [];
  const scan = (side: Side, count: number, span: number, flat: boolean) => {
    for (let line = 0; line < count; line++) {
      let start = -1;
      for (let along = 0; along <= span; along++) {
        const ok = along < span && (flat ? OPEN[side](cells, along, line) : OPEN[side](cells, line, along));
        if (ok && start < 0) start = along;
        if (!ok && start >= 0) {
          runs.push({ side, line, from: start, to: along });
          start = -1;
        }
      }
    }
  };
  scan("s", cells.rows, cells.cols, true);
  scan("n", cells.rows, cells.cols, true);
  scan("w", cells.cols, cells.rows, false);
  scan("e", cells.cols, cells.rows, false);
  return runs;
}

/* С какой стороны у ворот улица: туда смотрит проем */
export function doorSide(cells: Cells, item: Rect): Side {
  if (item.w >= item.h) return outside(cells, item.x, item.y - 1) ? "s" : "n";
  return outside(cells, item.x - 1, item.y) ? "w" : "e";
}

/* Ворота целиком в наружной стене: каждая их клетка на полу, а за ней улица */
export function onWall(cells: Cells, rect: Rect, side: Side): boolean {
  for (let row = rect.y; row < rect.y + rect.h; row++)
    for (let col = rect.x; col < rect.x + rect.w; col++) if (!OPEN[side](cells, col, row)) return false;
  return true;
}

/* Между воротами оставляем простенок в клетку, чтобы на плане было видно, что это двое ворот,
   а не одни широкие. Это правило рисования, а не данные. */
export const DOCK_GAP = 1;

/* Отрезки стены, свободные от чужих ворот вместе с простенком. Ворота ездят только по ним:
   так их не поставить внутрь соседних, и через соседа они перескакивают, а не наезжают. */
export function freeRuns(runs: Run[], docks: Rect[]): Run[] {
  const found: Run[] = [];
  for (const run of runs) {
    const across = run.side === "s" || run.side === "n";
    const taken = docks
      .filter((dock) => (across ? dock.w >= dock.h && dock.y === run.line : dock.h > dock.w && dock.x === run.line))
      .map((dock) =>
        across ? [dock.x - DOCK_GAP, dock.x + dock.w + DOCK_GAP] : [dock.y - DOCK_GAP, dock.y + dock.h + DOCK_GAP],
      )
      .sort((a, b) => a[0] - b[0]);
    let from = run.from;
    for (const [start, end] of taken) {
      if (end <= from || start >= run.to) continue;
      if (start > from) found.push({ ...run, from, to: start });
      from = Math.max(from, end);
    }
    if (from < run.to) found.push({ ...run, from, to: run.to });
  }
  return found;
}

/* Ближайшее место в стене для ворот длиной len. raw идет за мышью плавно, rect встает по клеткам.
   others это другие ворота: на них и вплотную к ним не встать. */
export function snapDock(
  runs: Run[],
  point: Point,
  len: number,
  others: Rect[] = [],
): { rect: Rect; raw: Rect } | null {
  let best: { rect: Rect; raw: Rect; gap: number } | null = null;
  for (const run of freeRuns(runs, others)) {
    if (run.to - run.from < len) continue;
    const across = run.side === "s" || run.side === "n";
    const cursor = across ? point.x : point.y;
    const raw = Math.min(run.to - len, Math.max(run.from, cursor - len / 2));
    const make = (at: number): Rect =>
      across ? { x: at, y: run.line, w: len, h: 1 } : { x: run.line, y: at, w: 1, h: len };
    const rect = make(Math.round(raw));
    const gap = Math.hypot(rect.x + rect.w / 2 - point.x, rect.y + rect.h / 2 - point.y);
    if (!best || gap < best.gap) best = { rect, raw: make(raw), gap };
  }
  return best && { rect: best.rect, raw: best.raw };
}

/* Докуда ворота можно растянуть: свободный отрезок стены, в котором они стоят. Ручка упирается
   в соседние ворота и в угол, дальше не идет. */
export function dockRoom(runs: Run[], dock: Rect, others: Rect[]): { from: number; to: number } | null {
  const across = dock.w >= dock.h;
  const start = across ? dock.x : dock.y;
  const end = start + (across ? dock.w : dock.h);
  const run = freeRuns(runs, others).find(
    (one) =>
      (one.side === "s" || one.side === "n") === across &&
      one.line === (across ? dock.y : dock.x) &&
      one.from <= start &&
      one.to >= end,
  );
  return run ? { from: run.from, to: run.to } : null;
}

/* Ворота встанут: целиком в наружной стене и не наезжают на соседние вместе с простенком */
export function dockFits(cells: Cells, rect: Rect, side: Side, others: Rect[]): boolean {
  if (!onWall(cells, rect, side)) return false;
  return !others.some((other) =>
    overlaps(rect, {
      x: other.x - DOCK_GAP,
      y: other.y - DOCK_GAP,
      w: other.w + DOCK_GAP * 2,
      h: other.h + DOCK_GAP * 2,
    }),
  );
}

/* Прилипание. Край объекта тянется к краям соседей и к стенам, если до них меньше reach метров.
   Если прилипнуть не к чему, встает по сетке в метр. Линия прилипания показывается на листе. */
/* Линия прилипания. У линии с картинки плана есть отрезок, вдоль которого край на нее лег:
   его и подсвечиваем, чтобы было видно, к чему прилипло */
export type Guide = { axis: "x" | "y"; at: number; from?: number; to?: number; photo?: boolean };

function nearest(value: number, lines: number[], reach: number): number | null {
  let best: number | null = null;
  for (const line of lines)
    if (Math.abs(line - value) <= reach && (best === null || Math.abs(line - value) < Math.abs(best - value)))
      best = line;
  return best;
}

export function magnetMove(rect: Rect, xs: number[], ys: number[], reach: number): { rect: Rect; guides: Guide[] } {
  const guides: Guide[] = [];
  const settle = (start: number, size: number, lines: number[], axis: "x" | "y") => {
    const low = nearest(start, lines, reach);
    const high = nearest(start + size, lines, reach);
    if (low !== null && (high === null || Math.abs(low - start) <= Math.abs(high - start - size))) {
      guides.push({ axis, at: low });
      return low;
    }
    if (high !== null) {
      guides.push({ axis, at: high });
      return high - size;
    }
    return Math.round(start);
  };
  return { rect: { ...rect, x: settle(rect.x, rect.w, xs, "x"), y: settle(rect.y, rect.h, ys, "y") }, guides };
}

export function magnetEdge(
  value: number,
  lines: number[],
  reach: number,
  axis: "x" | "y",
): { at: number; guide?: Guide } {
  const hit = nearest(value, lines, reach);
  return hit === null ? { at: Math.round(value) } : { at: hit, guide: { axis, at: hit } };
}

/* Линии, к которым прилипают: края других вещей и секций, стены и край участка */
export function snapLines(rects: (Rect & { id: string })[], segments: Segment[], skip: string, cells: Cells) {
  const xs = [0, cells.cols];
  const ys = [0, cells.rows];
  for (const rect of rects) {
    if (rect.id === skip) continue;
    xs.push(rect.x, rect.x + rect.w);
    ys.push(rect.y, rect.y + rect.h);
  }
  for (const segment of segments) {
    if (segment.x1 === segment.x2) xs.push(segment.x1);
    else ys.push(segment.y1);
  }
  return { xs: [...new Set(xs)], ys: [...new Set(ys)] };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* Что встает внутрь зоны хранения и вырезает себе место. Движок убирает стеллажи под ними,
   так что пандус или станцию можно поставить прямо в зону, не дробя ее на куски. */
const CARVE = ["ramp", "station", "buffer", "blocked", "aisle"];

/* Линия движения ничего не занимает: это правило езды по полу, как разметка на дороге. Ее кладут
   по проездам зоны хранения, через поперечный проезд и буфер. Не встает только на то, куда нельзя
   заехать, и на другую полосу: две стрелки в одной клетке спорили бы. */
const LANE_BLOCKS = ["blocked", "station", "flow"];

function nests(kind: string, other: string): boolean {
  if (kind === "flow") return !LANE_BLOCKS.includes(other);
  if (other === "flow") return !LANE_BLOCKS.includes(kind);
  return (CARVE.includes(kind) && other === "racks") || (kind === "racks" && CARVE.includes(other));
}

/* Встанет ли прямоугольник: весь на полу здания и не залезает на соседей. Зарядку, которую
   поставила программа, не считаем помехой: после правки программа ее переставит. */
export function fits(rect: Rect, cells: Cells, items: PlanItem[], self: string, kind = ""): boolean {
  if (rect.w < 1 || rect.h < 1) return false;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > cells.cols || rect.y + rect.h > cells.rows) return false;
  for (let row = rect.y; row < rect.y + rect.h; row++)
    for (let col = rect.x; col < rect.x + rect.w; col++) if (levelAt(cells, col, row) < 0) return false;
  return !items.some(
    (item) =>
      item.id !== self &&
      item.kind !== "dock" &&
      !(item.kind === "charge" && item.auto) &&
      !nests(kind, item.kind) &&
      overlaps(rect, item),
  );
}

/* Ряды стеллажей внутри зоны: тот же расклад, что у движка (rack_cut в engine/plan.py).
   Нужен только для картинки. Рядов столько, сколько помещается целиком, остаток поровну у краев;
   вдоль ряда поперечные проезды делят его на равные части не длиннее run_m. */
export type Cut = {
  band: number;
  pitch: number;
  blocks: number;
  offset: number;
  used: number;
  seg: number;
  cross: number;
  segments: number;
};

export function rackCut(item: PlanItem, row: number, cross: number): Cut {
  const band = (item.row_m || row) * Math.max(1, item.block_rows);
  const aisle = Math.max(item.aisle_m, 1);
  const gap = item.cross_m || cross;
  const across = item.rows === "x";
  const extent = across ? item.h : item.w;
  const length = across ? item.w : item.h;
  const blocks = Math.max(1, Math.floor((extent + aisle + 1e-6) / (band + aisle)));
  const used = Math.min(extent, blocks * band + (blocks - 1) * aisle);
  // run_m 0 значит «без поперечных проездов»: так рисуют зону по фото, а проезд кладут рукой
  const run = Math.max(item.run_m, 1);
  let segments = item.run_m > 0 ? Math.max(1, Math.ceil((length + gap) / (run + gap) - 1e-6)) : 1;
  let seg = (length - (segments - 1) * gap) / segments;
  if (seg <= 0) [segments, seg] = [1, length];
  return { band, pitch: band + aisle, blocks, offset: (extent - used) / 2, used, seg, cross: gap, segments };
}

export function rackRows(item: PlanItem, row: number, cross: number): Rect[] {
  const cut = rackCut(item, row, cross);
  const across = item.rows === "x";
  const extent = across ? item.h : item.w;
  const found: Rect[] = [];
  for (let block = 0; block < cut.blocks; block++) {
    const start = cut.offset + block * cut.pitch;
    const size = Math.min(cut.band, extent - start);
    for (let part = 0; part < cut.segments; part++) {
      const along = part * (cut.seg + cut.cross);
      found.push(
        across
          ? { x: item.x + along, y: item.y + start, w: cut.seg, h: size }
          : { x: item.x + start, y: item.y + along, w: size, h: cut.seg },
      );
    }
  }
  return found;
}

/* Ячейки стеллажа: каждый ряд из нарезки выше режем на клетки примерно по метру, как на
   складских картах. Ряд делится на целое число клеток, поэтому они чуть больше или меньше метра,
   зато ровно закрывают ряд. Поперек ряда клеток столько, сколько метров в его толщине: у
   двойного ряда фронтальных стеллажей их две, по одной на сторону проезда. Только для картинки. */
export function rackCells(item: PlanItem, row: number, cross: number): Rect[] {
  const found: Rect[] = [];
  const across = item.rows === "x";
  for (const band of rackRows(item, row, cross)) {
    const length = across ? band.w : band.h;
    const thick = across ? band.h : band.w;
    const along = Math.max(1, Math.round(length));
    const deep = Math.max(1, Math.round(thick));
    const a = length / along;
    const d = thick / deep;
    for (let i = 0; i < along; i++)
      for (let j = 0; j < deep; j++)
        found.push(
          across
            ? { x: band.x + i * a, y: band.y + j * d, w: a, h: d }
            : { x: band.x + j * d, y: band.y + i * a, w: d, h: a },
        );
  }
  return found;
}

/* Линия движения: куда смотрит стрелка. Новая полоса смотрит вдоль длинной стороны, на восток
   или на север; клавиша R разворачивает ее назад, Shift+R поворачивает на четверть круга. */
export const REVERSE: Record<Direction, Direction> = { east: "west", west: "east", north: "south", south: "north" };
export const TURN: Record<Direction, Direction> = { east: "south", south: "west", west: "north", north: "east" };

export function laneWay(rect: Rect, direction: string): Direction {
  if (direction === "east" || direction === "west" || direction === "north" || direction === "south") return direction;
  return rect.w >= rect.h ? "east" : "north";
}

/* Полосы змейки принадлежат зоне: сервер дает им имена «зона-flow-номер» */
export function lanesOf(items: PlanItem[], zone: string): PlanItem[] {
  return items.filter((item) => item.kind === "flow" && item.id.startsWith(`${zone}-flow-`));
}

/* Номер ряда под точкой или -1, если точка в проезде между рядами или вне зоны */
export function rowAt(item: PlanItem, at: Point, row: number, cross: number): number {
  const cut = rackCut(item, row, cross);
  const across = item.rows === "x" ? at.y - item.y : at.x - item.x;
  const from = across - cut.offset;
  if (from < 0 || from >= cut.used) return -1;
  const block = Math.floor(from / cut.pitch);
  return from - block * cut.pitch < cut.band ? block : -1;
}

/* Зона, разложенная на ряды: каждый ряд становится своей зоной хранения на всю длину, с теми
   же стеллажами, проездами и поперечными проездами. Сервер режет их на клетки так же, как
   целую зону, поэтому расчет не меняется, а ряд можно укоротить, сдвинуть или убрать. */
export function splitRows(item: PlanItem, row: number, cross: number, id: (index: number) => string): PlanItem[] {
  const cut = rackCut(item, row, cross);
  return Array.from({ length: cut.blocks }, (_, block) => {
    const start = cut.offset + block * cut.pitch;
    return item.rows === "x"
      ? { ...item, id: id(block), y: item.y + start, h: cut.band }
      : { ...item, id: id(block), x: item.x + start, w: cut.band };
  });
}

/* Размер зоны поперек рядов, в который ряды встают целиком без обрезка: тянешь край,
   и ряд добавляется или убирается весь. Сетка в метр, поэтому округляем вверх до клетки. */
export function wholeRows(extent: number, band: number, aisle: number): number {
  const gap = Math.max(aisle, 1);
  const blocks = Math.max(1, Math.round((extent + gap) / (band + gap)));
  return Math.ceil(blocks * band + (blocks - 1) * gap - 1e-6);
}

/* Сколько свободного пола от прямоугольника до ближайшей помехи в каждую сторону: стена,
   край пола или чужая вещь. Показываем, пока объект тянут, как расстояния в редакторах макетов. */
export type Gap = { side: Side; from: Point; to: Point; length: number };

const STEPS: Record<Side, [number, number]> = { e: [1, 0], w: [-1, 0], n: [0, 1], s: [0, -1] };

export function gaps(rect: Rect, cells: Cells, items: PlanItem[], self: string, kind: string, limit = 60): Gap[] {
  const blockers = items.filter(
    (item) =>
      item.id !== self && item.kind !== "dock" && !(item.kind === "charge" && item.auto) && !nests(kind, item.kind),
  );
  const cx = Math.floor(rect.x + rect.w / 2);
  const cy = Math.floor(rect.y + rect.h / 2);
  const hits = (col: number, row: number) =>
    levelAt(cells, col + 0.5, row + 0.5) < 0 ||
    blockers.some((item) => col >= item.x && col < item.x + item.w && row >= item.y && row < item.y + item.h);
  const walk = (side: Side): Gap | null => {
    const [dx, dy] = STEPS[side];
    let col = side === "e" ? rect.x + rect.w : side === "w" ? rect.x - 1 : cx;
    let row = side === "n" ? rect.y + rect.h : side === "s" ? rect.y - 1 : cy;
    let length = 0;
    while (length < limit && !hits(col, row)) {
      col += dx;
      row += dy;
      length += 1;
    }
    if (!length || length >= limit) return null;
    const from = {
      x: side === "e" ? rect.x + rect.w : side === "w" ? rect.x : cx + 0.5,
      y: side === "n" ? rect.y + rect.h : side === "s" ? rect.y : cy + 0.5,
    };
    return { side, from, to: { x: from.x + dx * length, y: from.y + dy * length }, length };
  };
  return (["e", "w", "n", "s"] as Side[]).map(walk).filter((gap): gap is Gap => gap !== null);
}

/* Если здание дотянули до края участка, участок растет: иначе пристройку некуда вести.
   Растем на запад и юг со сдвигом всего плана, чтобы ноль остался в левом нижнем углу. */
export function withRoom(plan: Plan, room = 16, near = 4): Plan {
  const floors = plan.sections.filter((section) => !section.hole);
  if (!floors.length) return plan;
  const x1 = Math.min(...floors.map((one) => one.x));
  const y1 = Math.min(...floors.map((one) => one.y));
  const x2 = Math.max(...floors.map((one) => one.x + one.w));
  const y2 = Math.max(...floors.map((one) => one.y + one.h));
  const west = x1 < near ? room - x1 : 0;
  const south = y1 < near ? room - y1 : 0;
  const east = plan.width_m - x2 < near ? room - (plan.width_m - x2) : 0;
  const north = plan.length_m - y2 < near ? room - (plan.length_m - y2) : 0;
  if (!west && !south && !east && !north) return plan;
  const shift = <T extends Rect>(one: T): T => ({ ...one, x: one.x + west, y: one.y + south });
  return {
    ...plan,
    width_m: plan.width_m + west + east,
    length_m: plan.length_m + south + north,
    sections: plan.sections.map((one) => ({
      ...shift(one),
      points: (one.points ?? []).map(([x, y]) => [x + west, y + south] as [number, number]),
    })),
    items: plan.items.map(shift),
  };
}

/* Цвет отметки пола: чем выше пол, тем темнее. Считаем по порядку разных отметок в здании. */
export function floorTone(heights: number[], floor: number): string {
  const order = [...new Set(heights)].sort((a, b) => a - b).indexOf(floor);
  return `var(--lvl-${Math.min(5, Math.max(0, order))})`;
}

/* Цвет высоты стеллажа: шесть ступеней от 4 до 14 метров. Только для картинки. */
export function heightTone(top: number): string {
  const step = Math.min(5, Math.max(0, Math.floor((top - 4) / 2)));
  return `var(--lvl-${step})`;
}

export function signed(value: number, digits = 1): string {
  const text = Math.abs(value).toLocaleString("ru-RU", { maximumFractionDigits: digits });
  return `${value < 0 ? "−" : "+"}${text}`;
}

/* Верхняя секция под точкой: ее и выбираем щелчком, как верхний лист в стопке */
export function sectionAt(plan: Plan, point: Point): PlanSection | undefined {
  return [...plan.sections]
    .reverse()
    .find(
      (one) =>
        point.x >= one.x &&
        point.x < one.x + one.w &&
        point.y >= one.y &&
        point.y < one.y + one.h &&
        (!outlineOf(one) || insideOf(one.points)(point.x, point.y)),
    );
}
