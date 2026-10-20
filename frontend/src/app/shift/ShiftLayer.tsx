import { useEffect, useRef } from "react";

import type { Clock, View } from "../../ui";
import { ACTION_COLOR, type HeatCell, heatColor, type Replay, type Spot, spotsAt } from "./replay";

/* Цвет из токена: холст не понимает var(), берем значение из стилей. from это элемент, чьи токены
   нужны: лист чертежа светлый и в темной теме (tokens.css), поэтому холст на листе читает свои */
export function tokenColor(value: string, from: Element = document.documentElement): string {
  const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (!name) return value;
  return getComputedStyle(from).getPropertyValue(name).trim() || "#000";
}

/* Роботы и тепловая карта поверх листа. Это холст, а не SVG: тридцать роботов шестьдесят раз
   в секунду и тысячи ячеек SVG не тянет (журнал решений, «Редактор плана на SVG, проигрыватель
   смены на Canvas»). Координаты те же, что у листа: вид доски пересчитывает метры в точки */
export function ShiftLayer({
  view,
  area,
  length,
  replay,
  clock,
  heat,
  robots,
  owners,
}: {
  view: View;
  area: { w: number; h: number };
  length: number;
  replay: Replay | null;
  clock: Clock;
  heat: { cells: HeatCell[]; ranks: Map<HeatCell, number> } | null;
  robots: boolean;
  /* все задачи вместе: чей робот (номер задачи у каждого робота лога) и цвета задач. Корпус
     красим цветом задачи и рисуем ее формой, огонек сзади остается цветом действия */
  owners?: { of: number[]; colors: string[] } | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // куда смотрит каждый робот: у стоящего остается последнее направление, а не сбрасывается вправо
  const headings = useRef(new Map<number, number>());

  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext("2d");
    if (!node || !context) return;
    const ratio = window.devicePixelRatio || 1;
    node.width = Math.round(area.w * ratio);
    node.height = Math.round(area.h * ratio);
    const colors = Object.fromEntries(
      Object.entries(ACTION_COLOR).map(([key, value]) => [key, tokenColor(value, node)]),
    );
    const heatFill = heat ? heat.cells.map((cell) => heatColor(heat.ranks.get(cell) ?? 0)) : [];
    const teams = owners ? owners.colors.map((one) => tokenColor(one, node)) : [];
    const paper = tokenColor("var(--paper)", node);
    const ink = tokenColor("var(--ink)", node);
    const px = (x: number) => x * view.s + view.tx;
    const py = (y: number) => (length - y) * view.s + view.ty;

    const draw = () => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, area.w, area.h);
      if (heat) {
        // ячейка чуть меньше клетки: видно, что это ячейки, а не сплошная заливка
        const gap = view.s >= 4 ? Math.min(1.5, view.s * 0.12) : 0;
        heat.cells.forEach((cell, index) => {
          context.fillStyle = heatFill[index];
          context.fillRect(px(cell.col) + gap / 2, py(cell.row + 1) + gap / 2, view.s - gap, view.s - gap);
        });
      }
      if (!robots || !replay) return;
      const radius = Math.max(6, Math.min(11, view.s * 0.65));
      const dot = (x: number, y: number, r: number, color: string) => {
        context.beginPath();
        context.arc(x, y, r, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
        context.lineWidth = 1.5;
        context.strokeStyle = paper;
        context.stroke();
      };
      // Робот значком сверху, как семья 07 на лендинге: белый корпус, обводка цветом действия,
      // темная полоса датчика спереди по ходу и огонек сзади. По точкам на плане
      // не читается, что едут роботы
      // у задач вместе корпус берет форму задачи: цвет не единственный признак (дальтоники, печать)
      const icon = (x: number, y: number, r: number, color: string, angle: number, shape = 0, light = color) => {
        const long = r * 1.25;
        const wide = r * 0.9;
        context.save();
        context.translate(x, y);
        context.rotate(angle);
        context.beginPath();
        bodyPath(context, shape, long, wide, r);
        context.fillStyle = paper;
        context.fill();
        context.lineWidth = Math.max(2, r * 0.28);
        context.strokeStyle = color;
        context.stroke();
        context.fillStyle = ink;
        context.fillRect(long * 0.35, -wide * 0.55, long * 0.35, wide * 1.1);
        context.beginPath();
        context.arc(-long * 0.55, 0, r * 0.28, 0, Math.PI * 2);
        context.fillStyle = light;
        context.fill();
        context.restore();
      };
      const before = new Map(spotsAt(replay, Math.max(0, clock.t - 3)).map((spot) => [spot.robot, spot]));
      const heading = (spot: Spot) => {
        const was = before.get(spot.robot);
        if (was && Math.hypot(spot.x - was.x, spot.y - was.y) > 0.05)
          headings.current.set(spot.robot, Math.atan2(-(spot.y - was.y), spot.x - was.x));
        return headings.current.get(spot.robot) ?? 0;
      };
      // Роботы в одном месте, чаще всего без задания у буфера, лежали друг на друге: из девяти
      // было видно три. Двоих-четверых раздвигаем рядом, больше рисуем одной точкой с числом.
      // Приблизили лист, и группа распадается на отдельных роботов
      // группу считаем по экрану: издалека роботы в метре друг от друга тоже лежат друг на друге
      for (const group of stacks(spotsAt(replay, clock.t), Math.max(0.5, (radius * 2.2) / view.s))) {
        const cx = px(group[0].x);
        const cy = py(group[0].y);
        if (group.length <= 4) {
          const shift = group.length > 1 ? radius * 1.5 : 0;
          group.forEach((spot, k) => {
            const angle = (Math.PI * 2 * k) / group.length - Math.PI / 4;
            const action = colors[spot.action] ?? colors["без задания"];
            const team = owners?.of[spot.robot];
            // робот без задания у задач вместе бледнее: на плане сразу видно, кто едет, а кто стоит
            context.globalAlpha = team !== undefined && spot.action === "без задания" ? 0.55 : 1;
            icon(
              cx + Math.cos(angle) * shift,
              cy + Math.sin(angle) * shift,
              radius,
              team !== undefined ? (teams[team] ?? action) : action,
              heading(spot),
              team ?? 0,
              action,
            );
            context.globalAlpha = 1;
          });
          continue;
        }
        const r = radius * 1.6;
        const team = owners ? mostOf(group.map((spot) => String(owners.of[spot.robot]))) : null;
        dot(cx, cy, r, team !== null ? (teams[Number(team)] ?? ink) : (colors[most(group)] ?? colors["без задания"]));
        context.fillStyle = paper;
        context.font = `600 ${Math.round(r * 1.05)}px 'JetBrains Mono', monospace`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(group.length), cx, cy + 0.5);
      }
    };
    draw();
    return clock.subscribe(draw);
  }, [view, area, length, replay, clock, heat, robots, owners]);

  return <canvas ref={canvas} className="u-shift-layer" style={{ width: area.w, height: area.h }} aria-hidden="true" />;
}

