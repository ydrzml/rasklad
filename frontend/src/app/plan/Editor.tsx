import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { Direction, Plan, PlanItem, PlanMeasures, PlanSection, RackType } from "../../api/client";
import { Actions, Board, Dim, Hint, Menu, type MenuItem, type Point as BoardPoint, step, type View } from "../../ui";
import {
  bounds,
  type Cells,
  cellsOf,
  cornersOf,
  withoutCorner,
  DOCK_GAP,
  dockFits,
  dockRoom,
  doorSide,
  edges,
  fits,
  floorAt,
  floorTone,
  frameOf,
  gaps,
  type Guide,
  heightTone,
  laneWay,
  lanesOf,
  LOST,
  magnetEdge,
  magnetMove,
  outerRuns,
  outlineOf,
  patches,
  type Point,
  rackCells,
  REVERSE,
  type Rect,
  routeAlpha,
  routePatches,
  type Segment,
  sectionAt,
  signed,
  snapDock,
  snapLines,
  TURN,
  withRoom,
} from "./geometry";
import { GroupWindow, ItemWindow, ManyWindow, nameOf, RowWindow, SectionWindow } from "./ItemWindow";
import {
  copiedMany,
  countOf,
  joined,
  lineOf,
  manyOf,
  membersOf,
  partOf,
  pickedOf,
  shiftedMany,
  toggled,
  unitOf,
  unitsIn,
  withoutMany,
} from "./many";
import { meters, tidyPlan } from "./meters";
import { type Ink, photoLine } from "./outline";
import {
  bandOf,
  countIn,
  frame,
  layoutIn,
  layoutOf,
  lengthOf,
  rectsOf,
  relay,
  resizeRow,
  rowByDrag,
  rowsOf,
  rowsText,
  withLength,
} from "./rows";
import { inkOfUnderlay, type Underlay } from "./underlay";

/* Два режима, как в строительной игре: «Здание» строит пол и стены, «Обстановка» ставит на пол
   стеллажи, ворота и остальное. В одном режиме вещи другого не мешают щелкать. */
export type Mode = "build" | "furnish";
export type Tool =
  | "outline"
  | "hall"
  | "hole"
  | "select"
  | "row"
  | "racks"
  | "aisle"
  | "flow"
  | "dock"
  | "buffer"
  | "ramp"
  | "blocked"
  | "nogo"
  | "station";
export type ColorBy = "level" | "racks" | "route";

type Drag =
  /* tap: щелкнули по одному из нескольких выбранных. Отпустили не сдвинув, выбран останется он один */
  | { mode: "move"; id: string; off: Point; live?: Rect; snap?: Rect; guides: Guide[]; tap?: string }
  | { mode: "size"; id: string; handle: string; from: Rect; live?: Rect; snap?: Rect; guides: Guide[] }
  | { mode: "dock"; id: string; live?: Rect; snap?: Rect }
  /* ряд ворот одним движением: протянул вдоль стены, ворота встали с шагом фур */
  | { mode: "docks"; first: Rect; rects: Rect[]; snap?: undefined }
  /* on: протяжку начали на секции; если это был просто щелчок, секцию выбираем */
  | { mode: "paint"; tool: Tool; from: Point; to?: Point; snap?: Rect; guides: Guide[]; on?: string }
  /* рамка выбора по пустому месту: берет все, что задела. add: с Shift, к тому, что уже выбрано */
  | { mode: "box"; from: Point; to: Point; add: boolean; snap?: undefined }
  /* угол контура здания или его сторона: соседние стороны держат прямой угол */
  | {
      mode: "corner";
      id: string;
      index: number;
      edge: boolean;
      from: Point;
      live?: [number, number][];
      snap?: undefined;
    };

type Props = {
  plan: Plan;
  measures: PlanMeasures | null;
  mode: Mode;
  tool: Tool;
  onTool: (tool: Tool) => void;
  tools: Tool[];
  colorBy: ColorBy;
  picked: string;
  onPick: (id: string) => void;
  /* relay: зона, у которой была змейка, а ряды сдвинулись: сервер кладет полосы заново */
  onCommit: (plan: Plan, relay?: string) => void;
  /* змейка по проездам зоны хранения: полосы кладет сервер */
  onSerpentine: (zone: string, first?: Direction) => void;
  onUndo: () => void;
  onRedo: () => void;
  aisle: number;
  fitKey: string;
  still: boolean;
  rackTypes: RackType[];
  /* Колонка справа от листа: туда встает окно свойств */
  side: HTMLElement | null;
  /* Что покажут числа, если отпустить: сервер считает план, который еще не положили */
  onPreview?: (plan: Plan) => Promise<PlanMeasures | null>;
  /* картинка с планом под листом: по ней обводят здание и зоны */
  underlay: Underlay | null;
  /* что сделать дальше, пока план не готов: встает в строку под листом вместо справки */
  next?: ReactNode;
  /* главные числа плана в углу листа: их видно, пока тянешь, и на весь экран тоже */
  hud?: ReactNode;
  /* своя кнопка под кнопками масштаба */
  corner?: ReactNode;
  /* только смотреть: лист двигают и приближают, но ничего на нем не правят. Так он стоит
     в прогоне смены на шаге экономики */
  watch?: boolean;
  /* слой поверх листа в тех же координатах: роботы и тепловая карта прогона */
  layer?: (view: View, area: { w: number; h: number }) => ReactNode;
  /* строка справа под листом вместо координат курсора */
  status?: ReactNode;
};

const HINTS: Record<Tool, ReactNode> = {
  outline: (
    <>
      <b>Контур.</b> Щелкайте по углам здания по порядку, углы встают прямыми, Shift ставит угол как есть. Щелчок в
      первую точку или Enter замыкает контур, Del или Ctrl+Z убирает последнюю точку
    </>
  ),
  hall: (
    <>
      <b>Здание.</b> Щелчок выбирает здание: тяните углы и стены. Протяжка поверх зала кладет секцию, чтобы поднять
      часть пола
    </>
  ),
  hole: (
    <>
      <b>Вырез.</b> Протяните там, где пола быть не должно: двор, выступ, угол буквы Г
    </>
  ),
  select: (
    <>
      <b>Обстановка.</b> Щелчок: действия над объектом, Shift+щелчок или рамка: несколько, Alt: без прилипания
    </>
  ),
  row: (
    <>
      <b>Ряд.</b> Протяните там, где стоит ряд стеллажей: встанет ровно один ряд. С Shift инструмент остается в руке
    </>
  ),
  racks: (
    <>
      <b>Ряды.</b> Протяните прямоугольник по полу: ряды встанут вдоль длинной стороны, число рядов и проезд поправите
      справа
    </>
  ),
  aisle: (
    <>
      <b>Проезд.</b> Протяните полосу через зону хранения там, где нужен проезд: стеллажи под ней уберутся
    </>
  ),
  flow: (
    <>
      <b>Линия движения.</b> Протяните полосу по проезду: по ней едут только по стрелке, поперек переезжать можно. R
      разворачивает стрелку
    </>
  ),
  dock: (
    <>
      <b>Ворота.</b> Щелкните у наружной стены или протяните вдоль нее: ворота встанут в ряд с шагом фур. С Shift
      инструмент остается в руке
    </>
  ),
  buffer: (
    <>
      <b>Буфер.</b> Протяните прямоугольник у ворот
    </>
  ),
  ramp: (
    <>
      <b>Пандус.</b> Протяните поперек ступени между разными отметками пола. Можно прямо поверх стеллажей
    </>
  ),
  blocked: (
    <>
      <b>Перегородка.</b> Протяните комнату или стену: офис, холодильник, техническое помещение
    </>
  ),
  nogo: (
    <>
      <b>Закрытая зона.</b> Протяните место на полу, которым роботы не пользуются: участок людей, стоянка погрузчиков
    </>
  ),
  station: (
    <>
      <b>Станция.</b> Протяните прямоугольник станции комплектации
    </>
  ),
};

/* Строка под листом, когда объект выбран: что с ним можно сделать прямо сейчас */
const PICKED: Record<string, ReactNode> = {
  rows: "Тяните, чтобы переставить все ряды, за край, чтобы добавить ряды. Двойной щелчок выбирает один ряд, Shift+щелчок несколько. R повернуть, S змейка",
  racks: "Тяните, чтобы переставить, за конец, чтобы удлинить. S змейка по проездам",
  flow: "Тяните вдоль проезда. R развернуть стрелку, Shift+R повернуть",
  dock: "Тяните вдоль стены, за конец, чтобы сделать шире. Назначение в свойствах",
  charge: "Место выбрала программа. Передвинете, и место станет вашим",
  section: "Тяните углы и стены, Shift ставит угол как есть. Щелчок по углу и Del убирают угол",
  hole: "Тяните целиком или за край, чтобы поменять размер",
};

function pickedHint(kind: string, name: string): ReactNode {
  return (
    <>
      <b>{name}.</b> {PICKED[kind] ?? "Тяните, чтобы переставить, за край, чтобы растянуть"}. Свойства справа, Del
      удалить, Esc снять выбор
    </>
  );
}

const HANDLES: [string, number, number][] = [
  ["nw", 0, 0],
  ["n", 0.5, 0],
  ["ne", 1, 0],
  ["e", 1, 0.5],
  ["se", 1, 1],
  ["s", 0.5, 1],
  ["sw", 0, 1],
  ["w", 0, 0.5],
];
const CURSORS: Record<string, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};
const LEAST: Record<string, number> = {
  row: 2,
  racks: 4,
  aisle: 1,
  flow: 1,
  buffer: 2,
  ramp: 2,
  blocked: 1,
  nogo: 1,
  station: 2,
  hall: 2,
  hole: 2,
};
// линия движения поверх всего: это разметка на полу, ее стрелки должны быть видны
const DRAW_ORDER = ["racks", "aisle", "buffer", "charge", "ramp", "station", "blocked", "flow"];
const DOUBLE_MS = 350;
const PREVIEW_MS = 350; // сколько объект должен постоять под мышью, чтобы спросить сервер
const SMALL_PX = 60; // меньше этого на экране у объекта остаются только угловые ручки, и те снаружи

/* Редактор плана. Устроен как строительный режим в игре: объект едет за мышью плавно, а
   пунктиром показано, куда он встанет по сетке. Зеленый пунктир значит встанет, красный значит
   нельзя, и тогда объект вернется на место. Края липнут к соседям и стенам. У выбранного объекта
   над головой панелька действий: изменить, повернуть, дублировать, удалить.

   Пока объект тянут, план не меняется: живое положение хранится здесь, а в план и на сервер
   уходит только то, что отпустили. Иначе каждый сдвиг мыши гонял бы весь экран и расчет. */
