import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreClinicQuotes, htmlEscape } from "../src/app/clinic/customer.ts";
import { restoreClinicFinance } from "../src/app/clinic/finance.ts";
import { restoreClinicSizing, sizingBasis } from "../src/app/clinic/optimization.ts";

test("условия разных поставщиков сохраняются по модели, включая явно бесплатные статьи", () => {
  const quotes = {
    a: { source: "КП №1", price_rub: 0, commissioning_rub: 0, maintenance_rub_year: 100, life_years: 7 },
    b: { source: "КП №2", price_rub: 1500000, rent_month_rub: 20000 },
  };
  assert.deepEqual(restoreClinicQuotes(JSON.parse(JSON.stringify(quotes))), quotes);
  assert.deepEqual(
    restoreClinicQuotes({ a: { life_years: 0, price_rub: -1, maintenance_rub_year: Infinity, unknown: 100 } }),
    { a: {} },
  );
  assert.deepEqual(restoreClinicQuotes([]), {});
});

test("хронометраж, календарь и предел расходов не исчезают после перезагрузки", () => {
  const finance = {
    manual_delivery_min_per_job: 17,
    manual_cleaning_m2_per_hour: 175,
    delivery_staff_per_shift: 5,
    cleaning_staff_per_shift: 0,
    delivery_hour_rub: 850,
    days_per_year: 250,
    cash_saving_cap_rub_year: 0,
    discount_rate: 0.18,
    annual_work_hours: 1800,
    wage_growth: 0,
    inflation: 0.04,
  };
  assert.deepEqual(restoreClinicFinance(JSON.parse(JSON.stringify(finance))), finance);
  assert.deepEqual(
    restoreClinicFinance({ manual_cleaning_m2_per_hour: 0, discount_rate: 2, days_per_year: 250.5 }),
    {},
  );
});

test("перестановка полей при сохранении не отменяет проверенный подбор", () => {
  const left = {
    operation_ids: ["floor_delivery", "cleaning"],
    overrides: { "clinic.orderlies": 5, "clinic.floors": 1 },
    quotes: { a: { price_rub: 100, life_years: 5 } },
    assumptions: { days_per_year: 250, discount_rate: 0.15 },
  };
  const right = {
    operation_ids: ["floor_delivery", "cleaning"],
    overrides: { "clinic.floors": 1, "clinic.orderlies": 5 },
    quotes: { a: { life_years: 5, price_rub: 100 } },
    assumptions: { discount_rate: 0.15, days_per_year: 250 },
  };
  assert.equal(sizingBasis(left), sizingBasis(right));
  const selected = {
    basis: sizingBasis(left),
    robot_id: "d",
    cleaner_id: "a",
    fleet: 0,
    cleaners: { 1: 1 },
    operation_ids: ["cleaning"],
  };
  assert.deepEqual(restoreClinicSizing(selected), selected);
  assert.equal(restoreClinicSizing({ ...selected, operation_ids: ["cart_transport"] }), null);
});

test("ввод заказчика экранируется в печатном отчете", () => {
  assert.equal(
    htmlEscape('<script>alert("x")</script> & КП'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; КП",
  );
  assert.equal(htmlEscape(null), "");
});
