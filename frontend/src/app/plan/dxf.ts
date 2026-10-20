/* Чертеж DXF как подложка. Сервер разбирает файл и отдает линии по слоям (api.planDxf), а здесь
   из включенных слоев собирается картинка SVG и кладется под лист в точном масштабе: единица
   чертежа известна, поэтому ничего не угадывается по картинке, как с фото. Считать по картинке
   нечего: план, который по ней обвели, это обычный план. */
import type { Plan, PlanItem } from "../../api/client";
import type { Rect } from "./geometry";
import type { Underlay } from "./underlay";

export type DxfLayer = {
  name: string;
  lines: number;
  texts: number;
  fills: number;
  role: "" | "walls" | "racks" | "doors" | "noise";
  on: boolean;
  off_in_file: boolean;
  box: [number, number, number, number]; // x0, y0, x1, y1 от юго-западного угла чертежа, y вверх
  d: string; // линии слоя как путь SVG: ноль в левом верхнем углу чертежа, y вниз
};

export type DxfDrawing = {
  units: { code: number; name: string; factor_m: number; source: "file" | "guess" | "unknown" };
  width: number;
  height: number;
  layers: DxfLayer[];
  far_away: number;
  skipped: Record<string, number>;
};

/* Что на слое, когда из чертежа строят план. Пусто значит, слой в план не идет */
export type LayerRole = "" | "walls" | "racks" | "doors";
export const ROLE_OPTIONS: { id: LayerRole; name: string }[] = [
  { id: "", name: "не использовать" },
  { id: "walls", name: "стены" },
  { id: "racks", name: "стеллажи" },
  { id: "doors", name: "ворота" },
];

/* Что человек выбрал в окне: какие слои показывать, в каких единицах чертеж и что лежит на слоях */
export type DxfChoice = { on: Set<string>; unit: Unit; roles: Record<string, LayerRole> };

/* Ответ сервера на "построить план": вещи в метрах от юго-западного угла здания */
export type DxfBuilt = {
  width_m: number;
  length_m: number;
  outline: [number, number][];
  items: {
    id: string;
    kind: "racks" | "dock" | "buffer";
    x: number;
    y: number;
    w: number;
    h: number;
    rows?: string;
    row_m?: number;
    block_rows?: number;
    aisle_m?: number;
    role?: string;
  }[];
  warnings: string[];
  counts: { racks: number; docks: number; buffers: number };
  turn_deg: number;
};

export type Unit = { id: string; name: string; factor: number };
export const UNITS: Unit[] = [
  { id: "mm", name: "миллиметры", factor: 0.001 },
  { id: "cm", name: "сантиметры", factor: 0.01 },
  { id: "m", name: "метры", factor: 1 },
  { id: "in", name: "дюймы", factor: 0.0254 },
  { id: "ft", name: "футы", factor: 0.3048 },
];

// Предел файла тот же, что у сервера (dxf_underlay.MAX_MB) и nginx: проверяем до отправки, чтобы
// не гнать по сети 100 МБ ради отказа. С BIG_MB разбор идет дольше полминуты, об этом предупреждаем
export const DXF_MAX_MB = 80;
// Пример чертежа склада 102 на 72 м в миллиметрах (backend/scripts/make_demo_dxf.py)
export const DXF_EXAMPLE = "/examples/sklad-demo.dxf";
const DXF_BIG_MB = 16;
const MB = 1024 * 1024;
export const DXF_ADVICE =
  "Сохраните в AutoCAD только нужные слои (стены, стеллажи, ворота) или как DXF R2000 без блоков и штриховок";
const DWG_TEXT =
  'Это файл DWG, а нужен DXF. В AutoCAD откройте чертеж, выберите "Файл", "Сохранить как" и тип файла DXF, потом загрузите его';

/* Почему файл не отправляем на сервер; пусто значит, отправляем */
export function dxfFileProblem(file: File): string {
  if (/\.dwg$/i.test(file.name)) return DWG_TEXT;
  if (!/\.dxf$/i.test(file.name)) return "Нужен файл DXF. Если чертеж в DWG или PDF, сохраните его в AutoCAD как DXF";
  if (file.size > DXF_MAX_MB * MB) return `Чертеж больше ${DXF_MAX_MB} МБ. ${DXF_ADVICE}`;
  return "";
}

/* Что сказать, пока сервер разбирает файл: большой чертеж разбирается минуту-две */
export function dxfWaitNote(file: File): string {
  if (file.size < DXF_BIG_MB * MB) return "";
  const mb = Math.round(file.size / MB);
  return `Чертеж ${mb} МБ: сервер разбирает его до двух-трех минут. Не закрывайте страницу`;
}

