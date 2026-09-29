/* Кадр смены в PNG: лист плана и роботы в текущую минуту, как на экране (ТЗ, п. 3.6: экспорт
   визуализации). Лист нарисован SVG со стилями из CSS, роботы холстом поверх. Стили листа
   переносим в сам SVG, иначе в картинке он станет черным: у картинки нет наших таблиц стилей */

const STYLE = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "visibility",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
  "vector-effect",
];

export async function frameOf(stage: HTMLElement, caption: string): Promise<Blob> {
  const svg = stage.querySelector<SVGSVGElement>(".u-board > svg");
  if (!svg) throw new Error("лист не найден");
  const box = svg.getBoundingClientRect();
  const ratio = 2;
  const foot = 36;

  const copy = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  from.forEach((node, index) => {
    const style = getComputedStyle(node);
    const target = to[index] as SVGElement;
    // свой стиль у элемента оставляем: сдвиг вещей на листе задан в нем
    const own = target.getAttribute("style") ?? "";
    const copied = STYLE.map((name) => `${name}:${style.getPropertyValue(name)}`).join(";");
    target.setAttribute("style", own ? `${copied};${own}` : copied);
  });
  copy.setAttribute("width", String(box.width));
  copy.setAttribute("height", String(box.height));
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml;charset=utf-8" }),
  );

  try {
    const sheet = await loaded(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round((box.height + foot) * ratio);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("холст недоступен");
    context.scale(ratio, ratio);
    // лист светлый и в темной теме (tokens.css), поэтому цвета берем с него, а не с корня страницы
    const style = getComputedStyle(svg);
    context.fillStyle = style.getPropertyValue("--paper").trim() || "#ffffff";
    context.fillRect(0, 0, box.width, box.height + foot);
    context.drawImage(sheet, 0, 0, box.width, box.height);
    // роботы и тепловая карта: холсты поверх листа, на своих местах
    for (const layer of stage.querySelectorAll("canvas")) {
      const place = layer.getBoundingClientRect();
      if (place.width === 0 || place.height === 0) continue;
      context.drawImage(layer, place.left - box.left, place.top - box.top, place.width, place.height);
    }
    context.fillStyle = style.getPropertyValue("--ink").trim() || "#0d141b";
    context.font = `13px ${style.getPropertyValue("--font").trim() || "sans-serif"}`;
    context.textBaseline = "middle";
    context.fillText(caption, 12, box.height + foot / 2);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("кадр не собрался"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loaded(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("лист не нарисовался"));
    image.src = url;
  });
}

/* Отдать файл браузеру: скачивание по ссылке */
export function save(blob: Blob, name: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
