/* Проверки проигрывателя смены: где робот в момент t, шкала по минутам, очереди и тепловая
   карта. Лог рисуем здесь же, на двух роботах. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actionsOf,
  ACTIONS,
  heatOf,
  heatRanks,
  minutesOf,
  queuesOf,
  replayOf,
  spotAt,
  spotsAt,
  summaryOf,
} from "../src/app/shift/replay.ts";

const log = [
  { robot: 0, from_s: 0, to_s: 60, action: "без задания", path: [[0, 0]] as [number, number][] },
  // едет 10 м на восток, потом 10 м на север, за 100 секунд
  {
    robot: 0,
    from_s: 60,
    to_s: 160,
    action: "едет",
    path: [
      [0, 0],
      [10, 0],
      [10, 10],
    ] as [number, number][],
  },
  { robot: 0, from_s: 160, to_s: 180, action: "грузит", path: [[10, 10]] as [number, number][] },
  { robot: 1, from_s: 0, to_s: 90, action: "ждет", path: [[5, 5]] as [number, number][] },
  {
    robot: 1,
    from_s: 90,
    to_s: 180,
    action: "едет",
    path: [
      [5, 5],
      [5, 15],
    ] as [number, number][],
  },
];

test("робот стоит на ломаной по доле времени отрезка", () => {
  const replay = replayOf(log, 180 / 3600);
  assert.deepEqual(spotAt(replay.robots[0], 30), { x: 0, y: 0, action: "без задания" });
  // четверть пути: 5 м из 20, еще на первом куске
  assert.deepEqual(spotAt(replay.robots[0], 85), { x: 5, y: 0, action: "едет" });
  // три четверти пути: 15 м, это 5 м вверх по второму куску
  assert.deepEqual(spotAt(replay.robots[0], 135), { x: 10, y: 5, action: "едет" });
  assert.deepEqual(spotAt(replay.robots[0], 170), { x: 10, y: 10, action: "грузит" });
  assert.equal(spotsAt(replay, 100).length, 2);
});

test("шкала по минутам: в работе едет, грузит и ждет, без задания нет", () => {
  const replay = replayOf(log, 3 / 60);
  const minutes = minutesOf(replay);
  assert.equal(minutes.length, 3);
  // первая минута: робот 0 без задания, робот 1 ждет всю минуту
  assert.deepEqual(minutes[0], { busy: 1, waiting: 1 });
  // вторая: робот 0 едет всю минуту, робот 1 ждет полминуты и полминуты едет
  assert.deepEqual(minutes[1], { busy: 2, waiting: 0.5 });
  assert.deepEqual(queuesOf(minutes), [{ from: 0, to: 2, peak: 1 }]);
});

test("уборщик моет и меняет воду: это работа, в легенде только действия смены", () => {
  const cleaner = [
    { robot: 0, from_s: 0, to_s: 60, action: "моет", path: [[3, 3]] as [number, number][] },
    { robot: 0, from_s: 60, to_s: 120, action: "меняет воду", path: [[0, 0]] as [number, number][] },
  ];
  const replay = replayOf(cleaner, 2 / 60);
  assert.deepEqual(
    minutesOf(replay).map((one) => one.busy),
    [1, 1],
  );
  assert.deepEqual(
    actionsOf(replay).map((one) => one.id),
    ["моет", "меняет воду"],
  );
  assert.ok(!actionsOf(replayOf(log, 3 / 60)).some((one) => one.id === "моет"));
  assert.deepEqual(actionsOf(replayOf([], 1)), ACTIONS);
});

test("тепловая карта ложится на ячейку стеллажа рядом с местом, равные места посередине шкалы", () => {
  const places = [
    { x: 3.5, y: 2.5, share: 0.5, visits: 4 },
    { x: 3.5, y: 3.5, share: 0.5, visits: 0 },
  ];
  // стеллаж слева от проезда, в колонке 2
  const cells = heatOf(places, "share", (col) => col === 2);
  assert.deepEqual(
    cells.map((cell) => [cell.col, cell.row]),
    [
      [2, 2],
      [2, 3],
    ],
  );
  assert.deepEqual([...heatRanks(cells).values()], [0.5, 0.5]);
  const visits = heatOf(places, "visits", (col) => col === 2);
  const ranks = heatRanks(visits);
  assert.equal(ranks.get(visits[1]), 0); // без заездов ячейка светлая
  assert.ok((ranks.get(visits[0]) ?? 0) > 0.5);
});

test("выводы партитуры: пик по спросу, занятость в пик и вне его, зарядка одновременно", () => {
  // смена два часа, пик во втором: там оба робота едут, в первом один едет, другой заряжается
  const shift = [
    { robot: 0, from_s: 0, to_s: 7200, action: "едет", path: [[0, 0]] as [number, number][] },
    { robot: 1, from_s: 0, to_s: 3600, action: "заряжается", path: [[1, 1]] as [number, number][] },
    { robot: 1, from_s: 3600, to_s: 7200, action: "едет", path: [[1, 1]] as [number, number][] },
  ];
  const summary = summaryOf(replayOf(shift, 2), [80, 120]);
  assert.equal(summary.peakFrom, 1);
  assert.equal(summary.peakTo, 2);
  assert.equal(summary.peakBusy, 1);
  assert.equal(summary.offBusy, 0.5);
  assert.equal(summary.charging, 1);
});
