/* Проверки поиска контура здания на картинке плана. Картинки рисуем здесь же точками: чистый
   чертеж, чертеж в рамке листа с размерными линиями, таблица помещений сбоку, стена с
   разрывами под ворота, здание поперек картинки, картинка без здания, чертеж в негативе и
   пестрая текстура вроде леса на снимке из карт. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { boxOf, homography, inkOf, photoLine } from "../src/app/plan/outline.ts";

const W = 600;
const H = 400;

/* Лист бумаги: белый фон, на нем рисуем темным */
function sheet(w = W, h = H, paper = 245) {
  const data = new Uint8ClampedArray(w * h * 4).fill(paper);
  const paint = (x: number, y: number, tone = 20) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const at = (Math.round(y) * w + Math.round(x)) * 4;
    data[at] = data[at + 1] = data[at + 2] = tone;
  };
  const fill = (x: number, y: number, rw: number, rh: number, tone = 20) => {
    for (let row = y; row < y + rh; row++) for (let col = x; col < x + rw; col++) paint(col, row, tone);
  };
  const frame = (x: number, y: number, rw: number, rh: number, t = 3) => {
    fill(x, y, rw, t);
    fill(x, y + rh - t, rw, t);
    fill(x, y, t, rh);
    fill(x + rw - t, y, t, rh);
  };
  return { data, w, h, paint, fill, frame };
}

/* Склад 360 на 216 точек, то есть 5 на 3, с рядами стеллажей внутри */
const B = { x: 120, y: 90, w: 360, h: 216 };
function warehouse(s: ReturnType<typeof sheet>) {
  s.frame(B.x, B.y, B.w, B.h);
  for (let i = 0; i < 8; i++) s.fill(B.x + 40 + i * 40, B.y + 30, 12, 150, 150);
}

function found(s: ReturnType<typeof sheet>, aspect = 5 / 3) {
  return boxOf(inkOf(s.data, s.w, s.h), aspect);
}

/* Совпал ли найденный прямоугольник со складом с точностью до пары точек */
function near(box: ReturnType<typeof found>, want = B, tolerance = 3) {
  assert.ok(box, "контур не нашли");
  const got = { x: box.x1, y: box.y1, w: box.x2 - box.x1, h: box.y2 - box.y1 };
  for (const key of ["x", "y", "w", "h"] as const)
    assert.ok(Math.abs(got[key] - want[key]) <= tolerance, `${key}: ${got[key]} вместо ${want[key]}`);
}

test("чистый чертеж: контур это стены склада", () => {
  const s = sheet();
  warehouse(s);
  near(found(s));
});

test("рамка листа, штамп и размерные линии не сбивают контур", () => {
  const s = sheet();
  warehouse(s);
  s.frame(10, 10, W - 20, H - 20, 2);
  s.frame(W - 170, H - 70, 160, 60, 2);
  s.fill(B.x, B.y - 30, B.w, 1);
  s.fill(B.x - 30, B.y, 1, B.h);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) s.fill(B.x + Math.round(B.w * t), B.y - 36, 1, 34);
  near(found(s));
});

test("таблица помещений сбоку не растягивает контур", () => {
  const s = sheet();
  warehouse(s);
  for (let i = 0; i < 12; i++) s.fill(B.x + B.w + 8, B.y + i * 18, 100, 6);
  near(found(s));
});

test("стена с разрывами под ворота все равно стена", () => {
  const s = sheet();
  warehouse(s);
  for (let i = 0; i < 8; i++) s.fill(B.x + 20 + i * 42, B.y + B.h - 3, 24, 3, 245);
  near(found(s));
});

test("здание поперек картинки находится, его потом повернем", () => {
  const s = sheet(400, 600);
  s.frame(92, 120, 216, 360);
  near(found(s), { x: 92, y: 120, w: 216, h: 360 });
});

test("неровно освещенный лист: тень в углу темнее линий в центре", () => {
  const s = sheet();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const at = (y * W + x) * 4;
      const tone = 235 - Math.round((x + y) * 0.16);
      s.data[at] = s.data[at + 1] = s.data[at + 2] = tone;
    }
  warehouse(s);
  near(found(s));
});

test("на картинке без здания контура нет", () => {
  const s = sheet();
  for (let i = 0; i < 30; i++) s.fill(30 + ((i * 97) % 500), 20 + ((i * 61) % 340), 40, 6);
  const box = found(s);
  assert.ok(!box || box.cover < 0.75, "нашли контур там, где его нет");
});

test("названные размеры не похожи на картинку: расхождение видно", () => {
  const s = sheet();
  s.frame(B.x, B.y, B.w, B.h);
  // склад на картинке 5 на 3, а назвали 4,5 на 3: разница 10 процентов, контур найден, но с пометкой
  const box = found(s, 4.5 / 3);
  assert.ok(box);
  assert.ok(Math.exp(box.miss) - 1 > 0.05);
});

test("выпрямление переводит углы выпрямленной картинки в углы на исходной", () => {
  const from = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ];
  const to = [
    { x: 21, y: 14 },
    { x: 70, y: 11 },
    { x: 78, y: 47 },
    { x: 12, y: 50 },
  ];
  const m = homography(from, to);
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const z = m[6] * x + m[7] * y + m[8];
    assert.ok(Math.abs((m[0] * x + m[1] * y + m[2]) / z - to[i].x) < 1e-6);
    assert.ok(Math.abs((m[3] * x + m[4] * y + m[5]) / z - to[i].y) < 1e-6);
  }
});

