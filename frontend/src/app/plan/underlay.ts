/* Подложка: картинка с планом склада под листом. Человек загружает скриншот из карт, фото
   или страницу PDF, сохраненную картинкой, программа находит на ней контур здания по темным
   линиям стен и выпрямляет картинку так, чтобы контур совпал со зданием, размеры которого
   человек назвал. Дальше по ней обводят зоны и ворота. Картинка живет в браузере и на сервер
   не уходит: считать по ней нечего, а план, который по ней обвели, это обычный план. */
import { useCallback, useState } from "react";

import { UNDERLAY_KEY } from "../saving";
import type { Point, Rect } from "./geometry";
import { boxOf, fitHomography, fitOutline, type Ink, inkOf, turnOf, upright } from "./outline";

export type Underlay = {
  src: string; // data-url выпрямленной картинки, она и лежит под листом
  x: number; // левый нижний угол в метрах листа
  y: number;
  w: number; // размер в метрах листа
  h: number;
  opacity: number;
  source?: string; // исходная картинка: по ней углы можно поставить заново
  corners?: Point[]; // углы здания на исходной картинке долями ее размера, по порядку обхода
  turn?: number; // на сколько четвертей по часовой повернуть картинку, чтобы здание легло вдоль листа
  found?: boolean; // углы нашла программа, а не взяты края картинки
};

const KEY = UNDERLAY_KEY;
const SAMPLE_PX = 700; // картинку для поиска контура ужимаем: точность в метр и так с запасом
const KEEP_PX = 2000; // исходную картинку храним не крупнее: память браузера на сайт невелика
const SHEET_PX = 1800; // длинная сторона здания на выпрямленной картинке
const MARGIN = 0.15; // сколько картинки оставить вокруг здания, доля от его стороны
const LINES_PER_M = 6; // точек на метр, когда ищем линии для прилипания

function read(): Underlay | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Underlay) : null;
  } catch {
    return null;
  }
}

function keep(value: Underlay | null) {
  try {
    if (value) window.localStorage.setItem(KEY, JSON.stringify(value));
    else window.localStorage.removeItem(KEY);
  } catch {
    // картинка не влезла в память браузера: подложка останется до перезагрузки страницы
  }
}

export function useUnderlay() {
  const [value, setValue] = useState<Underlay | null>(read);
  const set = useCallback((patch: Partial<Underlay>) => {
    setValue((now) => {
      if (!now) return now;
      const next = { ...now, ...patch };
      keep(next);
      return next;
    });
  }, []);
  const put = useCallback((next: Underlay | null) => {
    setValue(next);
    keep(next);
  }, []);
  return { value, set, put };
}

export function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("не картинка"));
    image.src = src;
  });
}

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("нет холста");
  return [canvas, context];
}

/* Углы здания на картинке долями ее размера. Сначала ищем на картинке как есть; если стороны
   прорисованы не целиком, перебираем небольшие наклоны: лист на столе редко лежит ровно. */
export async function findCorners(
  image: HTMLImageElement,
  aspect: number,
): Promise<{ corners: Point[]; found: boolean; off: number; unsure: boolean }> {
  const scale = Math.min(1, SAMPLE_PX / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.round(image.naturalWidth * scale);
  const h = Math.round(image.naturalHeight * scale);
  const [, context] = canvasOf(w, h);
  const tryAngle = (degrees: number) => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, w, h);
    context.translate(w / 2, h / 2);
    context.rotate((degrees * Math.PI) / 180);
    context.translate(-w / 2, -h / 2);
    context.drawImage(image, 0, 0, w, h);
    return { degrees, box: boxOf(inkOf(context.getImageData(0, 0, w, h).data, w, h), aspect) };
  };
  let best = tryAngle(0);
  const good = (found: typeof best) => (found.box ? found.box.cover : 0);
  if (good(best) < 0.95) {
    for (let degrees = -6; degrees <= 6; degrees++) {
      if (!degrees) continue;
      const next = tryAngle(degrees);
      if (good(next) > good(best) + 0.01) best = next;
    }
    for (const step of [-0.5, 0.5]) {
      const next = tryAngle(best.degrees + step);
      if (good(next) > good(best) + 0.01) best = next;
    }
  }
  const box = best.box;
  // три стороны из четырех прорисованы: у склада в стене много ворот, и линия идет с разрывами
  if (!box || box.cover < 0.75)
    return {
      corners: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      found: false,
      off: 0,
      unsure: false,
    };
  // углы прямоугольника на повернутой картинке возвращаем на исходную
  const turn = (-best.degrees * Math.PI) / 180;
  const back = (x: number, y: number): Point => {
    const [dx, dy] = [x - w / 2, y - h / 2];
    return {
      x: (w / 2 + dx * Math.cos(turn) - dy * Math.sin(turn)) / w,
      y: (h / 2 + dx * Math.sin(turn) + dy * Math.cos(turn)) / h,
    };
  };
  const corners = [back(box.x1, box.y1), back(box.x2, box.y1), back(box.x2, box.y2), back(box.x1, box.y2)];
  // насколько пропорции контура расходятся с названными размерами, в долях
  return {
    corners: upright(corners, w, h, aspect),
    found: true,
    off: Math.exp(box.miss) - 1,
    unsure: Boolean(box.rival),
  };
}

// --- выпрямление ----------------------------------------------------------------------------

/* Выпрямленная картинка: здание hall в названных размерах, вокруг поля. Углов сколько угодно, от
   четырех: склад буквой Г обводят шестью точками. Контур выпрямляется, стены встают вдоль и поперек
   листа, и по нему же выпрямляется картинка. Каждую точку новой картинки берем с исходной по
   преобразованию, смешивая четыре соседние точки. Контур в метрах листа возвращаем вместе с
   картинкой: он становится полом здания. */
