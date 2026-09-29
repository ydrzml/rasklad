/* Раскладка рядов в редакторе: сколько рядов встанет в протянутый прямоугольник и как правка
   числа держит угол группы на месте. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { layoutIn, layoutOf, rectsOf, relay, rowByDrag, withLength } from "../src/app/plan/rows.ts";

const base = {
  kind: "racks",
  aisle_m: 3.5,
  run_m: 0,
  rack_top_m: 0,
  rack_type: "front",
  row_m: 2.3,
  block_rows: 1,
  cross_m: 0,
  tiers: 5,
  tier_m: 1.7,
  role: "",
  auto: false,
  turnover: "",
  direction: "",
  group: "g",
} as const;

function rows(count: number, rows: "x" | "y" = "y") {
  const layout = layoutIn({ x: 10, y: 10, w: 40, h: 60 }, { x: 10, y: 70 }, 2.3, 3.5, rows);
  return rectsOf({ ...layout, count }).map((rect, index) => ({ ...base, ...rect, rows, id: `g-r${index}` }));
}

test("протянули прямоугольник: рядов столько, сколько встает целиком", () => {
  const layout = layoutIn({ x: 0, y: 0, w: 30, h: 50 }, { x: 0, y: 0 }, 2.3, 3.5);
  assert.equal(layout.rows, "y"); // вдоль длинной стороны
  assert.equal(layout.count, 5); // 5 * 2,3 + 4 * 3,5 = 25,5, шестой не влезет
  const found = rectsOf(layout);
  assert.equal(found[0].x, 0);
  assert.ok(Math.abs(found[1].x - 5.8) < 1e-9);
});

test("один ряд там, где тянули: линия протяжки по его середине", () => {
  const row = rowByDrag({ x: 20, y: 5 }, { x: 20.4, y: 45 }, 2.3);
  assert.equal(row.rows, "y");
  assert.equal(row.h, 40);
  assert.ok(row.x <= 20 && row.x + row.w >= 20);
});

test("меньше рядов: левый край и верх группы стоят на месте", () => {
  const now = rows(8);
  const layout = layoutOf(now, 2.2);
  assert.equal(layout.count, 8);
  assert.ok(Math.abs(layout.aisle - 3.5) < 1e-9);
  const fewer = relay(now, { ...layout, count: 3 }, "g", (index) => `new-${index}`);
  assert.equal(fewer.length, 3);
  assert.equal(Math.min(...fewer.map((one) => one.x)), Math.min(...now.map((one) => one.x)));
  assert.deepEqual(
    fewer.map((one) => one.id),
    ["g-r0", "g-r1", "g-r2"],
  );
  const top = (list: { y: number; h: number }[]) => Math.max(...list.map((one) => one.y + one.h));
  const shorter = relay(now, withLength(layout, 30), "g", String);
  assert.equal(top(shorter), top(now)); // ряды вдоль листа укорачиваются снизу, верх на месте
});

test("ряд, разрезанный поперечным проездом, остается одним рядом", () => {
  const layout = { ...layoutIn({ x: 0, y: 0, w: 20, h: 70 }, { x: 0, y: 0 }, 2.3, 3.5), pieces: 3, cross: 4 };
  const pieces = rectsOf(layout).map((rect, index) => ({ ...base, ...rect, rows: "y" as const, id: `p${index}` }));
  const read = layoutOf(pieces, 2.2);
  assert.equal(read.count, layout.count);
  assert.equal(read.pieces, 3);
  assert.ok(Math.abs(read.cross - 4) < 1e-9);
  assert.ok(Math.abs(read.length - 70) < 1e-9);
});
