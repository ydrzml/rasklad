/* Выбор нескольких объектов на листе: Shift+щелчок добавляет вещь или убирает ее, рамка по пустому
   месту берет все, что задела. Выбранное двигают, удаляют и дублируют вместе, одной правкой.

   Выбор лежит одной строкой в том же picked, что и выбор одного объекта: "many:a,b,c". Поэтому его
   снимает все, что снимает обычный выбор: Esc, смена режима, крестик. В строке имена вещей и имена
   групп рядов. Ряд из группы Shift и рамка берут отдельно, со всеми его кусками между поперечными
   проездами. Если выбраны все ряды группы, в строке остается имя группы, и змейка едет с ней.

   Здесь только списки, без проверки, встанет ли: ее делает редактор. Проверка: tests/many.test.ts */
import type { PlanItem } from "../../api/client";
import type { Rect } from "./geometry";

const MANY = "many:";

/* Что выбрано: список имен. Пусто, если выбран один объект или ничего */
export function manyOf(picked: string): string[] {
  return picked.startsWith(MANY) ? picked.slice(MANY.length).split(",").filter(Boolean) : [];
}

/* Строка выбора из списка: ничего, один объект или несколько */
export function pickedOf(units: string[]): string {
  const unique = [...new Set(units.filter(Boolean))];
  return unique.length > 1 ? MANY + unique.join(",") : (unique[0] ?? "");
}

/* Что выбирает обычный щелчок: ряд из группы выбирается всей группой */
export function unitOf(item: PlanItem): string {
  return grouped(item) ? item.group : item.id;
}

function grouped(item: PlanItem): boolean {
  return item.kind === "racks" && Boolean(item.group);
}

/* Один ряд группы: все его куски между поперечными проездами, они лежат на одной линии */
function lineKey(item: PlanItem): string {
  return `${item.group}:${Math.round((item.rows === "x" ? item.y : item.x) * 100)}`;
}

export function lineOf(items: PlanItem[], item: PlanItem): string[] {
  if (!grouped(item)) return [item.id];
  const key = lineKey(item);
  return items.filter((one) => grouped(one) && lineKey(one) === key).map((one) => one.id);
}

/* Имена, в которых все ряды группы собраны обратно в имя группы, а группа, из которой что-то
   убрали, разложена на оставшиеся ряды */
function tidy(items: PlanItem[], ids: string[]): string[] {
  const chosen = new Set(ids);
  const found: string[] = [];
  const add = (one: string) => !found.includes(one) && found.push(one);
  for (const id of ids) {
    const item = items.find((one) => one.id === id);
    if (!item || !grouped(item)) {
      add(id);
      continue;
    }
    const rows = items.filter((one) => grouped(one) && one.group === item.group);
    add(rows.every((one) => chosen.has(one.id)) ? item.group : id);
  }
  return found;
}

/* Имена в отдельные вещи: группа раскладывается на свои ряды */
function spread(items: PlanItem[], units: string[]): string[] {
  return units.flatMap((unit) => {
    const rows = items.filter((one) => grouped(one) && one.group === unit);
    return rows.length ? rows.map((one) => one.id) : [unit];
  });
}

/* Shift+щелчок по вещи: нет в выборе, добавляем; есть, убираем. Ряд группы берется один, со
   всеми своими кусками. Один выбранный объект тоже считается выбором, к нему добавляется второй */
export function toggled(items: PlanItem[], picked: string, item: PlanItem): string {
  const now = manyOf(picked);
  const units = spread(items, now.length ? now : picked ? [picked] : []);
  const line = lineOf(items, item);
  const has = line.every((id) => units.includes(id));
  const next = has ? units.filter((id) => !line.includes(id)) : [...units, ...line];
  return pickedOf(tidy(items, next));
}

/* Змейка группы рядов: полосы с ее именем. Отдельно их не выбирают */
function laneOf(item: PlanItem, owners: Set<string>): boolean {
  if (item.kind !== "flow") return false;
  const at = item.id.indexOf("-flow-");
  return at > 0 && owners.has(item.id.slice(0, at));
}

