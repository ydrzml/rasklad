/* Строка над листом чертежа: что сделать сейчас, и когда прячется правая колонка. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PICKING_CHECK, planTodo, practiceOffered, sideHidden } from "../src/app/plan/todo.ts";

const racks = { kind: "racks" };
const passed = { label: "Есть ворота", ok: true, detail: "" };
const desk = { photo: false, narrow: false };

test("до расчета сервера строки нет", () => {
  assert.equal(planTodo({ items: [racks] as never }, null, desk), null);
});

test("готовый план просит проверить ворота и ряды и идти дальше", () => {
  const todo = planTodo({ items: [racks] as never }, { docks: 4, checks: [passed] }, desk);
  assert.equal(todo?.next, false);
  assert.equal(todo?.tool, undefined);
  assert.match(todo!.text, /^Проверьте ворота и ряды/);
  assert.match(todo!.text, /"Дальше: решение"/);
});

test("на телефоне не зовем к инструментам: их там нет", () => {
  const todo = planTodo({ items: [racks] as never }, { docks: 4, checks: [passed] }, { photo: false, narrow: true });
  assert.doesNotMatch(todo!.text, /инструмент/);
});

test("сначала стеллажи, потом ворота, потом проверки сервера", () => {
  const failed = { label: "Ворота в наружной стене", ok: false, detail: "ворота 3 стоят внутри зала" };
  const empty = planTodo({ items: [] }, { docks: 0, checks: [failed] }, desk);
  assert.equal(empty?.tool, "racks");
  assert.equal(empty?.next, true);

  const noDocks = planTodo({ items: [racks] as never }, { docks: 0, checks: [failed] }, desk);
  assert.equal(noDocks?.tool, "dock");

  const open = planTodo({ items: [racks] as never }, { docks: 2, checks: [passed, failed] }, desk);
  assert.equal(open?.text, "Поправьте план: ворота 3 стоят внутри зала");
});

test("план по фото зовет обводить ряды по картинке", () => {
  const todo = planTodo({ items: [] }, { docks: 0, checks: [] }, { photo: true, narrow: false });
  assert.match(todo!.text, /по картинке/);
});

test("проверка про отбор не считается ошибкой плана", () => {
  const picking = { label: PICKING_CHECK, ok: false, detail: "отбор посчитаем по робозоне" };
  const todo = planTodo({ items: [racks] as never }, { docks: 2, checks: [picking] }, desk);
  assert.equal(todo?.next, false);
});

test("тексты без буквы ё, длинных тире и елочек", () => {
  const all = [
    planTodo({ items: [] }, { docks: 0, checks: [] }, desk),
    planTodo({ items: [] }, { docks: 0, checks: [] }, { photo: true, narrow: false }),
    planTodo({ items: [racks] as never }, { docks: 0, checks: [] }, desk),
    planTodo({ items: [racks] as never }, { docks: 1, checks: [] }, desk),
    planTodo({ items: [racks] as never }, { docks: 1, checks: [] }, { photo: false, narrow: true }),
  ];
  for (const todo of all) assert.doesNotMatch(todo!.text, /[ёЁ—«»]/);
});

test("правая колонка свернута, пока в ней нет дела", () => {
  const calm = { legend: false, tour: false, photo: false, corners: false };
  assert.equal(sideHidden(calm), true);
  assert.equal(sideHidden({ ...calm, legend: true }), false);
  // шаги обучения показывают на легенду, поэтому на время обучения колонка открыта
  assert.equal(sideHidden({ ...calm, tour: true }), false);
  assert.equal(sideHidden({ ...calm, photo: true }), false);
  assert.equal(sideHidden({ ...calm, corners: true }), false);
});

const ready = { narrow: false, answered: false, busy: false, off: false, built: true, wanted: true, onSheet: true };

test("после построения плана предлагаем практику, если обучение еще не предлагали", () => {
  assert.equal(practiceOffered(ready), true);
});

test("уже ответили на вопрос про обучение: второе окно подряд не показываем", () => {
  assert.equal(practiceOffered({ ...ready, answered: true }), false);
  assert.equal(practiceOffered({ ...ready, busy: true }), false);
});

test("практику не предлагаем на телефоне, при отключенных подсказках и вне листа", () => {
  assert.equal(practiceOffered({ ...ready, narrow: true }), false);
  assert.equal(practiceOffered({ ...ready, off: true }), false);
  assert.equal(practiceOffered({ ...ready, wanted: false }), false);
  assert.equal(practiceOffered({ ...ready, built: false }), false);
  assert.equal(practiceOffered({ ...ready, onSheet: false }), false);
});