export function Editor(props: Props) {
  const { plan, measures, mode, tool, colorBy, picked, watch } = props;
  // смотреть можно и на телефоне, и в прогоне смены: править нельзя ни там, ни там
  const still = props.still || Boolean(watch);
  const build = mode === "build";
  const underlay = props.underlay;
  // темные линии картинки плана: к ним липнут края, если рядом нет соседей и стен
  const [ink, setInk] = useState<{ src: string; ink: Ink } | null>(null);
  useEffect(() => {
    if (!underlay || ink?.src === underlay.src) return;
    let gone = false;
    inkOfUnderlay(underlay)
      .then((found) => !gone && setInk({ src: underlay.src, ink: found }))
      .catch(() => null);
    return () => {
      gone = true;
    };
  }, [underlay, ink]);
  const photo = (axis: "x" | "y", value: number, from: number, to: number, reach: number) =>
    underlay && ink?.src === underlay.src ? photoLine(ink.ink, underlay, axis, value, from, to, reach) : null;
  const L = plan.length_m;
  const cells = useMemo(() => cellsOf(plan), [plan]);
  const floor = useMemo(() => patches(cells), [cells]);
  const segments = useMemo(() => edges(cells), [cells]);
  const runs = useMemo(() => outerRuns(cells), [cells]);
  const heights = useMemo(() => cells.levels.map((level) => level.floor_m), [cells]);
  const building = useMemo(() => bounds(cells) ?? { x: 0, y: 0, w: cells.cols, h: cells.rows }, [cells]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // контур здания, который сейчас обводят по щелчкам: точки в метрах
  // Точки помнят, каким инструментом их ставили: взяли другой, и начатый контур пропадает
  const [traced, setTraced] = useState<{ tool: Tool; points: Point[] }>({ tool, points: [] });
  const trace = traced.tool === tool ? traced.points : [];
  const setTrace = (points: Point[]) => setTraced({ tool, points });
  // угол контура, по которому щелкнули последним: Del убирает его
  const [vertex, setVertex] = useState<{ sid: string; index: number } | null>(null);
  // правка из колонки справа не встала: ряд уперся в стену или соседа. Говорим это в окне
  const [refused, setRefused] = useState("");
  const [preview, setPreview] = useState<{ key: string; measures: PlanMeasures } | null>(null);
  const [fresh, setFresh] = useState("");
  // Размер цифрами, как в SketchUp: сразу после того, как вещь поставили или растянули, цифры
  // набирают ее размер, а не выбирают инструмент. anchor это угол, который стоит на месте.
  const [typed, setTyped] = useState<{ id: string; anchor: string; parts: string[] } | null>(null);
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const [area, setArea] = useState({ w: 800, h: 470 });
  const last = useRef({ id: "", at: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const onView = useCallback((next: View, size: { w: number; h: number }) => {
    setView(next);
    setArea(size);
  }, []);

  const depth = measures?.rack_depth_m ?? 1.1;
  const rowDefault = depth * 2;
  const cross = measures?.cross_aisle_m ?? 4.5;
  const docks = plan.items.filter((item) => item.kind === "dock");
  const otherDocks = (id: string) => docks.filter((one) => one.id !== id);
  const dockLen = docks.length ? Math.max(docks[0].w, docks[0].h) : 4;
  const floors = plan.sections.filter((section) => !section.hole);

  // экран рисует от верхнего края, движок считает от нижнего
  const toWorld = (point: BoardPoint): Point => ({ x: point.x, y: L - point.y });
  const onScreen = (rect: Rect): Rect => ({ x: rect.x, y: L - rect.y - rect.h, w: rect.w, h: rect.h });
  const toPixels = (rect: Rect) => {
    const drawn = onScreen(rect);
    return { x: drawn.x * view.s + view.tx, y: drawn.y * view.s + view.ty, w: drawn.w * view.s, h: drawn.h * view.s };
  };

  // в план кладем метры до сантиметра: иначе от сдвигов и прилипания копится хвост дроби
  const commit = (next: Plan, relay?: string) => props.onCommit(tidyPlan(withRoom({ ...next, edited: true })), relay);
  // группа рядов выбрана целиком: picked это имя группы, а не одного ряда
  const group = (id: string) => rowsOf(plan.items, id);
  // выбрано несколько: picked это "many:a,b", в нем вещи, отдельные ряды и группы рядов (many.ts)
  const many = build ? [] : manyOf(picked);
  const manyItems = membersOf(plan.items, many);
  const setItem = (id: string, patch: Partial<PlanItem>) => {
    const item = plan.items.find((one) => one.id === id);
    if (!item) return;
    commit({ ...plan, items: withZone(plan.items, item, patch) }, relayOf(item, patch, plan.items));
  };
  const setSection = (id: string, patch: Partial<PlanSection>) =>
    commit({ ...plan, sections: plan.sections.map((one) => (one.id === id ? { ...one, ...patch } : one)) });
  const settle = (id: string) => {
    setFresh(id);
    window.setTimeout(() => setFresh((now) => (now === id ? "" : now)), 500);
  };
  const addItem = (item: PlanItem) => {
    commit({ ...plan, items: [...plan.items, item] });
    props.onPick(item.id);
    settle(item.id);
  };
  const remove = (id: string) => {
    const section = plan.sections.find((one) => one.id === id);
    if (section && !section.hole && floors.length <= 1) {
      // без пола здания нет. Обведенный контур убираем: здание снова прямоугольник по его рамке
      if (outlineOf(section)) {
        setVertex(null);
        setSection(id, { points: [] });
      } else
        setRefused(
          "Здание целиком не удалить: без пола нет склада. Размер меняют за края, начать с нуля можно над чертежом",
        );
      return;
    }
    // вместе с рядами уходит и их змейка: полосы без стеллажей ничего не значат
    const rows = new Set(group(id).map((one) => one.id));
    const lanes = new Set(lanesOf(plan.items, id).map((one) => one.id));
    commit({
      ...plan,
      items: plan.items.filter((item) => item.id !== id && !rows.has(item.id) && !lanes.has(item.id)),
      sections: plan.sections.filter((one) => one.id !== id),
    });
    props.onPick("");
  };

  /* Правка группы рядов числами: раскладка держится за верхний левый угол листа, меняется только
     то, что правили. Если ряды так не встанут, группа остается прежней, а окно говорит почему. */
  const setGroup = (
    id: string,
    change: { count?: number; aisle?: number; length?: number; turn?: boolean },
    patch: Partial<PlanItem> = {},
  ) => {
    const rows = group(id);
    if (!rows.length) return;
    let layout = { ...layoutOf(rows, rowDefault), band: bandOf({ ...rows[0], ...patch }, rowDefault) };
    if (change.count) layout.count = change.count;
    if (change.aisle !== undefined) layout.aisle = change.aisle;
    // другой тип стеллажа приносит свой проезд
    else if (patch.aisle_m !== undefined) layout.aisle = patch.aisle_m;
    if (change.length) layout = withLength(layout, change.length);
    if (change.turn) {
      // ряды поворачиваются в той же рамке: сколько встанет поперек, столько и будет
      const box = frame(rows);
      const rows2 = layout.rows === "x" ? "y" : "x";
      layout = layoutIn(box, { x: box.x, y: box.y + box.h }, layout.band, layout.aisle, rows2);
    }
    const stamp = stampNow();
    const next = relay(
      rows.map((one) => ({ ...one, ...patch })),
      layout,
      id,
      (index) => `${id}-r${index}-${stamp}`,
    );
    const gone = new Set(rows.map((one) => one.id));
    const others = plan.items.filter((one) => !gone.has(one.id));
    if (!next.every((one) => fits(one, cells, others, "", "racks"))) {
      setRefused("Так ряды не встанут: упираются в стену или в соседа. Ряды остались как были");
      return;
    }
    setRefused("");
    commit({ ...plan, items: [...others, ...next] }, lanesOf(plan.items, id).length ? id : undefined);
  };

  /* Правка одного ряда: длина и толщина держат верхний левый угол листа */
  const setRow = (row: PlanItem, change: { length?: number }, patch: Partial<PlanItem> = {}) => {
    const band = bandOf({ ...row, ...patch }, rowDefault);
    const rect = resizeRow(row, { length: change.length, band: band !== bandOf(row, rowDefault) ? band : undefined });
    if (!fits(rect, cells, plan.items, row.id, "racks")) {
      setRefused("Так ряд не встанет: упирается в стену или в соседа");
      return;
    }
    setRefused("");
    setItem(row.id, { ...patch, ...rect });
  };

  const duplicate = (item: PlanItem) => {
    for (const shift of [2, 4, 8, 12, 20]) {
      for (const [dx, dy] of [
        [item.w + shift, 0],
        [0, -(item.h + shift)],
        [-(item.w + shift), 0],
        [0, item.h + shift],
      ]) {
        const spot = { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h };
        if (fits(spot, cells, plan.items, "", item.kind))
          return addItem({ ...item, ...spot, id: newId(item.kind), auto: false, group: "" });
      }
    }
  };

  /* Копия группы рядом, на свободном месте: те же ряды с тем же проездом */
  const duplicateGroup = (id: string) => {
    const rows = group(id);
    const box = frame(rows);
    for (const shift of [2, 4, 8, 12, 20])
      for (const [dx, dy] of [
        [box.w + shift, 0],
        [0, -(box.h + shift)],
        [-(box.w + shift), 0],
        [0, box.h + shift],
      ]) {
        const gid = newId("rows");
        const copy = rows.map((one, index) => ({
          ...one,
          id: `${gid}-r${index}`,
          group: gid,
          x: one.x + dx,
          y: one.y + dy,
        }));
        if (copy.every((one) => fits(one, cells, plan.items, "", "racks"))) {
          commit({ ...plan, items: [...plan.items, ...copy] });
          props.onPick(gid);
          return;
        }
      }
  };

  // ряды, взятые из группы по одному: змейку этой группы сервер кладет заново по оставшимся
  const relayMany = (units: string[]) => partOf(plan.items, units).find((one) => lanesOf(plan.items, one).length);
  /* Несколько выбранных: удалить и дублировать одной правкой, Ctrl+Z вернет все сразу */
  const removeMany = (units: string[]) => {
    commit({ ...plan, items: withoutMany(plan.items, units) }, relayMany(units));
    props.onPick("");
  };
  const duplicateMany = (units: string[]) => {
    const box = frame(membersOf(plan.items, units));
    for (const shift of [2, 4, 8, 12, 20])
      for (const [dx, dy] of [
        [box.w + shift, 0],
        [0, -(box.h + shift)],
        [-(box.w + shift), 0],
        [0, box.h + shift],
      ]) {
        const copy = copiedMany(plan.items, units, dx, dy, newId);
        if (!copy.items.length) return;
        if (copy.items.every((one) => fits(one, cells, plan.items, "", one.kind))) {
          commit({ ...plan, items: [...plan.items, ...copy.items] });
          props.onPick(pickedOf(copy.units));
          return;
        }
      }
    setRefused("Копии рядом места нет: вокруг стены или соседи");
  };

  // Новый ряд берет стеллажи у соседнего: на одном складе они обычно одного типа
  const born = (tool: Tool, rect: Rect): PlanItem => {
    const kind = kindOf(tool);
    const like = plan.items.find((item) => item.kind === "racks");
    const front = props.rackTypes.find((one) => one.id === "front");
    const racks = kind === "racks";
    return {
      id: newId(kind),
      kind,
      ...rect,
      aisle_m: racks ? (like?.aisle_m ?? props.aisle) : 0,
      // Ряд рисуют по своему складу, и поперечные проезды на нем свои: ряд сплошной,
      // проезд кладут инструментом «Проезд» там, где он есть. Каждые 30 м было нашей догадкой
      run_m: 0,
      rows: like?.rows ?? "y",
      rack_top_m: racks ? (like?.rack_top_m ?? measures?.rack_top_m ?? 0) : 0,
      rack_type: racks ? (like?.rack_type ?? "front") : "",
      row_m: racks ? (like?.row_m ?? front?.row_m ?? rowDefault) : 0,
      block_rows: racks ? (like?.block_rows ?? 1) : 1,
      cross_m: racks ? (like?.cross_m ?? front?.cross_m ?? 0) : 0,
      tiers: racks ? (like?.tiers ?? 0) : 0,
      tier_m: racks ? (like?.tier_m ?? front?.tier_m ?? 0) : 0,
      role: kind === "buffer" || kind === "dock" ? "both" : tool === "nogo" ? "zone" : "",
      auto: false,
      turnover: "",
      direction: kind === "flow" ? laneWay(rect, "") : "",
      group: "",
    };
  };
  // толщина и проезд нового ряда: как у соседнего ряда или у фронтального стеллажа
  const likeRow = plan.items.find((item) => item.kind === "racks");
  const front = props.rackTypes.find((one) => one.id === "front");
  const newBand = bandOf(likeRow ?? { row_m: front?.row_m ?? rowDefault, block_rows: 1 }, rowDefault);
  const newAisle = likeRow?.aisle_m ?? props.aisle;

  /* Ряды по протяжке: один ряд инструментом «Ряд», группа рядов инструментом «Ряды» */
  const bornRows = (tool: Tool, from: Point, to: Point, box: Rect): PlanItem[] => {
    if (tool === "row") {
      const rect = rowByDrag(from, to, newBand);
      return [{ ...born("racks", rect), ...rect }];
    }
    const layout = layoutIn(box, from, newBand, newAisle);
    const gid = newId("rows");
    const base = born("racks", box);
    return rectsOf(layout).map((rect, index) => ({
      ...base,
      ...rect,
      rows: layout.rows,
      id: `${gid}-r${index}`,
      group: gid,
      aisle_m: newAisle,
    }));
  };

  // Новая секция берет отметку и потолок той, что под ней: пристройку чаще всего рисуют на том же полу
  const bornSection = (rect: Rect, hole: boolean): PlanSection => {
    const under = sectionAt(plan, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }) ?? floors[0];
    return {
      id: newId(hole ? "hole" : "section"),
      ...rect,
      floor_m: under?.floor_m ?? 0,
      ceiling_m: under?.ceiling_m ?? 0,
      hole,
      points: [],
    };
  };

  /* Контур обвели: он становится полом основного зала вместо прямоугольника. Остальные секции,
     поднятые части и вырезы старых планов, остаются как были */
  const closeTrace = (points: Point[]) => {
    setTrace([]);
    if (points.length < 3) return;
    const outline = points.map((one) => [one.x, one.y] as [number, number]);
    const main = floors[0];
    const section: PlanSection = main
      ? { ...main, ...frameOf(outline), points: outline }
      : { ...bornSection(frameOf(outline), false), points: outline };
    commit({
      ...plan,
      sections: main ? plan.sections.map((one) => (one.id === main.id ? section : one)) : [...plan.sections, section],
    });
    props.onPick(section.id);
    props.onTool("hall");
  };

  /* Следующая точка контура: по сетке в метр, и сторона от прошлой точки вдоль листа или поперек,
     смотря куда ближе. С Shift угол как есть. К первой точке липнет, чтобы контур замкнулся ровно */
  const nextPoint = (at: Point, free: boolean): Point => {
    const spot = { x: Math.round(at.x), y: Math.round(at.y) };
    const last = trace.at(-1);
    if (!last || free) return spot;
    const flat = Math.abs(spot.x - last.x) >= Math.abs(spot.y - last.y);
    const first = trace[0];
    const reach = 10 / view.s;
    const next = flat ? { x: spot.x, y: last.y } : { x: last.x, y: spot.y };
    if (flat && Math.abs(next.x - first.x) <= reach) next.x = first.x;
    if (!flat && Math.abs(next.y - first.y) <= reach) next.y = first.y;
    return next;
  };
  // угол контура убирают двойным щелчком или Del: соседние стены сходятся напрямую
  const dropCorner = (section: PlanSection, index: number) => {
    setVertex(null);
    const points = withoutCorner(cornersOf(section), index);
    if (points) setSection(section.id, { ...frameOf(points), points });
    else setRefused("Точку не убрать: у здания меньше трех углов не бывает");
  };
  const closes = (at: Point) => trace.length >= 3 && Math.hypot(at.x - trace[0].x, at.y - trace[0].y) * view.s <= 12;

  // После одной вещи инструмент возвращается к выбору, как в редакторах макетов: иначе следующее
  // движение рисовало вторую зону вместо того, чтобы подвинуть первую. Shift держит инструмент.
  const rest = (event: { shiftKey: boolean }) => {
    const home: Tool = build ? "hall" : "select";
    if (!event.shiftKey && tool !== home) props.onTool(home);
  };

  // Двойной щелчок ловим сами: пока объект держат, браузер отдает щелчки листу, а не объекту
  const twice = (id: string) => {
    const now = clock();
    const again = last.current.id === id && now - last.current.at < DOUBLE_MS;
    last.current = { id, at: now };
    return again;
  };

  // --- мышь ----------------------------------------------------------------------------

  const hit = (event: { target: EventTarget | null }) => {
    const node = (event.target as Element | null)?.closest?.("[data-id],[data-sid]");
    return {
      id: node?.getAttribute("data-id") ?? "",
      sid: node?.getAttribute("data-sid") ?? "",
      handle: node?.getAttribute("data-h") ?? "",
      // угол контура или его сторона: номер точки, с которой сторона начинается
      corner: node?.getAttribute("data-v") ?? "",
      side: node?.getAttribute("data-e") ?? "",
    };
  };

  const down = (point: BoardPoint, event: ReactPointerEvent<SVGSVGElement>): boolean => {
    setMenu(null);
    setTyped(null);
    setRefused("");
    if (still) return false;
    const at = toWorld(point);
    const { id, sid, handle, corner, side } = hit(event);

    if (build) {
      if (tool === "outline") {
        // щелчок в первую точку замыкает контур
        if (closes(at)) closeTrace(trace);
        else {
          // щелчок в ту же точку второй точки не ставит: иначе контур копил невидимые углы
          const point = nextPoint(at, event.shiftKey);
          const last = trace.at(-1);
          if (!last || last.x !== point.x || last.y !== point.y) setTrace([...trace, point]);
        }
        return true;
      }
      const section = plan.sections.find((one) => one.id === sid);
      if (section && corner && twice(`${sid}:${corner}`)) {
        // двойной щелчок по углу убирает точку, соседние стены сходятся напрямую
        dropCorner(section, Number(corner));
        return true;
      }
      setVertex(section && corner ? { sid, index: Number(corner) } : null);
      if (section && (corner || side)) {
        setDrag({ mode: "corner", id: sid, index: Number(corner || side), edge: Boolean(side), from: at });
        return true;
      }
      if (handle && section) {
        setDrag({ mode: "size", id: sid, handle, from: rectOf(section), guides: [] });
        return true;
      }
      if (tool === "hall" && section) {
        // Выбранную секцию тянут целиком. По невыбранной протяжка кладет новую секцию поверх:
        // так поднимают часть зала, не двигая сам зал. Щелчок без протяжки секцию выбирает
        if (section.id === picked) {
          setDrag({ mode: "move", id: sid, off: { x: at.x - section.x, y: at.y - section.y }, guides: [] });
          return true;
        }
        setDrag({ mode: "paint", tool, from: at, guides: [], on: section.id });
        return true;
      }
      props.onPick("");
      setDrag({ mode: "paint", tool, from: at, guides: [] });
      return true;
    }

    const item = plan.items.find((one) => one.id === id);
    // ручки группы рядов носят имя группы, а не ряда
    const rows = group(id);
    if (handle && (item || rows.length)) {
      setDrag({ mode: "size", id, handle, from: item ? rectOf(item) : frame(rows), guides: [] });
      return true;
    }
    if (tool === "dock") {
      // ворота встают, когда отпустят: если до этого протянуть вдоль стены, встанет целый ряд
      const spot = snapDock(runs, at, dockLen, docks);
      if (spot) setDrag({ mode: "docks", first: spot.rect, rects: [spot.rect] });
      return true;
    }
    if (tool !== "select") {
      setDrag({ mode: "paint", tool, from: at, guides: [] });
      return true;
    }
    // Shift+щелчок добавляет вещь к выбранному или убирает ее оттуда. Ряд группы берется один:
    // если щелчком только что выбрали всю группу, в выбор идет ряд, по которому щелкнули
    if (item && event.shiftKey) {
      const first = plan.items.find((one) => one.id === last.current.id);
      const seed =
        item.group && picked === item.group && first?.group === item.group
          ? pickedOf(lineOf(plan.items, first))
          : picked;
      props.onPick(toggled(plan.items, seed, item));
      return true;
    }
    // выбрано несколько, и тянут одно из них: едут все вместе
    if (item && many.length && (many.includes(unitOf(item)) || many.includes(item.id))) {
      const box = frame(manyItems);
      setDrag({ mode: "move", id: picked, off: { x: at.x - box.x, y: at.y - box.y }, guides: [], tap: unitOf(item) });
      return true;
    }
    if (item) {
      const again = twice(item.id);
      // Ряд из группы: щелчок выбирает все ряды группы и тянет их вместе, двойной щелчок один ряд
      if (item.kind === "racks" && item.group) {
        if (again) {
          props.onPick(item.id);
          return true;
        }
        if (picked !== item.id) {
          props.onPick(item.group);
          const box = frame(group(item.group));
          setDrag({ mode: "move", id: item.group, off: { x: at.x - box.x, y: at.y - box.y }, guides: [] });
          return true;
        }
      }
      props.onPick(item.id);
      setDrag(
        item.kind === "dock"
          ? { mode: "dock", id }
          : { mode: "move", id, off: { x: at.x - item.x, y: at.y - item.y }, guides: [] },
      );
      return true;
    }
    // по пустому месту тянут рамку выбора. Лист двигают пробелом с мышью, средней кнопкой и тачпадом
    setDrag({ mode: "box", from: at, to: at, add: event.shiftKey });
    return true;
  };

  const move = (point: BoardPoint, event: ReactPointerEvent<SVGSVGElement>) => {
    const at = toWorld(point);
    setHover(at);
    if (!drag) return;
    // Alt отключает прилипание: иначе вплотную не к соседу, а в метре от него не поставить
    const reach = event.altKey ? 0 : 10 / view.s;
    const target = "id" in drag ? findRect(plan, drag.id) : undefined;
    // ряды группы не липнут сами к себе
    const riding = new Set("id" in drag ? membersOf(plan.items, manyOf(drag.id)).map((one) => one.id) : []);
    const others = build
      ? plan.sections
      : plan.items.filter((one) => !("id" in drag) || (one.group !== drag.id && !riding.has(one.id)));
    if (drag.mode === "box") {
      setDrag({ ...drag, to: at });
    } else if (drag.mode === "corner") {
      const section = plan.sections.find((one) => one.id === drag.id);
      if (!section) return;
      const spot = { x: Math.round(at.x), y: Math.round(at.y) };
      setDrag({ ...drag, live: dragCorner(cornersOf(section), drag.index, drag.edge, spot, event.shiftKey) });
    } else if (drag.mode === "move" && target) {
      const live = { x: at.x - drag.off.x, y: at.y - drag.off.y, w: target.w, h: target.h };
      const lines = snapLines(others, build ? [] : segments, target.id, cells);
      const pulled = magnetMove(live, lines.xs, lines.ys, reach);
      // по оси, где соседей и стен рядом нет, край липнет к линии на картинке плана
      let rect = pulled.rect;
      const guides = [...pulled.guides];
      for (const axis of ["x", "y"] as const) {
        if (guides.some((guide) => guide.axis === axis)) continue;
        const [start, size] = axis === "x" ? [live.x, live.w] : [live.y, live.h];
        const [a, b] = axis === "x" ? [live.y, live.y + live.h] : [live.x, live.x + live.w];
        const low = photo(axis, start, a, b, reach);
        const high = photo(axis, start + size, a, b, reach);
        const pick =
          low && (!high || Math.abs(low.at - start) <= Math.abs(high.at - start - size))
            ? { line: low, at: low.at }
            : high
              ? { line: high, at: high.at - size }
              : null;
        if (!pick) continue;
        guides.push(pick.line);
        rect = axis === "x" ? { ...rect, x: pick.at } : { ...rect, y: pick.at };
      }
      const snap = build
        ? { ...rect, x: Math.max(0, rect.x), y: Math.max(0, rect.y) }
        : {
            ...rect,
            x: Math.min(cells.cols - target.w, Math.max(0, rect.x)),
            y: Math.min(cells.rows - target.h, Math.max(0, rect.y)),
          };
      setDrag({ ...drag, live, snap, guides });
    } else if (drag.mode === "dock" && target) {
      const spot = snapDock(runs, at, Math.max(target.w, target.h), otherDocks(target.id));
      if (spot) setDrag({ ...drag, live: spot.raw, snap: spot.rect });
    } else if (drag.mode === "docks") {
      setDrag({ ...drag, rects: dockRow(drag.first, at) });
    } else if (drag.mode === "size" && target) {
      const lines = snapLines(others, build ? [] : segments, drag.id, cells);
      const from = drag.from;
      let [x1, y1, x2, y2] = [from.x, from.y, from.x + from.w, from.y + from.h];
      let [s1, t1, s2, t2] = [x1, y1, x2, y2];
      const guides: Guide[] = [];
      const pull = (value: number, axis: "x" | "y") => {
        const found = magnetEdge(value, axis === "x" ? lines.xs : lines.ys, reach, axis);
        if (found.guide) {
          guides.push(found.guide);
          return found.at;
        }
        const line =
          axis === "x"
            ? photo(axis, value, from.y, from.y + from.h, reach)
            : photo(axis, value, from.x, from.x + from.w, reach);
        if (line) guides.push(line);
        return line ? line.at : found.at;
      };
      const least = build ? 2 : 1;
      // ручка на экране сверху значит северный край, то есть большее y
      if (drag.handle.includes("w"))
        [x1, s1] = [Math.min(at.x, x2 - least), Math.max(0, Math.min(pull(at.x, "x"), x2 - least))];
      if (drag.handle.includes("e")) [x2, s2] = [Math.max(at.x, x1 + least), Math.max(pull(at.x, "x"), x1 + least)];
      if (drag.handle.includes("s"))
        [y1, t1] = [Math.min(at.y, y2 - least), Math.max(0, Math.min(pull(at.y, "y"), y2 - least))];
      if (drag.handle.includes("n")) [y2, t2] = [Math.max(at.y, y1 + least), Math.max(pull(at.y, "y"), y1 + least)];
      const item = build ? undefined : plan.items.find((one) => one.id === drag.id);
      if (item?.kind === "dock") {
        // ручка ворот упирается в соседние ворота и в угол стены
        const room = dockRoom(runs, from, otherDocks(item.id));
        if (room && from.w >= from.h) [s1, s2] = [Math.max(s1, room.from), Math.min(s2, room.to)];
        if (room && from.h > from.w) [t1, t2] = [Math.max(t1, room.from), Math.min(t2, room.to)];
      }
      const rows = build ? [] : group(drag.id);
      if (rows.length) {
        // группа растет целыми рядами: тянешь край поперек рядов, ряд добавляется или уходит весь
        const { band, aisle, rows: axis } = layoutOf(rows, rowDefault);
        const whole = (extent: number) => {
          const count = Math.max(1, Math.round((extent + aisle) / (band + aisle)));
          return count * band + (count - 1) * aisle;
        };
        if (axis === "x") {
          if (drag.handle.includes("s")) t1 = t2 - whole(t2 - t1);
          else if (drag.handle.includes("n")) t2 = t1 + whole(t2 - t1);
        } else {
          if (drag.handle.includes("w")) s1 = s2 - whole(s2 - s1);
          else if (drag.handle.includes("e")) s2 = s1 + whole(s2 - s1);
        }
      }
      setDrag({
        ...drag,
        live: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
        snap: { x: s1, y: t1, w: s2 - s1, h: t2 - t1 },
        guides,
      });
    } else if (drag.mode === "paint") {
      if (drag.tool === "row") {
        // один ряд: толщина от стеллажа, длина там, где тянули
        const rect = rowByDrag(drag.from, at, newBand);
        setDrag({ ...drag, to: at, snap: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, guides: [] });
        return;
      }
      // новый прямоугольник липнет к соседям и стенам так же, как тот, что двигают
      const lines = snapLines(others, build ? [] : segments, "", cells);
      const guides: Guide[] = [];
      const edge = (value: number, axis: "x" | "y", fallback: (value: number) => number) => {
        const found = magnetEdge(value, axis === "x" ? lines.xs : lines.ys, reach, axis);
        if (found.guide) {
          guides.push(found.guide);
          return found.at;
        }
        const [a, b] =
          axis === "x"
            ? [Math.min(drag.from.y, at.y), Math.max(drag.from.y, at.y)]
            : [Math.min(drag.from.x, at.x), Math.max(drag.from.x, at.x)];
        const line = photo(axis, value, a, b, reach);
        if (!line) return fallback(value);
        guides.push(line);
        return line.at;
      };
      const x1 = Math.max(0, edge(Math.min(drag.from.x, at.x), "x", Math.floor));
      const y1 = Math.max(0, edge(Math.min(drag.from.y, at.y), "y", Math.floor));
      let x2 = Math.max(x1 + 1, edge(Math.max(drag.from.x, at.x), "x", Math.ceil));
      let y2 = Math.max(y1 + 1, edge(Math.max(drag.from.y, at.y), "y", Math.ceil));
      // секция может выйти за участок: участок под нее вырастет. Вещи остаются в пределах участка
      if (!build) {
        x2 = Math.min(cells.cols, x2);
        y2 = Math.min(cells.rows, y2);
      }
      setDrag({ ...drag, to: at, snap: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, guides });
    }
  };

  /* Ряд ворот от первых до курсора вдоль стены, с шагом фур: створка и простенок. Ряд не
     выходит за свободный отрезок стены, в котором стоят первые ворота, и не наезжает на соседей. */
  const dockRow = (first: Rect, at: Point): Rect[] => {
    const across = first.w >= first.h;
    const room = dockRoom(runs, first, docks);
    if (!room) return [first];
    const pitch = dockLen + DOCK_GAP;
    const start = across ? first.x : first.y;
    const cursor = across ? at.x : at.y;
    const make = (pos: number): Rect => (across ? { ...first, x: pos } : { ...first, y: pos });
    const found = [first];
    if (cursor > start + dockLen) {
      const count = Math.min(40, Math.floor((cursor - start) / pitch));
      for (let k = 1; k <= count && start + k * pitch + dockLen <= room.to; k++) found.push(make(start + k * pitch));
    } else if (cursor < start) {
      const count = Math.min(40, Math.floor((start - cursor + dockLen) / pitch));
      for (let k = 1; k <= count && start - k * pitch >= room.from; k++) found.push(make(start - k * pitch));
    }
    return found;
  };

  /* План, который получится, если отпустить сейчас. null значит, что ничего не изменится или
     встать нельзя: красный пунктир, объект вернется назад. */
  const after = (done: Drag): { plan: Plan; picked?: string; relay?: string } | null => {
    if (done.mode === "box") return null;
    if (done.mode === "docks") {
      const items = done.rects.map((rect) => born("dock", rect));
      return { plan: { ...plan, items: [...plan.items, ...items] }, picked: items[items.length - 1].id };
    }
    if (done.mode === "corner") {
      const section = plan.sections.find((one) => one.id === done.id);
      if (!section || !done.live || done.live.length < 3) return null;
      const box = frameOf(done.live);
      if (box.w < 2 || box.h < 2) return null;
      if (JSON.stringify(done.live) === JSON.stringify(cornersOf(section))) return null;
      return {
        plan: {
          ...plan,
          sections: plan.sections.map((one) =>
            one.id === section.id ? { ...one, ...box, points: done.live ?? [] } : one,
          ),
        },
      };
    }
    if (!done.snap) return null;
    const snap = done.snap;
    if (done.mode === "paint") {
      const least = LEAST[done.tool] ?? 1;
      if (snap.w < least || snap.h < least) return null;
      if (done.tool === "hall" || done.tool === "hole") {
        const section = bornSection(snap, done.tool === "hole");
        return { plan: { ...plan, sections: [...plan.sections, section] }, picked: section.id };
      }
      if (done.tool === "row" || done.tool === "racks") {
        const rows = bornRows(done.tool, done.from, done.to ?? done.from, snap);
        if (!rows.every((one) => fits(one, cells, plan.items, "", "racks"))) return null;
        return { plan: { ...plan, items: [...plan.items, ...rows] }, picked: rows[0].group || rows[0].id };
      }
      if (!fits(snap, cells, plan.items, "", kindOf(done.tool))) return null;
      const item = born(done.tool, snap);
      return { plan: { ...plan, items: [...plan.items, item] }, picked: item.id };
    }
    if (build) {
      const section = plan.sections.find((one) => one.id === done.id);
      if (!section || same(snap, section)) return null;
      // контур едет вместе с секцией
      const [dx, dy] = [snap.x - section.x, snap.y - section.y];
      const points = (section.points ?? []).map(([x, y]) => [x + dx, y + dy] as [number, number]);
      return {
        plan: {
          ...plan,
          sections: plan.sections.map((one) => (one.id === section.id ? { ...one, ...snap, points } : one)),
        },
      };
    }
    const units = manyOf(done.id);
    if (units.length) {
      // несколько выбранных едут вместе: каждое встает по своим правилам, иначе не едет ничего
      const members = membersOf(plan.items, units);
      const box = frame(members);
      if (same(snap, box)) return null;
      const moved = new Map(shiftedMany(plan.items, units, snap.x - box.x, snap.y - box.y).map((one) => [one.id, one]));
      const others = plan.items.filter((one) => !moved.has(one.id));
      const ok = members.every((one) => {
        const next = moved.get(one.id) ?? one;
        return one.kind === "dock"
          ? dockFits(
              cells,
              next,
              doorSide(cells, one),
              others.filter((other) => other.kind === "dock"),
            )
          : fits(next, cells, others, "", one.kind);
      });
      if (!ok) return null;
      return { plan: { ...plan, items: plan.items.map((one) => moved.get(one.id) ?? one) }, relay: relayMany(units) };
    }
    const rows = group(done.id);
    if (rows.length) {
      const box = frame(rows);
      if (same(snap, box)) return null;
      const others = plan.items.filter((one) => one.group !== done.id);
      let next: PlanItem[];
      if (done.mode === "move") {
        const [dx, dy] = [snap.x - box.x, snap.y - box.y];
        next = rows.map((one) => ({ ...one, x: one.x + dx, y: one.y + dy }));
      } else {
        // ручку отпустили: ряды встают в новую рамку от того края, который не трогали
        const was = layoutOf(rows, rowDefault);
        const handle = done.mode === "size" ? done.handle : "";
        const across = was.rows === "x" ? snap.h : snap.w;
        const high = was.rows === "x" ? handle.includes("s") : handle.includes("w");
        const layout = {
          ...was,
          count: countIn(across, was.band, was.aisle),
          length: was.rows === "x" ? snap.w : snap.h,
          start: was.rows === "x" ? snap.x : snap.y,
          from: high ? ("high" as const) : ("low" as const),
          edge: was.rows === "x" ? (high ? snap.y + snap.h : snap.y) : high ? snap.x + snap.w : snap.x,
        };
        const stamp = stampNow();
        next = relay(rows, layout, done.id, (index) => `${done.id}-r${index}-${stamp}`);
      }
      if (!next.every((one) => fits(one, cells, others, "", "racks"))) return null;
      const lanes = new Set(lanesOf(plan.items, done.id).map((one) => one.id));
      const [dx, dy] = [snap.x - box.x, snap.y - box.y];
      const moved = done.mode === "move";
      return {
        plan: {
          ...plan,
          items: [
            // змейка едет вместе с рядами; если ряды встали по-другому, ее кладет заново сервер
            ...others.map((one) => (lanes.has(one.id) && moved ? { ...one, x: one.x + dx, y: one.y + dy } : one)),
            ...next,
          ],
        },
        relay: !moved && lanes.size ? done.id : undefined,
      };
    }
    const item = plan.items.find((one) => one.id === done.id);
    if (!item || same(snap, item)) return null;
    // ворота целиком в наружной стене и не на соседних; остальное на полу и не на соседях
    const ok =
      item.kind === "dock"
        ? dockFits(cells, snap, doorSide(cells, item), otherDocks(item.id))
        : fits(snap, cells, plan.items, item.id, item.kind);
    if (!ok) return null;
    // передвинул зарядку сам: теперь это его место, программа его не трогает
    const patch = { ...snap, ...(item.kind === "charge" ? { auto: false } : {}) };
    return { plan: { ...plan, items: withZone(plan.items, item, patch) }, relay: relayOf(item, patch, plan.items) };
  };

  const up = (_point: BoardPoint, event: ReactPointerEvent<SVGSVGElement>) => {
    const done = drag;
    setDrag(null);
    setPreview(null);
    if (!done) return;
    if (done.mode === "box") {
      const rect = boxOf(done.from, done.to);
      // рамку не тянули, это щелчок по пустому месту: снимает выбор
      if (rect.w * view.s < 4 && rect.h * view.s < 4) {
        if (!done.add) props.onPick("");
        return;
      }
      const found = unitsIn(plan.items, rect);
      props.onPick(done.add ? joined(plan.items, picked, found) : pickedOf(found));
      return;
    }
    const next = after(done);
    if (!next) {
      if (done.mode === "paint" && done.on) props.onPick(done.on);
      // щелкнули по одному из выбранных и не сдвинули: выбран он один
      if (done.mode === "move" && done.tap && (!done.snap || same(done.snap, frame(manyItems)))) props.onPick(done.tap);
      return;
    }
    commit(next.plan, next.relay);
    if (next.picked) {
      props.onPick(next.picked);
      settle(next.picked);
    }
    if (done.mode === "paint" || done.mode === "docks") rest(event);
    // После новой вещи или растяжки можно сразу набрать размер цифрами. У ворот размер один,
    // у рядов числа стоят справа: там число рядов и проезд, а не ширина с длиной
    const armed = done.mode === "paint" ? next.picked : done.mode === "size" ? done.id : undefined;
    const kind = next.plan.items.find((one) => one.id === armed)?.kind;
    const polygon = next.plan.sections.some((one) => one.id === armed && outlineOf(one));
    const typable =
      kind !== "dock" && kind !== "charge" && kind !== "racks" && !rowsOf(next.plan.items, armed ?? "").length;
    if (armed && typable && !polygon && done.snap) {
      const rect = done.snap;
      const anchor =
        done.mode === "paint"
          ? `${done.from.y <= rect.y + rect.h / 2 ? "s" : "n"}${done.from.x <= rect.x + rect.w / 2 ? "w" : "e"}`
          : done.mode === "size"
            ? `${done.handle.includes("s") ? "n" : "s"}${done.handle.includes("w") ? "e" : "w"}`
            : "sw";
      setTyped({ id: armed, anchor, parts: [] });
    } else setTyped(null);
  };

  /* Набранный размер: первое число вдоль листа, второе поперек. Угол, от которого тянули,
     остается на месте. Вещь, которая так не встанет, остается прежней. */
  const applyTyped = (entry: { id: string; anchor: string; parts: string[] }) => {
    const target = findRect(plan, entry.id);
    if (!target) return;
    const read = (text: string | undefined, now: number) => {
      const value = Math.round(Number((text ?? "").replace(",", ".")));
      return Number.isFinite(value) && value >= 1 ? value : now;
    };
    const w = read(entry.parts[0], target.w);
    const h = read(entry.parts[1], target.h);
    const next = {
      x: entry.anchor.includes("w") ? target.x : target.x + target.w - w,
      y: entry.anchor.includes("s") ? target.y : target.y + target.h - h,
      w,
      h,
    };
    const item = plan.items.find((one) => one.id === entry.id);
    if (!item) setSection(entry.id, next);
    else if (fits(next, cells, plan.items, item.id, item.kind)) setItem(item.id, next);
  };

  // Цена правки до отпускания, как в строительных играх: объект постоял под мышью, и сервер
  // уже посчитал, каким станет маршрут. Считает сервер, здесь только разница двух его ответов.
  const onPreview = props.onPreview;
  const previewKey = drag?.snap
    ? `${"id" in drag ? drag.id : drag.mode}:${JSON.stringify(drag.snap)}`
    : drag?.mode === "docks"
      ? `docks:${JSON.stringify(drag.rects)}`
      : drag?.mode === "corner" && drag.live
        ? `corner:${JSON.stringify(drag.live)}`
        : "";
  const pending = useRef<Drag | null>(null);
  useEffect(() => {
    pending.current = drag;
  });
  useEffect(() => {
    if (!previewKey || !onPreview) return;
    let gone = false;
    const timer = window.setTimeout(() => {
      const done = pending.current;
      const next = done && after(done);
      if (!next) return;
      onPreview(withRoom({ ...next.plan, edited: true })).then((answer) => {
        if (!gone && answer) setPreview({ key: previewKey, measures: answer });
      });
    }, PREVIEW_MS);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
    // план в момент вопроса берем из pending: зависимость только от того, куда встанет объект
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, onPreview]);
  const priced = preview && preview.key === previewKey && measures ? price(preview.measures, measures) : "";
  // слой «далеко от ворот»: пока объект тянут, пол красится по плану, который еще не положили
  // Пока тянут ворота или буфер, слой включается сам: видно, что именно двигаешь
  const routeSource = preview && preview.key === previewKey ? preview.measures : measures;
  const dragged = drag ? dragKind(drag, plan) : "";
  const showRoute = colorBy === "route" || dragged === "dock" || dragged === "buffer";
  const routeMap = showRoute ? routeSource?.route_map : undefined;
  const route = useMemo(() => routePatches(routeMap, cells), [routeMap, cells]);
  const routeBands = Math.max(1, (routeMap?.bands_m.length ?? 1) - 1);

  // --- что можно сделать с выбранным ------------------------------------------------------

  // Свойства выбранного стоят в колонке справа сразу, поэтому пункта «Изменить» в панельке нет
  const itemActions = (item: PlanItem): MenuItem[] => {
    const found: MenuItem[] = [];
    if (item.kind === "racks") {
      if (item.group) found.push({ label: "Все ряды группы", onPick: () => props.onPick(item.group) });
      found.push(snakeAction(item.group || item.id));
    }
    if (item.kind === "flow") {
      found.push({ label: "Развернуть", hint: "R", onPick: () => turnLane(item, false) });
      found.push({ label: "Повернуть", hint: "Shift+R", onPick: () => turnLane(item, true) });
    }
    if (item.kind !== "dock" && item.kind !== "charge")
      found.push({ label: "Дублировать", hint: "Ctrl+D", onPick: () => duplicate(item) });
    if (item.kind === "charge" && !item.auto)
      found.push({ label: "Место программе", onPick: () => setItem(item.id, { auto: true }) });
    if (found.length) found.push("line");
    found.push({ label: "Удалить", hint: "Del", danger: true, onPick: () => remove(item.id) });
    return found;
  };

  const groupActions = (id: string): MenuItem[] => [
    { label: "Повернуть ряды", hint: "R", onPick: () => setGroup(id, { turn: true }) },
    snakeAction(id),
    { label: "Дублировать", hint: "Ctrl+D", onPick: () => duplicateGroup(id) },
    "line",
    { label: "Удалить ряды", hint: "Del", danger: true, onPick: () => remove(id) },
  ];

  const manyActions = (units: string[]): MenuItem[] => [
    { label: "Дублировать", hint: "Ctrl+D", onPick: () => duplicateMany(units) },
    "line",
    { label: "Удалить", hint: "Del", danger: true, onPick: () => removeMany(units) },
  ];

  // змейку кладет сервер; повторное нажатие разворачивает ее, а не кладет вторую
  const snakeAction = (id: string): MenuItem => ({
    label: lanesOf(plan.items, id).length ? "Змейка наоборот" : "Змейка по проездам",
    hint: "S",
    onPick: () => serpentine(id),
  });

  /* Змейка по проездам между рядами. Если она уже лежит, кладем ее в другую сторону: первая
     полоса смотрела туда, теперь обратно */
  const serpentine = (id: string) => {
    const lanes = lanesOf(plan.items, id);
    const first = lanes.find((one) => one.id === `${id}-flow-0`) ?? lanes[0];
    props.onSerpentine(id, first ? REVERSE[laneWay(first, first.direction)] : undefined);
  };
  const turnLane = (item: PlanItem, quarter: boolean) => {
    const way = laneWay(item, item.direction);
    setItem(item.id, { direction: quarter ? TURN[way] : REVERSE[way] });
  };

  const sectionActions = (section: PlanSection): MenuItem[] =>
    section.hole || floors.length > 1
      ? [{ label: "Удалить", hint: "Del", danger: true, onPick: () => remove(section.id) }]
      : outlineOf(section)
        ? [{ label: "Убрать контур", hint: "Del", danger: true, onPick: () => remove(section.id) }]
        : [];

  const context = (_point: BoardPoint, event: ReactMouseEvent<SVGSVGElement>) => {
    if (still) return;
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const { id, sid } = hit(event);
    const x = Math.min(event.clientX - box.left, box.width - 230);
    const y = Math.min(event.clientY - box.top, box.height - 250);
    const item = build ? undefined : plan.items.find((one) => one.id === id);
    const section = build ? plan.sections.find((one) => one.id === sid) : undefined;
    const undoRedo: MenuItem[] = [
      { label: "Отменить", hint: "Ctrl+Z", onPick: props.onUndo },
      { label: "Повторить", hint: "Ctrl+Shift+Z", onPick: props.onRedo },
    ];
    if (item && (many.includes(unitOf(item)) || many.includes(item.id))) {
      setMenu({ x, y, items: manyActions(many) });
    } else if (item?.group && picked !== item.id) {
      props.onPick(item.group);
      setMenu({ x, y, items: groupActions(item.group) });
    } else if (item) {
      props.onPick(item.id);
      setMenu({ x, y, items: itemActions(item) });
    } else if (section) {
      props.onPick(section.id);
      const found = sectionActions(section);
      setMenu({ x, y, items: found.length ? found : undoRedo });
    } else setMenu({ x, y, items: undoRedo });
  };

  // --- клавиатура ------------------------------------------------------------------------

  const key = (event: KeyLike) => {
    if (still) return;
    const ctrl = event.ctrlKey || event.metaKey;
    // Контур обводят по щелчкам: Enter замыкает, Backspace, Del и Ctrl+Z убирают последнюю точку.
    // Отмена здесь про точки, а не про план: иначе Ctrl+Z откатывал прошлую правку под контуром
    if (trace.length) {
      const back = event.key === "Backspace" || event.key === "Delete" || (ctrl && event.code === "KeyZ");
      if (event.key === "Enter" || back) {
        event.preventDefault();
        if (event.key === "Enter") closeTrace(trace);
        else setTrace(trace.slice(0, -1));
        return;
      }
    }
    if (ctrl && event.code === "KeyZ") {
      event.preventDefault();
      if (event.shiftKey) props.onRedo();
      else props.onUndo();
      return;
    }
    if (ctrl && event.code === "KeyY") {
      event.preventDefault();
      props.onRedo();
      return;
    }
    if (event.key === "Escape") {
      // Esc, которому нечего отменять, уходит дальше: на весь экран он сворачивает лист
      if (menu || drag || typed || picked || trace.length || tool !== props.tools[0]) event.preventDefault();
      setTyped(null);
      setMenu(null);
      setDrag(null);
      if (trace.length) setTrace([]);
      else if (tool !== props.tools[0]) props.onTool(props.tools[0]);
      else props.onPick("");
      return;
    }
    if (typed && typed.id === picked && !ctrl) {
      const parts = typed.parts.length ? typed.parts : [""];
      const last = parts.length - 1;
      if (/^[0-9]$/.test(event.key) || ((event.key === "," || event.key === ".") && !parts[last].includes("."))) {
        event.preventDefault();
        const char = event.key === "," ? "." : event.key;
        setTyped({ ...typed, parts: [...parts.slice(0, last), parts[last] + char] });
        return;
      }
      if (typed.parts.length && ["Tab", " ", "x", "х", "*"].includes(event.key)) {
        event.preventDefault();
        if (parts.length === 1 && parts[0]) setTyped({ ...typed, parts: [parts[0], ""] });
        return;
      }
      if (typed.parts.length && event.key === "Backspace") {
        event.preventDefault();
        const trimmed = parts[last].slice(0, -1);
        setTyped({
          ...typed,
          parts: trimmed || last === 0 ? [...parts.slice(0, last), trimmed] : parts.slice(0, last),
        });
        return;
      }
      if (typed.parts.length && event.key === "Enter") {
        event.preventDefault();
        applyTyped(typed);
        setTyped(null);
        return;
      }
    }
    if (event.key !== "Shift") setTyped(null);
    const digit = Number(event.key);
    if (!ctrl && digit >= 1 && digit <= props.tools.length) {
      props.onTool(props.tools[digit - 1]);
      return;
    }
    const target = findRect(plan, picked);
    if (!target) return;
    const item = plan.items.find((one) => one.id === picked);
    const rows = group(picked);
    if (many.length) {
      // несколько выбранных: удалить, дублировать и сдвинуть стрелками вместе, одной правкой
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeMany(many);
      } else if (ctrl && event.code === "KeyD") {
        event.preventDefault();
        duplicateMany(many);
      } else if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const stepM = event.shiftKey ? 5 : 1;
        const dx = event.key === "ArrowLeft" ? -stepM : event.key === "ArrowRight" ? stepM : 0;
        const dy = event.key === "ArrowDown" ? -stepM : event.key === "ArrowUp" ? stepM : 0;
        const found = after({
          mode: "move",
          id: picked,
          off: { x: 0, y: 0 },
          snap: { ...rectOf(target), x: target.x + dx, y: target.y + dy },
          guides: [],
        });
        if (found) commit(found.plan);
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const section = build && vertex?.sid === picked ? plan.sections.find((one) => one.id === picked) : undefined;
      if (section && vertex && outlineOf(section)) dropCorner(section, vertex.index);
      else remove(picked);
    } else if (ctrl && event.code === "KeyD" && (item || rows.length)) {
      event.preventDefault();
      if (rows.length) duplicateGroup(picked);
      else if (item && item.kind !== "dock" && item.kind !== "charge") duplicate(item);
    } else if (event.code === "KeyR" && rows.length) {
      setGroup(picked, { turn: true });
    } else if (event.code === "KeyR" && item?.kind === "flow") {
      turnLane(item, event.shiftKey);
    } else if (event.code === "KeyS" && (rows.length || item?.kind === "racks")) {
      serpentine(rows.length ? picked : item?.group || picked);
    } else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const stepM = event.shiftKey ? 5 : 1;
      const dx = event.key === "ArrowLeft" ? -stepM : event.key === "ArrowRight" ? stepM : 0;
      const dy = event.key === "ArrowDown" ? -stepM : event.key === "ArrowUp" ? stepM : 0;
      const next = { x: target.x + dx, y: target.y + dy, w: target.w, h: target.h };
      if (rows.length) {
        const found = after({ mode: "move", id: picked, off: { x: 0, y: 0 }, snap: next, guides: [] });
        if (found) commit(found.plan);
      } else if (!item) {
        const section = plan.sections.find((one) => one.id === picked);
        const points = (section?.points ?? []).map(([x, y]) => [x + dx, y + dy] as [number, number]);
        setSection(picked, { ...next, points });
      } else if (item.kind === "dock") {
        const center = { x: item.x + item.w / 2 + dx, y: item.y + item.h / 2 + dy };
        const spot = snapDock(runs, center, Math.max(item.w, item.h), otherDocks(item.id));
        if (spot) setItem(item.id, spot.rect);
      } else if (fits(next, cells, plan.items, item.id, item.kind))
        setItem(item.id, { ...next, ...(item.kind === "charge" ? { auto: false } : {}) });
    }
  };

  // Клавиши работают на всем шаге, а не только когда лист в фокусе: нажал кнопку инструмента
  // слева, и цифры с буквами уже не доходили до листа. Поля ввода и окно свойств не трогаем
  const keyNow = useRef(key);
  useEffect(() => {
    keyNow.current = key;
  });
  useEffect(() => {
    if (still) return;
    const listen = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || !target || wrap.current?.contains(target)) return;
      if (target.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return;
      keyNow.current(event);
    };
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, [still]);

  // --- картинка --------------------------------------------------------------------------

  const lost = useMemo(
    () => (measures?.unreachable ?? []).map(([col, row]) => `M${col} ${L - row - 1}h1v1h-1z`).join(""),
    [measures, L],
  );
  const pickedItem = build ? undefined : plan.items.find((one) => one.id === picked);
  // несколько выбранных: общая рамка. Пока их тянут, те же вещи едут за ней
  const manyBox = manyItems.length ? frame(manyItems) : undefined;
  const dragUnits = drag?.mode === "move" ? manyOf(drag.id) : [];
  const dragMembers = dragUnits.length ? membersOf(plan.items, dragUnits) : [];
  const dragMany = {
    ids: new Set(dragMembers.map((one) => one.id)),
    box: dragMembers.length ? frame(dragMembers) : undefined,
  };
  const pickedRows = build ? [] : group(picked);
  const pickedBox = pickedRows.length ? frame(pickedRows) : undefined;
  // «18 рядов по 76 м»: куски одного ряда между поперечными проездами это один ряд
  const groupText = (rows: PlanItem[]) => {
    const layout = layoutOf(rows, rowDefault);
    return rowsText(layout.count, layout.length);
  };
  const pickedSection = build ? plan.sections.find((one) => one.id === picked) : undefined;
  const underFloor = hover ? floorAt(cells, Math.floor(hover.x), Math.floor(hover.y)) : null;
  const status = props.status ? (
    props.status
  ) : hover ? (
    <>
      <span>
        x {Math.floor(hover.x)} · y {Math.floor(hover.y)} м
      </span>
      <span>{underFloor === null ? "вне здания" : `пол ${signed(underFloor)} м`}</span>
      <span>сетка {step(view.s)} м</span>
    </>
  ) : (
    <span>
      {still
        ? "чертеж здесь только смотрят: править удобнее на компьютере"
        : "колесо: масштаб · пробел с мышью: сдвиг листа"}
    </span>
  );

  // ворота встают по щелчку, поэтому место под курсором показываем заранее, как постройку в игре
  const dockGhost = tool === "dock" && hover && !drag && !build ? snapDock(runs, hover, dockLen, docks) : null;
  // следующая точка контура под курсором: куда встанет угол, если щелкнуть
  const traceNext = tool === "outline" && build && hover && !still ? nextPoint(hover, false) : null;

  // панелька действий висит над выбранным, пока его не тянут
  const chosenActions = manyBox
    ? manyActions(many)
    : pickedItem
      ? itemActions(pickedItem)
      : pickedBox
        ? groupActions(picked)
        : pickedSection
          ? sectionActions(pickedSection)
          : null;
  const chosen = manyBox ?? pickedItem ?? pickedBox ?? pickedSection;
  const barAt = chosen && chosenActions?.length && !drag && !still ? toPixels(chosen) : null;
  const lanesAt = (id: string) => lanesOf(plan.items, id).length;
  const dropLanes = (id: string) => {
    const lanes = new Set(lanesOf(plan.items, id).map((one) => one.id));
    commit({ ...plan, items: plan.items.filter((one) => !lanes.has(one.id)) });
  };
  // Свойства выбранного встают в колонку справа сразу, без двойного щелчка. Крестик снимает выбор
  const unpick = () => props.onPick("");
  const panel =
    !props.side || still ? null : manyBox ? (
      <ManyWindow
        key={picked}
        count={countOf(plan.items, many)}
        problem={refused}
        onDuplicate={() => duplicateMany(many)}
        onRemove={() => removeMany(many)}
        onClose={unpick}
      />
    ) : pickedBox ? (
      <GroupWindow
        key={picked}
        rows={pickedRows}
        layout={layoutOf(pickedRows, rowDefault)}
        rackTypes={props.rackTypes}
        problem={refused}
        onLayout={(change) => setGroup(picked, change)}
        onChange={(patch) =>
          "row_m" in patch || "block_rows" in patch
            ? setGroup(picked, {}, patch)
            : commit({ ...plan, items: plan.items.map((one) => (one.group === picked ? { ...one, ...patch } : one)) })
        }
        onClose={unpick}
        lanes={lanesAt(picked)}
        onSerpentine={() => serpentine(picked)}
        onDropLanes={() => dropLanes(picked)}
      />
    ) : pickedItem?.kind === "racks" ? (
      <RowWindow
        key={picked}
        row={pickedItem}
        length={lengthOf(pickedItem)}
        rackTypes={props.rackTypes}
        problem={refused}
        onLength={(length) => setRow(pickedItem, { length })}
        onChange={(patch) =>
          "row_m" in patch || "block_rows" in patch ? setRow(pickedItem, {}, patch) : setItem(pickedItem.id, patch)
        }
        onGroup={pickedItem.group ? () => props.onPick(pickedItem.group) : undefined}
        onRemove={() => remove(pickedItem.id)}
        onClose={unpick}
        lanes={lanesAt(pickedItem.group || pickedItem.id)}
        onSerpentine={() => serpentine(pickedItem.group || pickedItem.id)}
        onDropLanes={() => dropLanes(pickedItem.group || pickedItem.id)}
      />
    ) : pickedItem ? (
      <ItemWindow
        key={picked}
        item={pickedItem}
        rackTypes={props.rackTypes}
        onChange={(patch) => setItem(pickedItem.id, patch)}
        onClose={unpick}
      />
    ) : pickedSection ? (
      <SectionWindow
        key={picked}
        section={pickedSection}
        problem={refused}
        onChange={(patch) => setSection(pickedSection.id, patch)}
        onClose={unpick}
        onOutline={outlineOf(pickedSection) ? undefined : () => props.onTool("outline")}
        onPlain={() => remove(pickedSection.id)}
      />
    ) : null;

  return (
    <div ref={wrap} className="u-editor">
      <Board
        widthM={plan.width_m}
        lengthM={plan.length_m}
        fit={onScreen(building)}
        fitKey={props.fitKey}
        onView={onView}
        onDown={down}
        onMove={move}
        onUp={up}
        onContext={context}
        onKey={key}
        onLeave={() => setHover(null)}
        cursor={watch ? "grab" : tool === "select" || tool === "hall" ? "default" : "crosshair"}
        label={`План склада ${meters(building.w)} на ${meters(building.h)} метров`}
        status={status}
        hint={
          !still &&
          (typed && typed.id === picked && !drag ? (
            <Hint sticky>
              <b>Размер цифрами.</b> Наберите длину, Tab, ширину и Enter, например 24 Tab 30. Esc отменит
            </Hint>
          ) : trace.length ? (
            <Hint sticky>
              <b>Контур, точек {trace.length}.</b> Щелчок в первую точку или Enter замыкает, Del или Ctrl+Z убирает
              последнюю, Esc отменяет весь контур
            </Hint>
          ) : manyBox && !drag ? (
            <Hint>
              <b>{manyText(countOf(plan.items, many))}.</b> Тяните любой, и поедут все. Shift+щелчок добавляет или
              убирает, Ctrl+D дублирует, Del удаляет, Ctrl+Z отменит все сразу
            </Hint>
          ) : (pickedItem || pickedBox || pickedSection) && !drag ? (
            <Hint>
              {pickedItem
                ? pickedHint(pickedItem.kind, pickedItem.kind === "racks" ? "Ряд" : nameOf(pickedItem))
                : pickedBox
                  ? pickedHint("rows", groupText(pickedRows))
                  : pickedHint(pickedSection?.hole ? "hole" : "section", pickedSection?.hole ? "Вырез" : "Здание")}
            </Hint>
          ) : props.next && (tool === "select" || tool === "hall") && !drag ? (
            <Hint sticky>{props.next}</Hint>
          ) : (
            <Hint>{HINTS[tool]}</Hint>
          ))
        }
        // в прогоне смены лист двигают и приближают, как в редакторе; на телефоне только смотрят
        still={props.still}
        corner={props.corner}
        overlay={
          <>
            {props.layer?.(view, area)}
            {props.hud}
            {barAt && chosenActions && (
              <Actions
                x={Math.min(Math.max(barAt.x + barAt.w / 2, 150), area.w - 150)}
                y={Math.max(96, barAt.y - 14)}
                items={chosenActions}
              />
            )}
            {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
            {panel && props.side && createPortal(panel, props.side)}
          </>
        }
      >
        {(now) => {
          const s = now.s;
          const size = 12 / s;
          const live = (id: string): Rect | undefined => {
            if (!drag || !("id" in drag) || drag.mode === "corner" || !("live" in drag) || !drag.live) return undefined;
            if (drag.id === id) return drag.live;
            // несколько выбранных едут за общей рамкой
            if (dragMany.box && drag.mode === "move") {
              const one = dragMany.ids.has(id) ? plan.items.find((item) => item.id === id) : undefined;
              return (
                one && { ...one, x: one.x + drag.live.x - dragMany.box.x, y: one.y + drag.live.y - dragMany.box.y }
              );
            }
            // группу рядов тянут целиком: каждый ряд едет за рамкой группы
            const one = drag.mode === "move" ? plan.items.find((item) => item.id === id) : undefined;
            if (!one?.group || one.group !== drag.id) return undefined;
            const box = frame(group(one.group));
            return { ...one, x: one.x + drag.live.x - box.x, y: one.y + drag.live.y - box.y };
          };
          return (
            <>
              <defs>
                {/* штриховка закрытой зоны: шаг в точках экрана, чтобы не сливалась издалека */}
                <pattern
                  id="u-nogo-hatch"
                  patternUnits="userSpaceOnUse"
                  width={8 / s}
                  height={8 / s}
                  patternTransform="rotate(45)"
                >
                  <rect width={8 / s} height={8 / s} fill="color-mix(in srgb, var(--stop) 5%, transparent)" />
                  <line
                    x1={0}
                    y1={0}
                    x2={0}
                    y2={8 / s}
                    stroke="var(--stop)"
                    strokeOpacity={0.4}
                    strokeWidth={1.2 / s}
                  />
                </pattern>
              </defs>
              {floor.map((patch) => (
                <rect
                  key={`${patch.x}:${patch.y}:${patch.level}`}
                  {...box(onScreen(patch))}
                  fill={
                    colorBy === "level"
                      ? floorTone(heights, heights[patch.level] ?? 0)
                      : colorBy === "route"
                        ? "var(--paper)"
                        : "var(--lvl-0)"
                  }
                  pointerEvents="none"
                />
              ))}
              {underlay && (
                <image
                  key={underlay.src.slice(-24)}
                  className="u-underlay"
                  href={underlay.src}
                  x={underlay.x}
                  y={L - underlay.y - underlay.h}
                  width={underlay.w}
                  height={underlay.h}
                  preserveAspectRatio="none"
                  opacity={underlay.opacity}
                  pointerEvents="none"
                />
              )}
              {route.length > 0 && (
                <g className="u-route-layer">
                  {route.map((patch) => (
                    <rect
                      key={`r${patch.x}:${patch.y}:${patch.level}`}
                      {...box(onScreen(patch))}
                      className={patch.level === LOST ? "u-route is-lost" : "u-route"}
                      fillOpacity={patch.level === LOST ? undefined : routeAlpha(patch.level, routeBands)}
                    />
                  ))}
                </g>
              )}
              <path
                d={path(segments, "step", L)}
                className="u-step"
                strokeWidth={2 / s}
                strokeDasharray={`${5 / s} ${3 / s}`}
              />

              {build &&
                plan.sections.map((section) =>
                  outlineOf(section) || (drag?.mode === "corner" && drag.id === section.id && drag.live) ? (
                    <polygon
                      key={section.id}
                      data-sid={section.id}
                      points={flip(
                        drag?.mode === "corner" && drag.id === section.id && drag.live
                          ? drag.live
                          : moved(section, live(section.id)),
                        L,
                      )}
                      className="u-section"
                    />
                  ) : (
                    <rect
                      key={section.id}
                      data-sid={section.id}
                      {...box(onScreen(live(section.id) ?? section))}
                      className={section.hole ? "u-section is-hole" : "u-section"}
                    />
                  ),
                )}

              <g className={build ? "u-muted" : undefined}>
                {[...plan.items]
                  .filter((one) => one.kind !== "dock")
                  .sort((a, b) => DRAW_ORDER.indexOf(a.kind) - DRAW_ORDER.indexOf(b.kind))
                  .map((one) => {
                    const moving = build ? undefined : live(one.id);
                    const rect = onScreen(moving ?? one);
                    return (
                      <Thing key={one.id} rect={rect} held={Boolean(moving)} fresh={fresh === one.id}>
                        {shape(one, rect, s, colorBy, rowDefault, cross)}
                      </Thing>
                    );
                  })}
              </g>

              <path d={path(segments, "wall", L)} className="u-wall" strokeWidth={3 / s} />

              {!build && lost && <path d={lost} className="u-lost" />}

              <g className={build ? "u-muted" : undefined}>
                {docks.map((one) => {
                  const moving = build ? undefined : live(one.id);
                  const rect = onScreen(moving ?? one);
                  return (
                    <Thing key={one.id} rect={rect} held={Boolean(moving)} fresh={fresh === one.id}>
                      {door(one, rect, s, doorSide(cells, one))}
                    </Thing>
                  );
                })}
              </g>

              {drag?.snap &&
                ghost(
                  drag,
                  onScreen(drag.snap),
                  s,
                  size,
                  plan,
                  cells,
                  build,
                  priced,
                  drag.mode === "paint" && (drag.tool === "row" || drag.tool === "racks")
                    ? paintedText(bornRows(drag.tool, drag.from, drag.to ?? drag.from, drag.snap))
                    : drag.mode === "move" && pickedRows.length && drag.id === picked
                      ? groupText(pickedRows)
                      : dragMany.box
                        ? manyText(countOf(plan.items, dragUnits))
                        : "",
                  dragMany.box ? Boolean(after(drag)) : undefined,
                )}
              {drag?.mode === "paint" &&
                drag.snap &&
                (drag.tool === "row" || drag.tool === "racks") &&
                bornRows(drag.tool, drag.from, drag.to ?? drag.from, drag.snap).map((one) => (
                  <rect key={one.id} {...box(onScreen(one))} className="u-ghost-row" />
                ))}
              {drag?.mode === "docks" && (
                <>
                  {drag.rects.map((rect, index) => (
                    <rect
                      key={index}
                      {...box(onScreen(rect))}
                      className="u-ghost"
                      strokeWidth={2 / s}
                      strokeDasharray={`${4 / s} ${3 / s}`}
                    />
                  ))}
                  <text
                    x={onScreen(drag.first).x + drag.first.w / 2}
                    y={onScreen(drag.first).y - 8 / s}
                    fontSize={size}
                    className="u-size"
                    textAnchor="middle"
                  >
                    {`${drag.rects.length} ${plural(drag.rects.length, "ворота", "ворот", "ворот")}`}
                    {priced ? ` · ${priced}` : ""}
                  </text>
                </>
              )}
              {drag?.snap &&
                !build &&
                drag.mode !== "dock" &&
                !dragMany.box &&
                gaps(drag.snap, cells, plan.items, "id" in drag ? drag.id : "", dragKind(drag, plan)).map((gap) => (
                  <Dim
                    key={gap.side}
                    x1={gap.from.x}
                    y1={L - gap.from.y}
                    x2={gap.to.x}
                    y2={L - gap.to.y}
                    text={`${meters(gap.length)} м`}
                    size={size * 0.9}
                  />
                ))}
              {drag &&
                "guides" in drag &&
                drag.guides.map((guide, index) =>
                  guide.photo ? (
                    // линия с картинки: подсвечен кусок вдоль края, к которому он прилип
                    <line
                      key={index}
                      className="u-guide is-photo"
                      {...(guide.axis === "x"
                        ? { x1: guide.at, x2: guide.at, y1: L - (guide.from ?? 0), y2: L - (guide.to ?? L) }
                        : { x1: guide.from ?? 0, x2: guide.to ?? plan.width_m, y1: L - guide.at, y2: L - guide.at })}
                    />
                  ) : (
                    <line
                      key={index}
                      className="u-guide"
                      {...(guide.axis === "x"
                        ? { x1: guide.at, x2: guide.at, y1: 0, y2: L }
                        : { x1: 0, x2: plan.width_m, y1: L - guide.at, y2: L - guide.at })}
                    />
                  ),
                )}

              {manyBox && !drag && (
                <>
                  {many.map((unit) => {
                    const rect = findRect(plan, unit);
                    return (
                      rect && (
                        <rect
                          key={unit}
                          {...box(onScreen(rect))}
                          className="u-picked"
                          strokeWidth={2 / s}
                          pointerEvents="none"
                        />
                      )
                    );
                  })}
                  <rect
                    {...box(onScreen(manyBox))}
                    className="u-picked is-many"
                    strokeWidth={1.5 / s}
                    strokeDasharray={`${5 / s} ${4 / s}`}
                    pointerEvents="none"
                  />
                  <text
                    x={manyBox.x + manyBox.w / 2}
                    y={L - manyBox.y + 18 / s}
                    fontSize={size}
                    className="u-size"
                    textAnchor="middle"
                  >
                    {manyText(countOf(plan.items, many))}
                  </text>
                </>
              )}
              {drag?.mode === "box" && (
                <rect
                  {...box(onScreen(boxOf(drag.from, drag.to)))}
                  className="u-marquee"
                  strokeWidth={1.5 / s}
                  pointerEvents="none"
                />
              )}
              {pickedItem &&
                !drag &&
                selection(
                  pickedItem.id,
                  pickedItem.kind,
                  onScreen(pickedItem),
                  s,
                  size,
                  pickedItem.kind === "racks" ? "Ряд" : nameOf(pickedItem),
                  "",
                  typing(typed, pickedItem.id),
                )}
              {pickedBox && !drag && selection(picked, "rows", onScreen(pickedBox), s, size, groupText(pickedRows), "")}
              {pickedSection &&
                !drag &&
                pickedSection.hole &&
                selection(
                  pickedSection.id,
                  "section",
                  onScreen(pickedSection),
                  s,
                  size,
                  "Вырез",
                  "",
                  typing(typed, pickedSection.id),
                )}
              {pickedSection &&
                !pickedSection.hole &&
                (!drag || drag.mode === "corner") &&
                corners(
                  pickedSection.id,
                  drag?.mode === "corner" && drag.live ? drag.live : cornersOf(pickedSection),
                  L,
                  s,
                  size,
                  vertex?.sid === pickedSection.id ? vertex.index : -1,
                )}
              {trace.length > 0 && tracing(trace, traceNext, L, s, size, hover ? closes(hover) : false)}
              {!trace.length && traceNext && (
                <circle cx={traceNext.x} cy={L - traceNext.y} r={4 / s} className="u-trace-dot" />
              )}

              {dockGhost && (
                <rect
                  {...box(onScreen(dockGhost.rect))}
                  className="u-ghost"
                  strokeWidth={2 / s}
                  strokeDasharray={`${4 / s} ${3 / s}`}
                />
              )}
              {hover && !drag && !watch && s >= 9 && underFloor !== null && (
                <rect x={Math.floor(hover.x)} y={L - Math.floor(hover.y) - 1} width={1} height={1} className="u-cell" />
              )}

              {building.w > 0 && (
                <>
                  <Dim
                    x1={building.x}
                    y1={L - building.y + 22 / s}
                    x2={building.x + building.w}
                    y2={L - building.y + 22 / s}
                    text={`${meters(building.w)} м`}
                    size={size}
                  />
                  <Dim
                    x1={building.x - 22 / s}
                    y1={L - building.y - building.h}
                    x2={building.x - 22 / s}
                    y2={L - building.y}
                    text={`${meters(building.h)} м`}
                    size={size}
                  />
                </>
              )}
            </>
          );
        }}
      </Board>
    </div>
  );
}

function rectOf(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function same(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/* Рамка по двум углам, как ее тянут: в любую сторону */
function boxOf(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/* Прямоугольник вещи, секции или группы рядов: у группы это рамка вокруг всех ее рядов, у
   нескольких выбранных рамка вокруг всего выбранного */
function findRect(plan: Plan, id: string): (Rect & { id: string }) | undefined {
  const found = plan.items.find((one) => one.id === id) ?? plan.sections.find((one) => one.id === id);
  if (found) return found;
  const members = membersOf(plan.items, manyOf(id));
  if (members.length) return { ...frame(members), id };
  const rows = rowsOf(plan.items, id);
  return rows.length ? { ...frame(rows), id } : undefined;
}

/* Подпись рядов, которые встанут по протяжке: «7 рядов по 40 м» */
function paintedText(rows: PlanItem[]): string {
  return rows.length ? rowsText(rows.length, lengthOf(rows[0])) : "";
}

/* Точки контура для SVG: экран рисует от верхнего края, движок считает от нижнего */
function flip(points: [number, number][], L: number): string {
  return points.map(([x, y]) => `${x},${L - y}`).join(" ");
}

/* Контур секции, которую сейчас тянут целиком: точки сдвинуты вместе с рамкой */
function moved(section: PlanSection, live: Rect | undefined): [number, number][] {
  const points = cornersOf(section);
  if (!live) return points;
  const [dx, dy] = [live.x - section.x, live.y - section.y];
  return points.map(([x, y]) => [x + dx, y + dy]);
}

/* Угол контура тянут: соседние стороны остаются вдоль и поперек листа, так углы остаются прямыми.
   Сторону тянут поперек: оба ее конца едут вместе. С Shift угол едет один, как есть. */
function dragCorner(
  points: [number, number][],
  index: number,
  edge: boolean,
  at: Point,
  free: boolean,
): [number, number][] {
  const next = points.map((one) => [...one] as [number, number]);
  const n = next.length;
  const before = (index - 1 + n) % n;
  const after = (index + 1) % n;
  if (edge) {
    const [a, b] = [points[index], points[after]];
    if (a[1] === b[1]) next[index][1] = next[after][1] = at.y;
    else if (a[0] === b[0]) next[index][0] = next[after][0] = at.x;
    return next;
  }
  const was = points[index];
  next[index] = [at.x, at.y];
  if (free) return next;
  for (const other of [before, after]) {
    const one = points[other];
    if (one[0] === was[0]) next[other][0] = at.x;
    else if (one[1] === was[1]) next[other][1] = at.y;
  }
  return next;
}

/* Контур выбранного здания: точки на углах, за них тянут; на серединах прямых стен ручки, за
   них стену двигают целиком. Длина каждой стены подписана. */
function corners(id: string, points: [number, number][], L: number, s: number, size: number, on: number) {
  const n = points.length;
  return (
    <>
      <polygon points={flip(points, L)} className="u-picked" strokeWidth={2.5 / s} pointerEvents="none" />
      {points.map(([x1, y1], index) => {
        const [x2, y2] = points[(index + 1) % n];
        const length = Math.hypot(x2 - x1, y2 - y1);
        const straight = x1 === x2 || y1 === y2;
        const [mx, my] = [(x1 + x2) / 2, L - (y1 + y2) / 2];
        const side = 13 / s;
        return (
          <g key={`e${index}`}>
            {length * s > 60 && (
              <text x={mx} y={my - 8 / s} fontSize={size * 0.9} className="u-size" textAnchor="middle">
                {meters(length)} м
              </text>
            )}
            {straight && length * s > 40 && (
              <rect
                data-sid={id}
                data-e={index}
                x={mx - (x1 === x2 ? side / 4 : side / 2)}
                y={my - (x1 === x2 ? side / 2 : side / 4)}
                width={x1 === x2 ? side / 2 : side}
                height={x1 === x2 ? side : side / 2}
                rx={2 / s}
                className="u-handle"
                strokeWidth={1.5 / s}
                style={{ cursor: x1 === x2 ? "ew-resize" : "ns-resize" }}
              />
            )}
          </g>
        );
      })}
      {points.map(([x, y], index) => (
        <circle
          key={`v${index}`}
          data-sid={id}
          data-v={index}
          cx={x}
          cy={L - y}
          r={(index === on ? 7 : 6) / s}
          className={index === on ? "u-handle is-on" : "u-handle"}
          strokeWidth={1.5 / s}
          style={{ cursor: "move" }}
        />
      ))}
    </>
  );
}

/* Контур, который обводят сейчас: поставленные точки, линия до курсора и ее длина */
function tracing(trace: Point[], next: Point | null, L: number, s: number, size: number, closing: boolean) {
  const line = [...trace, ...(next && !closing ? [next] : []), ...(closing ? [trace[0]] : [])];
  const last = trace[trace.length - 1];
  const length = next && !closing ? Math.hypot(next.x - last.x, next.y - last.y) : 0;
  return (
    <g pointerEvents="none">
      <polyline points={line.map((one) => `${one.x},${L - one.y}`).join(" ")} className="u-trace" strokeWidth={2 / s} />
      {trace.map((one, index) => (
        <circle
          key={index}
          cx={one.x}
          cy={L - one.y}
          r={(index === 0 && closing ? 8 : 4) / s}
          className={index === 0 ? "u-trace-dot is-first" : "u-trace-dot"}
          strokeWidth={1.5 / s}
        />
      ))}
      {next && length > 0 && (
        <text
          x={(last.x + next.x) / 2}
          y={L - (last.y + next.y) / 2 - 8 / s}
          fontSize={size}
          className="u-size"
          textAnchor="middle"
        >
          {meters(length)} м
        </text>
      )}
    </g>
  );
}

/* Вещь на листе. Лежит в сдвиге, а не в координатах: так отпущенный объект доезжает до клетки
   плавно, а не прыгает. Пока объект держат, плавность выключена, иначе он отстает от мыши. */
function Thing({ rect, held, fresh, children }: { rect: Rect; held: boolean; fresh?: boolean; children: ReactNode }) {
  return (
    <g className={held ? "u-thing is-held" : "u-thing"} style={{ transform: `translate(${rect.x}px, ${rect.y}px)` }}>
      {/* только что поставленный объект чуть пружинит: видно, что он встал */}
      <g className={fresh ? "u-pop" : undefined}>{children}</g>
    </g>
  );
}

/* Ворота окрашены по назначению: приемка, отгрузка или и то и другое. Цвета в tokens.css */
const ROLE_CLASS: Record<string, string> = { receiving: "in", shipping: "out", both: "both" };

/* Ворота рисуем проемом поперек стены, толщиной в точках экрана: иначе издалека метровая
   створка пряталась под линией стены. Поле нажатия шире, чем видно. */
function door(item: PlanItem, rect: Rect, s: number, side: string) {
  const wide = rect.w >= rect.h;
  const thick = Math.max(1.4, 9 / s);
  const gap = Math.min(0.4, (wide ? rect.w : rect.h) * 0.1);
  const pad = Math.max(0, (18 / s - 1) / 2);
  const jamb = Math.max(0.3, 3 / s);
  const opening = wide
    ? { x: gap, y: (side === "s" ? rect.h : 0) - thick / 2, w: rect.w - gap * 2, h: thick }
    : { x: (side === "w" ? 0 : rect.w) - thick / 2, y: gap, w: thick, h: rect.h - gap * 2 };
  return (
    <>
      <rect {...box(opening)} className={`u-dock is-${ROLE_CLASS[item.role] ?? "both"}`} strokeWidth={1.5} />
      <rect
        {...(wide
          ? { x: gap, y: opening.y, width: jamb, height: thick }
          : { x: opening.x, y: gap, width: thick, height: jamb })}
        className="u-dock-mark"
      />
      <rect
        {...(wide
          ? { x: rect.w - gap - jamb, y: opening.y, width: jamb, height: thick }
          : { x: opening.x, y: rect.h - gap - jamb, width: thick, height: jamb })}
        className="u-dock-mark"
      />
      <rect
        data-id={item.id}
        x={wide ? 0 : -pad}
        y={wide ? -pad : 0}
        width={wide ? rect.w : rect.w + pad * 2}
        height={wide ? rect.h + pad * 2 : rect.h}
        fill="transparent"
        style={{ cursor: "move" }}
      />
    </>
  );
}

function shape(item: PlanItem, rect: Rect, s: number, colorBy: ColorBy, row: number, cross: number) {
  const label = (text: string) =>
    rect.w * s > 70 && rect.h * s > 22 ? (
      <text
        x={rect.w / 2}
        y={rect.h / 2}
        fontSize={12 / s}
        className="u-tag"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {text}
      </text>
    ) : null;
  const base = { "data-id": item.id, width: rect.w, height: rect.h };
  switch (item.kind) {
    case "racks": {
      const local = { ...item, x: 0, y: 0, w: rect.w, h: rect.h };
      return (
        <>
          <rect {...base} className="u-racks" fill={colorBy === "racks" ? heightTone(item.rack_top_m) : undefined} />
          <RackCells item={local} row={row} cross={cross} height={rect.h} gap={cellGap(s)} />
        </>
      );
    }
    case "flow":
      return (
        <>
          <rect {...base} className="u-flow" />
          <path d={chevrons(rect, laneWay(rect, item.direction), s)} className="u-flow-marks" strokeWidth={1.6 / s} />
        </>
      );
    case "aisle":
      return (
        <>
          <rect {...base} className="u-aisle" strokeDasharray={`${4 / s} ${3 / s}`} />
          {label("проезд")}
        </>
      );
    case "buffer":
      return (
        <>
          <rect {...base} className="u-buffer" strokeDasharray={`${6 / s} ${4 / s}`} />
          {label("буфер у ворот")}
        </>
      );
    case "charge":
      return (
        <>
          <rect {...base} className="u-charge" strokeDasharray={`${4 / s} ${3 / s}`} />
          {label(item.auto ? "зарядка · ставит программа" : "зарядка")}
        </>
      );
    case "station":
      return (
        <>
          <rect {...base} className="u-station" />
          {label("станция")}
        </>
      );
    case "ramp": {
      const along = rect.h >= rect.w;
      const length = along ? rect.h : rect.w;
      const count = Math.max(1, Math.floor(length / 2));
      const marks = Array.from({ length: count }, (_, index) => {
        const t = (index + 0.5) * (length / count);
        return along
          ? `M${rect.w * 0.2} ${t + 0.5}L${rect.w / 2} ${t - 0.5}L${rect.w * 0.8} ${t + 0.5}`
          : `M${t - 0.5} ${rect.h * 0.2}L${t + 0.5} ${rect.h / 2}L${t - 0.5} ${rect.h * 0.8}`;
      });
      return (
        <>
          <rect {...base} className="u-ramp" />
          <path d={marks.join("")} className="u-ramp-marks" strokeWidth={1.5 / s} pointerEvents="none" />
          {label("пандус")}
        </>
      );
    }
    default:
      // закрытая зона это место на полу без стен: штриховка и пунктир, а не сплошная стена
      return item.role === "zone" ? (
        <>
          <rect {...base} className="u-nogo" strokeDasharray={`${5 / s} ${3 / s}`} />
          {label("закрытая зона")}
        </>
      ) : (
        <>
          <rect {...base} className="u-blocked" />
          {label("перегородка")}
        </>
      );
  }
}

function ghost(
  drag: Drag,
  rect: Rect,
  s: number,
  size: number,
  plan: Plan,
  cells: Cells,
  build: boolean,
  priced: string,
  label = "",
  /* встанет ли, если это уже решили снаружи: несколько выбранных проверяет редактор */
  verdict?: boolean,
) {
  const self = "id" in drag ? drag.id : "";
  const item = plan.items.find((one) => one.id === self);
  const kind = dragKind(drag, plan);
  const world = { x: rect.x, y: plan.length_m - rect.y - rect.h, w: rect.w, h: rect.h };
  const least = drag.mode === "paint" ? (LEAST[drag.tool] ?? 1) : 1;
  const big = world.w >= least && world.h >= least;
  const others = plan.items.filter((one) => one.kind === "dock" && one.id !== self);
  let ok = big;
  if (verdict !== undefined) ok = verdict;
  else if (!build)
    ok =
      item?.kind === "dock"
        ? dockFits(cells, world, doorSide(cells, item), others)
        : big && fits(world, cells, plan.items, self, kind);
  const erase = drag.mode === "paint" && drag.tool === "hole";
  const parts = label ? [label] : [`${meters(rect.w)} × ${meters(rect.h)} м`];
  if (!ok) parts.push("не помещается");
  else if (priced) parts.push(priced);
  return (
    <>
      <rect
        {...box(rect)}
        className={erase ? "u-paint is-erase" : ok ? "u-ghost" : "u-ghost is-bad"}
        strokeWidth={2 / s}
        strokeDasharray={`${6 / s} ${4 / s}`}
      />
      {/* подпись внутри у верхнего края: сверху она ложилась на соседей и на стену */}
      <text
        x={rect.x + rect.w / 2}
        y={rect.h * s >= 40 ? rect.y + size + 6 / s : rect.y - 8 / s}
        fontSize={size}
        className={ok ? "u-size" : "u-size is-bad"}
        textAnchor="middle"
      >
        {drag.mode === "dock" ? priced || null : parts.join(" · ")}
      </text>
    </>
  );
}

/* Что тянут: вещь, секцию или новый прямоугольник инструментом */
function dragKind(drag: Drag, plan: Plan): string {
  if (drag.mode === "paint") return kindOf(drag.tool);
  if (drag.mode === "box") return "";
  if (drag.mode === "docks") return "dock";
  return plan.items.find((one) => one.id === drag.id)?.kind ?? "";
}

/* Подпись у нескольких выбранных: «Выбрано 3 объекта» */
function manyText(count: number): string {
  return `Выбрано ${count} ${plural(count, "объект", "объекта", "объектов")}`;
}

/* Сколько рядов в зоне: подпись у выбранной зоны и у той, что тянут */
function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const last = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}

/* Разница двух ответов сервера: что будет с маршрутом и воротами, если отпустить */
function price(next: PlanMeasures, now: PlanMeasures): string {
  // до первой зоны маршрута нет, и прибавка к нулю ничего не говорит
  const route = now.route_m ? Math.round(next.route_m - now.route_m) : 0;
  const docks = next.docks - now.docks;
  const found = [
    `маршрут ${Math.round(next.route_m)} м${route ? ` (${route > 0 ? "+" : "−"}${Math.abs(route)})` : ""}`,
  ];
  if (docks) found.push(`ворот ${docks > 0 ? "+" : "−"}${Math.abs(docks)}`);
  if (next.unreachable_points > now.unreachable_points) found.push("есть места без проезда");
  return found.join(" · ");
}

/* Что набрано цифрами, для подписи выбранного объекта: «24 × 3▍» */
function typing(typed: { id: string; parts: string[] } | null, id: string): string | undefined {
  if (!typed || typed.id !== id || !typed.parts.length) return undefined;
  return typed.parts.length === 1 ? `${typed.parts[0]}▍ × …` : `${typed.parts[0]} × ${typed.parts[1]}▍`;
}

function selection(
  id: string,
  kind: string,
  rect: Rect,
  s: number,
  size: number,
  name: string,
  extra = "",
  typed?: string,
) {
  const handle = 11 / s;
  const wide = rect.w >= rect.h;
  const wPx = rect.w * s;
  const hPx = rect.h * s;
  // У мелкого объекта ручки выносим за край, а боковые убираем: иначе они налезали друг на друга
  // и закрывали середину, и вместо того чтобы подвинуть, человек тянул ручку.
  const out = Math.min(wPx, hPx) < SMALL_PX ? handle * 0.7 : 0;
  // У ворот только две ручки, на концах: их тянут вдоль стены, и ворота становятся длиннее.
  // У ряда тоже: толщина ряда задана стеллажом, тянут только длину
  const handles =
    kind === "dock" || kind === "racks"
      ? HANDLES.filter(([one]) => (wide ? one === "e" || one === "w" : one === "n" || one === "s"))
      : HANDLES.filter(([one]) => {
          if (one === "n" || one === "s") return wPx >= SMALL_PX;
          if (one === "e" || one === "w") return hPx >= SMALL_PX;
          return true;
        });
  const data = kind === "section" ? { "data-sid": id } : { "data-id": id };
  const push = (at: number) => (at === 0 ? -out : at === 1 ? out : 0);
  return (
    <>
      <rect {...box(rect)} className="u-picked" strokeWidth={2.5 / s} pointerEvents="none" />
      {handles.map(([one, fx, fy]) => (
        <rect
          key={one}
          {...data}
          data-h={one}
          x={rect.x + rect.w * fx - handle / 2 + push(fx)}
          y={rect.y + rect.h * fy - handle / 2 + push(fy)}
          width={handle}
          height={handle}
          rx={2 / s}
          className="u-handle"
          strokeWidth={1.5 / s}
          style={{ cursor: CURSORS[one] }}
        />
      ))}
      {/* у высокого объекта подпись внутри у нижнего края: под зоной хранения обычно стоят буфер
          и ворота, и подпись ложилась на них */}
      <text
        x={rect.x + rect.w / 2}
        y={hPx >= 90 ? rect.y + rect.h - 9 / s : rect.y + rect.h + 18 / s}
        fontSize={size}
        className="u-size"
        textAnchor="middle"
      >
        {kind === "rows" ? (
          name
        ) : (
          <>
            {name} ·{" "}
            {typed ? (
              <tspan className="u-typing">{typed}</tspan>
            ) : kind === "dock" || kind === "racks" ? (
              meters(Math.max(rect.w, rect.h))
            ) : (
              `${meters(rect.w)} × ${meters(rect.h)}`
            )}{" "}
            м{typed ? " · Enter" : extra ? ` · ${extra}` : ""}
          </>
        )}
      </text>
    </>
  );
}

function box(rect: Rect) {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
}

function path(segments: Segment[], kind: Segment["kind"], L: number): string {
  return segments
    .filter((segment) => segment.kind === kind)
    .map((segment) => `M${segment.x1} ${L - segment.y1}L${segment.x2} ${L - segment.y2}`)
    .join("");
}

/* Метка времени для новых имен и двойного щелчка. Вынесена из компонента: время не часть отрисовки */
function clock(): number {
  return Date.now();
}

function stampNow(): string {
  counter += 1;
  return `${clock().toString(36)}${counter}`;
}

let counter = 0;
function newId(kind: string): string {
  counter += 1;
  return `${kind}-${Date.now().toString(36)}-${counter}`;
}

/* Правка вещи. Зона хранения везет с собой свою змейку: сдвинули зону, сдвинулись и полосы */
function withZone(items: PlanItem[], item: PlanItem, patch: Partial<PlanItem>): PlanItem[] {
  const lanes = new Set(item.kind === "racks" ? lanesOf(items, item.id).map((one) => one.id) : []);
  const dx = (patch.x ?? item.x) - item.x;
  const dy = (patch.y ?? item.y) - item.y;
  return items.map((one) =>
    one.id === item.id ? { ...one, ...patch } : lanes.has(one.id) ? { ...one, x: one.x + dx, y: one.y + dy } : one,
  );
}

/* Ряды зоны встали по-другому, а змейка на ней лежала: полосы надо положить заново, иначе они
   окажутся на стеллажах. Сдвиг целиком полосы везет с собой, его пересчитывать не надо. */
const ROW_KEYS: (keyof PlanItem)[] = [
  "w",
  "h",
  "rows",
  "row_m",
  "aisle_m",
  "block_rows",
  "rack_type",
  "run_m",
  "cross_m",
];

function relayOf(item: PlanItem, patch: Partial<PlanItem>, items: PlanItem[]): string | undefined {
  if (item.kind !== "racks" || !lanesOf(items, item.id).length) return undefined;
  return ROW_KEYS.some((key) => key in patch && patch[key] !== item[key]) ? item.id : undefined;
}

/* Зазор между ячейками стеллажа: на крупном плане видно каждую клетку, издалека ряд сливается */
function cellGap(s: number): number {
  return s >= 3 ? Math.min(0.18, 0.9 / s) : 0;
}

/* Ячейки стеллажа одним контуром: на складе в десять тысяч метров их тысячи, и отдельными
   прямоугольниками лист тормозил бы на каждом движении мыши. Считаются, только когда зона
   поменялась. Щелчок по ячейке попадает в зону: data-id у контура тот же. */
const RackCells = memo(function RackCells({
  item,
  row,
  cross,
  height,
  gap,
}: {
  item: PlanItem;
  row: number;
  cross: number;
  height: number;
  gap: number;
}) {
  const d = useMemo(() => {
    let found = "";
    for (const cell of rackCells(item, row, cross)) {
      const w = Math.max(0.05, cell.w - gap);
      const h = Math.max(0.05, cell.h - gap);
      found += `M${round(cell.x + gap / 2)} ${round(height - cell.y - cell.h + gap / 2)}h${round(w)}v${round(h)}h${round(-w)}z`;
    }
    return found;
  }, [item, row, cross, height, gap]);
  return <path data-id={item.id} d={d} className="u-rack-cells" />;
});

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* Шевроны по оси полосы остриями по ходу. Шаг не меньше трех метров и не меньше 40 точек
   экрана: издалека частые стрелки сливались в штриховку. Размер от ширины полосы, но не больше
   метра: в широком проезде стрелки не расползаются на весь проезд. */
function chevrons(rect: Rect, way: Direction, s: number): string {
  const flat = way === "east" || way === "west";
  const length = flat ? rect.w : rect.h;
  const size = Math.min(1, (flat ? rect.h : rect.w) * 0.3);
  const count = Math.max(1, Math.floor(length / Math.max(3, 40 / s)));
  // экран рисует сверху вниз: на север значит вверх по листу
  const sign = way === "east" || way === "south" ? 1 : -1;
  let found = "";
  for (let k = 0; k < count; k++) {
    const t = ((k + 0.5) * length) / count;
    if (flat) {
      const cy = rect.h / 2;
      found += `M${t - (sign * size) / 2} ${cy - size}L${t + (sign * size) / 2} ${cy}L${t - (sign * size) / 2} ${cy + size}`;
    } else {
      const cx = rect.w / 2;
      found += `M${cx - size} ${t - (sign * size) / 2}L${cx} ${t + (sign * size) / 2}L${cx + size} ${t - (sign * size) / 2}`;
    }
  }
  return found;
}

/* Нажатие клавиши с листа или со страницы: нужны только сама клавиша и модификаторы */
type KeyLike = {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
};

/* Инструмент кладет вещь этого вида. Закрытая зона для робота то же, что перегородка */
function kindOf(tool: Tool): string {
  return tool === "nogo" ? "blocked" : tool;
}
