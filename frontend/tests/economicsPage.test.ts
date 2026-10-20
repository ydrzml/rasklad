/* Страница "Как читается экономика": запрос демо-расчета, допущения по группам, значения словами,
   "нет данных" отдельно от нуля и первые строки чувствительности. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dateText,
  demoRequest,
  groupSources,
  mergeSources,
  topImpacts,
  trustCounts,
  valueText,
  zeroUnknowns,
  type Source,
} from "../src/features/economics/data.ts";

const source = (path: string, value: number, trust: string, unit = "", name = path): Source => ({
  path,
  value,
  source: "источник",
  date: "2026-09",
  trust,
  unit,
  name,
});

test("демо-запрос: склад с паллетами на Ronavi H1500, прогон смены, аренда без выкупа", () => {
  const request = demoRequest(null);
  assert.equal(request.facility_id, "warehouse");
  assert.equal(request.robot_id, "ronavi-h1500");
  assert.equal(request.use_simulation, true);
  assert.equal(request.raas_buyout, false);
  assert.deepEqual(request.overrides, {});
});

test("кредит и лизинг меняют только способ оплаты", () => {
  assert.deepEqual(demoRequest(null, 1).overrides, { "financing.method": 1 });
  assert.deepEqual(demoRequest(null, 2).overrides, { "financing.method": 2 });
});

test("доля пишется процентом с остатком единицы, остальное числом с единицей", () => {
  assert.equal(valueText({ value: 0.07, unit: "доля в год" }), "7% в год");
  assert.equal(valueText({ value: 0.151, unit: "доля оклада" }), "15,1% оклада");
  assert.equal(valueText({ value: 0.95, unit: "доля" }), "95%");
  assert.equal(valueText({ value: 2979000, unit: "₽ в год" }), "2 979 000 ₽ в год");
  assert.equal(valueText({ value: [3, 5], unit: "лет" }), "3-5 лет");
});

test("дата источника месяцем и годом, без даты так и пишем", () => {
  assert.equal(dateText("2026-09"), "09.2026");
  assert.equal(dateText(null), "без даты");
});

test("допущения ищутся по концу пути: у робота в начале пути его id", () => {
  const groups = groupSources([
    source("economics.discount_rate", 0.14, "C", "доля в год"),
    source("robots.ronavi-h1500.price_rub", 2700000, "B", "₽"),
    source("robots.ronavi-h1500.battery_price_rub", 158000, "D", "₽"),
    source("facilities.warehouse.peak_factor", 1.5, "D", "раза"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.id),
    ["time", "robot"],
  );
  // цена аккумулятора не попадает под "price_rub" дважды
  const robot = groups.find((group) => group.id === "robot");
  assert.deepEqual(
    robot?.items.map((item) => item.path),
    ["robots.ronavi-h1500.price_rub", "robots.ronavi-h1500.battery_price_rub"],
  );
});

test("значения нескольких расчетов без повторов, у страховки свое название", () => {
  const merged = mergeSources([
    [source("economics.discount_rate", 0.14, "C")],
    [source("economics.discount_rate", 0.2, "F"), source("financing.insurance_share_year", 0.007, "D")],
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].value, 0.14);
  assert.equal(merged[1].name, "Страховка залога или предмета лизинга");
  assert.equal(valueText(merged[1]), "0,7% цены в год");
});

test("нет данных это ноль с оценкой F, а не любое нулевое значение", () => {
  const zeros = zeroUnknowns([
    source("economics.payroll.turnover_rate", 0, "F", "доля в год"),
    source("robots.ronavi-h1500.station_price_rub", 0, "F", "₽"),
    source("economics.payroll.workwear_rub_year", 5000, "F", "₽ в год"),
  ]);
  assert.deepEqual(
    zeros.map((one) => one.path),
    ["economics.payroll.turnover_rate"],
  );
});

test("счетчик оценок от S до F", () => {
  const counts = trustCounts([source("a", 1, "S"), source("b", 1, "F"), source("c", 1, "F")]);
  assert.equal(counts.length, 7);
  assert.equal(counts.find((one) => one.level === "F")?.count, 2);
  assert.equal(counts.find((one) => one.level === "A")?.count, 0);
});

const cell = (delta: number, saving: number) => ({
  delta,
  fleet: 9,
  baseline_tco_rub: 1,
  outcomes: [{ scenario_id: "purchase", payback_years: 1, tco_rub: 1, saving_rub: saving }],
});

const param = (id: string, swing: number, savings: number[]) => ({
  id,
  name: id,
  base: "сейчас",
  what: "",
  cells: savings.map((saving, index) => cell([-0.2, -0.1, 0, 0.1, 0.2][index], saving)),
  swings: [{ scenario_id: "purchase", rub: swing }],
});

test("чувствительность: самые сильные сверху, выгода как сейчас из среднего варианта", () => {
  const all = {
    horizon_years: 5,
    deltas: [-0.2, -0.1, 0, 0.1, 0.2],
    params: [param("weak", 10, [95, 98, 100, 102, 105]), param("strong", 80, [60, 80, 100, 120, 140])],
    flat: [],
    zeros: [],
  };
  const { base, rows } = topImpacts(all, "purchase", 1);
  assert.equal(base, 100);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "strong");
  assert.equal(rows[0].low, 60);
  assert.equal(rows[0].high, 140);
  assert.equal(rows[0].min, 60);
  assert.equal(rows[0].max, 140);
});
