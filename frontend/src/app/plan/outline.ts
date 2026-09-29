/* Чистый расчет подложки без браузера: где на картинке темные линии, где контур здания и
   как выпрямить картинку по четырем углам. Холст и загрузка картинки живут в underlay.ts,
   а здесь только числа, поэтому это можно проверить тестами без браузера. */
import type { Guide, Point, Rect } from "./geometry";

// --- где на картинке темные линии ---------------------------------------------------------

/* Темная точка это точка заметно темнее своей округи. Сравниваем с соседями, а не с одним
   порогом на всю картинку: на фото лист освещен неровно, и тень в углу темнее линий в центре.
   Очень темное считаем линией всегда: толстая залитая стена внутри себя однородна. */
export type Ink = { w: number; h: number; dark: Uint8Array; lum: Float32Array };

export function inkOf(data: ArrayLike<number>, w: number, h: number): Ink {
  const lum = new Float32Array(w * h);
  let total = 0;
  for (let i = 0; i < lum.length; i++) {
    lum[i] = 0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2];
    total += lum[i];
  }
  // синька и снимок чертежа в негативе: светлые линии на темном фоне. Переворачиваем
  if (total / lum.length < 100) for (let i = 0; i < lum.length; i++) lum[i] = 255 - lum[i];
  // сумма яркостей по прямоугольнику за одно сложение: таблица накопленных сумм
  const stride = w + 1;
  const sums = new Float64Array(stride * (h + 1));
  for (let row = 0; row < h; row++) {
    let line = 0;
    for (let col = 0; col < w; col++) {
      line += lum[row * w + col];
      sums[(row + 1) * stride + col + 1] = sums[row * stride + col + 1] + line;
    }
  }
  const radius = Math.max(6, Math.round(Math.max(w, h) / 45));
  const dark = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    const r1 = Math.max(0, row - radius);
    const r2 = Math.min(h, row + radius + 1);
    for (let col = 0; col < w; col++) {
      const c1 = Math.max(0, col - radius);
      const c2 = Math.min(w, col + radius + 1);
      const mean =
        (sums[r2 * stride + c2] - sums[r1 * stride + c2] - sums[r2 * stride + c1] + sums[r1 * stride + c1]) /
        ((r2 - r1) * (c2 - c1));
      const value = lum[row * w + col];
      dark[row * w + col] = value < mean - 18 || value < 60 ? 1 : 0;
    }
  }
  return { w, h, dark, lum };
}

/* Доля длины отрезка, вдоль которой яркость резко меняется поперек: с одной стороны от точки
   соседняя точка заметно светлее. Это и есть край линии или залитого ряда. Отметки «темно»
   мало: у широкой заливки темной отмечается и полоса внутри у края. */
function step(ink: Ink, axis: "row" | "col", at: number, from: number, to: number): number {
  const across = axis === "row" ? ink.h : ink.w;
  if (at < 0 || at >= across) return 0;
  const [a, b] = [Math.max(0, Math.min(from, to)), Math.min(axis === "row" ? ink.w : ink.h, Math.max(from, to))];
  if (b <= a) return 0;
  const lum = (p: number, t: number) => {
    const q = Math.min(across - 1, Math.max(0, p));
    return axis === "row" ? ink.lum[q * ink.w + t] : ink.lum[t * ink.w + q];
  };
  let hit = 0;
  for (let t = a; t < b; t++) {
    const here = lum(at, t);
    if (Math.max(lum(at - 1, t), lum(at + 1, t)) - here > 30) hit++;
  }
  return hit / (b - a);
}

/* Доля длины отрезка, вдоль которой идет темная линия. Линия может быть на пару точек
   в стороне: стена толстая, фото чуть наклонено. */