export async function straighten(
  source: string,
  corners: Point[],
  hall: Rect,
  opacity: number,
  turn = turnOf(corners),
): Promise<Underlay & { outline: [number, number][] }> {
  const image = await loadImage(source);
  const [, from] = canvasOf(image.naturalWidth, image.naturalHeight);
  from.drawImage(image, 0, 0);
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;
  const pixels = from.getImageData(0, 0, iw, ih).data;

  const k = SHEET_PX / Math.max(hall.w, hall.h); // точек на метр
  const [mx, my] = [hall.w * MARGIN, hall.h * MARGIN];
  const tw = Math.round((hall.w + 2 * mx) * k);
  const th = Math.round((hall.h + 2 * my) * k);
  const [canvas, context] = canvasOf(tw, th);
  const out = context.createImageData(tw, th);
  const at = corners.map((one) => ({ x: one.x * iw, y: one.y * ih }));
  const { outline } = fitOutline(at, hall.w, hall.h, turn);
  const m = fitHomography(
    outline.map((one) => ({ x: (mx + one.x) * k, y: (my + one.y) * k })),
    at,
  );
  for (let v = 0; v < th; v++)
    for (let u = 0; u < tw; u++) {
      const z = m[6] * u + m[7] * v + m[8];
      const sx = (m[0] * u + m[1] * v + m[2]) / z;
      const sy = (m[3] * u + m[4] * v + m[5]) / z;
      const at = (v * tw + u) * 4;
      if (sx < 0 || sy < 0 || sx > iw - 1 || sy > ih - 1) {
        out.data.set([255, 255, 255, 255], at);
        continue;
      }
      const [x0, y0] = [Math.floor(sx), Math.floor(sy)];
      const [fx, fy] = [sx - x0, sy - y0];
      const x1 = Math.min(iw - 1, x0 + 1);
      const y1 = Math.min(ih - 1, y0 + 1);
      for (let c = 0; c < 3; c++) {
        const top = pixels[(y0 * iw + x0) * 4 + c] * (1 - fx) + pixels[(y0 * iw + x1) * 4 + c] * fx;
        const bottom = pixels[(y1 * iw + x0) * 4 + c] * (1 - fx) + pixels[(y1 * iw + x1) * 4 + c] * fx;
        out.data[at + c] = top * (1 - fy) + bottom * fy;
      }
      out.data[at + 3] = 255;
    }
  context.putImageData(out, 0, 0);
  return {
    src: canvas.toDataURL("image/jpeg", 0.85),
    x: hall.x - mx,
    y: hall.y - my,
    w: hall.w + 2 * mx,
    h: hall.h + 2 * my,
    opacity,
    source,
    corners,
    turn,
    // метры листа: y растет на север, контур по сетке в метр, как все на плане
    outline: outline.map((one) => [Math.round(hall.x + one.x), Math.round(hall.y + hall.h - one.y)]),
  };
}

/* Исходную картинку ужимаем до того, что стоит хранить: фото с телефона бывает в 12 мегапикселей */
async function shrink(src: string): Promise<string> {
  const image = await loadImage(src);
  const scale = Math.min(1, KEEP_PX / Math.max(image.naturalWidth, image.naturalHeight));
  if (scale === 1 && src.length < 1_500_000) return src;
  const [canvas, context] = canvasOf(image.naturalWidth * scale, image.naturalHeight * scale);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

/* Находим контур здания и выпрямляем картинку под здание hall. Если контура не нашли,
   растягиваем на здание картинку целиком и говорим об этом. */
export async function fitToBuilding(
  src: string,
  hall: Rect,
): Promise<{ underlay: Underlay; found: boolean; off: number; unsure: boolean }> {
  const source = await shrink(src);
  const { corners, found, off, unsure } = await findCorners(await loadImage(source), hall.w / hall.h);
  // контур здесь не нужен: здание уже того размера, что назвали, а углы нашла программа
  const underlay = await straighten(source, corners, hall, 0.55);
  return { underlay: { ...underlay, found }, found, off, unsure };
}

/* Что сказать человеку после подгонки. Контур с другими пропорциями мы все равно кладем:
   чаще всего размеры названы на глаз, но бывает, что нашлась не стена, а размерная линия. */
export function fitNote(fit: { found: boolean; off: number; unsure?: boolean }): string {
  if (fit.found && fit.unsure)
    return "На картинке два похожих контура, например план и таблица под ним. Проверьте, те ли углы выбрали, и нажмите «Готово»";
  if (!fit.found)
    return "Контур здания на картинке не нашли, поэтому растянули на здание всю картинку. Обведите здание по углам: «Обвести контур»";
  if (fit.off > 0.05)
    return `Нашли контур здания, но его пропорции расходятся с названными размерами на ${Math.round(fit.off * 100)}%. Проверьте размеры или обведите контур заново`;
  return "Нашли на картинке контур здания и совместили его со стенами. Если лег криво или склад не прямоугольный, обведите контур";
}

// --- прилипание к линиям на картинке ------------------------------------------------------

/* Темные точки выпрямленной картинки: по ним край зоны липнет к линии на плане. Считаем
   один раз на картинку, при загрузке листа. */
export async function inkOfUnderlay(u: Underlay): Promise<Ink> {
  const image = await loadImage(u.src);
  const scale = Math.min(1, (LINES_PER_M * Math.max(u.w, u.h)) / Math.max(image.naturalWidth, image.naturalHeight));
  const [canvas, context] = canvasOf(image.naturalWidth * scale, image.naturalHeight * scale);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return inkOf(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
}
