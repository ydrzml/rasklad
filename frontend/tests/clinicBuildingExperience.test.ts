import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addSection,
  floorArea,
  patchSection,
  removeSection,
  resizeFloor,
  type Building,
} from "../src/app/clinic/building.ts";
import { restoreClinicFinance } from "../src/app/clinic/finance.ts";

function building(): Building {
  return {
    version: 1,
    floor_height_m: 3.3,
    lifts: [],
    floors: [
      {
        number: 1,
        name: "Первый",
        width_m: 60,
        length_m: 40,
        items: [],
        sections: [
          { id: "a", x: 0, y: 0, w: 40, h: 10 },
          { id: "b", x: 0, y: 0, w: 10, h: 30 },
        ],
      },
      {
        number: 2,
        name: "Второй",
        width_m: 44,
        length_m: 24,
        items: [],
        sections: [{ id: "c", x: 0, y: 0, w: 44, h: 24 }],
      },
    ],
  };
}

test("план здания считает объединение секций без двойного учета и меняет этаж независимо", () => {
  const house = building(),
    saved = structuredClone(house);
  assert.equal(floorArea(house.floors[0]), 600);
  const next = patchSection(house, 1, "a", { x: 0, y: 0, w: 50, h: 10 });
  assert.equal(floorArea(next.floors[0]), 700);
  assert.deepEqual(next.floors[1], saved.floors[1]);
  assert.deepEqual(house, saved);
  const resized = resizeFloor(next, 1, 80, 50);
  assert.equal(resized.floors[0].sections.length, 2);
  assert.equal(floorArea(resized.floors[0]), 700);
  assert.deepEqual(resized.floors[1], saved.floors[1]);
  const added = addSection(resized, 1, { x: 50, y: 0, w: 10, h: 10 });
  assert.equal(floorArea(added.floors[0]), 800);
  const id = added.floors[0].sections.at(-1)!.id;
  assert.equal(floorArea(removeSection(added, 1, id).floors[0]), 700);
});

test("кредит и его условия сохраняются, невозможные сроки и ставки отбрасываются", () => {
  const terms = { loan_enabled: 1, loan_rate: 0.2, loan_months: 36, loan_own_share: 0.25, loan_insurance_share: 0.01 };
  assert.deepEqual(restoreClinicFinance(JSON.parse(JSON.stringify(terms))), terms);
  assert.deepEqual(restoreClinicFinance({ ...terms, loan_rate: 2, loan_months: 0, loan_enabled: 0.5 }), {
    loan_own_share: 0.25,
    loan_insurance_share: 0.01,
  });
});