// здание короче этого или длиннее этого на плане не бывает: единицы выбраны не те
export const HALL_MIN_M = 10;
export const HALL_MAX_M = 1000;
const PICTURE_PX = 2400; // длинная сторона картинки: на листе в метр приходится не меньше двух точек
const STROKE_DIV = 800; // толщина линии, доля от длинной стороны чертежа

type Box = [number, number, number, number];

export function unitOf(drawing: DxfDrawing): Unit {
  return UNITS.find((one) => Math.abs(one.factor - drawing.units.factor_m) < 1e-9) ?? UNITS[2];
}

/* Роли слоев по именам: сервер угадывает стены, стеллажи и ворота, остальное человек назначит сам */
export function initialRoles(drawing: DxfDrawing): Record<string, LayerRole> {
  const roles: Record<string, LayerRole> = {};
  for (const one of drawing.layers)
    roles[one.name] =
      one.lines > 0 && (one.role === "walls" || one.role === "racks" || one.role === "doors") ? one.role : "";
  return roles;
}

/* Слои, из которых строится план: включены галочкой и им назначена роль. Отправляем на сервер */
export function rolesToSend(drawing: DxfDrawing, choice: DxfChoice): Record<string, Exclude<LayerRole, "">> {
  const out: Record<string, Exclude<LayerRole, "">> = {};
  for (const one of drawing.layers) {
    const role = choice.roles[one.name];
    if (role && choice.on.has(one.name) && one.lines > 0) out[one.name] = role;
  }
  return out;
}

/* Слои, включенные сразу: так их отметил сервер по именам (размеры, штамп и надписи выключены) */
export function initialLayers(drawing: DxfDrawing): Set<string> {
  return new Set(drawing.layers.filter((one) => one.on).map((one) => one.name));
}

function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

const drawn = (drawing: DxfDrawing, on: Set<string>) =>
  drawing.layers.filter((one) => on.has(one.name) && one.lines > 0);

/* Рамка включенных слоев: по ней режем картинку, чтобы пустое поле и штамп не уменьшали масштаб */
export function visibleBox(drawing: DxfDrawing, on: Set<string>): Box | null {
  return union(drawn(drawing, on).map((one) => one.box));
}

/* Рамка здания в единицах чертежа: слои со стенами, а если их нет среди включенных, все включенные.
   Двор и соседние здания на слое стен не лежат, поэтому здание не растягивается на весь участок. */
export function buildingBox(drawing: DxfDrawing, on: Set<string>, roles?: Record<string, LayerRole>): Box | null {
  const shown = drawn(drawing, on);
  // роли, которые назвал человек, главнее тех, что угадал сервер
  const walls = shown.filter((one) => (roles ? roles[one.name] === "walls" : one.role === "walls"));
  return union((walls.length ? walls : shown).map((one) => one.box));
}

export type DxfView = {
  src: string; // data-url картинки SVG
  box: Box; // что на картинке, в единицах чертежа
  building: Box;
  hall: { w: number; h: number }; // здание в метрах, по сетке в метр
};

export function hallProblem(hall: { w: number; h: number } | null): string {
  if (!hall) return "Включите хотя бы один слой с линиями";
  const side = Math.min(hall.w, hall.h);
  const long = Math.max(hall.w, hall.h);
  if (side < HALL_MIN_M || long > HALL_MAX_M)
    return `Здание получается ${hall.w} на ${hall.h} м. Проверьте единицы или включите слой со стенами`;
  return "";
}

