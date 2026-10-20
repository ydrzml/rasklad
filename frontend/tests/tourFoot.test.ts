/* Кнопки карточки обучения: на шаге выбора главная кнопка начинает выбранное. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { movePick, tourFoot } from "../src/ui/tourFoot.ts";

test("на шаге выбора главная кнопка начинает обучение, отказ второй кнопкой", () => {
  const foot = tourFoot({ choices: [{}, {}], next: "Разберусь сам" }, true);
  assert.equal(foot.go, "Начать обучение");
  assert.equal(foot.skip, "Разберусь сам");
});

test("отказ без подписи все равно есть", () => {
  assert.equal(tourFoot({ choices: [{}] }, true).skip, "Разберусь сам");
});

test("обычный шаг: Дальше, на последнем Понятно, своя подпись важнее", () => {
  assert.deepEqual(tourFoot({}, false), { go: "Дальше" });
  assert.deepEqual(tourFoot({}, true), { go: "Понятно" });
  assert.deepEqual(tourFoot({ next: "Теперь попробуйте" }, false), { go: "Теперь попробуйте" });
  assert.deepEqual(tourFoot({ choices: [] }, true), { go: "Понятно" });
});

test("стрелки двигают выбор по кругу", () => {
  assert.equal(movePick(0, 2, "ArrowDown"), 1);
  assert.equal(movePick(1, 2, "ArrowDown"), 0);
  assert.equal(movePick(0, 2, "ArrowUp"), 1);
  assert.equal(movePick(1, 2, "ArrowLeft"), 0);
  assert.equal(movePick(1, 2, "Enter"), 1);
  assert.equal(movePick(3, 0, "ArrowDown"), 0);
});
