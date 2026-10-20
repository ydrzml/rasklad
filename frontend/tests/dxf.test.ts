import assert from "node:assert/strict";
import { test } from "node:test";

import type { Plan } from "../src/api/client.ts";
import {
  buildingBox,
  builtNotes,
  buildView,
  DXF_MAX_MB,
  type DxfBuilt,
  dxfFileProblem,
  dxfWaitNote,
  type DxfDrawing,
  type DxfLayer,
  hallProblem,
  initialLayers,
  initialRoles,
  placeUnderlay,
  planFromDxf,
  rolesToSend,
  UNITS,
  unitOf,
  unitsNote,
  visibleBox,
} from "../src/app/plan/dxf.ts";

const layer = (name: string, box: [number, number, number, number], extra: Partial<DxfLayer> = {}): DxfLayer => ({
  name,
  lines: 4,
  texts: 0,
  fills: 0,
  role: "",
  on: true,
  off_in_file: false,
  box,
  d: "M0 0 10 0",
  ...extra,
});

// склад 60 x 36 м в миллиметрах, ноль чертежа ниже размерной линии на 2 м
const drawing: DxfDrawing = {
  units: { code: 4, name: "миллиметры", factor_m: 0.001, source: "file" },
  width: 60000,
  height: 38000,
  far_away: 0,
  skipped: {},
  layers: [
    layer("WALL", [0, 2000, 60000, 38000], { role: "walls" }),
    layer("RACKS", [8000, 12000, 48000, 35000], { role: "racks" }),
    layer("DIM", [0, 0, 60000, 0], { role: "noise", on: false }),
  ],
};

const unit = UNITS[0];

test("layers the server switched on are on, dimensions are off", () => {
  assert.deepEqual([...initialLayers(drawing)].sort(), ["RACKS", "WALL"]);
});

test("the building is the walls layer, the picture is every shown layer", () => {
  const on = new Set(["WALL", "RACKS", "DIM"]);
  assert.deepEqual(buildingBox(drawing, on), [0, 2000, 60000, 38000]);
  assert.deepEqual(visibleBox(drawing, on), [0, 0, 60000, 38000]);
});

test("without a walls layer the building is the box of everything shown", () => {
  assert.deepEqual(buildingBox(drawing, new Set(["RACKS"])), [8000, 12000, 48000, 35000]);
});

test("hall size follows the chosen unit", () => {
  const view = buildView(drawing, initialLayers(drawing), unit);
  assert.deepEqual(view?.hall, { w: 60, h: 36 });
  assert.deepEqual(buildView(drawing, initialLayers(drawing), UNITS[1])?.hall, { w: 600, h: 360 });
  assert.equal(hallProblem({ w: 0, h: 0 }) !== "", true);
  assert.equal(hallProblem({ w: 60, h: 36 }), "");
  assert.match(hallProblem({ w: 6000, h: 3600 }), /единицы/);
  assert.match(hallProblem(null), /слой/);
});

test("nothing drawn gives no view", () => {
  assert.equal(buildView(drawing, new Set(), unit), null);
  // слой без линий не рисуется, даже если включен
  const empty = { ...drawing, layers: [layer("TXT", [0, 0, 0, 0], { lines: 0 })] };
  assert.equal(buildView(empty, new Set(["TXT"]), unit), null);
});

test("the picture is an svg with the real aspect and no markup from layer names", () => {
  const name = '<img src=x onerror="1">';
  const weird = { ...drawing, height: 50, layers: [layer(name, [0, 0, 100, 50])] };
  const view = buildView(weird, new Set([name]), unit);
  assert.ok(view);
  const svg = Buffer.from(view.src.split(",")[1], "base64").toString();
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes("onerror"));
  assert.match(svg, /width="2400" height="1206"/);
});

test("the drawing lands under the sheet at the real scale, corner to corner", () => {
  const view = buildView(drawing, new Set(["WALL", "RACKS", "DIM"]), unit);
  assert.ok(view);
  // здание плана стоит в точке (5, 7) метров листа
  const placed = placeUnderlay(view, { x: 5, y: 7, w: 60, h: 36 }, unit, 0.55, "sklad.dxf");
  // картинка шире здания на размерную линию: она ниже стены на 2 м
  // поле вокруг линий в две толщины линии: 60000 / 800 * 2 = 150 мм с каждой стороны
  assert.ok(Math.abs(placed.x - 4.85) < 1e-9);
  assert.ok(Math.abs(placed.y - 4.85) < 1e-9);
  assert.ok(Math.abs(placed.w - 60.3) < 1e-9);
  assert.ok(Math.abs(placed.h - 38.3) < 1e-9);
  assert.equal(placed.exact, true);
});

test("units are named honestly: from the file, guessed, or chosen", () => {
  assert.equal(unitOf(drawing).id, "mm");
  assert.match(unitsNote(drawing, UNITS[0]), /записаны в чертеже/);
  assert.match(unitsNote(drawing, UNITS[2]), /выбраны вами/);
  const guessed = { ...drawing, units: { ...drawing.units, source: "guess" as const } };
  assert.match(unitsNote(guessed, UNITS[0]), /Проверьте/);
  const unknown = { ...drawing, units: { ...drawing.units, factor_m: 1, source: "unknown" as const } };
  assert.match(unitsNote(unknown, UNITS[2]), /определить их не удалось/);
});

