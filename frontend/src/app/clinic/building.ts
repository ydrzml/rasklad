/* Корпус медучреждения в формате сервера (docs/medical.md, backend/app/schemas/clinic.py): этажи как
   план склада, вещи-прямоугольники в метрах, ноль в левом нижнем углу, y на север. Здесь только
   правки корпуса без экрана: добавить помещение с дверью, перенести, скопировать этаж, поставить
   шахту лифта сразу на все этажи. Экран рисует, сервер проверяет и считает. Модуль без браузера:
   npm test.

   Набор инструментов взят из редактора корпуса Аркера (помещение, дверь на стене, шахта через
   этажи, копия этажа), формат наш: тот же, что считает движок engine/clinic. */

export type Kind = "room" | "door" | "lift" | "charge" | "blocked";
export type Role = "" | "pharmacy" | "supplies" | "ward" | "other" | "cleaning";

export type Item = {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  role: Role;
  width_mm: number;
  automatic: boolean;
  lift: string;
};

export type Section = { id: string; x: number; y: number; w: number; h: number; floor_m?: number; ceiling_m?: number };

export type Floor = {
  number: number;
  name: string;
  width_m: number;
  length_m: number;
  sections: Section[];
  items: Item[];
};

export type Lift = {
  id: string;
  name: string;
  cabin_w_mm: number;
  cabin_d_mm: number;
  door_mm: number;
  robots: boolean;
  people_calls_per_hour: number;
};

export type ProcessFlow = { source: string; target: string; per_day: number };
export type DeliveryProcess = {
  enabled: boolean;
  mode: "per_point" | "building" | "routes";
  per_day: number | null;
  urgent_share: number | null;
  picking_min: number | null;
  deadline_min: number | null;
  urgent_deadline_min: number | null;
  flows: ProcessFlow[];
};
export type ClinicScenario = {
  shift_start_h: number;
  shift_hours: number;
  schedule: "industry" | "uniform" | "custom";
  hourly_weights: number[];
  meds: DeliveryProcess;
  supplies: DeliveryProcess;
  point_weights: Record<string, number>;
  cleaning_passes: number;
  floor_cleaning_passes: Record<string, number>;
  days_per_year?: number | null;
};
export type Building = {
  version: 1;
  floor_height_m: number;
  floors: Floor[];
  lifts: Lift[];
  scenario?: ClinicScenario | null;
};
export type Box = { x: number; y: number; w: number; h: number };
export type XY = { x: number; y: number };

// Потолки те же, что у сервера (MAX_FLOORS, MAX_ITEMS, MAX_LIFTS в schemas/clinic.py)
export const MAX_FLOORS = 20;
export const MAX_ITEMS = 300;
export const MAX_LIFTS = 12;
export const MAX_SIDE_M = 200;
export const MIN_ROOM_M = 3;
export const SHAFT_M = 3;
export const CHARGE_M = 2;

export const ROLE_NAMES: Record<Exclude<Role, "cleaning">, string> = {
  ward: "Пост отделения",
  pharmacy: "Аптека",
  supplies: "Склад расходников",
  other: "Другое помещение",
  "": "Другое помещение",
};

const blank = { name: "", role: "" as Role, width_mm: 0, automatic: true, lift: "" };

