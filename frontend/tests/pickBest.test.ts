import assert from "node:assert/strict";
import { test } from "node:test";

import type { Solution } from "../src/api/client.ts";
import { bestToPick, fitLines, forOtherTask, lower, scoreOf, weakSpot } from "../src/app/steps/pickBest.ts";

function solution(over: Partial<Solution>): Solution {
  return {
    id: "1",
    product: "Робот",
    vendor: "Завод",
    type: "AMR",
    subtype: "",
    process: "",
    maturity: "operation",
    tested_fcbas: false,
    registry_719: false,
    status: "recommended",
    score: 0.5,
    at_limit: false,
    checks: [],
    factors: [],
    missing: [],
    can_calculate: true,
    robot_id: "r1",
    calc_note: "",
    summary: "",
    ...over,
  } as Solution;
}

test("лучшее решение: подходящее, считается, с большим баллом", () => {
  const list = [
    solution({ robot_id: "low", score: 0.4 }),
    solution({ robot_id: "top", score: 0.9 }),
    solution({ robot_id: "excluded", score: 0.99, status: "excluded" }),
  ];
  assert.equal(bestToPick(list), "top");
});

test("впритык по грузу идет после решений с запасом, как в списке карточек", () => {
  const list = [
    solution({ robot_id: "edge", score: 0.95, at_limit: true }),
    solution({ robot_id: "roomy", score: 0.6 }),
  ];
  assert.equal(bestToPick(list), "roomy");
});

test("решение другой задачи и то, что не считается, заранее не выбираем", () => {
  const other = solution({
    robot_id: "other",
    checks: [{ label: "Процесс", outcome: "blocks", detail: "не та задача" }],
  });
  const dry = solution({ robot_id: "dry", can_calculate: false });
  assert.equal(forOtherTask(other), true);
  assert.equal(bestToPick([other, dry]), null);
  assert.equal(bestToPick([]), null);
});

test("подходящих нет: ничего не выбираем, человек решает сам", () => {
  assert.equal(bestToPick([solution({ status: "needs_check" }), solution({ status: "excluded" })]), null);
});

test("кому подходит и когда не брать: только из проверок подбора", () => {
  const lines = fitLines(
    solution({
      checks: [
        { label: "Процесс", outcome: "fits", detail: "Решение для задачи" },
        { label: "Груз", outcome: "fits", detail: "Поднимает 1500 кг при грузе 800 кг" },
        { label: "Проезд", outcome: "fits", detail: "Проезд 2.4 м шире минимума" },
        { label: "Пол", outcome: "unknown", detail: "Покрытие пола не указано" },
        { label: "Высота", outcome: "blocks", detail: "Подъем 1.6 м ниже верхнего яруса" },
      ],
    }),
  );
  assert.equal(lines.suits, "поднимает 1500 кг при грузе 800 кг; проезд 2,4 м шире минимума");
  assert.equal(lines.avoid, "подъем 1,6 м ниже верхнего яруса; нет данных: пол");
});

test("без проверок обе строки пустые, карточка говорит, что ограничений нет", () => {
  assert.deepEqual(fitLines(solution({})), { suits: "", avoid: "" });
});

test("пояснение с маленькой буквы и запятой в числе", () => {
  assert.equal(lower("Ширина 2.4 м"), "ширина 2,4 м");
  assert.equal(lower(""), "");
});

test("балл на карточке из 100: 0,79 это 79", () => {
  assert.equal(scoreOf(0.79), 79);
  assert.equal(scoreOf(0.755), 76);
});

test("слабое место подходящего: впритык по грузу раньше пилота", () => {
  const pilot = { label: "Зрелость", outcome: "fits", detail: "Пилот по каталогу: серийную эксплуатацию уточните" };
  const edge = solution({ at_limit: true, checks: [pilot] as Solution["checks"] });
  assert.match(weakSpot(edge), /^груз впритык/);
  assert.match(weakSpot(solution({ checks: [pilot] as Solution["checks"] })), /^пилот по каталогу/);
});

test("слабое место: нет независимой проверки, потом нет цены аренды, иначе пусто", () => {
  const none = { label: "Независимая проверка", contribution: 0, detail: "Независимой проверки в открытых данных нет" };
  assert.equal(
    weakSpot(solution({ factors: [none] as Solution["factors"], raas_fee_rub_month: 100 })),
    "независимой проверки в открытых данных нет",
  );
  assert.equal(weakSpot(solution({ raas_fee_rub_month: null })), "цены аренды в каталоге нет");
  assert.equal(weakSpot(solution({ raas_fee_rub_month: 100 })), "");
});

test("у неподходящих и требующих проверки строки слабого места нет", () => {
  assert.equal(weakSpot(solution({ status: "excluded", at_limit: true })), "");
  assert.equal(weakSpot(solution({ status: "needs_check", raas_fee_rub_month: null })), "");
});

test("подходит при условии: условие стоит слабым местом, а не строкой кому подходит", () => {
  const condition = {
    label: "Условие",
    outcome: "fits",
    detail: "Подвоз стеллажа к станции отбора не подтвержден производителем: спросите поставщика",
  };
  const conditional = solution({ checks: [condition] as Solution["checks"] });
  assert.equal(
    weakSpot(conditional),
    "при условии: подвоз стеллажа к станции отбора не подтвержден производителем: спросите поставщика",
  );
  assert.equal(fitLines(conditional).suits, "");
});
