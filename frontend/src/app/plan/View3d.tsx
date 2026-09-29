import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Plan, PlanMeasures } from "../../api/client";
import { IconButton } from "../../ui";
import type { ColorBy } from "./Editor";
import { type Floor, onFloors, sceneOrder, type Solid, spun } from "./depth";
import { cellsOf, edges, floorAt, floorTone, heightTone, patches, rackRows, type Rect } from "./geometry";

type Props = { plan: Plan; measures: PlanMeasures | null; colorBy: ColorBy };

const SIN = 0.5;
const COS = Math.sqrt(3) / 2;

/* Объемный вид. Только смотреть: правят в плане, здесь видно, что получилось по высоте.
   Стены прозрачные на всю высоту потолка, как стекло: видно и высоту здания, и то, что внутри.
   Поворот по девяносто градусов, как камера в строительном режиме игры. */
export function View3d({ plan, measures, colorBy }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [turn, setTurn] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const held = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const scene = useMemo(() => build(plan, measures, colorBy), [plan, measures, colorBy]);
  // порядок рисования зависит от поворота: считаем его, когда меняется сцена или поворот, а не на
  // каждый сдвиг и масштаб
  const order = useMemo(
    () => sceneOrder(scene.floor, scene.things, turn, plan.width_m / 2, plan.length_m / 2),
    [scene, turn, plan.width_m, plan.length_m],
  );

  useLayoutEffect(() => {
    const node = canvas.current;
    if (!node) return;
    // меряем сразу, не дожидаясь наблюдателя: в фоновой вкладке он молчит, и лист не вписывался
    const first = node.getBoundingClientRect();
    setSize({ w: first.width, h: first.height });
    const watch = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    const node = canvas.current;
    if (!node || !size.w) return;
    const ratio = window.devicePixelRatio || 1;
    node.width = size.w * ratio;
    node.height = size.h * ratio;
    const context = node.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint(context, order, plan, turn, zoom, shift, size);
  }, [order, plan, turn, zoom, shift, size]);

  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    // как на плане: масштаб от силы прокрутки, иначе тачпад улетает за секунду
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0015))));
      setZoom((now) => Math.min(8, Math.max(0.4, now * factor)));
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);

  const rotate = (by: number) => setTurn((now) => (now + by + 4) % 4);
  const reset = () => {
    setZoom(1);
    setShift({ x: 0, y: 0 });
  };

  return (
    <div className="u-board">
      <canvas
        ref={canvas}
        className="u-view3d"
        tabIndex={0}
        role="img"
        aria-label="Объемный вид склада: высота пола, стеллажей и потолка"
        onPointerDown={(event) => {
          if (event.currentTarget.hasPointerCapture?.(event.pointerId) === false) {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // без захвата лист тоже тянется, пока курсор над ним
            }
          }
          held.current = { x: event.clientX, y: event.clientY, sx: shift.x, sy: shift.y };
        }}
        onPointerMove={(event) => {
          const start = held.current;
          if (start) setShift({ x: start.sx + event.clientX - start.x, y: start.sy + event.clientY - start.y });
        }}
        onPointerUp={() => (held.current = null)}
        onKeyDown={(event) => {
          if (event.code === "KeyQ") rotate(-1);
          if (event.code === "KeyE") rotate(1);
          if (event.code === "KeyF") reset();
        }}
      />
      <div className="u-board-ctl">
        <IconButton label="Повернуть влево, клавиша Q" onClick={() => rotate(-1)}>
          <path d="M3.5 6.5a4.5 4.5 0 1 1 1.3 4.7M3.5 3v3.5H7" />
        </IconButton>
        <IconButton label="Повернуть вправо, клавиша E" onClick={() => rotate(1)}>
          <path d="M11.5 6.5a4.5 4.5 0 1 0-1.3 4.7M11.5 3v3.5H8" />
        </IconButton>
        <IconButton label="Приблизить" onClick={() => setZoom((now) => Math.min(8, now * 1.3))}>
          <path d="M7.5 3v9M3 7.5h9" />
        </IconButton>
        <IconButton label="Отдалить" onClick={() => setZoom((now) => Math.max(0.4, now / 1.3))}>
          <path d="M3 7.5h9" />
        </IconButton>
        <IconButton label="Вписать, клавиша F" onClick={reset}>
          <path d="M2.5 5.5v-3h3M9.5 2.5h3v3M12.5 9.5v3h-3M5.5 12.5h-3v-3" />
        </IconButton>
      </div>
      <div className="u-board-status mono">
        <span>тяните, чтобы сдвинуть · колесо: масштаб · Q и E: поворот</span>
        <span>стены прозрачные, высотой до потолка</span>
      </div>
    </div>
  );
}

