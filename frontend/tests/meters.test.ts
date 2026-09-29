/* Метры на листе: подписи до 0,1 м с запятой, в плане до сантиметра. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { meters, snapM, tenth, tidyPlan } from "../src/app/plan/meters.ts";

test("подпись без хвоста дроби и с запятой", () => {
  assert.equal(meters(10.399999999999991), "10,4");
  assert.equal(meters(10), "10");
  assert.equal(meters(2.25), "2,3");
  assert.equal(meters(0.1 + 0.2), "0,3");
  assert.equal(meters(-0.04), "0");
  assert.equal(`${meters(10.399999999999991)} × ${meters(10)} м`, "10,4 × 10 м");
});

test("число для поля до 0,1", () => {
  assert.equal(tenth(3.4999999999), 3.5);
  assert.equal(tenth(118), 118);
  assert.ok(!Object.is(tenth(-0.01), -0));
});

test("в план кладем до сантиметра", () => {
  assert.equal(snapM(10.399999999999991), 10.4);
  assert.equal(snapM(2.2 * 3), 6.6);
  assert.equal(snapM(1.005 + 0.001), 1.01);
});

test("план после правки без хвостов: вещи, секции и точки контура", () => {
  const plan = {
    width_m: 50,
    length_m: 40,
    items: [{ id: "a", x: 1.1 + 2.2, y: 0.30000000000000004, w: 10.399999999999991, h: 10 }],
    sections: [{ id: "s", x: 0, y: 0, w: 30.000000000000004, h: 20, points: [[0.1 + 0.2, 7.000000000000001]] }],
  } as never;
  const tidy = tidyPlan(plan) as unknown as {
    width_m: number;
    items: { x: number; y: number; w: number; h: number }[];
    sections: { w: number; points: [number, number][] }[];
  };
  assert.deepEqual(tidy.items[0], { id: "a", x: 3.3, y: 0.3, w: 10.4, h: 10 });
  assert.equal(tidy.sections[0].w, 30);
  assert.deepEqual(tidy.sections[0].points, [[0.3, 7]]);
  assert.equal(tidy.width_m, 50);
});
