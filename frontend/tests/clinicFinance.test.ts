import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreClinicFinance } from "../src/app/clinic/finance.ts";

test("сценарные условия медучреждения восстанавливаются с явным нулем реализации", () => {
  assert.deepEqual(restoreClinicFinance({ cash_realization_share: 0, cleaner_hour_rub: 600 }), {
    cash_realization_share: 0,
    cleaner_hour_rub: 600,
  });
});

test("поврежденное сохранение не превращается в обещание экономии", () => {
  assert.deepEqual(
    restoreClinicFinance({
      cash_realization_share: 100,
      days_per_year: 100.5,
      cleaner_hour_rub: -1,
      integration_rub: NaN,
      arbitrary: 1,
    }),
    {},
  );
  assert.deepEqual(restoreClinicFinance(null), {});
});
