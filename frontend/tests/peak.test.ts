import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultTemplate,
  peakWarning,
  pickingZoneM2,
  planFitsPicking,
  zoneArea,
  zoneLine,
} from "../src/app/steps/peak.ts";

test("подсказка про робозону: только шаблон робозоны ее не требует", () => {
  assert.equal(planFitsPicking("robot_zone"), true);
  assert.equal(planFitsPicking("one_side"), false);
  assert.equal(planFitsPicking("custom"), false);
  assert.equal(planFitsPicking(undefined), false);
});

test("задача «товар к человеку» на плане под погрузчик: не предупреждение, отбор считаем по робозоне", () => {
  assert.equal(peakWarning(undefined, true, false), null);
  assert.equal(peakWarning(undefined, true, true), null);
  assert.equal(peakWarning(undefined, false, false), null);
});

test("площадь робозоны под отбор: доля склада по умолчанию и правки первого шага", () => {
  const facility = { id: "warehouse", active_area_m2: 10000, picking_zone_share: 0.28 };
  assert.equal(pickingZoneM2(facility, {}), 2800);
  assert.equal(pickingZoneM2(facility, { "facilities.warehouse.picking_zone_share": 0.5 }), 5000);
  assert.equal(pickingZoneM2(facility, { "facilities.warehouse.active_area_m2": 20000 }), 5600);
  assert.equal(pickingZoneM2({ id: "airport" }, {}), null);
  assert.equal(zoneArea(2800), "2\u00a0800 м²");
});

test("парк по формуле: не сходится или больше того, что гоняет прогон", () => {
  assert.ok(peakWarning({ fleet_needed: null }, false, true)?.includes("не вытянуть"));
  assert.ok(peakWarning({ fleet_needed: 300 }, false, true)?.includes("300 роботов"));
  assert.equal(peakWarning({ fleet_needed: 250 }, false, true), null);
  assert.equal(peakWarning({ fleet_needed: 9 }, false, true), null);
});

test("типовая планировка по умолчанию: робозона только под отбор", () => {
  assert.equal(defaultTemplate(true), "robot_zone");
  assert.equal(defaultTemplate(false), "one_side");
});

test("строка шага 5 про отбор по робозоне", () => {
  assert.equal(zoneLine(), "Отбор посчитан по компактной робозоне, как ставят такие системы");
  assert.equal(
    zoneLine("Мелкоштучный отбор"),
    "Мелкоштучный отбор: отбор посчитан по компактной робозоне, как ставят такие системы",
  );
});
