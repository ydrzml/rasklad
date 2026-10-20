/* Способы оплаты: выбор, строки на карточке решения с бюджетом и вывод на шаге экономики. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Solution } from "../src/api/client.ts";
import {
  ALL_WAYS,
  byCardPrice,
  cardLines,
  cardSortValue,
  DEFAULT_WAYS,
  savedWays,
  shiftOverrides,
  toggled,
  verdict,
} from "../src/app/steps/paymentWays.ts";

// Ronavi H1500 на демо-складе, как на шаге экономики: 9 роботов, суммы сервера в рублях
const DEMO = [
  { id: "own" as const, start: 41_390_000, tco: 119_600_000 },
  { id: "loan" as const, start: 8_280_000, tco: 133_100_000 },
  { id: "leasing" as const, start: 19_670_000, tco: 131_200_000 },
  { id: "raas" as const, start: 11_500_000, tco: 121_800_000 },
];
const BASELINE = 256_900_000;

test("по умолчанию покупка и аренда, кредит и лизинг только по отметке", () => {
  assert.deepEqual(DEFAULT_WAYS, ["own", "raas"]);
  assert.deepEqual(ALL_WAYS, ["own", "loan", "leasing", "raas"]);
});

test("снять последний способ нельзя, порядок всегда как в списке", () => {
  assert.deepEqual(toggled(["raas"], "raas"), ["raas"]);
  assert.deepEqual(toggled(["raas"], "own"), ["own", "raas"]);
  assert.deepEqual(toggled(ALL_WAYS, "loan"), ["own", "leasing", "raas"]);
});

test("битый или пустой выбор из черновика дает выбор по умолчанию", () => {
  assert.deepEqual(savedWays(undefined), DEFAULT_WAYS);
  assert.deepEqual(savedWays([]), DEFAULT_WAYS);
  assert.deepEqual(savedWays(["nothing"]), DEFAULT_WAYS);
  assert.deepEqual(savedWays(["raas", "own", "x"]), ["own", "raas"]);
});

test("вывод без бюджета: дешевле всего покупка за свои, на сколько и почему", () => {
  const text = verdict(DEMO, BASELINE, 5, null);
  assert.match(
    text,
    /^Выгоднее всего покупка за свои: за 5 лет дешевле кредита на 13,5, лизинга на 11,6, аренды на 2,2 млн ₽\./,
  );
  assert.match(text, /Дороже кредит на проценты, лизинг на удорожание/);
  assert.match(text, /Меньше всего своих денег на старте: кредит, 8,3 млн ₽\./);
  assert.doesNotMatch(text, /бюджет/);
});

test("вывод с бюджетом: выгоднейшее не влезает, называем лучшее из того, что влезает", () => {
  const text = verdict(DEMO, BASELINE, 5, 30_000_000);
  assert.match(
    text,
    /В бюджет 30,0 млн ₽ на старте укладывается: кредит, лизинг, аренда\. Из них выгоднее всего аренда\./,
  );
});

test("вывод с бюджетом, куда влезает все или ничего", () => {
  assert.match(verdict(DEMO, BASELINE, 5, 50_000_000), /укладывается все отмеченное\.$/);
  assert.match(verdict(DEMO, BASELINE, 5, 1_000_000), /не укладывается ничего из отмеченного\.$/);
});

test("один способ сравниваем с жизнью без роботов", () => {
  assert.equal(verdict([DEMO[3]], BASELINE, 5, null), "Аренда: за 5 лет дешевле, чем без роботов, на 135,1 млн ₽.");
  assert.equal(verdict([], BASELINE, 5, null), "");
});

const FIT = {
  fleet_needed: 10,
  investment_needed_rub: 44_660_000,
  loan_start_rub: 8_930_000,
  leasing_start_rub: 21_000_000,
  raas_start_rub: 11_830_000,
  raas_month_rub: 1_000_000,
};

test("карточка: отмеченные способы по порядку, аренда в месяц", () => {
  const lines = cardLines(FIT, ALL_WAYS, null);
  assert.deepEqual(
    lines.map((line) => [line.id, line.value, line.unit, line.over]),
    [
      ["own", "44,7", "млн ₽", false],
      ["loan", "8,9", "млн ₽", false],
      ["leasing", "21,0", "млн ₽", false],
      ["raas", "1,0", "млн ₽ в месяц", false],
    ],
  );
  assert.deepEqual(
    cardLines(FIT, ["raas", "loan"], null).map((line) => line.id),
    ["loan", "raas"],
  );
});

test("карточка: больше бюджета помечено по деньгам на старте, у аренды это подготовка объекта", () => {
  const over = Object.fromEntries(cardLines(FIT, ALL_WAYS, 20_000_000).map((line) => [line.id, line.over]));
  assert.deepEqual(over, { own: true, loan: false, leasing: true, raas: false });
  const tight = Object.fromEntries(cardLines(FIT, ALL_WAYS, 10_000_000).map((line) => [line.id, line.over]));
  assert.equal(tight.raas, true);
});

test("карточка без парка или без способа у решения: пусто, а не нули", () => {
  assert.deepEqual(cardLines(undefined, ALL_WAYS, null), []);
  assert.deepEqual(cardLines({ ...FIT, fleet_needed: null }, ALL_WAYS, null), []);
  assert.deepEqual(
    cardLines({ ...FIT, raas_month_rub: null }, ALL_WAYS, null).map((line) => line.id),
    ["own", "loan", "leasing"],
  );
});

// Шаг 4, "сначала дешевые": порядок по крупной цифре карточки, а не по цене штуки (снимок: DMR 1200 56,2, H1500 41,9, H2000 63,8, AMR 1500 36,0)
const unit = (robot: string, price: number) => ({ robot_id: robot, price_rub: price }) as unknown as Solution;
const FITS = {
  dmr: { fleet_needed: 12, investment_needed_rub: 56_200_000, raas_month_rub: 1_100_000 },
  h1500: { fleet_needed: 12, investment_needed_rub: 41_900_000, raas_month_rub: 1_400_000 },
  h2000: { fleet_needed: 20, investment_needed_rub: 63_800_000, raas_month_rub: 0.9e6 },
  amr: { fleet_needed: 12, investment_needed_rub: 36_000_000, raas_month_rub: 1_000_000 },
};
const CATALOG = [unit("dmr", 4_000_000), unit("h1500", 2_700_000), unit("h2000", 2_600_000), unit("amr", 2_200_000)];
const order = (list: Solution[]) => list.map((one) => one.robot_id);

test("сначала дешевые: по возрастанию своих денег на старте, не по цене штуки", () => {
  assert.deepEqual(order(byCardPrice(CATALOG, FITS, ["own", "raas"])), ["amr", "h1500", "dmr", "h2000"]);
});

test("сначала дешевые: решения без цифры от сервера в конце, среди них по цене штуки", () => {
  const list = [unit("none-b", 3_000_000), unit("dmr", 4_000_000), unit("none-a", 1_000_000), unit("amr", 2_200_000)];
  assert.deepEqual(order(byCardPrice(list, FITS, ["own"])), ["amr", "dmr", "none-a", "none-b"]);
});

test("сначала дешевые: если отмечена одна аренда, сортируем по платежу в месяц", () => {
  assert.equal(cardSortValue(FITS.h2000, ["raas"]), 0.9e6);
  assert.deepEqual(order(byCardPrice(CATALOG, FITS, ["raas"])), ["h2000", "amr", "dmr", "h1500"]);
});

test("сначала дешевые не меняет исходный список", () => {
  const copy = order(CATALOG);
  byCardPrice(CATALOG, FITS, ["own"]);
  assert.deepEqual(order(CATALOG), copy);
});

test("все способы дороже людей: не называем выгодным, говорим, где меньше потерь", () => {
  const rows = [
    { id: "own" as const, start: 2_900_000, tco: 6_700_000 },
    { id: "loan" as const, start: 600_000, tco: 7_700_000 },
  ];
  const text = verdict(rows, 2_900_000, 5, null);
  assert.match(
    text,
    /^Любым способом за 5 лет дороже, чем без роботов\. Меньше всего потерь: покупка за свои, дешевле кредита на 1,0 млн ₽\./,
  );
  assert.doesNotMatch(text, /Выгоднее/);
});

test("смене на плане не передаем способ оплаты и другие денежные правки", () => {
  const all = {
    "financing.method": 1,
    "financing.loan_rate": 0.15,
    "subsidies.tech.chosen": 1,
    "ramp_up.share": 0.5,
    "roles.picker.salary": 90_000,
    "facilities.warehouse.peak_factor": 1.4,
  };
  assert.deepEqual(shiftOverrides(all), { "facilities.warehouse.peak_factor": 1.4 });
  assert.deepEqual(shiftOverrides({}), {});
});