export function along(ink: Ink, axis: "row" | "col", at: number, from: number, to: number, band = 2): number {
  let hit = 0;
  const [a, b] = [Math.max(0, Math.min(from, to)), Math.min(axis === "row" ? ink.w : ink.h, Math.max(from, to))];
  if (b <= a) return 0;
  for (let t = a; t < b; t++) {
    for (let k = -band; k <= band; k++) {
      const p = at + k;
      if (axis === "row" ? p < 0 || p >= ink.h : p < 0 || p >= ink.w) continue;
      if (axis === "row" ? ink.dark[p * ink.w + t] : ink.dark[t * ink.w + p]) {
        hit++;
        break;
      }
    }
  }
  return hit / (b - a);
}

// --- контур здания --------------------------------------------------------------------------

export type Box = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cover: number;
  miss: number;
  score: number;
  /* в другом месте картинки нашелся почти такой же контур: программа не уверена, какой из двух */
  rival?: boolean;
};

/* Контур здания: прямоугольник той формы, которую дают названные размеры, у которого все
   четыре стороны прорисованы темной линией. Самые крайние линии брать нельзя: на настоящих
   планах вокруг здания рамка листа, штамп, размерные линии и таблица помещений. Форма их
   отсекает: рамка листа и таблица по пропорции на здание не похожи. */
export function boxOf(ink: Ink, aspect: number): Box | null {
  const { w, h, dark } = ink;
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++)
      if (dark[row * w + col]) {
        rows[row]++;
        cols[col]++;
      }
  const ys = peaks(rows, w * 0.1);
  const xs = peaks(cols, h * 0.1);
  // накопленные суммы вдоль строк и столбцов, с запасом в пару точек поперек линии
  const rowRun = runs(ink, "row");
  const colRun = runs(ink, "col");
  // доля отрезка с темной линией; за краем картинки считаем темно, там ничего не известно
  const rowCover = (y: number, a: number, b: number) => (y < 0 || y >= h ? 1 : (rowRun[y][b] - rowRun[y][a]) / (b - a));
  const colCover = (x: number, a: number, b: number) => (x < 0 || x >= w ? 1 : (colRun[x][b] - colRun[x][a]) / (b - a));
  // стена это линия, у которой хотя бы с одной стороны светло. У леса на снимке из карт
  // или у штриховки темно с обеих сторон, и такой «контур» брать нельзя
  const D = 7;
  const edge = (here: number, one: number, two: number) => here - Math.min(one, two);
  let best: Box | null = null;
  const all: Box[] = [];
  for (let a = 0; a < xs.length; a++)
    for (let b = a + 1; b < xs.length; b++) {
      const [x1, x2] = [xs[a], xs[b]];
      if (x2 - x1 < w * 0.2) continue;
      for (let p = 0; p < ys.length; p++)
        for (let q = p + 1; q < ys.length; q++) {
          const [y1, y2] = [ys[p], ys[q]];
          if (y2 - y1 < h * 0.2) continue;
          const shape = (x2 - x1) / (y2 - y1);
          // здание может лежать на картинке и поперек: тогда ее повернем
          const miss = Math.min(Math.abs(Math.log(shape / aspect)), Math.abs(Math.log(shape * aspect)));
          if (miss > 0.12) continue;
          const [top, bottom] = [rowCover(y1, x1, x2), rowCover(y2, x1, x2)];
          const [left, right] = [colCover(x1, y1, y2), colCover(x2, y1, y2)];
          const cover = (top + bottom + left + right) / 4;
          const sides = [
            edge(top, rowCover(y1 - D, x1, x2), rowCover(y1 + D, x1, x2)),
            edge(bottom, rowCover(y2 - D, x1, x2), rowCover(y2 + D, x1, x2)),
            edge(left, colCover(x1 - D, y1, y2), colCover(x1 + D, y1, y2)),
            edge(right, colCover(x2 - D, y1, y2), colCover(x2 + D, y1, y2)),
          ];
          // каждая сторона сама должна быть похожа на стену: две хорошие не вытягивают две плохие
          if (Math.min(...sides) < 0.25 || sides.reduce((sum, one) => sum + one, 0) / 4 < 0.35) continue;
          const score = cover - miss;
          const area = (x2 - x1) * (y2 - y1);
          all.push({ x1, y1, x2, y2, cover, miss, score });
          // при равной прорисовке берем больший: внутри здания бывают комнаты той же формы
          if (
            !best ||
            score > best.score + 0.02 ||
            (score > best.score - 0.02 && area > (best.x2 - best.x1) * (best.y2 - best.y1))
          )
            best = { x1, y1, x2, y2, cover, miss, score };
        }
    }
  if (!best) return null;
  // Соперник: почти такой же хороший контур сравнимого размера в другом месте, а не та же
  // стена изнутри и не блок стеллажей. Так бывает у плана эвакуации, где под планом таблица
  // той же ширины
  const chosen = best;
  const size = (box: Box) => (box.x2 - box.x1) * (box.y2 - box.y1);
  const rival = all.some(
    (one) => one.score > chosen.score - 0.05 && size(one) > size(chosen) * 0.5 && overlap(one, chosen) < 0.5,
  );
  return { ...chosen, rival };
}

