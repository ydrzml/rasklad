/* Стоп-состояния шага экономики: куда вести и что показывать. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autoTemplate,
  forPlan,
  planBuilds,
  troubleOf,
  waitingInsteadOfStale,
  withoutPayment,
  withoutRobot,
} from "../src/app/flow.ts";
import { fieldsText } from "../src/api/http.ts";

test("парк не покрывает спрос: ведем менять решение", () => {
  const trouble = troubleOf({ feasible: false, message: "Задача «Отбор»: парк не покрывает пик" }, null);
  assert.equal(trouble?.kind, "solution");
  assert.equal(trouble?.step, 3);
  assert.equal(trouble?.action, "Поменять решение");
  assert.match(trouble?.text ?? "", /не покрывает/);
});

test("план не заполнен: ведем обратно к плану, а не менять решение", () => {
  const message =
    "Перевозка паллет между зонами, AMR 800: парк не покрывает пик 130 операций в час, потому что план не заполнен";
  const trouble = troubleOf({ feasible: false, message, cause: "plan" }, null);
  assert.equal(trouble?.kind, "plan");
  assert.equal(trouble?.step, 2);
  assert.equal(trouble?.action, "Вернуться к плану");
  assert.equal(trouble?.text, message);
});

test("сервер не принял ввод (422): ведем в параметры, сервер упал: повторить", () => {
  assert.equal(troubleOf(null, { message: "36 ч в сутки", status: 422 })?.step, 1);
  assert.equal(troubleOf(null, { message: "нет робота", status: 404 })?.step, 3);
  const down = troubleOf(null, { message: "Сервер не отвечает" });
  assert.equal(down?.kind, "server");
  assert.equal(down?.step, null);
  assert.equal(down?.action, "Повторить");
});

test("отказ по оплате ведет не в параметры, а снимает правки оплаты", () => {
  const message = "Срок кредита или лизинга задается целым числом месяцев от 1 до 360";
  const trouble = troubleOf(null, { message, status: 422 });
  assert.equal(trouble?.kind, "payment");
  assert.equal(trouble?.action, "Вернуть оплату как было");
  const overrides = {
    "financing.leasing.term_months": 0,
    "subsidies.frp.chosen": 1,
    "ramp_up.pallet_transport.months": 3,
    "robots.ronavi-h1500.price_rub": 2_000_000,
  };
  assert.deepEqual(withoutPayment(overrides), { "robots.ronavi-h1500.price_rub": 2_000_000 });
});

test("план строится заново только от правок объекта, срок лизинга его не трогает", () => {
  const overrides = {
    "facilities.warehouse.active_area_m2": 12_000,
    "facilities.warehouse.staff.pickers.salary_month": 90_000,
    "facilities.warehouse.implementation.integration_rub": 1,
    "financing.leasing.term_months": 24,
    "robots.ronavi-h1500.price_rub": 2_000_000,
  };
  assert.deepEqual(forPlan(overrides), { "facilities.warehouse.active_area_m2": 12_000 });
});

test("сошедшийся расчет без ошибки: мешать нечему", () => {
  assert.equal(troubleOf({ feasible: true }, null), null);
  assert.equal(troubleOf(null, null), null);
});

test("пока считаем заново, старую ошибку и старое несошедшееся не показываем, цифры оставляем", () => {
  // после смены решения на шаге 4 идет новый расчет: старое "не сошлось" уходит, стоит ожидание
  assert.equal(waitingInsteadOfStale(true, { feasible: false }, null), true);
  assert.equal(waitingInsteadOfStale(true, null, { message: "упал" }), true);
  assert.equal(waitingInsteadOfStale(true, null, null), true);
  // сошедшиеся цифры при пересчете остаются на экране приглушенными
  assert.equal(waitingInsteadOfStale(true, { feasible: true }, null), false);
  // ничего не считаем: показываем, что есть
  assert.equal(waitingInsteadOfStale(false, { feasible: false }, null), false);
});

/* Шаг плана. Сборки идут запросами к серверу, и ответ ранней сборки может прийти позже.
   Порядок ниже тот, что давал поломки: сначала план по нашей типовой, потом выбор человека */