/* Картинка из включенных слоев; здание в метрах по выбранной единице */
export function buildView(
  drawing: DxfDrawing,
  on: Set<string>,
  unit: Unit,
  roles?: Record<string, LayerRole>,
): DxfView | null {
  const tight = visibleBox(drawing, on);
  const building = buildingBox(drawing, on, roles);
  if (!tight || !building) return null;
  // поле в две толщины линии: стена на краю чертежа не обрезается наполовину
  const pad = (Math.max(tight[2] - tight[0], tight[3] - tight[1]) / STROKE_DIV) * 2;
  const box: Box = [tight[0] - pad, tight[1] - pad, tight[2] + pad, tight[3] + pad];
  const [x0, y0, x1, y1] = box;
  const [w, h] = [Math.max(x1 - x0, 1e-9), Math.max(y1 - y0, 1e-9)];
  const k = PICTURE_PX / Math.max(w, h);
  const paths = drawn(drawing, on)
    .map((one) => one.d)
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${drawing.height - y1} ${w} ${h}" ` +
    `width="${Math.max(1, Math.round(w * k))}" height="${Math.max(1, Math.round(h * k))}">` +
    `<path d="${paths}" fill="none" stroke="#1d1d1b" stroke-width="${Math.max(w, h) / STROKE_DIV}" ` +
    `stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return {
    src: `data:image/svg+xml;base64,${btoa(svg)}`,
    box,
    building,
    hall: {
      w: Math.round((building[2] - building[0]) * unit.factor),
      h: Math.round((building[3] - building[1]) * unit.factor),
    },
  };
}

/* Подложка под лист: здание на чертеже встает на здание на плане, юго-западный угол в угол. Масштаб
   точный, поэтому угла и поворота картинки не ищем. Ось y листа растет на север, как в чертеже. */
export function placeUnderlay(view: DxfView, hall: Rect, unit: Unit, opacity: number, label: string): Underlay {
  const [x0, y0, x1, y1] = view.box;
  const k = unit.factor;
  return {
    src: view.src,
    x: hall.x - (view.building[0] - x0) * k,
    y: hall.y - (view.building[1] - y0) * k,
    w: (x1 - x0) * k,
    h: (y1 - y0) * k,
    opacity,
    exact: true,
    label,
  };
}

/* Что сказать про единицы. Угаданные и не найденные просим проверить, записанные в файле не трогаем */
export function unitsNote(drawing: DxfDrawing, unit: Unit): string {
  const same = Math.abs(unit.factor - drawing.units.factor_m) < 1e-9;
  if (!same) return `Единицы выбраны вами: ${unit.name}`;
  if (drawing.units.source === "file") return `Единицы записаны в чертеже: ${unit.name}`;
  if (drawing.units.source === "guess")
    return `В чертеже единицы не указаны, по размеру похоже на ${unit.name}. Проверьте`;
  return "В чертеже единицы не указаны, и определить их не удалось. Выберите сами";
}

const NO_ITEM: Omit<PlanItem, "id" | "kind" | "x" | "y" | "w" | "h"> = {
  aisle_m: 0,
  run_m: 0,
  rows: "y",
  rack_top_m: 0,
  rack_type: "",
  row_m: 0,
  block_rows: 1,
  cross_m: 0,
  tiers: 0,
  tier_m: 0,
  role: "",
  auto: false,
  turnover: "",
  direction: "",
  group: "",
};

/* План по ответу сервера: здание плана становится зданием чертежа, ряды, ворота и буфер из чертежа
   заменяют прежние. Сервер считает от юго-западного угла здания, здесь только сдвиг на угол
   здания на листе. Прочие вещи (зарядка, перегородки) остаются где были. */
export function planFromDxf(plan: Plan, built: DxfBuilt, hall: Rect): Plan {
  const main = plan.sections.find((one) => !one.hole);
  const outline = built.outline.map(([x, y]) => [x + hall.x, y + hall.y] as [number, number]);
  const sections = plan.sections.map((one) =>
    one.id === main?.id ? { ...one, x: hall.x, y: hall.y, w: built.width_m, h: built.length_m, points: outline } : one,
  );
  const imported: PlanItem[] = built.items.map((one) => ({
    ...NO_ITEM,
    id: one.id,
    kind: one.kind,
    x: one.x + hall.x,
    y: one.y + hall.y,
    w: one.w,
    h: one.h,
    rows: one.rows ?? NO_ITEM.rows,
    row_m: one.row_m ?? 0,
    block_rows: one.block_rows ?? 1,
    aisle_m: one.aisle_m ?? 0,
    role: one.role ?? "",
  }));
  const kept = plan.items.filter((one) => !["racks", "dock", "buffer"].includes(one.kind));
  return { ...plan, edited: true, sections, items: [...kept, ...imported] };
}

/* Что сказать человеку после построения: что нашли и что пришлось приблизить или пропустить */
export function builtNotes(built: DxfBuilt): string[] {
  const shape = built.outline.length ? `, контур из ${built.outline.length} точек` : "";
  const buffer = built.counts.buffers ? `, буферов: ${built.counts.buffers}` : "";
  return [
    `Здание ${built.width_m} × ${built.length_m} м${shape}`,
    `Рядов стеллажей: ${built.counts.racks}, ворот: ${built.counts.docks}${buffer}`,
    ...built.warnings,
  ];
}
