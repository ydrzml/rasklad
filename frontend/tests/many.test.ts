/* Выбор нескольких объектов на листе: Shift+щелчок, рамка, и что уходит, едет и копируется
   вместе с выбранным. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  copiedMany,
  countOf,
  joined,
  manyOf,
  membersOf,
  partOf,
  pickedOf,
  shiftedMany,
  toggled,
  unitOf,
  unitsIn,
  withoutMany,
} from "../src/app/plan/many.ts";

const thing = (id: string, kind: string, x: number, y: number, w: number, h: number, extra = {}) =>
  ({ id, kind, x, y, w, h, group: "", auto: false, direction: "", ...extra }) as never;

// группа из двух рядов, ее змейка, отдельный ряд, буфер, ворота и зарядка программы
const items = [
  thing("g-r0", "racks", 0, 0, 2, 20, { group: "g" }),
  thing("g-r1", "racks", 6, 0, 2, 20, { group: "g" }),
  thing("g-flow-0", "flow", 2, 0, 4, 20),
  thing("row", "racks", 20, 0, 2, 20),
  thing("buf", "buffer", 30, 0, 6, 4),
  thing("dock", "dock", 30, -1, 4, 1),
  thing("charge", "charge", 40, 0, 2, 2, { auto: true }),
];
const ids = (list: { id: string }[]) => list.map((one) => one.id);

// группа из двух рядов вдоль y, у первого два куска между поперечным проездом
const pieces = [
  thing("p-a0", "racks", 0, 0, 2, 10, { group: "p", rows: "y" }),
  thing("p-a1", "racks", 0, 14, 2, 10, { group: "p", rows: "y" }),
  thing("p-b0", "racks", 6, 0, 2, 24, { group: "p", rows: "y" }),
  thing("buf", "buffer", 30, 0, 6, 4),
];

test("Shift+щелчок добавляет и убирает, один выбранный тоже считается", () => {
  const [, , , row, buf] = items;
  assert.equal(toggled(items, "", buf), "buf");
  assert.equal(toggled(items, "buf", row), "many:buf,row");
  assert.equal(toggled(items, "many:buf,row", row), "buf");
  assert.equal(toggled(items, "buf", buf), "");
  assert.deepEqual(manyOf("buf"), []);
  assert.deepEqual(manyOf("many:buf,row"), ["buf", "row"]);
  assert.equal(pickedOf(["buf", "buf"]), "buf");
});

test("ряд группы Shift берет один, со всеми кусками; все ряды собираются в группу", () => {
  const [a0] = pieces;
  // у первого ряда два куска между поперечным проездом: берутся оба
  assert.equal(toggled(pieces, "buf", a0), "many:buf,p-a0,p-a1");
  assert.equal(countOf(pieces, manyOf("many:buf,p-a0,p-a1")), 2);
  // второй ряд добил группу целиком: в выборе снова ее имя
  assert.equal(toggled(pieces, "many:buf,p-a0,p-a1", pieces[2]), "many:buf,p");
  // из выбранной группы Shift убирает один ряд
  assert.equal(toggled(pieces, "p", a0), "p-b0");
  assert.deepEqual(partOf(pieces, ["p-b0"]), ["p"]);
  assert.deepEqual(partOf(pieces, ["p"]), []);
});

test("ряд из группы выбирается всей группой", () => {
  assert.equal(unitOf(items[0]), "g");
  assert.equal(unitOf(items[3]), "row");
});

test("в выбранное входят ряды группы и ее змейка", () => {
  assert.deepEqual(ids(membersOf(items, ["g", "buf"])), ["g-r0", "g-r1", "g-flow-0", "buf"]);
});

test("рамка берет все, что задела, змейку группы отдельно не берет", () => {
  assert.deepEqual(unitsIn(items, { x: 5, y: 5, w: 20, h: 2 }), ["g-r1", "row"]);
  assert.deepEqual(unitsIn(items, { x: -1, y: 5, w: 30, h: 2 }), ["g", "row"]);
  // один кусок ряда в рамке тянет за собой весь ряд
  assert.deepEqual(unitsIn(pieces, { x: 0, y: 0, w: 1, h: 1 }), ["p-a0", "p-a1"]);
  assert.equal(joined(pieces, "buf", ["p-a0", "p-a1"]), "many:buf,p-a0,p-a1");
  assert.deepEqual(unitsIn(items, { x: 3, y: 5, w: 1, h: 1 }), []);
  assert.deepEqual(unitsIn(items, { x: 29, y: -2, w: 20, h: 3 }), ["buf", "dock", "charge"]);
});

test("удаление уносит группу со змейкой одной правкой", () => {
  assert.deepEqual(ids(withoutMany(items, ["g", "charge"])), ["row", "buf", "dock"]);
});

test("ряды, увезенные из группы по одному, выходят из нее", () => {
  const moved = shiftedMany(pieces, ["p-b0"], 5, 0) as unknown as { id: string; group: string }[];
  assert.deepEqual(
    moved.map((one) => [one.id, one.group]),
    [["p-b0", ""]],
  );
  const whole = shiftedMany(pieces, ["p"], 5, 0) as unknown as { group: string }[];
  assert.ok(whole.every((one) => one.group === "p"));
  // ряд из двух кусков увезли: в подписи он все равно один
  const out = shiftedMany(pieces, ["p-a0", "p-a1"], 20, 0);
  assert.equal(countOf([...out, pieces[2], pieces[3]], ["p-a0", "p-a1", "buf"]), 2);
});

test("сдвиг двигает все выбранное, зарядка становится местом человека", () => {
  const moved = shiftedMany(items, ["g", "charge"], 3, -1) as unknown as {
    id: string;
    x: number;
    y: number;
    auto: boolean;
  }[];
  assert.deepEqual(
    moved.map((one) => [one.id, one.x, one.y]),
    [
      ["g-r0", 3, -1],
      ["g-r1", 9, -1],
      ["g-flow-0", 5, -1],
      ["charge", 43, -1],
    ],
  );
  assert.equal(moved.at(-1)?.auto, false);
});

test("копия: новые имена, группа остается группой, ворота, зарядка и змейка не копируются", () => {
  let n = 0;
  const copy = copiedMany(items, ["g", "buf", "dock", "charge"], 0, 30, (kind) => `${kind}-${++n}`);
  const made = copy.items as unknown as { id: string; group: string; y: number; kind: string }[];
  assert.deepEqual(
    made.map((one) => [one.id, one.group, one.y]),
    [
      ["rows-1-r0", "rows-1", 30],
      ["rows-1-r1", "rows-1", 30],
      ["buffer-2", "", 30],
    ],
  );
  assert.deepEqual(copy.units, ["rows-1", "buffer-2"]);
  assert.equal(pickedOf(copy.units), "many:rows-1,buffer-2");
  // отдельный ряд из группы копируется отдельным рядом
  const one = copiedMany(pieces, ["p-b0"], 10, 0, (kind) => `${kind}-x`);
  assert.deepEqual(one.units, ["racks-x"]);
  assert.equal((one.items[0] as unknown as { group: string }).group, "");
});
