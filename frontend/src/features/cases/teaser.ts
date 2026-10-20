/* Первый экран разбора: три пункта справа и фразы ролика слева. Числа из ответа сервера о разборе,
   здесь только слова и простая арифметика для картинки. Из импортов только слова окупаемости,
   проверяется без браузера: npm test */

import { aboutYears, laterNote } from "../../app/paybackWords.ts";

export type PointId = "work" | "money" | "people";

export type Point = {
  id: PointId;
  // вопрос, на который отвечает пункт
  label: string;
  // крупно: главное число пункта
  big: string;
  // одна строка пояснения под ним
  note: string;
  // фраза поверх сцены ролика: то, что сцена показывает
  phrase: string;
  // выгода или расход: крупное число и фраза цветом выгоды или цветом расхода
  tone?: "gain" | "loss";
};

export type CaseNumbers = {
  robotName: string;
  // что роботы делают в фразе ролика: везут, подвозят стеллажи под, убирают
  verb?: string;
  // у уборки пика нет: спрос ровный, в час идет средняя площадь (так считает методика)
  average?: boolean;
  // чем меряется работа: один, два, пять (паллета, паллеты, паллет)
  unit: [string, string, string];
  fleet: number;
  // пик спроса и спрос с запасом, под который считали парк: оба из sizing, как в панели "Парк"
  peak: number;
  design: number;
  horizon: number;
  investment: number;
  rentStart: number | null;
  rentPayback?: number | null;
  /* за горизонт не окупается, а в досчете сервера окупается: год из досчета */
  rentLater?: number | null;
  payback: number | null | undefined;
  later?: number | null;
  effect: number | null | undefined;
  // экономия за горизонт, та же, что на графике за 5 лет: из нее доля вернувшихся вложений
  effectTotal?: number | null;
  peopleBefore: number;
  peopleAfter: number;
  // затраты к концу горизонта: последние точки cumulative_cost_rub, те же, что на графике ниже
  baselineTotal: number;
  purchaseTotal: number;
};

export type Format = {
  mln: (rub: number) => string;
  term: (years: number | null | undefined) => string;
  plural: (count: number, one: string, few: string, many: string) => string;
};

export function casePoints(input: CaseNumbers, format: Format): Point[] {
  const { mln, term, plural } = format;
  const peak = Math.round(input.peak);
  const design = Math.round(input.design);
  const reserve = input.peak > 0 ? Math.round((input.design / input.peak - 1) * 100) : 0;
  const [a, b, c] = input.unit;
  const per = (n: number) => `${n} ${plural(n, a, b, c)} в час`;
  const robots = `${input.fleet} ${plural(input.fleet, "робот", "робота", "роботов")}`;
  const rates = (n: number) => `${n} ${plural(n, "ставка", "ставки", "ставок")}`;
  const start = `${mln(input.investment)} млн ₽`;
  const back =
    input.payback != null
      ? `вернутся за ${term(input.payback)}`
      : input.later != null
        ? `вернутся примерно за ${aboutYears(input.later, input.horizon)}, ${laterNote(input.horizon)}`
        : "не окупаются";
  const saving = input.effect ?? 0;
  const gap = input.baselineTotal - input.purchaseTotal;
  return [
    {
      id: "work",
      label: "Сколько роботов",
      big: `${robots} ${input.robotName}`,
      note:
        reserve > 0
          ? `Рассчитаны на ${per(design)}, это ${input.average ? "в среднем" : "пик"} ${peak} и запас ${reserve}%. Прогон смены на плане это подтвердил`
          : `Рассчитаны на ${input.average ? "в среднем" : "пик"} ${per(peak)}. Прогон смены на плане это подтвердил`,
      phrase: `${robots} ${input.verb ?? "везут"} ${peak} ${plural(peak, a, b, c)} в час`,
    },
    {
      id: "money",
      label: "Сколько вложить и когда вернется",
      big: `${start} ${back}`,
      note:
        "Покупка за свои деньги" +
        (input.rentStart != null ? `. В аренду на старте ${mln(input.rentStart)} млн ₽${rentBack(input)}` : ""),
      phrase: `${start} на старте ${back}`,
    },
    {
      id: "people",
      label: "Сколько сэкономите",
      // одно однозначное число: экономия за горизонт или на сколько дороже, без "вместо ставок"
      big:
        Math.abs(gap) < 50_000
          ? `За ${input.horizon} лет выходит одинаково`
          : gap > 0
            ? `Экономия ${mln(gap)} млн ₽ за ${input.horizon} лет`
            : `Дороже на ${mln(-gap)} млн ₽ за ${input.horizon} лет`,
      note:
        (saving > 0 ? `В первый год экономия ${mln(saving)} млн ₽. ` : "В первый год экономии нет. ") +
        `Было: ${rates(input.peopleBefore)}, останется: ` +
        (input.peopleAfter ? rates(input.peopleAfter) : "0"),
      phrase:
        gap > 0
          ? `Экономия за ${input.horizon} лет: ${mln(gap)} млн ₽`
          : `С роботами дороже на ${mln(-gap)} млн ₽ за ${input.horizon} лет`,
      tone: gap > 0 ? "gain" : "loss",
    },
  ];
}

// окупаемость аренды рядом с ее стартом: на странице разбора больше ее нигде нет
function rentBack(input: CaseNumbers): string {
  if (input.rentPayback === undefined) return "";
  if (input.rentPayback != null) return `, окупится за ${termShort(input.rentPayback)}`;
  return input.rentLater != null
    ? `, окупится примерно за ${aboutYears(input.rentLater, input.horizon)}, ${laterNote(input.horizon)}`
    : ", не окупается";
}

// срок без импорта format.ts: 1,2 года, 3 года, 5 лет
function termShort(years: number): string {
  const rounded = Math.round(years * 10) / 10;
  const shown = rounded.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  if (!Number.isInteger(rounded)) return `${shown} года`;
  return `${shown} ${rounded === 1 ? "год" : rounded >= 2 && rounded <= 4 ? "года" : "лет"}`;
}

/* Деньги возвращаются по месяцам: вложение наполняется месячной экономией. Если за горизонт
   не наполняется, показываем, какая доля вернулась: экономия за весь горизонт к вложениям, как на графике.
   Экономии нет: loss, на сколько в год расходы с роботами выше */
export type Refill = { months: number | null; perMonth: number; share: number; loss?: number };

export function refillOf(
  investment: number,
  effectYear1: number | null | undefined,
  payback: number | null | undefined,
  horizon: number,
  effectTotal?: number | null,
): Refill {
  const perMonth = Math.max(0, (effectYear1 ?? 0) / 12);
  if (payback != null && payback >= 0) return { months: Math.max(1, Math.round(payback * 12)), perMonth, share: 1 };
  const total = effectTotal ?? perMonth * 12 * horizon;
  const share = investment > 0 ? Math.min(1, Math.max(0, total / investment)) : 0;
  const refill = { months: null, perMonth, share };
  return (effectYear1 ?? 0) < 0 ? { ...refill, loss: -(effectYear1 ?? 0) } : refill;
}

/* Разница за горизонт между "без роботов" и покупкой словами */
export function totalsText(
  baselineRub: number,
  purchaseRub: number,
  horizon: number,
  mln: (rub: number) => string,
): string {
  const gap = baselineRub - purchaseRub;
  if (Math.abs(gap) < 50_000) return `За ${horizon} лет выходит одинаково`;
  return gap > 0
    ? `За ${horizon} лет на ${mln(gap)} млн ₽ меньше, чем без роботов`
    : `За ${horizon} лет на ${mln(-gap)} млн ₽ дороже, чем без роботов`;
}
