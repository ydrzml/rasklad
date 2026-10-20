import type { Item } from "./items";

// Фильтры каталога живут в адресе: ссылку на "уборщики для аэропорта" можно отправить
export type Filters = { query: string; facility: string; task: string; type: string; sort: string };

export const EMPTY: Filters = { query: "", facility: "all", task: "all", type: "all", sort: "name" };

export const SORTS = [
  { id: "name", name: "По названию" },
  { id: "price", name: "Сначала дешевле" },
  { id: "data", name: "Сначала с полными данными" },
];

const KEYS: Record<keyof Filters, string> = {
  query: "q",
  facility: "object",
  task: "task",
  type: "type",
  sort: "sort",
};

export function readFilters(): Filters {
  const query = new URLSearchParams(window.location.search);
  const read = (key: keyof Filters) => query.get(KEYS[key]) ?? EMPTY[key];
  return {
    query: read("query"),
    facility: read("facility"),
    task: read("task"),
    type: read("type"),
    sort: read("sort"),
  };
}

export function writeFilters(filters: Filters) {
  const query = new URLSearchParams();
  (Object.keys(KEYS) as (keyof Filters)[]).forEach((key) => {
    if (filters[key] !== EMPTY[key]) query.set(KEYS[key], filters[key]);
  });
  const search = query.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
}

export function applyFilters(items: Item[], filters: Filters): Item[] {
  const words = filters.query.trim().toLowerCase();
  const [taskFacility, task] = filters.task.split(":");
  const found = items.filter((item) => {
    if (words && !`${item.product} ${item.vendor}`.toLowerCase().includes(words)) return false;
    if (filters.facility !== "all" && !item.uses.some((use) => use.facility === filters.facility)) return false;
    if (task && !item.uses.some((use) => use.facility === taskFacility && use.task === task)) return false;
    if (filters.type === "none") return !item.type;
    return filters.type === "all" || item.type === filters.type;
  });
  return [...found].sort(ORDER[filters.sort] ?? ORDER.name);
}

const byName = (left: Item, right: Item) => left.product.localeCompare(right.product, "ru");

// Без цены в конце списка: "нет данных" не дешевле самого дешевого
const ORDER: Record<string, (left: Item, right: Item) => number> = {
  name: byName,
  price: (left, right) => (left.price ?? Infinity) - (right.price ?? Infinity) || byName(left, right),
  data: (left, right) => known(right) - known(left) || byName(left, right),
};

// Сколько характеристик известно: значение есть и это не "данных нет"
export function known(item: Item): number {
  return item.facts.filter((fact) => fact.value && fact.trust !== "F").length;
}