/* Роботы, стоящие ближе reach метров к центру группы, одной группой. Центр группы это среднее
   ее роботов, поэтому кучка у буфера собирается целиком, а не рвется по клеткам сетки */
function stacks(spots: Spot[], reach: number): Spot[][] {
  const groups: { x: number; y: number; spots: Spot[] }[] = [];
  for (const spot of spots) {
    const near = groups.find((group) => Math.hypot(group.x - spot.x, group.y - spot.y) <= reach);
    if (!near) {
      groups.push({ x: spot.x, y: spot.y, spots: [spot] });
      continue;
    }
    near.spots.push(spot);
    near.x += (spot.x - near.x) / near.spots.length;
    near.y += (spot.y - near.y) / near.spots.length;
  }
  return groups.map((group) => group.spots.map((spot, k) => (k ? spot : { ...spot, x: group.x, y: group.y })));
}

/* Какое действие в группе у большинства: им красим точку с числом */
function most(group: Spot[]): string {
  return mostOf(group.map((spot) => spot.action));
}

/* Самое частое значение: действие в группе, а у задач вместе задача */
function mostOf(values: string[]): string {
  const count = new Map<string, number>();
  for (const value of values) count.set(value, (count.get(value) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/* Корпус робота сверху. Форма 0 это прямоугольник со скругленными углами, как у одной задачи;
   у задач вместе вторая задача круглая, третья ромбом, четвертая шестигранником */
export function bodyPath(
  context: CanvasRenderingContext2D | Path2D,
  shape: number,
  long: number,
  wide: number,
  r: number,
): void {
  if (shape === 1) {
    context.ellipse(0, 0, long, long, 0, 0, Math.PI * 2);
    return;
  }
  if (shape === 2) {
    const d = long * 1.15;
    context.moveTo(d, 0);
    context.lineTo(0, d);
    context.lineTo(-d, 0);
    context.lineTo(0, -d);
    context.closePath();
    return;
  }
  if (shape === 3) {
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k;
      const x = Math.cos(a) * long * 1.05;
      const y = Math.sin(a) * long * 1.05;
      if (k) context.lineTo(x, y);
      else context.moveTo(x, y);
    }
    context.closePath();
    return;
  }
  context.roundRect(-long, -wide, long * 2, wide * 2, r * 0.45);
}
