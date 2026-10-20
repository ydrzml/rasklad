/* Готовые разборы: вывод одной фразой из чисел сервера и черновик мастера "Начать с этого разбора".
   Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { caseDraft, ECONOMICS_STEP, WIZARD_URL } from "../src/features/cases/start.ts";
import { verdictNotes, verdictOf } from "../src/features/cases/verdict.ts";

const format = {
  mln: (rub: number) => (rub / 1e6).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  term: (years: number | null | undefined) => (years == null ? "не окупается" : `${years} года`),
};

// числа разбора паллет из ответа сервера
const pallets = {
  robotName: "Ronavi H1500",
  horizon: 5,
  sizing: {
    fleet: 9,
    fte_before: 23.75,
    fte_after: 0,
    operator_posts: 0.225,
    operators_fte: 1.145,
    retrained_fte: 1.145,
  },
  purchase: {
    investment_year0_rub: 41_350_000,
    annual_effect_year1_rub: 37_660_000,
    payback_cumulative_years: 1.1,
    verdict: {
      risks: [
        "План объекта вы не чертили: мы взяли типовую планировку склада",
        "Выход на режим: в первый год экономия меньше на 1,1 млн рублей",
      ],
    },
  },
};

test("фраза собирается из парка, ставок, вложений и окупаемости", () => {
  assert.equal(
    verdictOf(pallets, format).sentence,
    "9 роботов Ronavi H1500 берут работу, на которой сейчас 24 ставки. 41,4 млн ₽ на старте возвращаются за 1.1 года.",
  );
});

test("если люди остаются у станций, фраза это говорит", () => {
  const picking = { ...pallets, sizing: { ...pallets.sizing, fleet: 67, fte_before: 86.8, fte_after: 27.8 } };
  assert.match(
    verdictOf(picking, format).sentence,
    /сейчас 87 ставок, после останется 29 вместе с присмотром за роботами\./,
  );
  // то же число в абзаце про людей: станции и присмотр вместе, как в ролике
  assert.match(verdictOf(picking, format).parts[1].text, /Вместе с присмотром на этой работе остается 29 ставок\./);
});

test("экономия в минусе: без минуса в тексте, расходы с роботами выше", () => {
  const loss = {
    ...pallets,
    purchase: { ...pallets.purchase, annual_effect_year1_rub: -230_000, payback_cumulative_years: null },
  };
  const [first] = verdictOf(loss, format).parts;
  assert.equal(first.title, "Почему не окупается");
  assert.match(first.text, /^Экономии нет: в первый год с роботами расходы выше на 0,2 млн ₽/);
  assert.doesNotMatch(first.text, /-0/);
});

test("не окупается и в досчете до 10 лет, так и пишем", () => {
  const slow = { ...pallets, purchase: { ...pallets.purchase, payback_cumulative_years: null } };
  assert.match(verdictOf(slow, format).sentence, /на старте не окупаются\.$/);
});

test("окупается дольше горизонта: примерно целыми годами и пометка", () => {
  const slow = {
    ...pallets,
    purchase: { ...pallets.purchase, payback_cumulative_years: null, payback_later_years: 7.3 },
  };
  assert.match(
    verdictOf(slow, format).sentence,
    /на старте возвращаются примерно за 7 лет, дольше горизонта расчета в 5 лет\.$/,
  );
});

test("три абзаца: откуда окупаемость, что остается людям, что может сдвинуть", () => {
  const { parts } = verdictOf(pallets, format);
  assert.deepEqual(
    parts.map((one) => one.title),
    ["Откуда окупаемость", "Что остается людям", "Что может сдвинуть вывод"],
  );
  assert.equal(
    parts[1].text,
    "Присмотр за роботами: доля ставки в смену, часть работы начальника смены: его берем из тех, кто сейчас на этой работе.",
  );
  // риск про план, которого гость не чертил, пропускаем
  assert.match(parts[2].text, /^Выход на режим/);
});

test("черновик мастера несет задачу, решение и план разбора и открывает экономику", () => {
  const plan = { width_m: 118, length_m: 85, edited: false };
  const draft = caseDraft(
    {
      facility_id: "warehouse",
      tasks: [{ operation_id: "pallet_transport", robot_id: "ronavi-h1500", share: 1 }],
      overrides: {},
    },
    plan,
  );
  assert.deepEqual(draft.taskIds, ["pallet_transport"]);
  assert.deepEqual(draft.picks, { pallet_transport: [{ robotId: "ronavi-h1500", share: 1 }] });
  assert.equal(draft.robotId, "ronavi-h1500");
  assert.equal(draft.plan, plan);
  assert.equal(draft.reached, ECONOMICS_STEP);
  assert.equal(draft.calcStarted, true);
  assert.equal(draft.staffTouched, false);
  assert.equal(WIZARD_URL, "/calc?step=5");
});

test("как платить: подписи у самого дешевого, самого легкого на старте и самого быстрого из покупок", async () => {
  const { payRows } = await import("../src/features/cases/payments.ts");
  // паллеты: свои, кредит, лизинг, аренда, млн
  const rows = payRows(
    {
      own: { investment_year0_rub: 41.4, tco_rub: 119.6, payback_cumulative_years: 1.33 },
      loan: { investment_year0_rub: 8.3, tco_rub: 133.1, payback_cumulative_years: 1.53 },
      leasing: { investment_year0_rub: 19.7, tco_rub: 131.2, payback_cumulative_years: 1.48 },
      raas: {
        investment_year0_rub: 11.5,
        tco_rub: 121.8,
        payback_cumulative_years: 0.52,
        annual_effect_year1_rub: 29.6,
      },
    },
    5,
  );
  // аренда как найм: окупается у нее только внедрение, в "быстрее всего окупается" она не участвует
  assert.deepEqual(
    rows.map((row) => [row.id, row.badges]),
    [
      ["own", ["дешевле всего за 5 лет", "быстрее всего окупается"]],
      ["loan", ["меньше всего денег на старте"]],
      ["leasing", []],
      ["raas", []],
    ],
  );
  assert.equal(rows[3].first, 29.6);
});

test("как платить: то, что не окупается, быстрым не считаем, а без кредита карточки нет", async () => {
  const { payRows } = await import("../src/features/cases/payments.ts");
  const rows = payRows(
    {
      own: { investment_year0_rub: 2.8, tco_rub: 28.9, payback_cumulative_years: 3.9 },
      raas: { investment_year0_rub: 0.2, tco_rub: 29.8, payback_cumulative_years: null },
    },
    5,
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.badges]),
    [
      ["own", ["дешевле всего за 5 лет", "быстрее всего окупается"]],
      ["raas", ["меньше всего денег на старте"]],
    ],
  );
});

test("строки под выводом разбора: порог, если покупка не окупается, и круглосуточный режим", () => {
  const notes = verdictNotes({
    horizon_years: 5,
    scenarios: [{ id: "purchase", payback_cumulative_years: null }],
    payback_needs: [{ text: "оклад от 137 000 рублей в месяц (у вас 100 000)" }],
    round_the_clock: { text: "При круглосуточной работе (3 смены, 365 дней) покупка за 2,4 года" },
  });
  assert.deepEqual(notes, [
    "Чтобы покупка окупилась за 5 лет, хватит одного из условий: оклад от 137 000 рублей в месяц (у вас 100 000).",
    "При круглосуточной работе (3 смены, 365 дней) покупка за 2,4 года.",
  ]);
  // окупается: порога нет, круглосуточной строки нет, если склад и так круглосуточный
  assert.deepEqual(
    verdictNotes({ horizon_years: 5, scenarios: [{ id: "purchase", payback_cumulative_years: 2 }] }),
    [],
  );
});

test("присмотр дробью не пишем: меньше человека это доля ставки, больше целыми вверх", () => {
  const one = { ...pallets, sizing: { ...pallets.sizing, fleet: 1, operator_posts: 0.02, operators_fte: 0.1 } };
  const text = verdictOf(one, format).parts[1].text;
  assert.match(text, /Присмотр за роботами: доля ставки в смену/);
  assert.doesNotMatch(text, /\d человека/);
  const many = { ...pallets, sizing: { ...pallets.sizing, fleet: 80, operator_posts: 1.4, operators_fte: 3.6 } };
  assert.match(verdictOf(many, format).parts[1].text, /Присмотр за роботами: 2 человека в смену/);
});

test("кейс-двойник: наш результат рядом с их фактом, расхождение больше чем вдвое называем", async () => {
  const { gapOf, twinResult } = await import("../src/features/cases/twin.ts");
  const twin = {
    place: "Склад X",
    given: "7 000 м²",
    fact: "48 роботов, окупаемость 6-9 месяцев",
    years: [0.5, 0.75] as [number, number],
    compare: "raas" as const,
    link: { title: "кейс", site: "retail.ru", href: "https://example.org" },
  };
  const ours = {
    sizing: { fleet: 20, fte_before: 80, fte_after: 31, operators_fte: 1 },
    scenarios: [
      { id: "purchase", payback_cumulative_years: 1.2 },
      { id: "raas", payback_cumulative_years: 0.4 },
    ],
  };
  const term = (years: number | null) => `${years} года`;
  const fmt = { term, mln: (rub: number) => String(rub / 1e6) };
  assert.equal(gapOf(twin, ours), 1.25);
  assert.equal(
    twinResult(twin, ours, fmt),
    "У нас на тех же значениях: 20 роботов, ставок на этой работе 80 → 32, покупка окупается за 1.2 года, " +
      "аренда за 0.4 года. У них: 48 роботов, окупаемость 6-9 месяцев.",
  );
  // внутри их коридора расхождения нет, втрое быстрее называем
  assert.equal(gapOf({ ...twin, compare: "purchase", years: [1, 3] }, ours), 1);
  const fast = { ...ours, scenarios: [{ id: "raas", payback_cumulative_years: 0.2 }] };
  assert.match(twinResult(twin, fast, fmt), /покупка не окупается.*больше чем вдвое/);
  // у них опубликована экономия в год: рядом наша экономия первого года
  const saving = {
    ...ours,
    scenarios: [{ id: "purchase", payback_cumulative_years: null, annual_effect_year1_rub: 1e6 }],
  };
  assert.match(
    twinResult({ ...twin, years: null, effect: true }, saving, fmt),
    /экономия первого года 1 млн ₽, покупка не окупается/,
  );
  // срок не публиковали: сравнивать нечем
  assert.equal(gapOf({ ...twin, years: null }, ours), null);
});