/* Доля общей площади двух прямоугольников от площади их объединения */
function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const common = w * h;
  const area = (box: Box) => (box.x2 - box.x1) * (box.y2 - box.y1);
  return common / (area(a) + area(b) - common);
}

/* Строки или столбцы, где темных точек больше порога и больше, чем у соседей: кандидаты
   в стены. Берем самые сильные, чтобы перебор пар оставался быстрым. */
function peaks(counts: Uint32Array, floor: number): number[] {
  const found: number[] = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] < floor) continue;
    let top = true;
    for (let k = -3; k <= 3 && top; k++) {
      const j = i + k;
      if (j >= 0 && j < counts.length && counts[j] > counts[i]) top = false;
    }
    if (top && (!found.length || i - found[found.length - 1] > 3)) found.push(i);
  }
  return found
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 40)
    .sort((a, b) => a - b);
}

function runs(ink: Ink, axis: "row" | "col"): Uint32Array[] {
  const { w, h, dark } = ink;
  const lines = axis === "row" ? h : w;
  const length = axis === "row" ? w : h;
  const out: Uint32Array[] = [];
  for (let line = 0; line < lines; line++) {
    const sum = new Uint32Array(length + 1);
    for (let t = 0; t < length; t++) {
      let hit = 0;
      for (let k = -2; k <= 2 && !hit; k++) {
        const p = line + k;
        if (p < 0 || p >= lines) continue;
        hit = axis === "row" ? dark[p * w + t] : dark[t * w + p];
      }
      sum[t + 1] = sum[t] + hit;
    }
    out.push(sum);
  }
  return out;
}

/* Порядок углов так, чтобы длинная сторона контура легла вдоль длинной стороны здания.
   Если на картинке здание стоит поперек, первым углом становится левый нижний: картинка
   повернется по часовой стрелке. */
export function upright(corners: Point[], w: number, h: number, aspect: number): Point[] {
  const across = Math.hypot((corners[1].x - corners[0].x) * w, (corners[1].y - corners[0].y) * h);
  const down = Math.hypot((corners[3].x - corners[0].x) * w, (corners[3].y - corners[0].y) * h);
  return across >= down === aspect >= 1 ? corners : [corners[3], corners[0], corners[1], corners[2]];
}

/* Преобразование плоскости по четырем парам точек: куда уходит каждая точка выпрямленной
   картинки на исходной. Так выпрямляются и наклон, и поворот, и фото листа, снятое сбоку. */
export function homography(from: Point[], to: Point[]): number[] {
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // метод Гаусса с выбором главного элемента
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    for (let row = 0; row < 8; row++) {
      if (row === col || !rows[col][col]) continue;
      const factor = rows[row][col] / rows[col][col];
      for (let k = col; k < 9; k++) rows[row][k] -= factor * rows[col][k];
    }
  }
  return [...rows.map((row, i) => row[8] / row[i]), 1];
}

/* Темная линия на картинке рядом с краем value, идущая вдоль него на отрезке from..to.
   Ищем в пределах reach метров и берем линию, прорисованную на большей части отрезка;
   из равных ближнюю. Край встает на целый метр: сетка расчета в метр. */
