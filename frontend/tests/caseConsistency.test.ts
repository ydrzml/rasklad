import assert from "node:assert/strict";
import { test } from "node:test";

import { formulaLine } from "../src/app/steps/formulaLine.ts";
import { fitsTaskUnit } from "../src/app/steps/specUnits.ts";
import { taskVolume, volumePath } from "../src/app/steps/taskVolume.ts";

// Разбор "Штучный отбор" повторяет Восток-Сервис: 5 233 строки в сутки вместо 35 000 по умолчанию
const VOSTOK = { [volumePath("warehouse", "piece_picking")]: 5233 };

test("шаг 1: карточка задачи показывает объем разбора, как шаг параметров", () => {
  assert.deepEqual(taskVolume("warehouse", "piece_picking", 35000, VOSTOK), { value: 5233, edited: true });
});

test("шаг 1: без правки на карточке объем объекта по умолчанию", () => {
  assert.deepEqual(taskVolume("warehouse", "piece_picking", 35000, {}), { value: 35000, edited: false });
  // правка другой задачи эту карточку не трогает
  assert.deepEqual(taskVolume("warehouse", "pallet_transport", 2000, VOSTOK), { value: 2000, edited: false });
});

test("шаг 4: паллеты в час на отборе не показываем, единица задачи другая", () => {
  assert.equal(fitsTaskUnit("80–100 паллет/ч", "строк/сут"), false);
});

test("шаг 4: производительность в единицах задачи остается", () => {
  assert.equal(fitsTaskUnit("80–100 паллет/ч", "паллет/сут"), true);
  assert.equal(fitsTaskUnit("5,2 паллеты/ч на робота", "паллет/сут"), true);
  assert.equal(fitsTaskUnit("3000 м²/ч", "м2/сут"), true);
  // задачи не знаем: показываем как есть
  assert.equal(fitsTaskUnit("80–100 паллет/ч"), true);
});

test("шаг 5: формула меньше прогона, строка говорит почему, а не про пик", () => {
  const line = formulaLine(17, 23, { waiting_share: 0.06 });
  assert.equal(
    line,
    "По формуле 17 роботов, прогон смены показал 23: формула берет рейс по среднему маршруту, без порожних переездов, очередей и запаса роботов на ремонт, поэтому дает меньше (в этой смене очереди 6% времени)",
  );
  assert.doesNotMatch(line, /в пик/);
});

test("шаг 5: без заметных очередей строка без скобок, совпадение и запас формулы как раньше", () => {
  assert.equal(
    formulaLine(3, 4, { waiting_share: 0 }),
    "По формуле 3 робота, прогон смены показал 4: формула берет рейс по среднему маршруту, без порожних переездов, очередей и запаса роботов на ремонт, поэтому дает меньше",
  );
  assert.equal(formulaLine(5, 5, { waiting_share: 0 }), "По формуле тоже 5 роботов: прогон смены это подтвердил");
  assert.match(formulaLine(6, 5, { waiting_share: 0 }), /формула берет запас/);
});