function build(plan: Plan, measures: PlanMeasures | null, colorBy: ColorBy): { floor: Solid[]; things: Solid[] } {
  const cells = cellsOf(plan);
  const levels = cells.levels;
  const heights = levels.map((level) => level.floor_m);
  const floorOf = (index: number) => levels[index]?.floor_m ?? 0;
  const ceilingAt = (index: number) => levels[index]?.ceiling_m || 8;
  const under = (rect: Rect) => {
    const col = Math.min(cells.cols - 1, Math.max(0, Math.floor(rect.x + rect.w / 2)));
    const row = Math.min(cells.rows - 1, Math.max(0, Math.floor(rect.y + rect.h / 2)));
    return Math.max(0, cells.at[row * cells.cols + col]);
  };

  const pieces = patches(cells);
  const floors: Floor[] = pieces.map((patch) => ({
    x: patch.x,
    y: patch.y,
    w: patch.w,
    h: patch.h,
    floor: floorOf(patch.level),
    ceiling: ceilingAt(patch.level),
  }));
  // Вещь стоит на полу своей секции: заходит на две секции, режем по границе, и каждый кусок
  // стоит на своей отметке. Вне здания вещи не бывает, но если так вышло, ставим под серединой
  const stand = (rect: Rect): Floor[] => {
    const found = onFloors(rect, floors);
    if (found.length) return found;
    const level = under(rect);
    return [{ ...rect, floor: floorOf(level), ceiling: ceilingAt(level) }];
  };

  const floor: Solid[] = pieces.map((patch) => {
    const top = floorOf(patch.level);
    return {
      ...patch,
      z0: Math.min(0, top),
      z1: top,
      color: colorBy === "level" ? floorTone(heights, top) : "var(--lvl-0)",
      kind: top === 0 ? "flat" : "box",
    };
  });

  const things: Solid[] = [];
  for (const segment of edges(cells)) {
    if (segment.kind !== "wall") continue;
    const along = segment.y1 === segment.y2 ? "x" : "y";
    const probe =
      along === "x"
        ? { x: segment.x1, y: segment.y1 - 0.5, w: 1, h: 1 }
        : { x: segment.x1 - 0.5, y: segment.y1, w: 1, h: 1 };
    const level = Math.max(
      under(probe),
      under(along === "x" ? { ...probe, y: segment.y1 } : { ...probe, x: segment.x1 }),
    );
    const base = floorOf(level);
    things.push({
      x: Math.min(segment.x1, segment.x2),
      y: Math.min(segment.y1, segment.y2),
      w: Math.max(0.01, Math.abs(segment.x2 - segment.x1)),
      h: Math.max(0.01, Math.abs(segment.y2 - segment.y1)),
      z0: base,
      z1: base + ceilingAt(level),
      color: "var(--blue-deep)",
      kind: "glass",
    });
  }

  const depth = measures?.rack_depth_m ?? 1.1;
  const cross = measures?.cross_aisle_m ?? 4.5;
  for (const item of plan.items) {
    const level = under(item);
    const base = floorOf(level);
    if (item.kind === "racks") {
      const color = colorBy === "racks" ? heightTone(item.rack_top_m) : "var(--lvl-3)";
      for (const row of rackRows(item, depth, cross))
        for (const part of stand(row))
          things.push({
            ...rect(part),
            z0: part.floor,
            z1: part.floor + Math.max(1, item.rack_top_m),
            color,
            kind: "box",
          });
    } else if (item.kind === "blocked" && item.role === "zone") {
      // закрытая зона без стен: лежит на полу, а не стоит коробкой
      for (const part of stand(item))
        things.push({
          ...rect(part),
          z0: part.floor + 0.02,
          z1: part.floor + 0.02,
          color: "var(--stop)",
          kind: "flat",
          alpha: 0.16,
        });
    } else if (item.kind === "blocked") {
      // перегородка и колонна: от пола своей секции до ее потолка, светлые, как стены на макете.
      // Темная коробка на всю высоту закрывала стеллажи и читалась как что-то чужое
      for (const part of stand(item))
        things.push({
          ...rect(part),
          z0: part.floor,
          z1: part.floor + part.ceiling,
          color: "var(--paper)",
          kind: "box",
        });
    } else if (item.kind === "station") {
      for (const part of stand(item))
        things.push({ ...rect(part), z0: part.floor, z1: part.floor + 1.2, color: "var(--blue)", kind: "box" });
    } else if (item.kind === "dock") {
      things.push({
        ...item,
        z0: base,
        z1: base + Math.min(4, ceilingAt(level)),
        color: "var(--blue-deep)",
        kind: "box",
      });
    } else if (item.kind === "ramp") {
      // пандус идет вдоль длинной стороны от отметки пола у одного конца к отметке у другого
      const along = item.h >= item.w;
      const low = along
        ? floorAt(cells, Math.floor(item.x + item.w / 2), item.y - 1)
        : floorAt(cells, item.x - 1, Math.floor(item.y + item.h / 2));
      const high = along
        ? floorAt(cells, Math.floor(item.x + item.w / 2), item.y + item.h)
        : floorAt(cells, item.x + item.w, Math.floor(item.y + item.h / 2));
      things.push({
        ...item,
        z0: low ?? base,
        z1: high ?? base,
        color: "var(--paper)",
        kind: "ramp",
        along: item.h >= item.w ? "y" : "x",
      });
    } else {
      const charge = item.kind === "charge";
      for (const part of stand(item))
        things.push({
          ...rect(part),
          z0: part.floor + 0.02,
          z1: part.floor + 0.02,
          color: charge ? "var(--go)" : "var(--blue)",
          kind: "flat",
          alpha: charge ? 0.22 : 0.14,
        });
    }
  }
  return { floor, things };
}

