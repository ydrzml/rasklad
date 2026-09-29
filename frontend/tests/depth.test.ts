/* Объемный вид: вещь стоит на полу своей секции, тела рисуются от дальнего к ближнему.
   Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { drawOrder, onFloors, sceneOrder, type Solid } from "../src/app/plan/depth.ts";

// зал на нуле и поднятая на 1,5 м секция слева снизу, потолки разные
const floors = [
  { x: 0, y: 0, w: 20, h: 20, floor: 1.5, ceiling: 6 },
  { x: 20, y: 0, w: 80, h: 20, floor: 0, ceiling: 10 },
  { x: 0, y: 20, w: 100, h: 60, floor: 0, ceiling: 10 },
];

test("перегородка на двух секциях режется по границе, каждый кусок на своем полу", () => {
  const parts = onFloors({ x: 15, y: 5, w: 10, h: 4 }, floors);
  assert.deepEqual(parts, [
    { x: 15, y: 5, w: 5, h: 4, floor: 1.5, ceiling: 6 },
    { x: 20, y: 5, w: 5, h: 4, floor: 0, ceiling: 10 },
  ]);
});

test("куски на одной отметке склеиваются, шва нет", () => {
  const parts = onFloors({ x: 40, y: 15, w: 4, h: 10 }, floors);
  assert.deepEqual(parts, [{ x: 40, y: 15, w: 4, h: 10, floor: 0, ceiling: 10 }]);
});

const box = (name: string, x: number, y: number, w: number, h: number, z0: number, z1: number) =>
  ({ name, x, y, w, h, z0, z1, color: "", kind: "box" }) as Solid & { name: string };
const names = (list: Solid[]) => list.map((one) => (one as Solid & { name: string }).name);

test("колонна перед длинным рядом рисуется после ряда", () => {
  // ряд вдоль y, колонна ближе к зрителю по x, но дальше ближнего угла ряда
  const row = box("ряд", 10, 0, 2, 76, 0, 6);
  const column = box("колонна", 8, 36, 1, 1, 0, 10);
  assert.deepEqual(names(drawOrder([column, row], 0, 50, 40)), ["ряд", "колонна"]);
  // камера с другой стороны: наоборот
  assert.deepEqual(names(drawOrder([column, row], 2, 50, 40)), ["колонна", "ряд"]);
});

test("поднятый пол раньше того, что на нем, вещь нижнего пола за ним раньше него", () => {
  const raised = box("пол", 0, 0, 20, 20, 0, 1.5);
  const onTop = box("на полу", 5, 5, 2, 10, 1.5, 7);
  const behind = box("за полом", 30, 5, 2, 10, 0, 6);
  const front = [raised, onTop, behind];
  assert.deepEqual(names(drawOrder(front, 0, 50, 40)), ["за полом", "пол", "на полу"]);
});

test("плоский пол всегда первым: большая плита не ложится поверх рядов", () => {
  // плита под одним рядом и перед другим: в общем порядке это замыкало круг
  const hall = { ...box("плита", 0, 20, 100, 60, 0, 0), kind: "flat" as const };
  const a = box("ряд на плите", 50, 5, 2, 70, 0, 6);
  const b = box("ряд перед плитой", 60, 5, 2, 10, 0, 6);
  for (const turn of [0, 1, 2, 3]) {
    const order = names(sceneOrder([hall], [a, b], turn, 50, 40));
    assert.equal(order[0], "плита");
    assert.equal(order.length, 3);
  }
});