export function photoLine(
  ink: Ink,
  u: Rect,
  axis: "x" | "y",
  value: number,
  from: number,
  to: number,
  reach: number,
): Guide | null {
  if (reach <= 0 || to - from < 1) return null;
  const kx = ink.w / u.w;
  const ky = ink.h / u.h;
  const across = axis === "x" ? kx : ky;
  const center = axis === "x" ? (value - u.x) * kx : (u.y + u.h - value) * ky;
  const [a, b] =
    axis === "x"
      ? [Math.round((u.y + u.h - to) * ky), Math.round((u.y + u.h - from) * ky)]
      : [Math.round((from - u.x) * kx), Math.round((to - u.x) * kx)];
  let best: { at: number; cover: number } | null = null;
  const span = Math.ceil(reach * across);
  const line = axis === "x" ? "col" : "row";
  // линия это граница: рядом с одной стороны заметно светлее. Иначе внутри залитого ряда
  // на картинке край лип бы в любую точку
  for (let p = Math.round(center) - span; p <= Math.round(center) + span; p++) {
    const cover = step(ink, line, p, a, b);
    if (cover < 0.6) continue;
    const closer = !best || Math.abs(p - center) < Math.abs(best.at - center);
    if (!best || cover > best.cover + 0.05 || (cover > best.cover - 0.05 && closer)) best = { at: p, cover };
  }
  if (!best) return null;
  const found = axis === "x" ? u.x + best.at / kx : u.y + u.h - best.at / ky;
  return { axis, at: Math.round(found), from, to, photo: true };
}

/* Преобразование по любому числу пар точек, не меньше четырех: при четырех оно проходит через
   все точки, при большем числе ложится ближе всего ко всем сразу, наименьшими квадратами.
   Точки сначала сводим к середине и одному размаху: иначе метры рядом с точками картинки дают
   систему, которую метод Гаусса решает с большой ошибкой. */