test("roles named by the person beat the roles the server guessed", () => {
  const on = new Set(["WALL", "RACKS", "DIM"]);
  // человек назвал стенами слой стеллажей: здание берется по нему
  assert.deepEqual(buildingBox(drawing, on, { WALL: "", RACKS: "walls", DIM: "" }), [8000, 12000, 48000, 35000]);
  assert.deepEqual(buildingBox(drawing, on, { WALL: "walls", RACKS: "racks", DIM: "" }), [0, 2000, 60000, 38000]);
});

test("only checked layers with a role go to the server", () => {
  const roles = initialRoles(drawing);
  assert.deepEqual(roles, { WALL: "walls", RACKS: "racks", DIM: "" });
  const choice = { on: new Set(["WALL", "DIM"]), unit, roles: { ...roles, DIM: "doors" as const } };
  assert.deepEqual(rolesToSend(drawing, choice), { WALL: "walls", DIM: "doors" });
});

const built: DxfBuilt = {
  width_m: 60,
  length_m: 36,
  outline: [],
  items: [
    { id: "dxf-rack-1", kind: "racks", x: 8, y: 10, w: 40, h: 2, rows: "x", row_m: 2, block_rows: 1, aisle_m: 3.5 },
    { id: "dxf-dock-1", kind: "dock", x: 6, y: 0, w: 4, h: 1, role: "both" },
  ],
  warnings: ["Стеллажей под углом: 1"],
  counts: { racks: 1, docks: 1, buffers: 0 },
  turn_deg: 0,
};

const emptyPlan = {
  width_m: 80,
  length_m: 60,
  template: "custom",
  edited: false,
  floor: [],
  levels: [],
  sections: [{ id: "s1", x: 5, y: 7, w: 60, h: 36, floor_m: 0, ceiling_m: 10, hole: false, points: [] }],
  items: [{ id: "old", kind: "racks", x: 20, y: 20, w: 5, h: 2 }],
} as unknown as Plan;

test("the built plan moves to the building corner on the sheet and replaces old racks and docks", () => {
  const plan = planFromDxf(emptyPlan, built, { x: 5, y: 7, w: 60, h: 36 });
  assert.equal(plan.edited, true);
  assert.deepEqual(
    plan.items.map((one) => [one.id, one.x, one.y]),
    [
      ["dxf-rack-1", 13, 17],
      ["dxf-dock-1", 11, 7],
    ],
  );
  const rack = plan.items[0];
  assert.deepEqual([rack.rows, rack.row_m, rack.block_rows, rack.aisle_m, rack.group], ["x", 2, 1, 3.5, ""]);
  assert.deepEqual([plan.sections[0].x, plan.sections[0].w, plan.sections[0].points], [5, 60, []]);
});

test("an outline moves with the building and keeps the other sections", () => {
  const l = {
    ...built,
    outline: [
      [0, 0],
      [60, 0],
      [60, 20],
      [0, 20],
    ] as [number, number][],
  };
  const plan = planFromDxf(emptyPlan, l, { x: 5, y: 7, w: 60, h: 36 });
  assert.deepEqual(plan.sections[0].points, [
    [5, 7],
    [65, 7],
    [65, 27],
    [5, 27],
  ]);
});

test("notes say what was found and then every warning", () => {
  const notes = builtNotes({
    ...built,
    outline: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    counts: { racks: 7, docks: 5, buffers: 1 },
  });
  assert.equal(notes[0], "Здание 60 × 36 м, контур из 3 точек");
  assert.equal(notes[1], "Рядов стеллажей: 7, ворот: 5, буферов: 1");
  assert.equal(notes[2], "Стеллажей под углом: 1");
});

// File только с именем и размером: содержимое проверке не нужно, а 60 МБ в тесте не создаем
const fileOf = (name: string, mb: number) => ({ name, size: mb * 1024 * 1024 }) as File;

test("too big drawing is refused in the browser with the size and what to do", () => {
  const text = dxfFileProblem(fileOf("cekh.dxf", DXF_MAX_MB + 1));
  assert.match(text, new RegExp(`больше ${DXF_MAX_MB} МБ`));
  assert.match(text, /только нужные слои/);
  assert.equal(dxfFileProblem(fileOf("cekh.dxf", 61)), "");
});

test("dwg and other files are refused before upload with a way out", () => {
  assert.match(dxfFileProblem(fileOf("plan.DWG", 1)), /DWG.*DXF/);
  assert.match(dxfFileProblem(fileOf("plan.pdf", 1)), /Нужен файл DXF/);
});

test("big drawing tells how long to wait, small one does not", () => {
  assert.match(dxfWaitNote(fileOf("cekh.dxf", 61)), /61 МБ.*до двух-трех минут/);
  assert.equal(dxfWaitNote(fileOf("sklad.dxf", 2)), "");
});
