/* Уборка машиной или вручную, когда штат уже правили руками. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { swapByNorm, swapText } from "../src/app/staffSwap.ts";

const operator = {
  id: "cleaners",
  role: "scrubber_operator",
  headcount: 1.46,
  filled: 1.46,
  salary_month: 60000,
  contractor: true,
};
const cleaners = {
  id: "cleaners",
  role: "cleaner",
  headcount: 7.9,
  filled: 7.9,
  salary_month: 60000,
  contractor: true,
};
const pickers = { id: "pickers", role: "picker", headcount: 90, filled: 90, salary_month: 110000 };

test("переключили на вручную: предлагаем уборщиков по норме вместо оператора машины", () => {
  const swap = swapByNorm([operator, pickers], [cleaners, pickers], ["scrubber_operator", "picker"]);
  assert.ok(swap);
  assert.deepEqual(swap.from, ["scrubber_operator"]);
  assert.deepEqual(swap.to, ["cleaner"]);
  // правки человека в других строках остаются как были
  assert.deepEqual(swap.lines, [pickers, cleaners]);
});

test("обратно на машину: оператор по норме вместо уборщиков", () => {
  const swap = swapByNorm([cleaners], [operator], ["cleaner"]);
  assert.deepEqual(swap?.lines, [operator]);
});

test("нужная роль уже есть в штате или роли те же: предлагать нечего", () => {
  assert.equal(swapByNorm([operator, cleaners], [cleaners], ["scrubber_operator"]), null);
  assert.equal(swapByNorm([operator], [operator], ["scrubber_operator"]), null);
  // новая задача без прежней роли в штате: это не смена способа, строки добавит merge
  assert.equal(swapByNorm([pickers], [pickers, cleaners], ["picker"]), null);
});

test("подпись называет роли словами справочника", () => {
  const names = new Map([
    ["cleaner", "Уборщик"],
    ["scrubber_operator", "Оператор поломоечной машины"],
  ]);
  const text = swapText({ from: ["scrubber_operator"], to: ["cleaner"] }, names);
  assert.match(text, /нужна роль "Уборщик", а в штате "Оператор поломоечной машины"/);
});
