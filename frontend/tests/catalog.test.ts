/* Каталог роботов для гостя: сборка из ответов сервера, слова на экране и фильтры. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFilters, EMPTY, known } from "../src/features/catalog/filters.ts";
import { buildCatalog, plain } from "../src/features/catalog/items.ts";

const facility = (id: string, name: string, status: string, operations: [string, string][]) => ({
  id,
  name,
  status,
  note: "",
  next: [],
  catalog: { count: 0, note: "", source: "", trust: "" },
  operations: operations.map(([opId, opName]) => ({ id: opId, name: opName })),
});

const FACILITIES = [
  facility("warehouse", "Склад", "ready", [
    ["pallet_transport", "Перевозка паллет"],
    ["cleaning", "Уборка полов"],
  ]),
  facility("airport", "Аэропорт", "solutions", [["cleaning", "Уборка терминала"]]),
  facility("other", "Другое", "catalog_only", []),
];

const OTHER_TASK = { label: "Процесс", outcome: "blocks", detail: "Решение для другой задачи" };
const FITS = { label: "Процесс", outcome: "fits", detail: "" };

const stockSolution = (id: string, product: string, checks: object[]) => ({
  id,
  product,
  vendor: "ООО Тест",
  type: "Мобильные роботы",
  maturity: "operation",
  tested_fcbas: false,
  checks,
  specs: [{ field: "payload_kg", label: "Грузоподъемность, кг", value: "1.5", trust: "C", unit: "кг" }],
  price_rub: 1_000_000,
  summary: "",
  photo_url: null,
});

const listedSolution = (id: string, product: string) => ({
  id,
  product,
  vendor: "ООО Тест",
  from_catalog: true,
  operation: "cleaning",
  operation_name: "Уборка терминала",
  why: "в эксплуатации по каталогу организатора",
  limits: "",
  availability: "эксплуатация",
  specs: [
    {
      field: "payload_kg",
      label: "Грузоподъемность",
      value: "20 кг",
      trust: "B",
      trust_name: "Два источника",
      note: "сходятся организатор и производитель",
      sources: "организатор, производитель",
      date: "2026-09-23",
    },
  ],
  price_rub: null,
  price_source: "организатор, 15.09.2026",
  photo_url: null,
});

// склад отвечает по каждой задаче отдельно: уборщик в перевозке помечен как решение для другой задачи
const STOCK = [
  [stockSolution("amr", "AMR 800", [FITS]), stockSolution("bot", "Уборщик", [OTHER_TASK])],
  [stockSolution("amr", "AMR 800", [OTHER_TASK]), stockSolution("bot", "Уборщик", [FITS])],
];
const OTHERS = [
  { solutions: [listedSolution("bot", "Уборщик"), listedSolution("ext-1", "Неизвестный")], conditions: [] },
];

// типы ответа сервера здесь урезаны до полей, которые читает страница
const catalog = buildCatalog(FACILITIES as never, STOCK as never, OTHERS as never);
const byId = (id: string) => catalog.items.find((item) => item.id === id)!;

test("одно решение у нескольких объектов стоит на странице один раз со всеми задачами", () => {
  assert.equal(catalog.items.length, 3);
  assert.deepEqual(
    byId("bot").uses.map((use) => `${use.facility}:${use.task}`),
    ["warehouse:cleaning", "airport:cleaning"],
  );
  // задача склада берется только там, где подбор не сказал "решение для другой задачи"
  assert.deepEqual(
    byId("amr").uses.map((use) => use.task),
    ["pallet_transport"],
  );
});

test("у разобранных решений цифры с источником и датой, а не одной буквой", () => {
  const fact = byId("bot").facts[0];
  assert.equal(fact.trust, "B");
  assert.equal(fact.source, "каталог ФЦ БАС, производитель, 23.09.2026");
  // у склада единица из карточки каталога и запятая в числе
  assert.equal(byId("amr").facts[0].value, "1,5 кг");
  assert.equal(byId("amr").facts[0].label, "Грузоподъемность");
});

test("на экране для гостя нет слов организатор и выгрузка", () => {
  const text = JSON.stringify(catalog.items);
  assert.ok(!/организатор|выгрузк/.test(text), text);
  assert.equal(plain("в эксплуатации по каталогу организатора"), "в эксплуатации по каталогу ФЦ БАС");
  assert.equal(plain("только организатор"), "только каталог ФЦ БАС");
  assert.equal(plain("организатор, производитель"), "каталог ФЦ БАС, производитель");
});

test("фильтры: объект, задача, тип и поиск по названию", () => {
  const ids = (filters: Partial<typeof EMPTY>) =>
    applyFilters(catalog.items, { ...EMPTY, ...filters }).map((item) => item.id);
  assert.deepEqual(ids({ facility: "airport" }), ["ext-1", "bot"]);
  assert.deepEqual(ids({ task: "warehouse:pallet_transport" }), ["amr"]);
  // у решения из открытых источников тип в ответе сервера не указан
  assert.deepEqual(ids({ type: "none" }), ["ext-1"]);
  assert.deepEqual(ids({ query: "amr" }), ["amr"]);
  assert.deepEqual(ids({ query: "нет такого" }), []);
});

test("сначала дешевле: решения без цены в конце", () => {
  const order = applyFilters(catalog.items, { ...EMPTY, sort: "price" }).map((item) => item.id);
  assert.equal(order.at(-1), "ext-1");
  assert.equal(known(byId("ext-1")), 1);
});
