/* Правки корпуса медучреждения в редакторе: помещение с дверью, шахта через этажи, копия этажа.
   Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDoor,
  addFloor,
  addLift,
  addRoom,
  asBuilding,
  type Building,
  copyFloor,
  counts,
  doorsOf,
  hit,
  type Lift,
  moveItem,
  removeFloor,
  removeItem,
  resizeItem,
  setDoorWidth,
  toggleStop,
} from "../src/app/clinic/building.ts";

const LIFT: Lift = {
  id: "L1",
  name: "Больничный лифт",
  cabin_w_mm: 1500,
  cabin_d_mm: 2700,
  door_mm: 1200,
  robots: true,
  people_calls_per_hour: 12,
};

function empty(floors = 1): Building {
  let building: Building = {
    version: 1,
    floor_height_m: 3.3,
    lifts: [],
    floors: [
      {
        number: 1,
        name: "1 этаж",
        width_m: 60,
        length_m: 24,
        sections: [{ id: "f1", x: 0, y: 0, w: 60, h: 24 }],
        items: [],
      },
    ],
  };
  for (let n = 1; n < floors; n++) building = addFloor(building);
  return building;
}

const ids = (building: Building) => building.floors.flatMap((floor) => floor.items.map((item) => item.id));

test("помещение у нижнего края получает дверь на стене в коридор, шириной проема палаты", () => {
  const building = addRoom(empty(), 1, { x: 10.3, y: 0, w: 9.6, h: 8 });
  const [room, door] = building.floors[0].items;
  assert.deepEqual([room.x, room.y, room.w, room.h], [10, 0, 10, 8]);
  assert.equal(room.role, "ward");
  assert.equal(door.kind, "door");
  assert.equal(door.width_mm, 1200);
  // стена в коридор у этого помещения верхняя: дверь в верхнем ряду клеток
  assert.equal(door.y, 7);
  assert.equal(door.h, 1);
  assert.equal(door.w, 1.2);
});

test("слишком маленькое помещение растягиваем до 3 x 3 м", () => {
  const room = addRoom(empty(), 1, { x: 5, y: 5, w: 1, h: 1 }).floors[0].items[0];
  assert.deepEqual([room.w, room.h], [3, 3]);
});

test("помещение едет вместе со своими дверями и не выходит за край этажа", () => {
  let building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
  building = moveItem(building, 1, "f1-room-1", 100, 3);
  const floor = building.floors[0];
  const room = floor.items[0];
  assert.equal(room.x, 50);
  assert.equal(room.y, 3);
  assert.equal(doorsOf(floor, room).length, 1);
});

test("дверь двигается только вдоль своей стены", () => {
  let building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
  const before = building.floors[0].items[1];
  building = moveItem(building, 1, before.id, 2, 5);
  const after = building.floors[0].items[1];
  assert.equal(after.y, before.y);
  assert.equal(after.x, before.x + 2);
});

test("ширина двери в мм меняет и проем на плане", () => {
  let building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
  building = setDoorWidth(building, 1, "f1-room-1-door", 800);
  const door = building.floors[0].items[1];
  assert.equal(door.width_mm, 800);
  assert.equal(door.w, 0.8);
});

test("новая дверь щелчком у стены помещения, мимо помещения двери нет", () => {
  const building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
  const added = addDoor(building, 1, { x: 10.2, y: 4 });
  assert.ok(added);
  const door = added.building.floors[0].items.find((item) => item.id === added.id)!;
  assert.equal(door.x, 10);
  assert.equal(door.w, 1);
  assert.equal(addDoor(building, 1, { x: 40, y: 20 }), null);
  assert.equal(addDoor(building, 1, { x: 15, y: 4 }), null);
});

test("повторные и соседние клики по занятому проему выбирают дверь без новых копий", () => {
  for (const at of [
    { x: 15, y: 8 },
    { x: 15, y: 0 },
    { x: 10, y: 4 },
    { x: 20, y: 4 },
  ]) {
    let building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
    const placed = addDoor(building, 1, at)!;
    building = placed.building;
    const count = counts(building).doors;
    for (let n = 0; n < 12; n++) {
      const repeated = addDoor(building, 1, { x: at.x + 0.2, y: at.y + 0.2 })!;
      assert.equal(repeated.building, building);
      assert.equal(repeated.id, placed.id);
      assert.equal(counts(repeated.building).doors, count);
    }
  }
});

test("раздельные двери разрешены, перенос и расширение на соседнюю дверь отклоняются", () => {
  for (const vertical of [false, true]) {
    let building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
    building = removeItem(building, 1, "f1-room-1-door");
    const first = addDoor(building, 1, vertical ? { x: 10, y: 2 } : { x: 13, y: 8 })!;
    const second = addDoor(first.building, 1, vertical ? { x: 10, y: 4 } : { x: 15, y: 8 })!;
    building = second.building;
    assert.equal(counts(building).doors, 2);
    assert.equal(moveItem(building, 1, second.id, vertical ? 0 : -1, vertical ? -1 : 0), building);
    assert.equal(setDoorWidth(building, 1, first.id, 4000), building);
    const saved = structuredClone(building);
    const moved = moveItem(building, 1, second.id, vertical ? 0 : 1, vertical ? 1 : 0);
    assert.notEqual(moved, building);
    assert.deepEqual(building, saved);
  }
});

test("сжатие помещения не склеивает двери, слишком широкий проем не выходит за помещение", () => {
  let building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
  building = addDoor(building, 1, { x: 17, y: 8 })!.building;
  assert.equal(resizeItem(building, 1, "f1-room-1", 5, 8), building);
  const small = addRoom(empty(), 1, { x: 10, y: 0, w: 3, h: 3 });
  assert.equal(setDoorWidth(small, 1, "f1-room-1-door", 4000), small);
});

test("в уже испорченном плане можно убрать наложение перемещением или удалением двери", () => {
  const building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
  const original = building.floors[0].items[1];
  building.floors[0].items.push({ ...original, id: "duplicate-door" });
  const repaired = moveItem(building, 1, "duplicate-door", 2, 0);
  assert.notEqual(repaired, building);
  assert.equal(counts(repaired).doors, 2);
  assert.equal(counts(removeItem(building, 1, "duplicate-door")).doors, 1);
});

test("при новом размере помещения дверь остается на своей стене", () => {
  let building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
  building = resizeItem(building, 1, "f1-room-1", 10, 12);
  const [room, door] = building.floors[0].items;
  assert.equal(room.h, 12);
  assert.equal(door.y, 11);
});

test("шахта лифта встает на все этажи и едет на всех сразу", () => {
  let building = empty(3);
  const added = addLift(building, { x: 30, y: 12 }, LIFT);
  assert.ok(added);
  building = added.building;
  assert.equal(building.lifts.length, 1);
  assert.equal(building.lifts[0].cabin_d_mm, 2700);
  assert.equal(building.floors.filter((floor) => floor.items.some((item) => item.lift === "L1")).length, 3);
  building = moveItem(building, 2, "f2-L1", 4, 0);
  assert.deepEqual(
    building.floors.map((floor) => floor.items.find((item) => item.lift === "L1")!.x),
    [33, 33, 33],
  );
});

test("шахту убрали с этажа: остановки нет; убрали со всех: нет и лифта", () => {
  let building = addLift(empty(2), { x: 30, y: 12 }, LIFT)!.building;
  building = removeItem(building, 1, "f1-L1");
  assert.equal(building.lifts.length, 1);
  building = toggleStop(building, "L1", 1);
  assert.ok(building.floors[0].items.some((item) => item.id === "f1-L1"));
  building = toggleStop(toggleStop(building, "L1", 1), "L1", 2);
  assert.equal(building.lifts.length, 0);
});

test("копия этажа: новые id без повторов, шахта того же лифта, аптека становится постом", () => {
  let building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 }, "pharmacy");
  building = addLift(building, { x: 30, y: 12 }, LIFT)!.building;
  building = copyFloor(building, 1);
  assert.equal(building.floors.length, 2);
  const all = ids(building);
  assert.equal(new Set(all).size, all.length);
  const top = building.floors[1];
  assert.equal(top.number, 2);
  assert.equal(top.items.find((item) => item.kind === "room")!.role, "ward");
  assert.ok(top.items.some((item) => item.kind === "lift" && item.lift === "L1"));
  assert.equal(counts(building).wards, 1);
});

test("удаление этажа уносит лифт, у которого больше нет шахт", () => {
  let building = empty(2);
  building = addLift(building, { x: 30, y: 12 }, LIFT)!.building;
  building = removeItem(building, 1, "f1-L1");
  building = removeFloor(building, 2);
  assert.equal(building.floors.length, 1);
  assert.equal(building.lifts.length, 0);
});

test("под курсором дверь поверх помещения", () => {
  const building = addRoom(empty(), 1, { x: 10, y: 0, w: 10, h: 8 });
  const door = building.floors[0].items[1];
  assert.equal(hit(building.floors[0], { x: door.x + 0.3, y: door.y + 0.5 })!.kind, "door");
  assert.equal(hit(building.floors[0], { x: 12, y: 3 })!.kind, "room");
});

test("сохраненный мусор не принимаем за корпус", () => {
  assert.equal(asBuilding(null), null);
  assert.equal(asBuilding({ version: 2, floors: [], lifts: [] }), null);
  assert.ok(asBuilding(empty()));
});
