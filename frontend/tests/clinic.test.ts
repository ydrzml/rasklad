/* Итог медучреждения словами: те же правила, что у шага 5 склада. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkedWhen, clinicWords, staffWords, type ClinicScenarioWords } from "../src/app/steps/clinic.ts";

// типовой корпус, доставка по этажам: суммы сервера в рублях
const BASE: ClinicScenarioWords = {
  id: "baseline",
  available: true,
  why_not: "",
  start_rub: 0,
  tco_rub: 7_630_000,
  effect_year1_rub: 0,
  payback_years: null,
  month_rub: null,
};
const BUY: ClinicScenarioWords = {
  ...BASE,
  id: "purchase",
  start_rub: 2_822_000,
  tco_rub: 6_420_000,
  effect_year1_rub: 600_000,
  payback_years: 4.13,
};
const NO_RENT: ClinicScenarioWords = {
  ...BASE,
  id: "raas",
  available: false,
  why_not: "Цену аренды не нашли: Pudu FlashBot Max",
  tco_rub: 0,
};

test("без цены аренды: ответ про покупку и честное окно про аренду", () => {
  const out = clinicWords(7, [BASE, BUY, NO_RENT]);
  assert.ok(out);
  assert.equal(out.head, "Покупка окупится за 4,1 года");
  assert.equal(
    out.sub,
    "Вложить 2,8 млн ₽, экономия 0,6 млн ₽ в год. За 7 лет дешевле, чем без роботов, на 1,2 млн ₽.",
  );
  assert.equal(out.best, null);
  assert.equal(out.rent.title, "Аренду не считаем");
  assert.match(out.rent.text, /^Цену аренды не нашли: Pudu FlashBot Max\. Придумывать цену не будем/);
});

test("аренда с ценой: выгоднее то, что дешевле за срок, и про склад ни слова", () => {
  const rent = {
    ...NO_RENT,
    available: true,
    why_not: "",
    tco_rub: 9_000_000,
    effect_year1_rub: -200_000,
    month_rub: 104_000,
  };
  const out = clinicWords(7, [BASE, BUY, rent]);
  assert.ok(out);
  assert.equal(out.best, "buy");
  assert.equal(out.rent.title, "Почему не аренда");
  assert.match(out.rent.text, /дороже покупки на 2,6 млн ₽, платеж 0,1 млн ₽ в месяц/);
  assert.doesNotMatch(`${out.head} ${out.sub} ${out.rent.text}`, /склад/);
});

test("нет сценария: ответа нет", () => {
  assert.equal(clinicWords(7, [BASE, BUY]), null);
});

test("без сокращения бюджета нет обещания денежной окупаемости", () => {
  const out = clinicWords(7, [BASE, BUY, NO_RENT], 0);
  assert.equal(out?.head, "Сокращение бюджета не подтверждено");
  assert.equal(out?.best, null);
  assert.doesNotMatch(out?.head ?? "", /окупится/);
});

test("при недовыполнении объема не выбираем выгодный парк по одной цене", () => {
  const out = clinicWords(7, [BASE, BUY, NO_RENT], 1, false);
  assert.equal(out?.head, "Достаточность парка не подтверждена");
  assert.equal(out?.best, null);
});

test("нулевой результат и срок за горизонтом не считаются прибыльной окупаемостью", () => {
  for (const purchase of [
    { ...BUY, tco_rub: BASE.tco_rub, payback_years: 7 },
    { ...BUY, payback_years: null },
    { ...BUY, payback_years: 8 },
  ]) {
    const out = clinicWords(7, [BASE, purchase, NO_RENT]);
    assert.equal(out?.best, null);
    assert.equal(out?.head, "Окупаемость с положительным результатом не подтверждена");
  }
});

test("дешевая аренда без подтвержденного возврата вложений не вытесняет окупаемую покупку", () => {
  const rent = { ...NO_RENT, available: true, tco_rub: 5_000_000, payback_years: null };
  assert.equal(clinicWords(7, [BASE, BUY, rent])?.best, "buy");
});

test("годовая аренда не выдается за ежемесячный платеж", () => {
  const out = clinicWords(7, [
    BASE,
    BUY,
    { ...NO_RENT, available: true, tco_rub: 9_000_000, month_rub: 50_000, rent_period: "year" },
  ]);
  assert.match(out?.rent.text ?? "", /0,6 млн ₽ в год/);
  assert.doesNotMatch(out?.rent.text ?? "", /в месяц/);
});

test("люди: доля ставки из санитаров датасета", () => {
  assert.match(staffWords(1.03, 65), /^Роботы забирают рейсы санитаров: это 1,0 ставки из 65 санитаров/);
  assert.match(staffWords(0.04, 65), /меньше 0,1 ставки/);
});

test("у цифры дата проверки словами, без даты так и пишем", () => {
  assert.equal(checkedWhen("2026-10"), "проверено: октябрь 2026");
  assert.equal(checkedWhen(null), "дата не указана");
  assert.equal(checkedWhen("когда-то"), "дата не указана");
});
