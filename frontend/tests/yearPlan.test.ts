/* План на 5 лет по годам и рекомендация по цифрам сервера. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CalculationResult } from "../src/api/client.ts";
import { buyMarks, buyoutLine, crossing, hasYearPlan, planRows, verdict } from "../src/app/steps/yearPlan.ts";

// демо паллет, 13 Ronavi H1500: накопленные затраты сервера, млн ₽ на конец года, год 0 это старт
const M = (values: number[]) => values.map((value) => value * 1_000_000);
const DEMO = {
  horizon: 5,
  none: M([0, 24.06, 49.79, 77.34, 106.8, 138.34]),
  buy: M([45.01, 51.27, 57.22, 65.29, 71.87, 78.77]),
  rent: M([10.39, 26.21, 41.59, 57.13, 74.46, 91.97]),
  trial: M([10.39, 49.22, 55.17, 63.25, 69.82, 76.73]),
  buyPayback: 2.38,
  buyout: { year: 3, price: 11.51e6, tco: 82.12e6, cheaper: 9.85e6, payback: 1.08 },
};

test("строки: за год это разность накопленных, год 0 это старт", () => {
  const rows = planRows(DEMO);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].cells.buy?.year, 45.01e6);
  assert.ok(Math.abs((rows[1].cells.buy?.year ?? 0) - 6.26e6) < 1);
  assert.equal(rows[5].cells.none?.total, 138.34e6);
});

test("отметки: покупка окупилась на 3-м году, дешевле аренды с 4-го", () => {
  const rows = planRows(DEMO);
  assert.deepEqual(
    rows.filter((row) => row.paidBack).map((row) => row.year),
    [3],
  );
  assert.deepEqual(
    rows.filter((row) => row.buyBeatsRent).map((row) => row.year),
    [4],
  );
});

test("один вывод: сначала аренда дешевле, потом покупка, итог за 5 лет", () => {
  assert.equal(
    verdict(DEMO),
    "Первые 3 года аренда обходится дешевле, с 4-го года покупка выгоднее. Итог за 5 лет: покупка 78,8 против 92,0 млн ₽ в аренде. Год аренды, потом выкуп выходит почти как покупка, 76,7 млн ₽, и дает проверить роботов.",
  );
  // вывод не спорит с отметкой в таблице: покупка дешевле аренды с того же 4-го года
  assert.equal(planRows(DEMO).find((row) => row.buyBeatsRent)?.year, 4);
});

test("точки графика: окупилась против людей, дешевле аренды", () => {
  const paid = crossing(DEMO.buy, DEMO.none);
  assert.ok(paid != null && paid > 2 && paid < 3);
  const beats = crossing(DEMO.buy, DEMO.rent);
  assert.ok(beats != null && beats > 3 && beats < 4);
  assert.equal(crossing(DEMO.rent, DEMO.buy), null);
});

test("аренда дешевле все 5 лет", () => {
  const rent = M([10.39, 20, 30, 40, 50, 60]);
  assert.equal(
    verdict({ ...DEMO, rent, trial: null, buyout: null }),
    "Все 5 лет аренда обходится дешевле покупки. Итог за 5 лет: аренда 60,0 против 78,8 млн ₽ при покупке.",
  );
});

test('покупка дешевле только со 2-й точки: без "первые 0 лет"', () => {
  const rent = M([40, 52, 64, 76, 88, 100]);
  assert.equal(
    verdict({ ...DEMO, rent, trial: null }),
    "Аренда дешевле только на старте, с 1-го года покупка выгоднее. Итог за 5 лет: покупка 78,8 против 100,0 млн ₽ в аренде.",
  );
});

test("все дороже людей: без роботов дешевле", () => {
  const out = verdict({
    horizon: 5,
    none: M([0, 1, 2, 3.5, 4.6, 5.8]),
    buy: M([2.7, 3.6, 4.5, 5.4, 6.3, 7.2]),
    rent: M([0.2, 2.3, 4.5, 6.6, 8.7, 10.8]),
    buyPayback: null,
  });
  assert.equal(out, "Без роботов дешевле: за 5 лет 5,8 млн ₽ против 7,2 млн ₽ при покупке и 10,8 млн ₽ в аренде.");
  const rows = planRows({ horizon: 5, none: M([0, 1, 2, 3, 4, 5]), buy: M([2, 3, 4, 5, 6, 7]), buyPayback: null });
  assert.ok(rows.every((row) => !row.paidBack));
});

test("выкуп в конце договора одной фразой", () => {
  assert.equal(
    buyoutLine(DEMO.buyout, 5),
    "Если арендовать, выкупить роботов в конце договора (3-й год, 11,5 млн ₽) выгодно: за 5 лет выйдет на 9,9 млн ₽ дешевле, чем платить аренду до конца.",
  );
  assert.equal(buyoutLine(null, 5), null);
});

test("точки графика: те же пересечения, что в таблице, для шага 5 и разборов", () => {
  const marks = buyMarks(DEMO.buy, DEMO.none, DEMO.rent);
  assert.deepEqual(
    marks.map((mark) => [mark.key, mark.label, mark.below]),
    [
      ["paid", "покупка окупилась", false],
      ["beats", "покупка дешевле аренды", true],
    ],
  );
  assert.equal(marks[0].at, crossing(DEMO.buy, DEMO.none));
  // без аренды точки "дешевле аренды" нет
  assert.deepEqual(
    buyMarks(DEMO.buy, DEMO.none, null).map((mark) => mark.key),
    ["paid"],
  );
});

test("ссылка на план под карточками только когда есть накопленные затраты", () => {
  const result = (ids: string[]) =>
    ({ scenarios: ids.map((id) => ({ id, cumulative_cost_rub: [1, 2] })) }) as unknown as CalculationResult;
  assert.equal(hasYearPlan(result(["baseline", "purchase"])), true);
  assert.equal(hasYearPlan(result(["baseline"])), false);
});
