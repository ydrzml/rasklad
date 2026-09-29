/* Запись чисел в полях: 10 000 с пробелами по разрядам и 1,7 с запятой. Отдельно от компонентов,
   чтобы проверить без браузера (tests/digits.test.ts) */
const DIGITS = /^-?\d+(\.\d+)?$/;

export function groupDigits(value: number | string): string {
  const text = String(value);
  if (!DIGITS.test(text)) return text;
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return fraction ? `${grouped},${fraction}` : grouped;
}

export function plainDigits(text: string): string | null {
  const plain = text.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (plain === "") return "";
  return Number.isNaN(Number(plain)) ? null : plain;
}

/* Единица как ее пишут: в данных площадь записана "м2", на экране "м²" */
export function unitText(unit: string): string {
  return unit.replace(/м2(?!\d)/g, "м²");
}
