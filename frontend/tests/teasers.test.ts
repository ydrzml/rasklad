/* Первый экран разбора: три пункта справа и фразы ролика из чисел сервера. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { casePoints, refillOf, totalsText, type CaseNumbers } from "../src/features/cases/teaser.ts";
import { plural } from "../src/features/cases/verdict.ts";

const format = {
  mln: (rub: number) => (rub / 1e6).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  term: (years: number | null | undefined) =>
    years == null ? "не окупается" : `${String(years).replace(".", ",")} года`,
  plural,
};

// числа разбора паллет из ответа сервера
const pallets: CaseNumbers = {
  robotName: "Ronavi H1500",
  unit: ["паллета", "паллеты", "паллет"],
  fleet: 9,
  peak: 129.5,
  design: 149,
  horizon: 5,
  investment: 41_350_000,
  rentStart: 11_490_000,
  payback: 1.1,
  effect: 37_660_000,
  peopleBefore: 24,
  peopleAfter: 1,
  baselineTotal: 256_860_000,
  purchaseTotal: 76_910_000,
};

test("пункты называют парк, вложения и экономию теми же числами, что ответ сервера", () => {
  const [work, money, people] = casePoints(pallets, format);
  assert.equal(work.big, "9 роботов Ronavi H1500");
  assert.equal(
    work.note,
    "Рассчитаны на 149 паллет в час, это пик 130 и запас 15%. Прогон смены на плане это подтвердил",
  );
  assert.equal(money.big, "41,4 млн ₽ вернутся за 1,1 года");
  assert.equal(money.note, "Покупка за свои деньги. В аренду на старте 11,5 млн ₽");
  assert.equal(people.label, "Сколько сэкономите");
  // однозначно: экономия за 5 лет цветом выгоды, первый год и люди в пояснении
  assert.equal(people.big, "Экономия 180,0 млн ₽ за 5 лет");
  assert.equal(people.tone, "gain");
  assert.equal(people.note, "В первый год экономия 37,7 млн ₽. Было: 24 ставки, останется: 1 ставка");
});

test("фраза ролика про людей берет ту же разницу за 5 лет, что пункт справа", () => {
  const [work, money, people] = casePoints(pallets, format);
  assert.equal(work.phrase, "9 роботов везут 130 паллет в час");
  assert.equal(money.phrase, "41,4 млн ₽ на старте вернутся за 1,1 года");
  assert.equal(people.phrase, "Экономия за 5 лет: 180,0 млн ₽");
});

test("покупка, которая не возвращается, так и названа", () => {
  const cleaning = {
    ...pallets,
    fleet: 1,
    payback: null,
    effect: 0,
    baselineTotal: 5_800_000,
    purchaseTotal: 7_250_000,
  };
  const [, money, people] = casePoints(cleaning, format);
  assert.equal(money.big, "41,4 млн ₽ не окупаются");
  // в досчете до 10 лет окупается: примерно целыми годами и пометка, что это дольше горизонта
  const [, later] = casePoints({ ...cleaning, later: 5.2 }, format);
  assert.equal(later.big, "41,4 млн ₽ вернутся примерно за 6 лет, дольше горизонта расчета в 5 лет");
  assert.equal(people.big, "Дороже на 1,5 млн ₽ за 5 лет");
  assert.equal(people.tone, "loss");
  assert.equal(people.phrase, "С роботами дороже на 1,5 млн ₽ за 5 лет");
  assert.match(people.note, /^В первый год экономии нет\./);
});

test("без запаса над пиком пункт называет только пик", () => {
  const [work] = casePoints({ ...pallets, design: 129.5 }, format);
  assert.equal(work.note, "Рассчитаны на пик 130 паллет в час. Прогон смены на плане это подтвердил");
});

test("сосуд вложений наполняется за срок окупаемости, иначе видно, какая доля вернулась", () => {
  assert.deepEqual(refillOf(41_350_000, 37_660_000, 1.1, 5), { months: 13, perMonth: 37_660_000 / 12, share: 1 });
  const short = refillOf(2_710_000, 180_000, null, 5);
  assert.equal(short.months, null);
  assert.equal(Math.round(short.share * 100), 33);
  // экономия за горизонт известна: доля по ней, как на графике, а не первый год на 5
  assert.equal(Math.round(refillOf(73_190_000, 8_330_000, null, 5, 69_780_000).share * 100), 95);
  // экономии нет: сосуд пустой, а на сколько расходы выше, видно
  assert.deepEqual(refillOf(4_440_000, -230_000, null, 5, -1_270_000), {
    months: null,
    perMonth: 0,
    share: 0,
    loss: 230_000,
  });
});

test("уборка: в среднем вместо пика, свой глагол и окупаемость аренды рядом со стартом", () => {
  const cleaning = { ...pallets, verb: "убирают", average: true, unit: ["м²", "м²", "м²"] as [string, string, string] };
  const [work, money] = casePoints({ ...cleaning, rentPayback: null }, format);
  assert.match(work.note, /это в среднем 130 и запас/);
  assert.equal(work.phrase, "9 роботов убирают 130 м² в час");
  assert.equal(money.note, "Покупка за свои деньги. В аренду на старте 11,5 млн ₽, не окупается");
  const [, slow] = casePoints({ ...cleaning, rentPayback: null, rentLater: 8.6 }, format);
  assert.match(slow.note, /, окупится примерно за 9 лет, дольше горизонта расчета в 5 лет$/);
  const [, rent] = casePoints({ ...pallets, rentPayback: 1.21 }, format);
  assert.match(rent.note, /, окупится за 1,2 года$/);
});

test("разница за горизонт: меньше, дороже или одинаково", () => {
  assert.equal(totalsText(10e6, 4e6, 5, format.mln), "За 5 лет на 6,0 млн ₽ меньше, чем без роботов");
  assert.equal(totalsText(4e6, 10e6, 5, format.mln), "За 5 лет на 6,0 млн ₽ дороже, чем без роботов");
  assert.equal(totalsText(4e6, 4.01e6, 5, format.mln), "За 5 лет выходит одинаково");
});
