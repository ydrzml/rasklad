/* Проигрыватель смены в корпусе: робот на ломаной, этаж, кабина лифта. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cabinAt, type ClinicSegment, type LiftSegment, spotOf, tracksOf } from "../src/app/clinic/shift.ts";

const leg = (
  from_s: number,
  to_s: number,
  floor: number | null,
  path: [number, number][],
  action = "едет",
): ClinicSegment => ({
  robot: 0,
  role: "delivery",
  floor,
  from_s,
  to_s,
  action,
  path,
  lift: floor === null ? "L1" : "",
});

test("робот на середине отрезка стоит на середине ломаной своего этажа", () => {
  const [track] = tracksOf([
    leg(10, 20, 2, [
      [0, 0],
      [10, 0],
    ]),
    leg(0, 10, 1, [[5, 5]], "грузит"),
  ]);
  assert.deepEqual(spotOf(track, 15), { robot: 0, role: "delivery", floor: 2, lift: "", action: "едет", x: 5, y: 0 });
  assert.equal(spotOf(track, 3)!.floor, 1);
});

test("в кабине этажа нет, есть лифт", () => {
  const [track] = tracksOf([leg(0, 30, null, [], "в лифте")]);
  const spot = spotOf(track, 10)!;
  assert.equal(spot.floor, null);
  assert.equal(spot.lift, "L1");
});

test("кабина между этажами на дробном этаже, после рейса там, где высадила", () => {
  const rides: LiftSegment[] = [
    { lift: "L1", from_s: 100, to_s: 120, action: "везет", from_floor: 1, to_floor: 3, robots: [0] },
  ];
  assert.deepEqual(cabinAt(rides, "L1", 110), { floor: 2, robots: [0] });
  assert.deepEqual(cabinAt(rides, "L1", 200), { floor: 3, robots: [] });
  assert.equal(cabinAt(rides, "L1", 50), null);
  assert.equal(cabinAt(rides, "L2", 110), null);
});