/* id вещи уникален во всем корпусе: так требует сервер, а проверка плана подсвечивает вещь по id */
export function newId(building: Building, prefix: string): string {
  const taken = new Set(building.floors.flatMap((floor) => floor.items.map((item) => item.id)));
  for (let n = 1; ; n++) if (!taken.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export const snap = (value: number, step = 1) => Math.round(value / step) * step;
const round = (value: number) => Math.round(value * 100) / 100;

export function boxOf(a: XY, b: XY): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function inside(box: Box, at: XY, pad = 0): boolean {
  return at.x >= box.x - pad && at.x <= box.x + box.w + pad && at.y >= box.y - pad && at.y <= box.y + box.h + pad;
}

function within(inner: Box, outer: Box, pad = 0.01): boolean {
  return (
    inner.x >= outer.x - pad &&
    inner.y >= outer.y - pad &&
    inner.x + inner.w <= outer.x + outer.w + pad &&
    inner.y + inner.h <= outer.y + outer.h + pad
  );
}

function clampBox(box: Box, floor: Floor): Box {
  const w = Math.min(box.w, floor.width_m);
  const h = Math.min(box.h, floor.length_m);
  return {
    x: round(Math.max(0, Math.min(floor.width_m - w, box.x))),
    y: round(Math.max(0, Math.min(floor.length_m - h, box.y))),
    w: round(w),
    h: round(h),
  };
}

function withFloor(building: Building, number: number, change: (floor: Floor) => Floor): Building {
  return { ...building, floors: building.floors.map((floor) => (floor.number === number ? change(floor) : floor)) };
}

function overlappingDoor(floor: Floor, door: Box & { id: string }): Item | undefined {
  return floor.items.find(
    (other) =>
      other.kind === "door" &&
      other.id !== door.id &&
      Math.min(door.x + door.w, other.x + other.w) - Math.max(door.x, other.x) > 0.000001 &&
      Math.min(door.y + door.h, other.y + other.h) - Math.max(door.y, other.y) > 0.000001,
  );
}

/* Проверяем именно измененные проемы: старый ошибочный план можно исправлять по одной двери.
   При сжатии помещения его двери тоже не должны слипаться или выходить за свою стену. */
function withItems(building: Building, number: number, items: Item[]): Building {
  const floor = floorOf(building, number);
  if (!floor) return building;
  const next = { ...floor, items };
  const before = new Map(floor.items.map((item) => [item.id, item]));
  for (const door of items) {
    if (door.kind !== "door") continue;
    const old = before.get(door.id);
    if (old && door.x === old.x && door.y === old.y && door.w === old.w && door.h === old.h) continue;
    const owner = old && roomOf(floor, old);
    const room = owner && items.find((item) => item.id === owner.id);
    if (
      (room && !within(door, room)) ||
      !within(door, { x: 0, y: 0, w: floor.width_m, h: floor.length_m }) ||
      overlappingDoor(next, door)
    )
      return building;
  }
  return withFloor(building, number, () => next);
}

export function floorOf(building: Building, number: number): Floor | undefined {
  return building.floors.find((floor) => floor.number === number);
}

/* Дверь стоит на краю помещения: прямоугольник поперек стены, глубиной в клетку сетки (1 м), вдоль
   стены ширина проема. Так ее читает движок: дверь вырезает проход в клетках стены */
export type Side = "south" | "north" | "west" | "east";

export function doorBox(room: Box, side: Side, along: number, widthMm: number): Box {
  const span = Math.max(0.6, widthMm / 1000);
  if (side === "south" || side === "north") {
    const x = Math.max(room.x + 1, Math.min(room.x + room.w - 1 - span, along - span / 2));
    return { x: round(x), y: side === "south" ? room.y : room.y + room.h - 1, w: round(span), h: 1 };
  }
  const y = Math.max(room.y + 1, Math.min(room.y + room.h - 1 - span, along - span / 2));
  return { x: side === "west" ? room.x : room.x + room.w - 1, y: round(y), w: 1, h: round(span) };
}

/* Ближняя к точке стена помещения и место на ней */
export function nearestSide(room: Box, at: XY): { side: Side; along: number } {
  const gaps: [Side, number][] = [
    ["south", Math.abs(at.y - room.y)],
    ["north", Math.abs(room.y + room.h - at.y)],
    ["west", Math.abs(at.x - room.x)],
    ["east", Math.abs(room.x + room.w - at.x)],
  ];
  const side = gaps.reduce((best, one) => (one[1] < best[1] ? one : best))[0];
  return { side, along: side === "south" || side === "north" ? at.x : at.y };
}

export function sideOf(door: Box, room: Box): Side {
  if (door.h <= 1.01 && Math.abs(door.y - room.y) < 0.01) return "south";
  if (door.h <= 1.01 && Math.abs(door.y + door.h - room.y - room.h) < 0.01) return "north";
  if (Math.abs(door.x - room.x) < 0.01) return "west";
  return "east";
}

/* Двери помещения: те, что лежат на его краю */
export function doorsOf(floor: Floor, room: Box): Item[] {
  return floor.items.filter((item) => item.kind === "door" && within(item, room));
}

export function roomOf(floor: Floor, door: Box): Item | undefined {
  return floor.items.find((item) => item.kind === "room" && within(door, item));
}

/* Дверь по умолчанию смотрит в коридор: на ту стену, что ближе к середине этажа. Ширина 1200 мм:
   проем палаты по СП 158.13330.2014, тот же, что в типовом корпусе */
export const DOOR_MM = 1200;

export function addRoom(
  building: Building,
  number: number,
  raw: Box,
  role: Exclude<Role, "cleaning"> = "ward",
): Building {
  const floor = floorOf(building, number);
  if (!floor) return building;
  const box = clampBox(
    {
      x: snap(raw.x),
      y: snap(raw.y),
      w: Math.max(MIN_ROOM_M, snap(raw.w)),
      h: Math.max(MIN_ROOM_M, snap(raw.h)),
    },
    floor,
  );
  const id = newId(building, `f${number}-room`);
  const rooms = floor.items.filter((item) => item.kind === "room").length;
  const center = { x: floor.width_m / 2, y: floor.length_m / 2 };
  const side: Side =
    center.y > box.y + box.h ? "north" : center.y < box.y ? "south" : center.x < box.x ? "west" : "east";
  const along = side === "south" || side === "north" ? box.x + box.w / 2 : box.y + box.h / 2;
  const room: Item = { ...blank, ...box, id, kind: "room", role, name: `${ROLE_NAMES[role]} ${rooms + 1}` };
  const door: Item = {
    ...blank,
    ...doorBox(box, side, along, DOOR_MM),
    id: `${id}-door`,
    kind: "door",
    width_mm: DOOR_MM,
  };
  return withFloor(building, number, (one) => ({ ...one, items: [...one.items, room, door] }));
}

/* Дверь щелчком по свободной стене. Повторный клик выбирает существующий проем. */
export function addDoor(building: Building, number: number, at: XY): { building: Building; id: string } | null {
  const floor = floorOf(building, number);
  const room = floor && [...floor.items].reverse().find((item) => item.kind === "room" && inside(item, at, 0.6));
  if (!floor || !room) return null;
  const { side, along } = nearestSide(room, at);
  const wall =
    side === "south" ? room.y : side === "north" ? room.y + room.h : side === "west" ? room.x : room.x + room.w;
  if (Math.abs((side === "south" || side === "north" ? at.y : at.x) - wall) > 0.6) return null;
  const id = newId(building, `${room.id}-door`);
  const door: Item = { ...blank, ...doorBox(room, side, along, DOOR_MM), id, kind: "door", width_mm: DOOR_MM };
  if (!within(door, room)) return null;
  const existing = overlappingDoor(floor, door);
  if (existing) return { building, id: existing.id };
  return { building: withFloor(building, number, (one) => ({ ...one, items: [...one.items, door] })), id };
}

/* Шахта лифта: один лифт на все этажи. Новый лифт берет кабину образца (типового корпуса), чтобы не
   выдумывать числа: паспорт больничного лифта в config/clinic.yaml */
export function addLift(building: Building, at: XY, sample: Lift): { building: Building; id: string } | null {
  if (building.lifts.length >= MAX_LIFTS) return null;
  let n = 1;
  while (building.lifts.some((lift) => lift.id === `L${n}`)) n++;
  const id = `L${n}`;
  const lift: Lift = { ...sample, id, name: `Лифт ${n}` };
  return {
    building: {
      ...building,
      lifts: [...building.lifts, lift],
      floors: building.floors.map((floor) => ({ ...floor, items: [...floor.items, shaft(floor, id, at)] })),
    },
    id,
  };
}

function shaft(floor: Floor, lift: string, at: XY): Item {
  const box = clampBox({ x: snap(at.x - SHAFT_M / 2), y: snap(at.y - SHAFT_M / 2), w: SHAFT_M, h: SHAFT_M }, floor);
  return { ...blank, ...box, id: `f${floor.number}-${lift}`, kind: "lift", lift };
}

/* Остановка лифта на этаже: есть шахта или нет. Нет ни на одном этаже: лифт удаляем целиком */
export function toggleStop(building: Building, lift: string, number: number): Building {
  const floor = floorOf(building, number);
  if (!floor) return building;
  const here = floor.items.find((item) => item.kind === "lift" && item.lift === lift);
  if (here) {
    const next = withFloor(building, number, (one) => ({ ...one, items: one.items.filter((item) => item !== here) }));
    const left = next.floors.some((one) => one.items.some((item) => item.kind === "lift" && item.lift === lift));
    return left ? next : { ...next, lifts: next.lifts.filter((one) => one.id !== lift) };
  }
  const elsewhere = building.floors
    .flatMap((one) => one.items)
    .find((item) => item.kind === "lift" && item.lift === lift);
  if (!elsewhere) return building;
  return withFloor(building, number, (one) => ({
    ...one,
    items: [...one.items, { ...elsewhere, ...clampBox(elsewhere, one), id: `f${number}-${lift}` }],
  }));
}

export function addBox(building: Building, number: number, kind: "charge" | "blocked", raw: Box): Building {
  const floor = floorOf(building, number);
  if (!floor) return building;
  const size =
    kind === "charge" ? { w: CHARGE_M, h: CHARGE_M } : { w: Math.max(1, snap(raw.w)), h: Math.max(1, snap(raw.h)) };
  const at =
    kind === "charge"
      ? { x: snap(raw.x - CHARGE_M / 2), y: snap(raw.y - CHARGE_M / 2) }
      : { x: snap(raw.x), y: snap(raw.y) };
  const item: Item = {
    ...blank,
    ...clampBox({ ...at, ...size }, floor),
    id: newId(building, `f${number}-${kind}`),
    kind,
  };
  return withFloor(building, number, (one) => ({ ...one, items: [...one.items, item] }));
}

/* Что под курсором: мелкое поверх крупного, иначе дверь не выбрать на помещении */
export function hit(floor: Floor, at: XY): Item | undefined {
  const order: Kind[] = ["door", "lift", "charge", "blocked", "room"];
  for (const kind of order) {
    const found = [...floor.items]
      .reverse()
      .find((item) => item.kind === kind && inside(item, at, kind === "door" ? 0.4 : 0));
    if (found) return found;
  }
  return undefined;
}

/* Сдвиг вещи. Помещение едет вместе со своими дверями, шахта на всех этажах сразу, дверь только
   вдоль своей стены */
export function moveItem(building: Building, number: number, id: string, dx: number, dy: number): Building {
  const floor = floorOf(building, number);
  const item = floor?.items.find((one) => one.id === id);
  if (!floor || !item) return building;
  if (item.kind === "lift") {
    return {
      ...building,
      floors: building.floors.map((one) => ({
        ...one,
        items: one.items.map((other) =>
          other.kind === "lift" && other.lift === item.lift
            ? { ...other, ...clampBox({ ...other, x: other.x + dx, y: other.y + dy }, one) }
            : other,
        ),
      })),
    };
  }
  if (item.kind === "door") {
    const room = roomOf(floor, item);
    if (!room) return building;
    const side = sideOf(item, room);
    const along = side === "south" || side === "north" ? item.x + item.w / 2 + dx : item.y + item.h / 2 + dy;
    return patchItem(building, number, id, doorBox(room, side, along, item.width_mm));
  }
  const moved = clampBox({ ...item, x: item.x + dx, y: item.y + dy }, floor);
  const shiftX = moved.x - item.x;
  const shiftY = moved.y - item.y;
  const doors = item.kind === "room" ? new Set(doorsOf(floor, item).map((door) => door.id)) : new Set<string>();
  return withItems(
    building,
    number,
    floor.items.map((other) =>
      other.id === id
        ? { ...other, ...moved }
        : doors.has(other.id)
          ? { ...other, x: round(other.x + shiftX), y: round(other.y + shiftY) }
          : other,
    ),
  );
}

/* Новый размер помещения или преграды. Двери помещения остаются на своих стенах */
export function resizeItem(building: Building, number: number, id: string, w: number, h: number): Building {
  const floor = floorOf(building, number);
  const item = floor?.items.find((one) => one.id === id);
  if (!floor || !item || (item.kind !== "room" && item.kind !== "blocked")) return building;
  const least = item.kind === "room" ? MIN_ROOM_M : 1;
  const box = clampBox({ ...item, w: Math.max(least, snap(w)), h: Math.max(least, snap(h)) }, floor);
  const doors = item.kind === "room" ? doorsOf(floor, item) : [];
  const placed = new Map(
    doors.map((door) => {
      const side = sideOf(door, item);
      const along = side === "south" || side === "north" ? door.x + door.w / 2 : door.y + door.h / 2;
      return [door.id, doorBox(box, side, along, door.width_mm)];
    }),
  );
  return withItems(
    building,
    number,
    floor.items.map((other) => {
      if (other.id === id) return { ...other, ...box };
      const door = placed.get(other.id);
      return door ? { ...other, ...door } : other;
    }),
  );
}

export function patchItem(building: Building, number: number, id: string, patch: Partial<Item>): Building {
  const floor = floorOf(building, number);
  return floor
    ? withItems(
        building,
        number,
        floor.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      )
    : building;
}

/* Ширина двери в мм меняет и прямоугольник: проем на плане той же ширины */
export function setDoorWidth(building: Building, number: number, id: string, widthMm: number): Building {
  const floor = floorOf(building, number);
  const door = floor?.items.find((one) => one.id === id);
  const room = floor && door && roomOf(floor, door);
  if (!door || !room) return patchItem(building, number, id, { width_mm: widthMm });
  const side = sideOf(door, room);
  const along = side === "south" || side === "north" ? door.x + door.w / 2 : door.y + door.h / 2;
  return patchItem(building, number, id, { ...doorBox(room, side, along, widthMm), width_mm: widthMm });
}

/* Удаление: помещение вместе со своими дверями, шахта только на этом этаже (это остановка) */
export function removeItem(building: Building, number: number, id: string): Building {
  const floor = floorOf(building, number);
  const item = floor?.items.find((one) => one.id === id);
  if (!floor || !item) return building;
  if (item.kind === "lift") return toggleStop(building, item.lift, number);
  const gone = new Set([id, ...(item.kind === "room" ? doorsOf(floor, item).map((door) => door.id) : [])]);
  return withFloor(building, number, (one) => ({ ...one, items: one.items.filter((other) => !gone.has(other.id)) }));
}

/* Копия этажа наверх: те же помещения и двери с новыми id, шахты лифтов остаются шахтами тех же
   лифтов, так лифт сразу встает и на новом этаже. Аптека и склад обычно одни на корпус: на копии
   это посты */
export function copyFloor(building: Building, number: number): Building {
  const source = floorOf(building, number);
  if (!source || building.floors.length >= MAX_FLOORS) return building;
  const top = Math.max(...building.floors.map((floor) => floor.number)) + 1;
  const prefix = new RegExp(`^f${number}-`);
  const items = source.items.map((item) => {
    const store = item.kind === "room" && (item.role === "pharmacy" || item.role === "supplies");
    const id =
      item.kind === "lift"
        ? `f${top}-${item.lift}`
        : prefix.test(item.id)
          ? item.id.replace(prefix, `f${top}-`)
          : `f${top}-${item.id}`;
    return { ...item, id, role: store ? ("ward" as Role) : item.role, name: store ? ROLE_NAMES.ward : item.name };
  });
  const scenario = building.scenario
    ? {
        ...building.scenario,
        point_weights: { ...building.scenario.point_weights },
        floor_cleaning_passes: { ...building.scenario.floor_cleaning_passes },
      }
    : null;
  if (scenario) {
    source.items.forEach((item, index) => {
      const weight = scenario.point_weights[item.id];
      if (item.role === "ward" && weight !== undefined) scenario.point_weights[items[index].id] = weight;
    });
    const passes = scenario.floor_cleaning_passes[number];
    if (passes !== undefined) scenario.floor_cleaning_passes[top] = passes;
  }
  return {
    ...building,
    ...(scenario ? { scenario } : {}),
    floors: [...building.floors, { ...source, number: top, name: `${top} этаж`, items }],
  };
}

export function addFloor(building: Building): Building {
  if (building.floors.length >= MAX_FLOORS) return building;
  const last = building.floors.at(-1);
  const top = Math.max(...building.floors.map((floor) => floor.number)) + 1;
  const width = last?.width_m ?? 60;
  const length = last?.length_m ?? 24;
  const floor: Floor = {
    number: top,
    name: `${top} этаж`,
    width_m: width,
    length_m: length,
    sections: [{ id: `f${top}`, x: 0, y: 0, w: width, h: length }],
    items: [],
  };
  return { ...building, floors: [...building.floors, floor] };
}

export function removeFloor(building: Building, number: number): Building {
  if (building.floors.length <= 1) return building;
  const floors = building.floors.filter((floor) => floor.number !== number);
  const stops = new Set(
    floors.flatMap((floor) => floor.items.filter((item) => item.kind === "lift").map((item) => item.lift)),
  );
  return { ...building, floors, lifts: building.lifts.filter((lift) => stops.has(lift.id)) };
}

/* Размер этажа: участок и пол. Вещи за новым краем сдвигаем внутрь */
export function resizeFloor(building: Building, number: number, width: number, length: number): Building {
  return withFloor(building, number, (floor) => {
    const next = {
      ...floor,
      width_m: width,
      length_m: length,
      sections:
        floor.sections.length === 1 &&
        floor.sections[0].x === 0 &&
        floor.sections[0].y === 0 &&
        floor.sections[0].w === floor.width_m &&
        floor.sections[0].h === floor.length_m
          ? [{ ...floor.sections[0], w: width, h: length }]
          : floor.sections.map((section) => ({
              ...section,
              ...clampBox(section, { ...floor, width_m: width, length_m: length }),
            })),
    };
    return { ...next, items: floor.items.map((item) => ({ ...item, ...clampBox(item, next) })) };
  });
}

export function addSection(building: Building, number: number, box: Box): Building {
  return withFloor(building, number, (floor) => {
    let n = 1;
    while (floor.sections.some((one) => one.id === `f${number}-section-${n}`)) n++;
    return {
      ...floor,
      sections: [
        ...floor.sections,
        {
          id: `f${number}-section-${n}`,
          ...clampBox(
            { x: snap(box.x), y: snap(box.y), w: Math.max(2, snap(box.w)), h: Math.max(2, snap(box.h)) },
            floor,
          ),
        },
      ],
    };
  });
}

export function patchSection(building: Building, number: number, id: string, box: Box): Building {
  return withFloor(building, number, (floor) => ({
    ...floor,
    sections: floor.sections.map((one) => (one.id === id ? { ...one, ...clampBox(box, floor) } : one)),
  }));
}

export function removeSection(building: Building, number: number, id: string): Building {
  return withFloor(building, number, (floor) => ({
    ...floor,
    sections: floor.sections.filter((one) => one.id !== id),
  }));
}

export function floorArea(floor: Floor): number {
  // Площадь объединения, пересекающиеся секции не считаются дважды.
  const xs = [...new Set(floor.sections.flatMap((s) => [s.x, s.x + s.w]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const spans = floor.sections
      .filter((s) => s.x < xs[i] && s.x + s.w > xs[i - 1])
      .map((s) => [s.y, s.y + s.h])
      .sort((a, b) => a[0] - b[0]);
    let end = -Infinity,
      height = 0;
    for (const [lo, hi] of spans) {
      height += Math.max(0, hi - Math.max(lo, end));
      end = Math.max(end, hi);
    }
    area += (xs[i] - xs[i - 1]) * height;
  }
  return area;
}

/* Сколько чего в корпусе: строка над листом и числа под ним */
export function counts(building: Building) {
  const items = building.floors.flatMap((floor) => floor.items);
  return {
    floors: building.floors.length,
    lifts: building.lifts.length,
    wards: items.filter((item) => item.kind === "room" && item.role === "ward").length,
    rooms: items.filter((item) => item.kind === "room").length,
    doors: items.filter((item) => item.kind === "door").length,
    manual: items.filter((item) => item.kind === "door" && !item.automatic).length,
  };
}

/* Сохраненный корпус из браузера или проекта: берем, только если похож на корпус */
export function asBuilding(raw: unknown): Building | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Building>;
  if (value.version !== 1 || !Array.isArray(value.floors) || !value.floors.length || !Array.isArray(value.lifts))
    return null;
  if (!value.floors.every((floor) => floor && Array.isArray(floor.items) && typeof floor.number === "number"))
    return null;
  return value as Building;
}