export function fitHomography(from: Point[], to: Point[]): number[] {
  const [a, fromNorm] = normalize(from);
  const [b, toNorm] = normalize(to);
  const ata = Array.from({ length: 8 }, () => new Array<number>(9).fill(0));
  const add = (row: number[], value: number) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) ata[i][j] += row[i] * row[j];
      ata[i][8] += row[i] * value;
    }
  };
  for (let i = 0; i < from.length; i++) {
    const { x, y } = fromNorm[i];
    const { x: u, y: v } = toNorm[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = [...solve(ata), 1];
  // обратно из сведенных координат: to = B^-1 * H * A
  return multiply(invertScale(b), multiply(h, a));
}

/* Куда уходит точка по преобразованию */
export function apply(m: number[], point: Point): Point {
  const z = m[6] * point.x + m[7] * point.y + m[8];
  return { x: (m[0] * point.x + m[1] * point.y + m[2]) / z, y: (m[3] * point.x + m[4] * point.y + m[5]) / z };
}

/* На сколько четвертей по часовой стрелке повернуть картинку, чтобы сторона от первого угла ко
   второму легла верхней стеной. Так читаются четыре угла, которые нашла программа */
export function turnOf(corners: Point[]): number {
  if (corners.length < 2) return 0;
  const angle = (Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180) / Math.PI;
  return (((4 - Math.round(angle / 90)) % 4) + 4) % 4;
}

/* Поворот точки картинки на четверть по часовой стрелке: у картинки y растет вниз */
export function turned(point: Point, turn: number): Point {
  let { x, y } = point;
  for (let k = 0; k < turn; k++) [x, y] = [-y, x];
  return { x, y };
}

/* Контур здания по точкам на картинке. Точки ставит человек, а здание прямоугольное в плане:
   стены почти вдоль листа становятся ровно вдоль, почти поперек ровно поперек, и весь контур
   вписывается в названные размеры. Косую стену, больше двадцати градусов от листа, оставляем
   косой. По ровному контуру заново подбираем преобразование картинки, и так несколько раз:
   фото, снятое сбоку, выпрямляется вместе с контуром.

   Возвращает контур в метрах от верхнего левого угла здания, y вниз, и преобразование из этих
   метров в точки исходной картинки. */
export function fitOutline(
  points: Point[],
  w: number,
  h: number,
  turn: number,
): { outline: Point[]; toSource: number[] } {
  const spun = points.map((one) => turned(one, turn));
  let local = fitBox(spun, w, h);
  let outline = local;
  for (let round = 0; round < 6; round++) {
    outline = fitBox(square(local), w, h);
    local = points.map((one) => apply(fitHomography(points, outline), one));
  }
  return { outline, toSource: fitHomography(outline, points) };
}

/* Вписываем точки в прямоугольник w на h: левый верхний угол в нуле */
function fitBox(points: Point[], w: number, h: number): Point[] {
  const xs = points.map((one) => one.x);
  const ys = points.map((one) => one.y);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const sx = w / Math.max(1e-9, Math.max(...xs) - x0);
  const sy = h / Math.max(1e-9, Math.max(...ys) - y0);
  return points.map((one) => ({ x: (one.x - x0) * sx, y: (one.y - y0) * sy }));
}

/* Стены вдоль и поперек листа: концы почти горизонтальной стены получают общий y, почти
   вертикальной общий x. Общее значение это среднее, а цепочки стен на одной линии сливаются */
function square(points: Point[]): Point[] {
  const n = points.length;
  const xs = [...Array(n).keys()];
  const ys = [...Array(n).keys()];
  const root = (parent: number[], i: number): number => (parent[i] === i ? i : (parent[i] = root(parent, parent[i])));
  const join = (parent: number[], a: number, b: number) => {
    parent[root(parent, a)] = root(parent, b);
  };
  for (let i = 0; i < n; i++) {
    const [a, b] = [points[i], points[(i + 1) % n]];
    const slope = (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
    if (slope < SKEW_DEG) join(ys, i, (i + 1) % n);
    else if (slope > 90 - SKEW_DEG) join(xs, i, (i + 1) % n);
  }
  const mean = (parent: number[], axis: "x" | "y") => {
    const sums = new Map<number, [number, number]>();
    for (let i = 0; i < n; i++) {
      const key = root(parent, i);
      const [sum, count] = sums.get(key) ?? [0, 0];
      sums.set(key, [sum + points[i][axis], count + 1]);
    }
    return (i: number) => {
      const [sum, count] = sums.get(root(parent, i)) ?? [points[i][axis], 1];
      return sum / count;
    };
  };
  const x = mean(xs, "x");
  const y = mean(ys, "y");
  return points.map((_, i) => ({ x: x(i), y: y(i) }));
}

const SKEW_DEG = 20; // стена отклонилась от листа меньше этого, значит, она вдоль листа

function normalize(points: Point[]): [number[], Point[]] {
  const cx = points.reduce((sum, one) => sum + one.x, 0) / points.length;
  const cy = points.reduce((sum, one) => sum + one.y, 0) / points.length;
  const spread = points.reduce((sum, one) => sum + Math.hypot(one.x - cx, one.y - cy), 0) / points.length || 1;
  const k = Math.SQRT2 / spread;
  return [[k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1], points.map((one) => ({ x: (one.x - cx) * k, y: (one.y - cy) * k }))];
}

function invertScale(m: number[]): number[] {
  const k = m[0];
  return [1 / k, 0, -m[2] / k, 0, 1 / k, -m[5] / k, 0, 0, 1];
}

function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}

/* Метод Гаусса с выбором главного элемента для системы 8 на 8 */
function solve(rows: number[][]): number[] {
  const size = rows.length;
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    for (let row = 0; row < size; row++) {
      if (row === col || !rows[col][col]) continue;
      const factor = rows[row][col] / rows[col][col];
      for (let k = col; k <= size; k++) rows[row][k] -= factor * rows[col][k];
    }
  }
  return rows.map((row, i) => row[size] / (row[i] || 1));
}
