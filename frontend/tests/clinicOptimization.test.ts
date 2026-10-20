import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateSizing, restoreClinicSizing, sizingFor } from "../src/app/clinic/optimization.ts";
import type { ClinicMoneyRequest, ClinicOptimizationCandidate } from "../src/api/client.ts";

const request: ClinicMoneyRequest = {
  operation_ids: ["floor_delivery", "cleaning"],
  overrides: {},
  building: null,
  robot_id: "robot-a",
  cleaner_id: "cleaner-a",
  assumptions: { cash_realization_share: 0 },
};
const chosen = {
  robot_id: "robot-a",
  cleaner_id: "cleaner-a",
  fleet: 4,
  cleaners: { "1": 2, "2": 1 },
} as ClinicOptimizationCandidate;

test("выбранный состав точно сохраняет численность и распределение по этажам", () => {
  const sizing = candidateSizing(request, chosen);
  assert.deepEqual(sizingFor(request, sizing)?.cleaners, { "1": 2, "2": 1 });
  assert.equal(sizingFor(request, sizing)?.fleet, 4);
  assert.deepEqual(restoreClinicSizing(JSON.parse(JSON.stringify(sizing))), sizing);
});

test("изменение корпуса, спроса, моделей и финансовых условий отменяет актуальность подбора", () => {
  const sizing = candidateSizing(request, chosen);
  for (const changed of [
    { ...request, overrides: { "clinic.drug_orders_per_day": 600 } },
    { ...request, assumptions: { cash_realization_share: 1 } },
    { ...request, robot_id: "robot-b" },
    { ...request, cleaner_id: "cleaner-b" },
    { ...request, operation_ids: ["cleaning"] },
  ])
    assert.equal(sizingFor(changed, sizing), null);
});

test("поврежденный сохраненный парк не отправляется в расчет", () => {
  const sizing = candidateSizing(request, chosen);
  assert.equal(restoreClinicSizing({ ...sizing, fleet: 31 }), null);
  assert.equal(restoreClinicSizing({ ...sizing, cleaners: { "1": 5 } }), null);
  assert.ok(restoreClinicSizing({ ...sizing, cleaners: { "0": 1, "7": 1, "20": 1 } }));
  assert.equal(restoreClinicSizing({ ...sizing, cleaners: { "41": 1 } }), null);
  assert.equal(restoreClinicSizing(null), null);
});
