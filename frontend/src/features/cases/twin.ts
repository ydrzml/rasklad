/* Реальное внедрение, которое повторяет разбор: что у них было по факту и что вышло у нас на тех же
   значениях (docs/decisions.md, "Разборы по реальным кейсам"). Числа нашего результата из ответа
   сервера, сроки форматирует вызывающий (term из app/format.ts): модуль проверяется без браузера, npm test */

import { aboutYears, laterNote } from "../../app/paybackWords.ts";
import { peopleOf, plural } from "./verdict.ts";

/* источник: что за материал, где и когда опубликован */
export type CaseLink = { title: string; site: string; href: string };

export type Twin = {
  /* чей склад, в фразе "Повторяем ...": "склад Восток-Сервиса" */
  place: string;
  /* что из кейса взяли в расчет, одной строкой */
  given: string;
  /* что у них было по факту: парк, люди, срок окупаемости */
  fact: string;
  /* их опубликованный срок окупаемости в годах, от и до; null, если срока не публиковали */
  years: [number, number] | null;
  /* с каким нашим сценарием сравнивать срок: при оплате за действие или по подписке это аренда */
  compare: "purchase" | "raas";
  /* у них опубликована экономия в год, а не срок: рядом показываем нашу экономию первого года */
  effect?: boolean;
  link: CaseLink;
};

export type TwinInput = {
  sizing: { fleet: number; fte_before: number; fte_after: number; operators_fte: number };
  scenarios: {
    id: string;
    payback_cumulative_years?: number | null;
    payback_later_years?: number | null;
    annual_effect_year1_rub?: number | null;
  }[];
  horizon?: number;
};

const paybackOf = (input: TwinInput, id: string) =>
  input.scenarios.find((one) => one.id === id)?.payback_cumulative_years ?? null;

/* Во сколько раз наш срок дальше их опубликованного: 1, если внутри их коридора. null, если сравнить нечем */
export function gapOf(twin: Twin, input: TwinInput): number | null {
  const ours = paybackOf(input, twin.compare);
  if (!twin.years || ours == null || ours <= 0) return null;
  const [low, high] = twin.years;
  if (ours < low) return low / ours;
  if (ours > high) return ours / high;
  return 1;
}

export type TwinFormat = { term: (years: number | null) => string; mln: (rub: number) => string };

/* Строка под итогом: наш результат против их факта. Расхождение больше чем вдвое называем прямо */
export function twinResult(twin: Twin, input: TwinInput, format: TwinFormat): string {
  const { term, mln } = format;
  const { fleet } = input.sizing;
  const { before, after } = peopleOf({ operator_posts: 0, retrained_fte: 0, ...input.sizing });
  const robots = `${fleet} ${plural(fleet, "робот", "робота", "роботов")}`;
  const people = before > 0 ? `, ставок на этой работе ${before} → ${after}` : "";
  const buy = paybackOf(input, "purchase");
  const rent = paybackOf(input, "raas");
  // как везде: дольше горизонта примерно целыми годами, дальше не окупается
  const horizon = input.horizon ?? 5;
  const laterOf = (id: string) => input.scenarios.find((one) => one.id === id)?.payback_later_years ?? null;
  const words = (years: number | null, id: string, lead: string) => {
    const later = laterOf(id);
    if (years != null) return `${lead}за ${term(years)}`;
    return later != null ? `${lead}примерно за ${aboutYears(later, horizon)}` : "не окупается";
  };
  const longer = (buy == null && laterOf("purchase") != null) || (rent == null && laterOf("raas") != null);
  const terms =
    `покупка ${words(buy, "purchase", "окупается ")}, аренда ${words(rent, "raas", "")}` +
    (longer ? `, ${laterNote(horizon)}` : "");
  const effect = input.scenarios.find((one) => one.id === "purchase")?.annual_effect_year1_rub;
  const saved = twin.effect && effect != null ? `, экономия первого года ${mln(effect)} млн ₽` : "";
  const gap = gapOf(twin, input);
  const far = gap != null && gap > 2 ? " С их сроком расходимся больше чем вдвое, почему, в сверке ниже." : "";
  return `У нас на тех же значениях: ${robots}${people}${saved}, ${terms}. У них: ${twin.fact}.${far}`;
}
