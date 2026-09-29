/* Проверки контура здания на листе: точку убирают двойным щелчком. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { withoutCorner } from "../src/app/plan/geometry.ts";

// склад буквой Г: 118 на 85 м, справа сверху вырезан угол 50 на 30 м
const letter: [number, number][] = [
  [0, 0],
  [118, 0],
  [118, 55],
  [68, 55],
  [68, 85],
  [0, 85],
];

test("без точки соседние стены сходятся напрямую", () => {
  // убрали внутренний угол выреза: стена идет косо от 118,55 к 68,85
  assert.deepEqual(withoutCorner(letter, 3), [
    [0, 0],
    [118, 0],
    [118, 55],
    [68, 85],
    [0, 85],
  ]);
});

test("меньше трех точек не бывает", () => {
  const triangle = letter.slice(0, 3);
  assert.equal(withoutCorner(triangle, 0), null);
  assert.equal(withoutCorner([...triangle, [0, 50]], 1)?.length, 3);
});

test("контур тоньше двух метров не здание", () => {
  // четвертая точка держит ширину, без нее остается полоса в метр
  assert.equal(
    withoutCorner(
      [
        [0, 0],
        [100, 0],
        [100, 1],
        [50, 40],
      ],
      3,
    ),
    null,
  );
});
