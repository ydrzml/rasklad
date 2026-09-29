/* IRR словами: выше 100% пишем "больше 100%". Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { irrText, scenarioWord } from "../src/app/steps/economicsNames.ts";

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