test("край липнет к границе залитого ряда, а не в его середину", () => {
  const s = sheet(300, 200);
  s.fill(100, 40, 30, 120, 150);
  const ink = inkOf(s.data, s.w, s.h);
  // картинка 300 на 200 точек лежит на листе 150 на 100 метров: две точки на метр
  const u = { x: 0, y: 0, w: 150, h: 100 };
  const left = photoLine(ink, u, "x", 52, 30, 70, 3);
  assert.equal(left?.at, 50);
  // из середины ряда до его краев дальше, чем можно дотянуться: прилипать не к чему
  assert.equal(photoLine(ink, u, "x", 57.5, 30, 70, 2), null);
});

test("чертеж в негативе, светлые линии на темном: контур находится", () => {
  const s = sheet(W, H, 25);
  for (let row = B.y; row < B.y + 3; row++) for (let col = B.x; col < B.x + B.w; col++) s.paint(col, row, 235);
  for (let row = B.y + B.h - 3; row < B.y + B.h; row++)
    for (let col = B.x; col < B.x + B.w; col++) s.paint(col, row, 235);
  for (let row = B.y; row < B.y + B.h; row++)
    for (const col of [B.x, B.x + 1, B.x + 2, B.x + B.w - 3, B.x + B.w - 2, B.x + B.w - 1]) s.paint(col, row, 235);
  near(found(s));
});

test("пестрая текстура вроде леса на снимке из карт не выдается за стены", () => {
  const s = sheet();
  // пятна темного вперемешку со светлым по всей левой части картинки
  for (let y = 0; y < H; y++) for (let x = 0; x < 260; x++) if ((x * 7 + y * 13) % 11 < 5) s.paint(x, y, 40);
  // светлая дорога поперек и крыша здания без темного контура
  s.fill(0, 300, W, 30, 200);
  const box = found(s);
  assert.ok(!box || box.cover < 0.75, "нашли контур в текстуре");
});

test("два похожих контура: программа говорит, что не уверена", () => {
  const s = sheet(W, 500);
  // план и под ним таблица той же ширины, как на плане эвакуации
  s.frame(120, 40, 360, 200);
  s.frame(120, 260, 360, 200);
  const box = boxOf(inkOf(s.data, s.w, s.h), 360 / 200);
  assert.ok(box?.rival);
  // на обычном плане сомнений нет
  const plain = sheet();
  warehouse(plain);
  assert.ok(!found(plain)?.rival);
});

test("контур буквой Г по шести точкам: стены встают ровно, фото сбоку выпрямляется", async () => {
  const { apply, fitOutline, homography: exact } = await import("../src/app/plan/outline.ts");
  // здание 60 на 40 м, угол 20 на 15 вырезан справа сверху; фото снято сбоку
  const plan = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 15 },
    { x: 60, y: 15 },
    { x: 60, y: 40 },
    { x: 0, y: 40 },
  ];
  const side = exact(
    [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
      { x: 0, y: 40 },
    ],
    [
      { x: 110, y: 60 },
      { x: 480, y: 90 },
      { x: 500, y: 340 },
      { x: 90, y: 360 },
    ],
  );
  // человек ставит точки не идеально: на пару точек мимо
  const clicked = plan.map((one, index) => {
    const at = apply(side, one);
    return { x: at.x + (index % 2 ? 2 : -1.5), y: at.y + (index % 3 ? -1 : 2) };
  });
  const { outline, toSource } = fitOutline(clicked, 60, 40, 0);
  for (let i = 0; i < plan.length; i++) {
    assert.ok(Math.abs(outline[i].x - plan[i].x) < 1.2, `x точки ${i}: ${outline[i].x}`);
    assert.ok(Math.abs(outline[i].y - plan[i].y) < 1.2, `y точки ${i}: ${outline[i].y}`);
  }
  // стены ровно вдоль и поперек листа
  for (let i = 0; i < outline.length; i++) {
    const [a, b] = [outline[i], outline[(i + 1) % outline.length]];
    assert.ok(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6);
  }
  // преобразование ведет метры контура в точки на исходной картинке
  const back = apply(toSource, outline[3]);
  assert.ok(Math.hypot(back.x - clicked[3].x, back.y - clicked[3].y) < 5);
});

test("поворот: здание на картинке стоит боком, верх листа это ее левый край", async () => {
  const { fitOutline, turnOf } = await import("../src/app/plan/outline.ts");
  // углы по порядку: первый снизу слева, второй над ним, картинку надо повернуть на четверть
  const corners = [
    { x: 10, y: 90 },
    { x: 10, y: 10 },
    { x: 60, y: 10 },
    { x: 60, y: 90 },
  ];
  assert.equal(turnOf(corners), 1);
  const { outline } = fitOutline(corners, 80, 50, 1);
  const xs = outline.map((one) => one.x);
  const ys = outline.map((one) => one.y);
  assert.ok(Math.abs(Math.max(...xs) - 80) < 1e-6 && Math.abs(Math.max(...ys) - 50) < 1e-6);
});