test("начать заново и другая схема: поздний ответ прежней схемы не ложится на лист", () => {
  const builds = planBuilds();
  // "Начать заново" строит план той же робозоной, потом человек выбирает "Сквозной"
  const restart = builds.ask("robot_zone");
  const through = builds.ask("through");
  // пересборка по задачам держит выбранную схему, а не ту, что еще на экране
  assert.equal(autoTemplate(builds.asked() || "robot_zone", true, "robot_zone"), "through");
  // ответы пришли в обратном порядке: робозона позже
  assert.equal(builds.latest(through), true);
  assert.equal(builds.latest(restart), false);
});

test("по фото: пустое здание, заполненная робозона поверх не приходит", () => {
  const builds = planBuilds();
  const first = builds.ask("robot_zone");
  // фото строит свой склад без ворот и рядов
  const photo = builds.ask("custom");
  assert.equal(autoTemplate(builds.asked() || "robot_zone", true, "robot_zone"), "custom");
  assert.equal(builds.latest(photo), true);
  assert.equal(builds.latest(first), false);
});

test("пересборка по задачам: нашу типовую меняем, выбранную и свой склад держим", () => {
  // план из браузера, запросов еще не было
  assert.equal(autoTemplate(undefined, false, "robot_zone"), "robot_zone");
  assert.equal(autoTemplate("one_side", false, "robot_zone"), "robot_zone");
  assert.equal(autoTemplate("one_side", true, "robot_zone"), "one_side");
  assert.equal(autoTemplate("custom", false, "one_side"), "custom");
});

test("отказ по числу робота ведет не в параметры, а снимает правки робота", () => {
  const trouble = troubleOf(null, { message: "Срок службы робота: нужно целое число лет, не меньше 1", status: 422 });
  assert.equal(trouble?.kind, "robot");
  assert.equal(trouble?.step, null);
  const overrides = {
    "robots.ronavi-h1500.service_life_years": 3.5,
    "engine.simulation.availability": 0,
    "facilities.warehouse.active_area_m2": 12_000,
  };
  assert.deepEqual(withoutRobot(overrides), { "facilities.warehouse.active_area_m2": 12_000 });
});

test("проезд между рядами уже, чем нужно роботу: ведем на шаг плана, а не в параметры", () => {
  const message =
    "Между рядами 0,5 м, а Ronavi H1500 нужно не меньше 0,75 м: раздвиньте ряды. Робот там не проедет, и считать парк не по чему";
  const trouble = troubleOf({ feasible: false, cause: "plan", message }, null);
  assert.equal(trouble?.kind, "plan");
  assert.equal(trouble?.step, 2);
  assert.equal(trouble?.action, "Вернуться к плану");
  assert.equal(trouble?.text, message);
});

test("сервер не принял план (422 по полю объекта): тоже на шаг плана, словами сервера", () => {
  const message =
    "План не принят: объект 12 на чертеже, рядов вплотную: должно быть не больше 40. Поправьте его на шаге плана";
  const trouble = troubleOf(null, { message, status: 422 });
  assert.equal(trouble?.kind, "plan");
  assert.equal(trouble?.step, 2);
  assert.equal(trouble?.action, "Вернуться к плану");
});

test("отказ по полям списком читается словами сервера, а не кодом 422", () => {
  const detail = [
    {
      loc: ["body", "plan", "items", 11, "block_rows"],
      msg: "План не принят: объект 12, рядов вплотную: не больше 40",
    },
    {
      loc: ["body", "plan", "items", 12, "block_rows"],
      msg: "План не принят: объект 12, рядов вплотную: не больше 40",
    },
    { loc: ["body", "x"], msg: "Input should be a valid number" },
  ];
  assert.equal(
    fieldsText(detail),
    "План не принят: объект 12, рядов вплотную: не больше 40; x: Input should be a valid number",
  );
  assert.equal(fieldsText("текст"), null);
  assert.equal(fieldsText([]), null);
});
