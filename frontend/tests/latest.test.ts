/* Ответ на последнее нажатие главный: старый ответ не затирает новый. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { latestOnly } from "../src/app/latest.ts";

/* Запрос, который ответит, когда скажем: так ответы приходят не в том порядке, в каком ушли */
function later<T>() {
  let answer: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => (answer = resolve));
  return { promise, answer };
}

test("ответ на прежнее нажатие, пришедший позже, не перезаписывает ответ на последнее", async () => {
  const nextTurn = latestOnly();
  let shown = "";
  const ask = (value: string, reply: Promise<string>) => {
    const turn = nextTurn();
    return reply.then((answer) => {
      if (turn.current()) shown = answer;
      return value;
    });
  };
  const own = later<string>();
  const loan = later<string>();
  const first = ask("own", own.promise);
  const second = ask("loan", loan.promise);
  loan.answer("цифры кредита");
  await second;
  own.answer("цифры своих денег");
  await first;
  assert.equal(shown, "цифры кредита");
});

test("новое нажатие отменяет прежний запрос", () => {
  const nextTurn = latestOnly();
  const first = nextTurn();
  assert.equal(first.current(), true);
  const second = nextTurn();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.current(), false);
  assert.equal(second.current(), true);
  assert.equal(second.signal.aborted, false);
});
