import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFloor, type Building } from "../src/app/clinic/building.ts";
import { reconcileProcesses, scenarioOf } from "../src/app/clinic/processes.ts";
import { clinicDocument, parseClinicDocument } from "../src/app/clinic/plan.ts";
import { candidateSizing, sizingFor } from "../src/app/clinic/optimization.ts";
import type { ClinicOptimizationCandidate } from "../src/api/client.ts";

const building: Building = {
  version: 1,
  floor_height_m: 3.3,
  lifts: [],
  floors: [
    {
      number: 1,
      name: "Этаж",
      width_m: 48,
      length_m: 24,
      sections: [],
      items: [
        {
          id: "f1-ward",
          kind: "room",
          role: "ward",
          x: 0,
          y: 0,
          w: 6,
          h: 6,
          name: "Пост",
          width_mm: 0,
          automatic: true,
          lift: "",
        },
      ],
    },
  ],
};

test("корпус без процессов получает умолчания сервера без изменения исходного объекта", () => {
  const result = scenarioOf(building);
  // config/clinic.yaml: стационар считается за сутки, уборка дважды в сутки
  assert.equal(result.shift_hours, 24);
  assert.equal(result.cleaning_passes, 2);
  assert.equal(result.meds.mode, "per_point");
  result.meds.enabled = false;
  assert.equal(scenarioOf(building).meds.enabled, true);
  assert.equal(building.scenario, undefined);
});

test("геометрия и процессы сохраняются в одном JSON", () => {
  const house = { ...building, scenario: { ...scenarioOf(building), shift_start_h: 22, shift_hours: 12 } };
  const parsed = parseClinicDocument(
    clinicDocument(house, { source: "custom", title: "Ночь", revision: "1", underlays: {} }),
  );
  assert.deepEqual(parsed.building, house);
});

test("копия этажа наследует веса постов и уборку без незаметного удвоения явных потоков", () => {
  const scenario = scenarioOf(building);
  scenario.point_weights = { "f1-ward": 2 };
  scenario.floor_cleaning_passes = { "1": 3 };
  scenario.meds.mode = "routes";
  scenario.meds.flows = [{ source: "pharmacy", target: "f1-ward", per_day: 20 }];
  const result = copyFloor({ ...building, scenario }, 1);
  assert.equal(result.scenario?.point_weights["f2-ward"], 2);
  assert.equal(result.scenario?.floor_cleaning_passes["2"], 3);
  assert.equal(result.scenario?.meds.flows.length, 1);
  assert.deepEqual(scenario.point_weights, { "f1-ward": 2 });
});

test("удаление геометрии очищает коэффициенты и оставляет потерянный маршрут для проверки", () => {
  const scenario = scenarioOf(building);
  scenario.point_weights = { "f1-ward": 2, missing: 3 };
  scenario.floor_cleaning_passes = { "1": 1, "2": 2 };
  scenario.meds.flows = [{ source: "pharmacy", target: "missing", per_day: 20 }];
  const result = reconcileProcesses({ ...building, scenario });
  assert.deepEqual(result.scenario?.point_weights, { "f1-ward": 2 });
  assert.deepEqual(result.scenario?.floor_cleaning_passes, { "1": 1 });
  assert.equal(result.scenario?.meds.flows[0].target, "missing");
});

test("изменение расписания и потоков делает старый подбор неактуальным", () => {
  const request = {
    building,
    operation_ids: ["floor_delivery"],
    overrides: {},
    robot_id: "robot",
    cleaner_id: "cleaner",
  };
  const chosen = { robot_id: "robot", cleaner_id: "cleaner", fleet: 2, cleaners: {} } as ClinicOptimizationCandidate;
  const sizing = candidateSizing(request, chosen);
  const next = { ...building, scenario: { ...scenarioOf(building), shift_hours: 24 } };
  assert.equal(sizingFor({ ...request, building: next }, sizing), null);
});
