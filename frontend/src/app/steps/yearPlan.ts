/* План на 5 лет под итогом шага 5: сколько уходит в каждый год при покупке, аренде, году аренды с
   выкупом и без роботов, накопленно с начала, один вывод по этим цифрам и точки для графика.
   Накопленные суммы считает сервер (cumulative_cost_rub), здесь разности соседних лет, сравнения
   и слова. Модуль без браузера: npm test */

import type { CalculationResult } from "../../api/client";

const mln = (value: number) =>
  (value / 1_000_000).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export type PlanWay = "buy" | "rent" | "trial" | "none";

export type PlanInput = {
  horizon: number;
  /* накопленные затраты на конец каждого года, первая точка это старт (год 0) */
  none: number[];
  buy: number[];
  rent?: number[] | null;
  /* год аренды как проверка, потом выкуп: допущение сервера, есть не у всех решений */
  trial?: number[] | null;
  /* окупаемость покупки с сервера, в годах; пусто, если за горизонт не окупается */
  buyPayback: number | null;
  /* выкуп в конце договора аренды: год, цена, на сколько дешевле аренды без выкупа за горизонт */
  buyout?: { year: number; price: number; tco: number; cheaper: number; payback: number | null } | null;
};

export type PlanCell = { year: number; total: number };
export type PlanRow = {
  year: number;
  cells: Partial<Record<PlanWay, PlanCell>>;
  /* в этот год покупка окупилась: накопленно дешевле работы без роботов */
  paidBack: boolean;
  /* с этого года покупка накопленно дешевле аренды */
  buyBeatsRent: boolean;
};

// разница меньше этой доли: "почти одинаково", а не "выгоднее". Точнее расчет-оценка не скажет
export const NEAR = 0.03;

/* Якорь блока "План на 5 лет" внизу шага 5: на него ведет ссылка под карточками итога */
export const YEAR_PLAN_ID = "year-plan";

/* Есть ли из чего строить план: накопленные затраты без роботов и покупки по годам */
export function hasYearPlan(result: CalculationResult): boolean {
  const scenarios = result.scenarios ?? [];
  const points = (id: string) => scenarios.find((one) => one.id === id)?.cumulative_cost_rub?.length ?? 0;
  return points("baseline") > 0 && points("purchase") > 0;
}

/* Где линия a опускается до линии b: год с долей, между соседними годами линии прямые. Пусто, если
   a с первого года не дороже b или так и не стала дешевле */
export function crossing(a: number[], b: number[]): number | null {
  for (let t = 1; t < Math.min(a.length, b.length); t += 1) {
    const before = a[t - 1] - b[t - 1];
    const after = a[t] - b[t];
    if (before > 0 && after <= 0) return t - 1 + before / (before - after);
  }
  return null;
}

/* Точки на графике накопленных затрат: где покупка догнала работу без роботов и где опустилась
   ниже аренды. Те же на шаге 5 (PlanByYears) и в разборах (CaseView) */
export type BuyMark = { key: "paid" | "beats"; at: number; label: string; below: boolean };

export function buyMarks(buy: number[], none: number[], rent: number[] | null): BuyMark[] {
  const paid = crossing(buy, none);
  const beats = rent ? crossing(buy, rent) : null;
  return [
    ...(paid != null ? [{ key: "paid" as const, at: paid, label: "покупка окупилась", below: false }] : []),
    ...(beats != null ? [{ key: "beats" as const, at: beats, label: "покупка дешевле аренды", below: true }] : []),
  ];
}

/* Первый год (целый), с которого покупка накопленно дешевле аренды. 0: дешевле с самого начала */
function buyBeatsYear(buy: number[], rent: number[]): number | null {
  if (buy.length && rent.length && buy[0] <= rent[0]) return 0;
  const at = crossing(buy, rent);
  return at == null ? null : Math.ceil(at - 1e-9);
}

