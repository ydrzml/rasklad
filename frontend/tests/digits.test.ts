/* Числа в полях: пробелы по разрядам на экране, число без пробелов наверх. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { groupDigits, plainDigits } from "../src/ui/digits.ts";

const nb = " ";

test("большое число делится пробелами по три цифры, дробь пишется с запятой", () => {
  assert.equal(groupDigits(10000), `10${nb}000`);
  assert.equal(groupDigits("120000"), `120${nb}000`);
  assert.equal(groupDigits(1234567.5), `1${nb}234${nb}567,5`);
  assert.equal(groupDigits(0.15), "0,15");
  assert.equal(groupDigits(-2500), `-2${nb}500`);
  assert.equal(groupDigits(950), "950");
});

test("то, что не похоже на число, остается как есть", () => {
  assert.equal(groupDigits(""), "");
  assert.equal(groupDigits("1e-7"), "1e-7");
});

test("из поля уходит число без пробелов и с точкой", () => {
  assert.equal(plainDigits(`10${nb}000`), "10000");
  assert.equal(plainDigits("12 500"), "12500");
  assert.equal(plainDigits("1,7"), "1.7");
  assert.equal(plainDigits("1,"), "1.");
  assert.equal(plainDigits(""), "");
});

test("пока набрано не число, наверх ничего не уходит", () => {
  assert.equal(plainDigits("-"), null);
  assert.equal(plainDigits("12а"), null);
  assert.equal(plainDigits("1,2,3"), null);
});
