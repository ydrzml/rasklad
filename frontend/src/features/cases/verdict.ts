/* Вывод разбора одной фразой и три коротких абзаца под ней. Все числа из ответа сервера, слова
   собираются по правилам ниже, ничего не дописываем от себя. Миллионы и сроки форматирует
   вызывающий (mln и term из app/format.ts), чтобы модуль проверялся без браузера: npm test */

import { aboutYears, laterNote } from "../../app/paybackWords.ts";

export type VerdictInput = {
  robotName: string;
  horizon: number;
  sizing: {
    fleet: number;
    fte_before: number;
    fte_after: number;
    operator_posts: number;
    operators_fte: number;
    retrained_fte: number;
  };
  purchase: {
    investment_year0_rub: number;
    annual_effect_year1_rub?: number | null;
    payback_cumulative_years?: number | null;
    payback_later_years?: number | null;
    verdict?: { risks: string[] } | null;
  };
};

export type Format = { mln: (rub: number) => string; term: (years: number | null | undefined) => string };

export type Verdict = {
  sentence: string;
  parts: { title: string; text: string }[];
};

export function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const last = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}

const rate = (fte: number) => Math.round(fte);
const rates = (fte: number) => `${rate(fte)} ${plural(rate(fte), "ставка", "ставки", "ставок")}`;
// присмотр в смену: дробью "0,2 человека" не пишем, меньше одного это доля ставки (как app/heads.ts на шаге 5)
const watch = (posts: number) => {
  if (posts < 1 - 1e-9) return "доля ставки";
  const count = Math.ceil(posts - 1e-9);
  return `${count} ${plural(count, "человек", "человека", "человек")}`;
};

// риск про план, которого гость не чертил, к разбору не относится: план здесь типовой у всех
const aboutOwnPlan = (risk: string) => risk.startsWith("План объекта вы не чертили");

/* Люди на этой работе до и после роботов, в ставках. После считаем вместе с операторами роботов:
   они тоже люди на операции, иначе у паллет вышло бы "24 -> 0" */
export function peopleOf(sizing: VerdictInput["sizing"]): { before: number; after: number } {
  return { before: rate(sizing.fte_before), after: rate(sizing.fte_after + sizing.operators_fte) };
}

export function verdictOf(input: VerdictInput, format: Format): Verdict {
  const { sizing, purchase, robotName, horizon } = input;
  const robots = `${sizing.fleet} ${plural(sizing.fleet, "робот", "робота", "роботов")} ${robotName}`;
  // после роботов одно число на всей странице: вместе с присмотром, как в ролике (peopleOf)
  const after = peopleOf(sizing).after;
  const people =
    sizing.fte_before > 0
      ? ` берут работу, на которой сейчас ${rates(sizing.fte_before)}` +
        (rate(sizing.fte_after) > 0 ? `, после останется ${after} вместе с присмотром за роботами` : "")
      : "";
  const start = format.mln(purchase.investment_year0_rub);
  // как везде: до горизонта срок, дольше горизонта примерно с пометкой, дальше не окупается
  const later = purchase.payback_later_years;
  const payback =
    purchase.payback_cumulative_years != null
      ? `возвращаются за ${format.term(purchase.payback_cumulative_years)}`
      : later != null
        ? `возвращаются примерно за ${aboutYears(later, horizon)}, ${laterNote(horizon)}`
        : "не окупаются";
  const sentence = `${robots}${people}. ${start} млн ₽ на старте ${payback}.`;

  const parts: { title: string; text: string }[] = [];
  const effect = purchase.annual_effect_year1_rub;
  // экономия в минусе: "экономят -0,2 млн" не пишем, говорим, что расходы с роботами выше
  if (effect != null && effect < 0)
    parts.push({
      title: "Почему не окупается",
      text:
        `Экономии нет: в первый год с роботами расходы выше на ${format.mln(-effect)} млн ₽, считая ` +
        `операторов, обслуживание и энергию. Вложения ${start} млн ₽ вернуть не из чего.`,
    });
  else if (effect != null)
    parts.push({
      title: "Откуда окупаемость",
      text:
        `За первый год роботы экономят ${format.mln(effect)} млн ₽ за вычетом ` +
        `операторов, обслуживания и энергии. Вложения ${start} млн ₽.`,
    });
  if (sizing.operator_posts > 0) {
    const fromStaff = sizing.retrained_fte >= sizing.operators_fte - 0.01;
    parts.push({
      title: "Что остается людям",
      text:
        `Присмотр за роботами: ${watch(sizing.operator_posts)} в смену, часть работы начальника смены` +
        (fromStaff ? ": его берем из тех, кто сейчас на этой работе." : ".") +
        (rate(sizing.fte_after) > 0 ? ` Вместе с присмотром на этой работе остается ${rates(after)}.` : ""),
    });
  }
  const risk = (purchase.verdict?.risks ?? []).find((one) => !aboutOwnPlan(one));
  if (risk) parts.push({ title: "Что может сдвинуть вывод", text: risk });
  return { sentence, parts };
}

/* Строки под выводом разбора: при какой одной цифре покупка окупится (если не окупается) и сколько
   было бы при круглосуточной работе. Тексты собирает сервер, здесь только порядок и точка в конце */
export type NotesInput = {
  horizon_years: number;
  scenarios?: { id: string; payback_cumulative_years?: number | null }[];
  payback_needs?: { text: string }[];
  round_the_clock?: { text: string } | null;
};

export function verdictNotes(result: NotesInput): string[] {
  const purchase = (result.scenarios ?? []).find((one) => one.id === "purchase");
  const notes: string[] = [];
  const needs = purchase && purchase.payback_cumulative_years == null ? (result.payback_needs ?? []) : [];
  if (needs.length)
    notes.push(
      `Чтобы покупка окупилась за ${result.horizon_years} лет, хватит одного из условий: ${needs.map((one) => one.text).join("; ")}.`,
    );
  if (result.round_the_clock) notes.push(`${result.round_the_clock.text}.`);
  return notes;
}
