/* Сохранение в проект: проект в адресе, возврат после входа, название. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DRAFT_KEY,
  forgetBrowser,
  projectFromUrl,
  projectName,
  RESULT_KEY,
  safeNext,
  UNDERLAY_KEY,
} from "../src/app/saving.ts";

test("проект и версия читаются из адреса", () => {
  assert.deepEqual(projectFromUrl("?step=5&project=12"), { id: 12, version: null, open: false });
  assert.deepEqual(projectFromUrl("?project=12&version=3&open=1"), { id: 12, version: 3, open: true });
  assert.equal(projectFromUrl("?step=5"), null);
  assert.equal(projectFromUrl("?project=abc"), null);
  assert.equal(projectFromUrl("?project=-1"), null);
});

test("после входа возвращаем только на страницу нашего сайта", () => {
  assert.equal(safeNext("/calc?step=5"), "/calc?step=5");
  assert.equal(safeNext(null), "/projects");
  assert.equal(safeNext("https://evil.example"), "/projects");
  assert.equal(safeNext("//evil.example"), "/projects");
  assert.equal(safeNext("/\\evil.example"), "/projects");
});

test("название проекта из объекта, площади и задач", () => {
  assert.equal(projectName("Склад", 10000, ["Перевозка паллет"]), "Склад 10 000 м², перевозка паллет");
  assert.equal(projectName("Склад", null, []), "Склад");
  assert.equal(projectName("Склад", 1, ["x".repeat(300)]).length, 200);
});

test("черновик: пустой не считается, у проекта ведем к проекту", async () => {
  const { draftOf, draftTitle, draftUrl } = await import("../src/app/saving.ts");
  assert.equal(draftOf(null), null);
  assert.equal(draftOf("{}"), null);
  assert.equal(draftOf("не json"), null);
  const mine = draftOf(JSON.stringify({ reached: 3, overrides: { "facilities.warehouse.active_area_m2": 12000 } }));
  assert.ok(mine);
  assert.equal(draftTitle(mine), "Расчет 12\u00a0000 м², дошли до шага «решение»");
  assert.equal(draftUrl(mine), "/calc");
  const project = draftOf(JSON.stringify({ reached: 4, projectId: 7, projectName: "Склад" }));
  assert.ok(project);
  assert.equal(draftUrl(project), "/calc?project=7");
  assert.match(draftTitle(project), /проекту «Склад»/);
  // только что сохранили и ничего не правили: это не черновик
  assert.equal(draftOf(JSON.stringify({ reached: 4, projectId: 7, savedAs: { version: 2, key: "{}" } })), null);
});

test("сохранить после входа: только если нажали недавно", async () => {
  const { saveAfterLogin } = await import("../src/app/saving.ts");
  const now = Date.now();
  assert.equal(saveAfterLogin(String(now - 60_000), now), true);
  assert.equal(saveAfterLogin(String(now - 2 * 60 * 60_000), now), false);
  assert.equal(saveAfterLogin("1", now), false); // старый флаг без времени
  assert.equal(saveAfterLogin(null, now), false);
});

test("снятые с расчета задачи не идут в запрос кабинета и ссылки", async () => {
  const { requestFrom, tasksOf } = await import("../src/app/saving.ts");
  const picks = {
    pallet_transport: [{ robotId: "ronavi-h1500", share: 1 }],
    piece_picking: [{ robotId: "ronavi-m", share: 1 }],
  };
  assert.deepEqual(
    tasksOf(["pallet_transport", "piece_picking"], picks, ["piece_picking"]).map((task) => task.operation_id),
    ["pallet_transport"],
  );
  const state = {
    facilityId: "warehouse",
    taskIds: ["pallet_transport", "piece_picking"],
    picks,
    excluded: ["piece_picking"],
  };
  assert.deepEqual(
    requestFrom(state).tasks.map((task) => task.operation_id),
    ["pallet_transport"],
  );
  assert.equal(requestFrom({ ...state, excluded: [] }).tasks.length, 2);
});

test("решения по задачам: старый снимок с одним robotId открывается, запрос несет задачи", async () => {
  const { choicesOf, requestFrom, tasksOf } = await import("../src/app/saving.ts");
  // старый проект: две задачи, одно решение, оно у первой задачи
  const old = { facilityId: "warehouse", taskIds: ["pallet_transport", "cleaning"], robotId: "ronavi-h1500" };
  assert.deepEqual(choicesOf(old), { pallet_transport: "ronavi-h1500" });
  const request = requestFrom(old);
  assert.equal(request.operation_id, "pallet_transport");
  assert.equal(request.robot_id, "ronavi-h1500");
  assert.deepEqual(request.tasks, [{ operation_id: "pallet_transport", robot_id: "ronavi-h1500", share: 1 }]);
  // новый снимок: решение на каждую задачу, порядок задач как на первом шаге
  const fresh = {
    facilityId: "warehouse",
    taskIds: ["cleaning", "pallet_transport"],
    choices: { pallet_transport: "ronavi-h1500", cleaning: "clinbotics-600" },
  };
  const { picksOf } = await import("../src/app/saving.ts");
  assert.deepEqual(tasksOf(fresh.taskIds, picksOf(fresh)), [
    { operation_id: "cleaning", robot_id: "clinbotics-600", share: 1 },
    { operation_id: "pallet_transport", robot_id: "ronavi-h1500", share: 1 },
  ]);
  assert.equal(requestFrom(fresh).operation_id, "cleaning");
  // совсем новый расчет: решение само не выбирается, его выбирает человек
  assert.deepEqual(choicesOf({}), {});
  assert.deepEqual(picksOf({ facilityId: "warehouse", taskIds: ["pallet_transport"] }), {});
  // смешанный парк: два решения на задачу с долями, в запросе по части на решение
  const mixed = {
    facilityId: "warehouse",
    taskIds: ["pallet_transport"],
    picks: {
      pallet_transport: [
        { robotId: "ronavi-h1500", share: 0.6 },
        { robotId: "moros-amr-1500", share: 0.4 },
      ],
    },
  };
  assert.deepEqual(requestFrom(mixed).tasks, [
    { operation_id: "pallet_transport", robot_id: "ronavi-h1500", share: 0.6 },
    { operation_id: "pallet_transport", robot_id: "moros-amr-1500", share: 0.4 },
  ]);
  assert.deepEqual(choicesOf(mixed), { pallet_transport: "ronavi-h1500" });
});

test("выход стирает из браузера все, что осталось от человека", () => {
  const store = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
  };
  const local = store();
  const session = store();
  Object.assign(globalThis, { window: { localStorage: local, sessionStorage: session } });
  local.setItem(DRAFT_KEY, "{}");
  local.setItem(UNDERLAY_KEY, "{}");
  local.setItem("lct.theme", "dark");
  session.setItem(RESULT_KEY, "{}");

  forgetBrowser();

  assert.equal(local.getItem(DRAFT_KEY), null);
  assert.equal(local.getItem(UNDERLAY_KEY), null);
  assert.equal(session.getItem(RESULT_KEY), null);
  // тема не личное, ее оставляем
  assert.equal(local.getItem("lct.theme"), "dark");
});
