/* Бюджет на старте на шаге экономики: какой сценарий открыт сначала и строки про бюджет. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { budgetLine, firstScenario, overBudget } from "../src/app/steps/economicsNames.ts";

// Эталон склада по плану: покупка 40,6 млн на старте и дешевле за 5 лет, аренда 11,5 млн на старте
const purchase = { id: "purchase", tco_rub: 180e6, investment_year0_rub: 40.6e6 };
const raas = { id: "raas", tco_rub: 205e6, investment_year0_rub: 11.5e6 };

test("сначала всегда покупка, даже когда аренда дешевле за горизонт", () => {
  assert.equal(firstScenario(purchase).id, "purchase");
  // аренда дешевле за горизонт: плитка помечена ниже, но сводка все равно открыта покупкой
  assert.equal(firstScenario({ ...purchase, tco_rub: 250e6 }).id, "purchase");
  // аренда на старте почти ничего не стоит и в бюджет влезает, но сама не открывается
  assert.equal(overBudget(raas, 20e6), false);
});

test("покупка больше бюджета: открыта покупка, а не аренда сама", () => {
  // при бюджете 20 млн сводка сама не открывается на аренде, хотя она в бюджет влезает
  assert.equal(overBudget(purchase, 20e6), true);
  assert.equal(firstScenario(purchase).id, "purchase");
  // даже если аренда еще и дешевле: человек смотрит покупку и видит строку, что можно взять аренду
  assert.equal(firstScenario(purchase).id, "purchase");
});

test("покупка в бюджет влезает: как без бюджета, покупка", () => {
  assert.equal(overBudget(purchase, 50e6), false);
  assert.equal(firstScenario(purchase).id, "purchase");
  assert.equal(overBudget(purchase, 0), false); // пустое поле ничего не меняет
});

test("кредит или лизинг: открыта покупка, ее человек и выбрал", () => {
  assert.equal(firstScenario(purchase).id, "purchase");
});

test("строка про бюджет по задаче простыми словами", () => {
  assert.equal(
    budgetLine({ operation_name: "Перевозка паллет", fleet_fits: 2, fleet_needed: 9, done_share: 0.44 }),
    "Перевозка паллет: на бюджет можно купить 2 робота из 9 нужных, они сделают 44% работы смены",
  );
  assert.equal(
    budgetLine({ operation_name: "Перевозка паллет", fleet_fits: 1, fleet_needed: 9, done_share: 0.18 }),
    "Перевозка паллет: на бюджет можно купить 1 робота из 9 нужных, он сделает 18% работы смены",
  );
  assert.equal(
    budgetLine({ operation_name: "Уборка полов", fleet_fits: 0, fleet_needed: 3, done_share: null }),
    "Уборка полов: на бюджет не купить ни одного робота, подготовка объекта под роботов уже дороже",
  );
  assert.equal(
    budgetLine({ operation_name: "Отбор", fleet_fits: 5, fleet_needed: 12 }),
    "Отбор: на бюджет можно купить 5 роботов из 12 нужных",
  );
  assert.equal(
    budgetLine({ operation_name: "Отбор", fleet_fits: 4, fleet_needed: 4, done_share: 1 }),
    "Отбор: на бюджет можно купить все 4 робота, сколько нужно",
  );
});
