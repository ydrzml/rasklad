/* IRR словами: выше 100% пишем "больше 100%". Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buyoutText, irrText, scenarioWord, times } from "../src/app/steps/economicsNames.ts";

test("IRR до 100% числом, выше словами", () => {
  assert.equal(irrText(0.8115, 84.9e6, 40.6e6), "81%");
  assert.equal(irrText(2.0873, 87.7e6, 11.5e6), "больше 100%");
  assert.equal(irrText(1, 1, 1), "100%");
});

test("пустой IRR: выше 1000%, не окупается или вложений нет", () => {
  assert.equal(irrText(null, 1, 1), "больше 100%");
  assert.equal(irrText(null, -1, 1), "не окупается");
  assert.equal(irrText(null, 1, 0), "вложений нет");
});

test("покупку в кредит называем так же, как сервер", () => {
  assert.equal(scenarioWord({ id: "purchase", name: "Покупка в кредит" }), "Покупка в кредит");
  assert.equal(scenarioWord({ id: "raas", name: "Роботы как услуга" }), "Аренда");
});

test("ROI по формуле ТЗ разами, чтобы не путать с ROI в процентах", () => {
  assert.equal(times(3.9491), "3,9 раза");
  assert.equal(times(1), "1,0 раза");
  assert.equal(times(-0.74), "-0,7 раза");
  assert.equal(times(null), "—");
});

test("выкуп в аренде одной фразой: цена, год в год, когда окупится, насколько дешевле", () => {
  const buyout = {
    year: 3,
    price_rub: 9_720_000,
    rent_year_rub: 12_427_300,
    own_year_rub: 3_407_700,
    payback_years: 1.0776,
    cheaper_rub: 8_319_400,
    worth: true,
  };
  assert.equal(
    buyoutText(buyout),
    "Выкуп в конце 3 года: 9,7 млн ₽, после выкупа 3,4 млн ₽ в год на обслуживание вместо 12,4 млн ₽ аренды, " +
      "выкуп окупится за 1,1 года, за срок расчета с выкупом дешевле на 8,3 млн ₽.",
  );
  assert.match(buyoutText({ ...buyout, payback_years: null, worth: false }), /выкуп не окупается, за срок расчета/);
});
