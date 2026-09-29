/* Объемный вид: на каком полу стоит вещь и в каком порядке рисовать тела.

   Вещь стоит на полу своей секции. Если она заходит на две секции с разной отметкой, режем ее по
   границе секций, и каждый кусок стоит на своем полу и высотой до своего потолка. Если ставить
   вещь целиком на отметку под своей серединой, перегородка, край которой попал на поднятую
   секцию, висит над полом.

   Рисуем как художник, от дальнего к ближнему. Ближний угол тела порядок не решает: иначе длинный
   ряд стеллажей закрывает колонну, которая стоит перед ним, а вещи нижнего пола рисуются поверх
   поднятого пола перед ними. Для каждой пары решаем честно: тело, которое целиком дальше по
   одной из осей, раньше; тела, которые стоят друг на друге, снизу вверх.

   Здесь нет холста, только числа. Проверка: tests/depth.test.ts */
import type { Rect } from "./geometry";

/* Тело сцены: коробка, плита пола или пандус. Все в метрах движка, z вверх */
export type Solid = Rect & {
  z0: number;
  z1: number;
  color: string;
  kind: "box" | "flat" | "glass" | "ramp";
  along?: "x" | "y";
  alpha?: number;
};

/* Кусок пола с отметкой и высотой потолка над ней */
export type Floor = Rect & { floor: number; ceiling: number };

const EPS = 1e-6;

/* Куски прямоугольника по кускам пола: каждый со своей отметкой и потолком */
export function onFloors(rect: Rect, floors: Floor[]): Floor[] {
  const found: Floor[] = [];
  for (const one of floors) {
    const x1 = Math.max(rect.x, one.x);
    const y1 = Math.max(rect.y, one.y);
    const x2 = Math.min(rect.x + rect.w, one.x + one.w);
    const y2 = Math.min(rect.y + rect.h, one.y + one.h);
    if (x2 - x1 > EPS && y2 - y1 > EPS)
      found.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, floor: one.floor, ceiling: one.ceiling });
  }
  // соседние куски на одной отметке склеиваем: у перегородки поперек двух полос пола не будет шва
  return merged(found);
}

function merged(parts: Floor[]): Floor[] {
  const found = [...parts];
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < found.length && !again; i++)
      for (let j = i + 1; j < found.length && !again; j++) {
        const a = found[i];
        const b = found[j];
        if (a.floor !== b.floor || a.ceiling !== b.ceiling) continue;
        const rows = near(a.y, b.y) && near(a.h, b.h) && (near(a.x + a.w, b.x) || near(b.x + b.w, a.x));
        const cols = near(a.x, b.x) && near(a.w, b.w) && (near(a.y + a.h, b.y) || near(b.y + b.h, a.y));
        if (!rows && !cols) continue;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        found[i] = { ...a, x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
        found.splice(j, 1);
        again = true;
      }
  }
  return found;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}

/* Поворот камеры по девяносто градусов вокруг середины участка */
export function spun(x: number, y: number, turn: number, cx: number, cy: number): [number, number] {
  const dx = x - cx;
  const dy = y - cy;
  return (
    [
      [dx, dy],
      [-dy, dx],
      [-dx, -dy],
      [dy, -dx],
    ] as [number, number][]
  )[((turn % 4) + 4) % 4];
}

type Box = { x1: number; x2: number; y1: number; y2: number; z0: number; z1: number; near: number };

/* После поворота зритель смотрит со стороны малых x и y: чем больше x + y, тем дальше */
function boxOf(solid: Solid, turn: number, cx: number, cy: number): Box {
  const corners = [
    spun(solid.x, solid.y, turn, cx, cy),
    spun(solid.x + solid.w, solid.y, turn, cx, cy),
    spun(solid.x, solid.y + solid.h, turn, cx, cy),
    spun(solid.x + solid.w, solid.y + solid.h, turn, cx, cy),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return {
    x1: Math.min(...xs),
    x2: Math.max(...xs),
    y1: Math.min(...ys),
    y2: Math.max(...ys),
    z0: solid.z0,
    z1: solid.z1,
    near: Math.min(...corners.map(([x, y]) => x + y)),
  };
}

/* Рисовать a раньше b? Тело, которое целиком дальше по оси x или y, раньше. Если одно дальше по
   x, а другое по y, на экране они не пересекаются, и порядок не важен. Если следы на полу
   пересекаются, тела стоят друг на друге: нижнее раньше */
function before(a: Box, b: Box): boolean {
  const aFar = a.x1 >= b.x2 - EPS || a.y1 >= b.y2 - EPS;
  const bFar = b.x1 >= a.x2 - EPS || b.y1 >= a.y2 - EPS;
  if (aFar || bFar) return aFar && !bFar;
  return a.z1 < b.z1 - EPS || (near(a.z1, b.z1) && a.z0 < b.z0 - EPS);
}

/* Порядок рисования: каждое тело после всех, что за ним. Где порядок не важен, дальнее раньше */
export function drawOrder<T extends Solid>(solids: T[], turn: number, cx: number, cy: number): T[] {
  const boxes = solids.map((one) => boxOf(one, turn, cx, cy));
  const n = solids.length;
  const after: number[][] = Array.from({ length: n }, () => []);
  const waiting = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (before(boxes[i], boxes[j])) {
        after[i].push(j);
        waiting[j]++;
      } else if (before(boxes[j], boxes[i])) {
        after[j].push(i);
        waiting[i]++;
      }
    }
  // запасной порядок: дальнее раньше, ниже раньше
  const fallback = [...solids.keys()].sort(
    (a, b) => boxes[b].near - boxes[a].near || boxes[a].z0 - boxes[b].z0 || a - b,
  );
  const done = new Array<boolean>(n).fill(false);
  const found: T[] = [];
  while (found.length < n) {
    // если где-то замкнулся круг, берем следующее по запасному порядку, чтобы нарисовать все
    const next =
      fallback.find((index) => !done[index] && waiting[index] === 0) ?? fallback.find((index) => !done[index]);
    if (next === undefined) break;
    done[next] = true;
    found.push(solids[next]);
    for (const other of after[next]) waiting[other]--;
  }
  return found;
}

/* Порядок всей сцены. Плоский пол рисуем первым, снизу вверх: он ниже всего, что на нем стоит.
   В общий порядок его не берем: большая плита пола под одними рядами и перед другими замыкала
   порядок в круг, и пол ложился поверх стеллажей. Поднятый пол стоит коробкой и идет в общий
   порядок вместе с вещами */
export function sceneOrder(floor: Solid[], things: Solid[], turn: number, cx: number, cy: number): Solid[] {
  const flat = floor.filter((one) => one.kind === "flat" || one.z1 - one.z0 <= EPS);
  const raised = floor.filter((one) => !flat.includes(one));
  const base = [...flat].sort((a, b) => a.z1 - b.z1);
  return [...base, ...drawOrder([...raised, ...things], turn, cx, cy)];
}
