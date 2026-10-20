import assert from "node:assert/strict";
import { test } from "node:test";
import type { Building } from "../src/app/clinic/building.ts";
import {
  CLINIC_TEMPLATES,
  cleanUnderlays,
  clinicDocument,
  dimensionsProblem,
  parseClinicDocument,
  restoreClinicPlan,
  type ClinicDimensions,
  type ClinicPlan,
} from "../src/app/clinic/plan.ts";

const building: Building = {
  version: 1,
  floor_height_m: 3.3,
  lifts: [],
  floors: [{ number: 1, name: "Этаж", width_m: 60, length_m: 24, sections: [], items: [] }],
};
const image = { src: "data:image/jpeg;base64,YWJjZA==", x: 0, y: 0, w: 60, h: 24, opacity: 0.6, label: "Этаж.jpg" };
const plan: ClinicPlan = { source: "upload", title: "Корпус", revision: "1", underlays: { "1": image } };

test("все готовые корпуса удовлетворяют ограничениям собственного плана", () => {
  for (const template of CLINIC_TEMPLATES)
    assert.equal(dimensionsProblem({ ...template, furnished: true, floor_height_m: 3.3 }), "");
});

test("пустой этаж может быть меньше готовой расстановки, но не выходит за пределы движка", () => {
  const params: ClinicDimensions = {
    width_m: 15,
    length_m: 12,
    floors: 3,
    wards_per_floor: 3,
    lifts: 1,
    furnished: false,
    floor_height_m: 3.3,
  };
  assert.equal(dimensionsProblem(params), "");
  assert.match(dimensionsProblem({ ...params, furnished: true }), /36 × 18/);
  assert.match(dimensionsProblem({ ...params, length_m: NaN }), /целыми/);
  assert.equal(dimensionsProblem({ ...params, floors: 20 }), "");
  assert.match(dimensionsProblem({ ...params, floors: 21 }), /1 до 20/);
});

test("JSON сохраняет этажи и подложку, обычный Building тоже импортируется", () => {
  const parsed = parseClinicDocument(clinicDocument(building, plan));
  assert.deepEqual(parsed.building, building);
  assert.deepEqual(cleanUnderlays(parsed.underlays, building), plan.underlays);
  assert.deepEqual(parseClinicDocument(JSON.stringify(building)).building, building);
  assert.throws(() => parseClinicDocument("{"), /прочитать JSON/);
  assert.throws(() => parseClinicDocument('{"warehouse":true}'), /JSON корпуса/);
});

test("в подложке разрешены локальные изображения существующих этажей с конечным масштабом", () => {
  assert.deepEqual(cleanUnderlays({ 1: { ...image, src: "https://example.org/private.png" } }, building), {});
  assert.deepEqual(cleanUnderlays({ 1: { ...image, w: -2 } }, building), {});
  assert.deepEqual(cleanUnderlays({ 1: { ...image, x: Infinity } }, building), {});
  assert.deepEqual(cleanUnderlays({ 9: image }, building), {});
  assert.equal(cleanUnderlays({ 1: { ...image, opacity: 10 } }, building)["1"].opacity, 1);
});

test("старый корпус открывается в редакторе, незавершенный выбор остается на стартовом экране", () => {
  assert.ok(restoreClinicPlan(undefined, building));
  assert.equal(restoreClinicPlan(null, building), null);
  assert.equal(restoreClinicPlan(plan, null), null);
  assert.deepEqual(restoreClinicPlan(plan, building)?.underlays, plan.underlays);
});