/* Все вещи выбранного: вещи, ряды выбранных групп и их змейка */
export function membersOf(items: PlanItem[], units: string[]): PlanItem[] {
  const chosen = new Set(units);
  return items.filter(
    (item) => chosen.has(item.id) || (grouped(item) && chosen.has(item.group)) || laneOf(item, chosen),
  );
}

/* Сколько выбрано, для подписи: группа, ряд с кусками и вещь считаются за один. Куски ряда,
   увезенного из группы, лежат на одной линии и тоже считаются одним рядом */
export function countOf(items: PlanItem[], units: string[]): number {
  const keys = new Set(
    units.map((unit) => {
      const item = items.find((one) => one.id === unit);
      return item?.kind === "racks" ? lineKey(item) : unit;
    }),
  );
  return keys.size;
}

/* Группы, из которых выбрана только часть рядов: их змейку кладут заново */
export function partOf(items: PlanItem[], units: string[]): string[] {
  const chosen = new Set(units);
  const found: string[] = [];
  for (const item of items)
    if (grouped(item) && chosen.has(item.id) && !chosen.has(item.group) && !found.includes(item.group))
      found.push(item.group);
  return found;
}

/* Что задела рамка. Ряд группы берется со всеми кусками, вся группа собирается в ее имя.
   Змейку рядов рамка отдельно не берет, ворота и зарядку берет, как щелчок */
export function unitsIn(items: PlanItem[], box: Rect): string[] {
  const owners = new Set(items.filter((item) => item.kind === "racks").map(unitOf));
  const ids: string[] = [];
  for (const item of items) {
    if (laneOf(item, owners) || !touches(item, box)) continue;
    for (const id of lineOf(items, item)) if (!ids.includes(id)) ids.push(id);
  }
  return tidy(items, ids);
}

/* К выбранному добавили найденное рамкой с Shift */
export function joined(items: PlanItem[], picked: string, found: string[]): string {
  const now = manyOf(picked);
  return pickedOf(tidy(items, spread(items, [...(now.length ? now : [picked]), ...found])));
}

function touches(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* План без выбранного: вещи, ряды и змейка выбранных групп уходят одной правкой */
export function withoutMany(items: PlanItem[], units: string[]): PlanItem[] {
  const gone = new Set(membersOf(items, units).map((item) => item.id));
  return items.filter((item) => !gone.has(item.id));
}

/* Выбранное, сдвинутое на dx, dy. Ряды, которые увезли из группы без остальных, больше не в ней:
   иначе правка группы числами разложила бы их обратно. Сдвинутая зарядка становится местом
   человека */
export function shiftedMany(items: PlanItem[], units: string[], dx: number, dy: number): PlanItem[] {
  const chosen = new Set(units);
  return membersOf(items, units).map((item) => ({
    ...item,
    x: item.x + dx,
    y: item.y + dy,
    ...(grouped(item) && !chosen.has(item.group) ? { group: "" } : {}),
    ...(item.kind === "charge" ? { auto: false } : {}),
  }));
}

/* Копия выбранного со сдвигом и с новыми именами. Целая группа копируется группой, отдельные
   ряды отдельными рядами. Ворота и зарядку не копируем, как и при одном объекте: ворота встают
   только в стену, зарядку ставит программа. Змейку тоже, ее кладут заново кнопкой у копии.
   name дает новое имя по виду вещи */
export function copiedMany(
  items: PlanItem[],
  units: string[],
  dx: number,
  dy: number,
  name: (kind: string) => string,
): { items: PlanItem[]; units: string[] } {
  const chosen = new Set(units);
  const groups = new Map<string, string>();
  const copies: PlanItem[] = [];
  const next: string[] = [];
  for (const item of membersOf(items, units)) {
    if (item.kind === "dock" || item.kind === "charge" || laneOf(item, chosen)) continue;
    const whole = grouped(item) && chosen.has(item.group);
    if (whole && !groups.has(item.group)) groups.set(item.group, name("rows"));
    const gid = whole ? (groups.get(item.group) ?? "") : "";
    const id = gid ? `${gid}-r${copies.filter((one) => one.group === gid).length}` : name(item.kind);
    copies.push({ ...item, id, group: gid, auto: false, x: item.x + dx, y: item.y + dy });
    const unit = gid || id;
    if (!next.includes(unit)) next.push(unit);
  }
  return { items: copies, units: next };
}
