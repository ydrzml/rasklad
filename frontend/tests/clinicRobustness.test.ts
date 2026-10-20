import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClinicCaseAssessment, ClinicOptimizationCandidate, ClinicServiceScore } from "../src/api/client.ts";
import {
  assessReady,
  candidateSizing,
  profileSummary,
  paybackReady,
  restoreClinicSizing,
  robustProfiles,
  serviceReady,
  sizingFor,
} from "../src/app/clinic/optimization.ts";

const score: ClinicServiceScore = {
  on_time_share: 0.99,
  urgent_on_time_share: 1,
  completion_share: 1,
  cleaning_coverage: 1,
  overdue_unfinished: 0,
  carryover_jobs: 1,
};
const targets = { on_time_share: 0.95, urgent_on_time_share: 1 };
const request = {
  operation_ids: ["floor_delivery"],
  overrides: {},
  building: null,
  robot_id: "robot",
  cleaner_id: "cleaner",
};

test("общая доля вовремя не подтверждает срочные, завершение и уборку", () => {
  assert.ok(serviceReady(score));
  assert.equal(serviceReady({ ...score, urgent_on_time_share: 0.9 }), false);
  assert.equal(serviceReady({ ...score, completion_share: 0.99 }), false);
  assert.equal(serviceReady({ ...score, cleaning_coverage: 0.999 }), false);
  assert.equal(serviceReady({ ...score, on_time_share: 0.94 }), false);
  assert.ok(serviceReady({ ...score, on_time_share: 0.94 }, 0.9));
});

test("неполная проверка условий не разрешает применять состав парка", () => {
  const assessments = robustProfiles().map(
    (profile) =>
      ({
        profile,
        training: score,
        validation: score,
        runs: 6,
        incremental_cost_range_rub: [1, 2],
        labour_balance_range_hours: [3, 4],
        payback_years: null,
        payback_met: false,
      }) as ClinicCaseAssessment,
  );
  assert.ok(assessReady(assessments, targets));
  assert.equal(
    assessReady(
      assessments.map((a, i) => (i ? { ...a, validation: null } : a)),
      targets,
    ),
    false,
  );
  assert.equal(
    assessReady(
      assessments.map((a, i) => (i ? { ...a, validation: { ...score, urgent_on_time_share: 0.8 } } : a)),
      targets,
    ),
    false,
  );
  assert.equal(assessReady([], targets), false);
});

test("проверочные множители прозрачны и не зависят от полученного результата", () => {
  const profiles = robustProfiles();
  assert.equal(profiles[0].demand_factor, 1.25);
  assert.equal(profiles[1].speed_factor, 0.8);
  assert.equal(profiles[1].runtime_factor, 0.8);
  assert.equal(profiles[1].support_factor, 1.5);
  assert.match(profileSummary(profiles[1]), /поток 125%/);
  assert.match(profileSummary(profiles[1]), /первые 30 мин/);
  assert.equal(robustProfiles(0, 0, 0)[1].speed_factor, 1);
});

test("условия и цели выбранного парка переживают сохранение, поврежденные не принимаются", () => {
  const candidate = {
    robot_id: "robot",
    cleaner_id: "cleaner",
    fleet: 3,
    cleaners: {},
    incremental_cost_range_rub: [-200, -100],
    released_hours_year: 3,
    payment_id: "purchase",
    payback_years: 3,
    payback_met: true,
    assessments: robustProfiles().map((profile) => ({
      profile,
      training: score,
      validation: score,
      runs: 6,
      incremental_cost_range_rub: [-200, -100],
      labour_balance_range_hours: [3, 4],
      payback_years: 3,
      payback_met: true,
    })),
  } as ClinicOptimizationCandidate;
  const sizing = candidateSizing(request, candidate, targets);
  assert.equal(sizing.assessment?.runs, 12);
  assert.ok(paybackReady(candidate, 7));
  assert.equal(paybackReady(candidate, 2), false);
  assert.equal(paybackReady({ ...candidate, payback_met: false }, 7), false);
  assert.equal(paybackReady({ ...candidate, payback_years: null }, 7), false);
  assert.equal(paybackReady({ ...candidate, incremental_cost_range_rub: [-100, 0] }, 7), false);
  assert.deepEqual(restoreClinicSizing(JSON.parse(JSON.stringify(sizing))), sizing);
  assert.equal(restoreClinicSizing({ ...sizing, assessment: { ...sizing.assessment, profiles: [null, null] } }), null);
  assert.equal(sizingFor({ ...request, overrides: { "clinic.drug_orders_per_day": 500 } }, sizing), null);
  assert.equal(restoreClinicSizing({ ...sizing, assessment: { ...sizing.assessment, paybackYears: 8 } }), null);
  for (const range of [
    [-100, 1],
    [0, 0],
    [100, 200],
  ]) {
    const loss = {
      ...sizing,
      assessment: { ...sizing.assessment, incrementalCostRangeRub: range, paybackYears: null },
    };
    assert.deepEqual(restoreClinicSizing(JSON.parse(JSON.stringify(loss))), loss);
    assert.deepEqual(sizingFor(request, restoreClinicSizing(loss)), loss);
  }
});

test("подбор старой версии методики не используется автоматически", () => {
  const legacy = {
    basis: JSON.stringify([request.operation_ids, request.overrides, null, {}]),
    robot_id: "robot",
    cleaner_id: "cleaner",
    fleet: 2,
    cleaners: {},
  };
  assert.equal(sizingFor(request, legacy), null);
});
