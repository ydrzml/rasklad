/* Строки-сводки шага 5: что берем из ответа сервера "что будет, если" и "что подготовить", и строка
   вывода кривой парка у смены. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readinessBrief, whatIfBrief } from "../src/app/steps/digests.ts";
import { fleetVerdict } from "../src/app/steps/economicsNames.ts";

const term = (years: number | null | undefined) => (years == null ? "не окупается" : `${years} г`);

// ячейка: сдвиг, окупаемость покупки и аренды; baseline null значит "парк не сходится"
const cell = (delta: number, purchase: number | null, raas: number | null = 1, fits = true) => ({
  delta,
  baseline_tco_rub: fits ? 100e6 : null,
  outcomes: [
    { scenario_id: "purchase", payback_years: purchase },
    { scenario_id: "raas", payback_years: raas },
  ],
});

test("что будет, если: от и до по окупаемости сервера, худший сдвиг словами", () => {
  const data = {
    params: [
      { id: "salary", name: "Зарплаты", cells: [cell(-0.2, 1.7), cell(-0.1, 1.5), cell(0, 1.3), cell(0.1, 1.2), cell(0.2, 1.1)] },
      { id: "price", name: "Цена робота", cells: [cell(-0.2, 1.2), cell(0, 1.3), cell(0.2, 1.4)] },
    ],
  };
  const brief = whatIfBrief(data, "purchase", term);
  assert.deepEqual(
    brief.facts.map((fact) => fact.value),
    ["1.1 г", "1.7 г"],
  );
  assert.equal(brief.line, "Хуже всего: зарплаты -20%. Сдвиги на 10 и 20%");
});

test("плата за аренду у покупки не считается: в таблице этой строки нет", () => {
  const data = {
    params: [
      { id: "salary", name: "Зарплаты", cells: [cell(-0.2, 1.5), cell(0, 1.3)] },
      { id: "raas_fee", name: "Аренда", cells: [cell(0.2, 9), cell(0, 1.3)] },
    ],
  };
  assert.equal(whatIfBrief(data, "purchase", term).facts[1].value, "1.5 г");
  // у аренды та же строка в счет идет
  assert.equal(whatIfBrief(data, "raas", term).facts.length, 2);
});

test("парк не сходится и не окупается: ближний к нынешнему сдвиг, а не любой", () => {
  const broken = {
    params: [
      {
        id: "volume",
        name: "Объем",
        cells: [cell(0, 1.3), cell(0.2, null, 1, false), cell(0.1, null, 1, false)],
      },
    ],
  };
  assert.equal(whatIfBrief(broken, "purchase", term).line, "Парк не справится: объем +10%");
  const lost = { params: [{ id: "salary", name: "Зарплаты", cells: [cell(-0.2, null), cell(0, 1.3)] }] };
  assert.equal(whatIfBrief(lost, "purchase", term).line, "Не окупится: зарплаты -20%");
});

test("что будет, если: пока нет ответа и когда ничего не посчиталось", () => {
  assert.deepEqual(whatIfBrief(null, "purchase", term), { facts: [], line: "Считаем варианты..." });
  const none = { params: [{ id: "salary", name: "Зарплаты", cells: [cell(0, null)] }] };
  assert.equal(whatIfBrief(none, "purchase", term).facts.length, 0);
});

test("что подготовить: три счетчика и первый пункт, аббревиатуры не портим", () => {
  const brief = readinessBrief({
    items: [
      { title: "Ровность пола", status: "check" },
      { title: "WMS отдает задания", status: "redo" },
    ],
    counts: { redo: 1, check: 1 },
  });
  assert.deepEqual(
    brief.facts.map((fact) => fact.value),
    ["1", "1", "0"],
  );
  assert.equal(brief.line, "Первым переделать: WMS отдает задания");
  assert.equal(
    readinessBrief({ items: [{ title: "Ровность пола", status: "check" }], counts: { check: 1 } }).line,
    "Первым проверить: ровность пола",
  );
  assert.equal(readinessBrief({ items: [], counts: {} }).line, "Все готово к роботам");
  assert.equal(readinessBrief(null).line, "Собираем список...");
});

test("строка кривой парка у смены", () => {
  assert.equal(
    fleetVerdict({ needed: 9, fleet: 9, demand: 148.98, washing: false }),
    "9 роботов вытягивают спрос 149 в час, 8 уже не хватает",
  );
  assert.equal(
    fleetVerdict({ needed: 11, fleet: 9, demand: 149, washing: false }),
    "На этом плане спрос 149 в час вытягивают 11 роботов. Экономика пересчитается с ним",
  );
  assert.match(fleetVerdict({ needed: null, fleet: 9, demand: 149, washing: false }), /не вытянуть и 250 роботами/);
  assert.equal(
    fleetVerdict({ needed: 1, fleet: 1, demand: 366, washing: true }),
    "1 робот успевает площадь смены, это 366 м² в час с запасом",
  );
});
