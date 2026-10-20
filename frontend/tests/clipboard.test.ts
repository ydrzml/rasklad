/* Копировать и вставить на листе: что берется в буфер, куда встает копия, выбор "все".
   Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { clipOf, everything, pasted } from "../src/app/plan/many.ts";

const thing = (id: string, kind: string, x: number, y: number, w: number, h: number, extra = {}) =>
  ({ id, kind, x, y, w, h, group: "", auto: false, direction: "", ...extra }) as never;

const items = [
  thing("g-r0", "racks", 0, 0, 2, 20, { group: "g" }),
  thing("g-r1", "racks", 6, 0, 2, 20, { group: "g" }),
  thing("row", "racks", 20, 0, 2, 20),
  thing("buf", "buffer", 30, 0, 6, 4),
  thing("dock", "dock", 30, -1, 4, 1),
  thing("charge", "charge", 40, 0, 2, 2, { auto: true }),
];

let counter = 0;
const name = (kind: string) => `${kind}-${++counter}`;
const anywhere = () => true;

test("в буфер берем выбранное, ворота и зарядку нет", () => {
  const clip = clipOf(items, ["row", "dock"]);
  const copy = pasted(clip!, null, anywhere, name);
  assert.deepEqual(
    copy?.items.map((one) => one.kind),
    ["racks"],
  );
});

test("одни ворота и зарядка: копировать нечего", () => {
  assert.equal(clipOf(items, ["dock"]), null);
  assert.equal(clipOf(items, ["charge"]), null);
  assert.equal(clipOf(items, ["нет такого"]), null);
});

test("с мышью центр копии встает под мышь, шаг в метр", () => {
  const clip = clipOf(items, ["buf"])!;
  const copy = pasted(clip, { x: 100.4, y: 50.2 }, anywhere, name)!;
  // буфер 6 на 4, центр копии уходит в (100, 50): левый нижний угол в (97, 48)
  assert.deepEqual([copy.items[0].x, copy.items[0].y], [97, 48]);
});

test("под мышью занято: ставим на ближайшее свободное место", () => {
  const clip = clipOf(items, ["buf"])!;
  const copy = pasted(clip, { x: 100, y: 50 }, (list) => list[0].x !== 97 || list[0].y !== 48, name);
  assert.ok(copy);
  assert.notDeepEqual([copy.items[0].x, copy.items[0].y], [97, 48]);
  assert.ok(Math.abs(copy.items[0].x - 97) <= 1 && Math.abs(copy.items[0].y - 48) <= 1);
});

test("у мыши не встала: копия идет на место оригинала, если оно свободно", () => {
  const clip = clipOf(items, ["row"])!;
  // оригинал удален с листа: свободно только его место
  const copy = pasted(clip, { x: 500, y: 500 }, (list) => list[0].x === 20 && list[0].y === 0, name);
  assert.deepEqual([copy?.items[0].x, copy?.items[0].y], [20, 0]);
});

test("и на месте оригинала занято: копия ложится рядом с ним", () => {
  const clip = clipOf(items, ["row"])!;
  const copy = pasted(clip, { x: 500, y: 500 }, (list) => list[0].x === 24, name);
  assert.equal(copy?.items[0].x, 24);
});

test("свободного места рядом нет: копии нет", () => {
  const clip = clipOf(items, ["row"])!;
  assert.equal(
    pasted(clip, { x: 5, y: 5 }, () => false, name),
    null,
  );
  assert.equal(
    pasted(clip, null, () => false, name),
    null,
  );
});

test("без мыши копия ложится рядом с оригиналом, справа первым делом", () => {
  const clip = clipOf(items, ["row"])!;
  const copy = pasted(clip, null, anywhere, name)!;
  assert.deepEqual([copy.items[0].x, copy.items[0].y], [24, 0]);
});

test("целая группа копируется группой", () => {
  const clip = clipOf(items, ["g"])!;
  const copy = pasted(clip, null, anywhere, name)!;
  assert.equal(copy.items.length, 2);
  assert.ok(copy.items[0].group);
  assert.equal(copy.items[0].group, copy.items[1].group);
  assert.notEqual(copy.items[0].group, "g");
  assert.deepEqual(copy.units, [copy.items[0].group]);
});

test("выбрать все: группа, ряд, буфер, ворота и зарядка одной строкой", () => {
  assert.equal(everything(items), "many:g,row,buf,dock,charge");
  assert.equal(everything([]), "");
  assert.equal(everything([items[2]]), "row");
});