/* Прямоугольник без лишних полей: у тела сцены не должно быть отметки и потолка куска пола */
function rect(one: Rect): Rect {
  return { x: one.x, y: one.y, w: one.w, h: one.h };
}

type Corner = [number, number, number];

function paint(
  context: CanvasRenderingContext2D,
  order: Solid[],
  plan: Plan,
  turn: number,
  zoom: number,
  shift: { x: number; y: number },
  size: { w: number; h: number },
) {
  // холст стоит на светлом листе и в темной теме (tokens.css): токены берем с него, а не с корня
  const css = getComputedStyle(context.canvas);
  const tone = (value: string) =>
    value.startsWith("var(") ? css.getPropertyValue(value.slice(4, -1)).trim() || "#999999" : value;
  const cx = plan.width_m / 2;
  const cy = plan.length_m / 2;
  const spin = ([x, y, z]: Corner): Corner => [...spun(x, y, turn, cx, cy), z];

  // масштаб так, чтобы весь участок влез: считаем проекцию его углов
  const lot: Corner[] = [
    [0, 0, 0],
    [plan.width_m, 0, 0],
    [0, plan.length_m, 0],
    [plan.width_m, plan.length_m, 0],
  ];
  const flat = lot.map(spin).map(([x, y, z]) => [(x - y) * COS, -(x + y) * SIN - z]);
  const xs = flat.map((point) => point[0]);
  const ys = flat.map((point) => point[1]);
  const top = Math.max(...plan.levels.map((level) => level.floor_m + (level.ceiling_m || 8)), 8);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys) + top;
  const scale = Math.min(size.w / spanX, size.h / spanY) * 0.9 * zoom;
  const middle = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys) - top) / 2];
  const project = (corner: Corner): [number, number] => {
    const [x, y, z] = spin(corner);
    return [
      size.w / 2 + shift.x + ((x - y) * COS - middle[0]) * scale,
      size.h / 2 + shift.y + (-(x + y) * SIN - z - middle[1]) * scale,
    ];
  };

  context.clearRect(0, 0, size.w, size.h);
  context.lineJoin = "round";

  const polygon = (corners: Corner[], fill: string, stroke?: string, alpha = 1) => {
    context.beginPath();
    corners.forEach((corner, index) => {
      const [x, y] = project(corner);
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    });
    context.closePath();
    context.globalAlpha = alpha;
    context.fillStyle = fill;
    context.fill();
    context.globalAlpha = 1;
    if (stroke) {
      context.strokeStyle = stroke;
      context.lineWidth = 1;
      context.stroke();
    }
  };

  const edge = tone("var(--blue-deep)");
  const draw = (solid: Solid) => {
    const color = tone(solid.color);
    const { x, y, w, h, z0, z1 } = solid;
    if (solid.kind === "flat") {
      polygon(
        [
          [x, y, z1],
          [x + w, y, z1],
          [x + w, y + h, z1],
          [x, y + h, z1],
        ],
        color,
        withAlpha(edge, 0.15),
        solid.alpha ?? 1,
      );
      return;
    }
    if (solid.kind === "ramp") {
      const low = z0;
      const high = z1;
      const corners: Corner[] =
        solid.along === "y"
          ? [
              [x, y, low],
              [x + w, y, low],
              [x + w, y + h, high],
              [x, y + h, high],
            ]
          : [
              [x, y, low],
              [x + w, y, high],
              [x + w, y + h, high],
              [x, y + h, low],
            ];
      polygon(corners, color, edge);
      return;
    }
    // у коробки видны три грани: верх и две боковые, обращенные к зрителю после поворота
    const faces: Corner[][] = [
      [
        [x, y, z0],
        [x + w, y, z0],
        [x + w, y, z1],
        [x, y, z1],
      ],
      [
        [x + w, y, z0],
        [x + w, y + h, z0],
        [x + w, y + h, z1],
        [x + w, y, z1],
      ],
      [
        [x + w, y + h, z0],
        [x, y + h, z0],
        [x, y + h, z1],
        [x + w, y + h, z1],
      ],
      [
        [x, y + h, z0],
        [x, y, z0],
        [x, y, z1],
        [x, y + h, z1],
      ],
    ];
    const glass = solid.kind === "glass";
    for (const face of faces) {
      const [a, b] = face.map(spin);
      const outward = [b[1] - a[1], -(b[0] - a[0])]; // нормаль грани в повернутых осях
      if (outward[0] + outward[1] > 0 && !glass) continue; // грань смотрит от зрителя
      const dark = outward[0] < outward[1] ? 0.82 : 0.68;
      polygon(
        face,
        glass ? color : shade(color, dark),
        glass ? withAlpha(color, 0.45) : withAlpha(edge, 0.25),
        glass ? 0.08 : 1,
      );
    }
    if (!glass)
      polygon(
        [
          [x, y, z1],
          [x + w, y, z1],
          [x + w, y + h, z1],
          [x, y + h, z1],
        ],
        color,
        withAlpha(edge, 0.3),
      );
  };

  // от дальнего к ближнему и снизу вверх: порядок посчитан заранее (depth.ts)
  order.forEach(draw);
}

function rgb(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const value = parseInt(full.slice(0, 6), 16);
  return Number.isNaN(value) ? [150, 150, 150] : [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function shade(color: string, factor: number): string {
  const [r, g, b] = rgb(color);
  return `rgb(${Math.round(r * factor)}, ${Math.round(g * factor)}, ${Math.round(b * factor)})`;
}

function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = rgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