/* Строки таблицы: год 0 это старт, дальше годы горизонта. За год это разность накопленных */
export function planRows(input: PlanInput): PlanRow[] {
  const series: [PlanWay, number[] | null | undefined][] = [
    ["buy", input.buy],
    ["rent", input.rent],
    ["trial", input.trial],
    ["none", input.none],
  ];
  const paidYear = input.buyPayback == null ? null : Math.max(1, Math.ceil(input.buyPayback - 1e-9));
  const beats = input.rent ? buyBeatsYear(input.buy, input.rent) : null;
  return Array.from({ length: input.horizon + 1 }, (_, t) => ({
    year: t,
    cells: Object.fromEntries(
      series.flatMap(([way, points]) =>
        points && points.length > t
          ? [[way, { year: t ? points[t] - points[t - 1] : points[0], total: points[t] }]]
          : [],
      ),
    ),
    paidBack: paidYear === t,
    buyBeatsRent: beats != null && beats > 0 && beats === t,
  }));
}

const yearsWord = (n: number) => {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  return !teen && last === 1 ? "год" : !teen && last >= 2 && last <= 4 ? "года" : "лет";
};

const end = (points: number[] | null | undefined) => (points && points.length ? points[points.length - 1] : null);

/* Один вывод по цифрам, без споров между отметками: как покупка и аренда идут во времени и итог за
   горизонт. Если без роботов дешевле всего, так и говорим. Год аренды с выкупом добавляем, только
   если он дешевле обоих или почти как покупка */
export function verdict(input: PlanInput): string {
  const h = input.horizon;
  const buy = end(input.buy) ?? 0;
  const none = end(input.none) ?? 0;
  const rent = end(input.rent);
  const trial = end(input.trial);
  const cheapest = Math.min(buy, rent ?? Infinity, trial ?? Infinity);
  if (cheapest >= none)
    return `Без роботов дешевле: за ${h} лет ${mln(none)} млн ₽ против ${mln(buy)} млн ₽ при покупке${rent != null ? ` и ${mln(rent)} млн ₽ в аренде` : ""}.`;
  const parts: string[] = [];
  if (rent == null || !input.rent)
    parts.push(`Итог за ${h} лет: покупка ${mln(buy)} млн ₽ против ${mln(none)} млн ₽ без роботов.`);
  else {
    const beats = buyBeatsYear(input.buy, input.rent);
    // в итоге первым тот, кто дешевле
    const total =
      buy <= rent
        ? `Итог за ${h} лет: покупка ${mln(buy)} против ${mln(rent)} млн ₽ в аренде.`
        : `Итог за ${h} лет: аренда ${mln(rent)} против ${mln(buy)} млн ₽ при покупке.`;
    if (beats === 0) parts.push(`Покупка дешевле аренды с самого начала. ${total}`);
    else if (beats == null || beats > h) parts.push(`Все ${h} лет аренда обходится дешевле покупки. ${total}`);
    else if (beats === 1) parts.push(`Аренда дешевле только на старте, с 1-го года покупка выгоднее. ${total}`);
    else {
      const early = beats - 1;
      parts.push(
        `Первые ${early} ${yearsWord(early)} аренда обходится дешевле, с ${beats}-го года покупка выгоднее. ${total}`,
      );
    }
  }
  if (trial != null) {
    if (trial < Math.min(buy, rent ?? Infinity) && Math.abs(trial - buy) > buy * NEAR)
      parts.push(`Дешевле всего год аренды, потом выкуп: ${mln(trial)} млн ₽ (это допущение).`);
    else if (Math.abs(trial - buy) <= buy * NEAR)
      parts.push(`Год аренды, потом выкуп выходит почти как покупка, ${mln(trial)} млн ₽, и дает проверить роботов.`);
  }
  return parts.join(" ");
}

/* Выкуп в конце договора одной фразой: выгоден ли и на сколько */
export function buyoutLine(buyout: PlanInput["buyout"], horizon: number): string | null {
  if (!buyout) return null;
  return buyout.cheaper > 0
    ? `Если арендовать, выкупить роботов в конце договора (${buyout.year}-й год, ${mln(buyout.price)} млн ₽) выгодно: за ${horizon} лет выйдет на ${mln(buyout.cheaper)} млн ₽ дешевле, чем платить аренду до конца.`
    : `Если арендовать, выкупать роботов в конце договора (${buyout.year}-й год, ${mln(buyout.price)} млн ₽) невыгодно: за ${horizon} лет выйдет на ${mln(-buyout.cheaper)} млн ₽ дороже аренды.`;
}
