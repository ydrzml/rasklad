import type { Facility, FacilitySolution, FacilitySolutions, Solution } from "../../api/client";

// Каталог для гостя из ответов открытых точек каталога. Подбор не трогаем, проверки по параметрам
// здесь не нужны: берем только, что за решение, для каких задач оно размечено и откуда его цифры.
// Одно и то же решение бывает у нескольких объектов (уборщик есть у всех трех), на странице оно одно.

export type Fact = {
  field: string;
  label: string;
  value: string;
  trust: string;
  trustTitle: string;
  source: string;
};

export type Use = { facility: string; facilityName: string; task: string; taskName: string };

export type Item = {
  id: string;
  product: string;
  vendor: string;
  type: string;
  photo: string | null;
  fromCatalog: boolean;
  tested: boolean;
  maturity: string;
  uses: Use[];
  facts: Fact[];
  price: number | null;
  priceSource: string;
  why: string[];
  limits: string[];
};

export type Catalog = { facilities: Facility[]; items: Item[] };

// Оценка надежности словами, как в "Откуда цифры", только без внутренних названий источников
export const TRUST_WORDS: Record<string, string> = {
  S: "закон или норматив",
  A: "производитель и независимая проверка",
  B: "сходятся два типа источников",
  C: "один источник",
  D: "только каталог ФЦ БАС или СМИ",
  E: "источники расходятся",
  F: "данных нет",
};

export const OTHER_TASK = "other";

// Расчет с начала: со страницы каталога, из карточки и из панели подробностей
export const CALC_HREF = "/calc?new=1";

// Собирает каталог из ответов сервера. Отдельно от запросов, чтобы проверять тестом без сети
export function buildCatalog(facilities: Facility[], stock: Solution[][], others: FacilitySolutions[]): Catalog {
  const warehouse = facilities.find((one) => one.id === "warehouse");
  const listed = facilities.filter((one) => one.status === "solutions");
  const items = new Map<string, Item>();
  if (warehouse) {
    warehouse.operations.forEach((task, index) =>
      stock[index].forEach((solution) => mergeStock(items, solution, warehouse, task.id, task.name)),
    );
  }
  listed.forEach((one, index) => others[index].solutions.forEach((solution) => mergeListed(items, solution, one)));
  return { facilities, items: [...items.values()].map(withOtherTask) };
}

function mergeStock(items: Map<string, Item>, solution: Solution, facility: Facility, task: string, name: string) {
  // подбор помечает решение для другой задачи проверкой "Процесс", так же ее читает шаг 4
  const forTask = !solution.checks.some((check) => check.label === "Процесс" && check.outcome === "blocks");
  const current = items.get(solution.id) ?? fromStock(solution);
  const uses = forTask ? [...current.uses, taskUse(facility, task, name)] : current.uses;
  items.set(solution.id, { ...current, uses });
}

function fromStock(solution: Solution): Item {
  return {
    id: solution.id,
    product: solution.product,
    vendor: solution.vendor,
    type: solution.type,
    photo: solution.photo_url ?? null,
    fromCatalog: true,
    tested: solution.tested_fcbas,
    maturity: solution.maturity === "piloting" ? "пилот" : "в эксплуатации",
    uses: [],
    facts: (solution.specs ?? []).map((spec) => ({
      field: spec.field,
      label: spec.unit ? spec.label.replace(/,\s*[^,]+$/, "") : spec.label,
      value: spec.value
        ? `${decimal(spec.value)}${spec.unit && !spec.value.includes("/ч") ? ` ${spec.unit}` : ""}`
        : "",
      trust: spec.trust,
      trustTitle: TRUST_WORDS[spec.trust] ?? spec.trust,
      source: TRUST_WORDS[spec.trust] ?? "",
    })),
    price: solution.price_rub ?? null,
    priceSource: solution.price_rub ? "каталог ФЦ БАС, с НДС, без доставки и интеграции" : "",
    why: solution.summary ? [plain(solution.summary)] : [],
    limits: [],
  };
}

function mergeListed(items: Map<string, Item>, solution: FacilitySolution, facility: Facility) {
  const facts = solution.specs.map((spec) => ({
    field: spec.field,
    label: spec.label,
    value: decimal(spec.value),
    trust: spec.trust,
    trustTitle: `${spec.trust_name}. ${plain(spec.note)}`,
    source: spec.value ? `${plain(spec.sources)}, ${day(spec.date)}` : `не нашли, искали ${day(spec.date)}`,
  }));
  const base: Item = items.get(solution.id) ?? {
    id: solution.id,
    product: solution.product,
    vendor: solution.vendor,
    type: "",
    photo: solution.photo_url ?? null,
    fromCatalog: solution.from_catalog,
    tested: false,
    maturity: plain(solution.availability),
    uses: [],
    facts,
    price: solution.price_rub ?? null,
    priceSource: plain(solution.price_source),
    why: [],
    limits: [],
  };
  items.set(solution.id, {
    ...base,
    // у разобранных решений источник и дата есть у каждой цифры: это подробнее записи склада
    facts: base.facts.some((fact) => fact.source.includes(",")) ? base.facts : facts,
    price: base.price ?? solution.price_rub ?? null,
    priceSource: base.priceSource || plain(solution.price_source),
    uses: [...base.uses, taskUse(facility, solution.operation, solution.operation_name)],
    // у каждого объекта свое "почему": подписываем объект, иначе две похожие фразы подряд читались повтором
    why: unique([...base.why, plain(solution.why) ? `${facility.name}: ${plain(solution.why)}` : ""]),
    limits: unique([...base.limits, plain(solution.limits)]),
  });
}

function taskUse(facility: Facility, task: string, taskName: string): Use {
  return { facility: facility.id, facilityName: facility.name, task, taskName };
}

// Решение склада, которое подбор не ведет ни в одну задачу мастера (работа на ярусах): на странице
// оно все равно есть, у склада, с задачей "другие задачи склада"
function withOtherTask(item: Item): Item {
  if (item.uses.length) return item;
  const other = { facility: "warehouse", facilityName: "Склад", task: OTHER_TASK, taskName: "Другие задачи склада" };
  return { ...item, uses: [other] };
}

// На экранах для гостя внутренние слова не пишем: данные организатора это каталог ФЦ БАС
export function plain(text: string): string {
  return text
    .replace(/(каталог\S*) организатора/g, "$1 ФЦ БАС")
    .replace(/данн(ые|ых|ым) организатора/g, "данн$1 каталога ФЦ БАС")
    .replace(/только организатор/g, "только каталог ФЦ БАС")
    .replace(/организатор[а-я]*/g, "каталог ФЦ БАС")
    .replace(/выгрузк[а-я]*/g, "каталог");
}

// 2026-09-23 -> 23.09.2026
function day(iso: string): string {
  return iso.split("-").reverse().join(".");
}

function decimal(text: string): string {
  return text.replace(/(\d)\.(\d)/g, "$1,$2");
}

function unique(lines: string[]): string[] {
  return [...new Set(lines.filter(Boolean))];
}
