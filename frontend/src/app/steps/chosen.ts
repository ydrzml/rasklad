/* Шаг 5 по выбору человека: на шаге 4 он отметил покупку, аренду или обе, здесь итог по
   отмеченному против работы без роботов и окно про невыбранный или менее выгодный способ.
   Все суммы считает сервер, здесь только слова. Модуль без браузера: npm test */

import { aboutYears, laterNote } from "../paybackWords.ts";

const mln = (value: number) =>
  (value / 1_000_000).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// окупаемость словами: 1 год, 1,1 года, 2 года, 5 лет
export function years(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (!Number.isInteger(rounded)) return `${rounded.toLocaleString("ru-RU")} года`;
  const last = rounded % 10;
  const teen = rounded % 100 >= 11 && rounded % 100 <= 14;
  return `${rounded} ${!teen && last === 1 ? "год" : !teen && last >= 2 && last <= 4 ? "года" : "лет"}`;
}

/* Бюджет на покупку на шаге 4: два необязательных поля "от" и "до" в млн рублей. Разумные границы:
   больше нуля и не больше 10 000 млн, "от" не больше "до" */
export const BUDGET_MAX_MLN = 10_000;

/* Текст поля в рубли: пусто это null, неверное значение "bad" */
export function parseMln(text: string): number | null | "bad" {
  const clean = text.trim().replace(",", ".");
  if (clean === "") return null;
  const value = Number(clean);
  if (!Number.isFinite(value) || value <= 0 || value > BUDGET_MAX_MLN) return "bad";
  return Math.round(value * 1_000_000);
}

/* Что не так с промежутком, словами под полями; пусто, если все хорошо */
export function rangeError(from: string, to: string): string | null {
  const low = parseMln(from);
  const high = parseMln(to);
  if (low === "bad" || high === "bad")
    return `Нужно число больше нуля и не больше ${BUDGET_MAX_MLN.toLocaleString("ru-RU")} млн ₽`;
  if (low != null && high != null && low > high) return '"От" больше, чем "до": поменяйте местами';
  return null;
}

// "от 20 до 50 млн ₽", "до 50 млн ₽", "от 20 млн ₽"
function rangeText(from: number | null, to: number | null): string {
  const num = (value: number) => (value / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  if (from != null && to != null) return `от ${num(from)} до ${num(to)} млн ₽`;
  if (to != null) return `до ${num(to)} млн ₽`;
  return `от ${num(from ?? 0)} млн ₽`;
}

// запас меньше этой доли верхней границы: "на грани"
const EDGE = 0.1;

/* Что нужно от сценария сервера */
export type Side = {
  start: number;
  tco: number;
  payback: number | null;
  /* за горизонт не окупается, а в досчете сервера до economics.later_payback_years окупается */
  later?: number | null;
  /* экономия первого года против людей, после всех затрат на роботов */
  effect: number;
  /* у аренды: платеж в месяц */
  month?: number;
  /* покупка в кредит или в лизинг: способ и свои деньги на старте, start тогда вся сумма покупки */
  way?: "loan" | "leasing";
  own?: number;
};

const WAY_WORDS = { loan: "в кредит", leasing: "в лизинг" };
const buyName = (buy: Side) => (buy.way ? `Покупка ${WAY_WORDS[buy.way]}` : "Покупка");
// с чего начинается строка под заголовком: сколько вложить, у кредита и лизинга свои деньги
const buyStart = (buy: Side) =>
  buy.way && buy.own != null
    ? `Своих денег на старте ${mln(buy.own)} млн ₽, остальное ${WAY_WORDS[buy.way]}`
    : `Вложить ${mln(buy.start)} млн ₽`;

export type ChosenInput = {
  horizon: number;
  baselineTco: number;
  buy: Side;
  rent: Side;
  wantBuy: boolean;
  wantRent: boolean;
  /* бюджет на покупку с шага 4: "до" и "от", оба необязательные */
  budget: number | null;
  budgetFrom?: number | null;
  /* свои деньги на старте в кредит и в лизинг, если сервер их посчитал */
  loanStart?: number | null;
  leasingStart?: number | null;
  /* на шаге 4 отмечены кредит или лизинг */
  credit?: boolean;
};

export type Chosen = {
  head: string;
  sub: string;
  /* какой из отмеченных выгоднее; пусто, если отмечен один или оба дороже людей */
  best: "buy" | "rent" | null;
  /* покупка против бюджета: влезает, на грани или не влезает, и что предложить */
  budget: { tone: "fit" | "edge" | "over"; title: string; text: string } | null;
};

const cheaperWord = (gain: number) => (gain >= 0 ? "дешевле" : "дороже");
// платеж меньше 0,1 млн в тысячах, иначе на экране "0,0 млн"
const money = (value: number) =>
  value >= 100_000 ? `${mln(value)} млн ₽` : `${Math.round(value / 1_000).toLocaleString("ru-RU")} тыс. ₽`;
const monthly = (rent: Side) => (rent.month ? `, платеж ${money(rent.month)} в месяц` : "");

/* Окупаемость как в format.paybackPhrase: до горизонта срок как есть, дольше горизонта примерно
   целыми годами и пометка в строке ниже, дальше "не окупается" */
function buyPayback(buy: Side, horizon: number): string {
  if (buy.payback != null) return `окупится за ${years(buy.payback)}`;
  if (buy.later != null) return `окупится примерно за ${aboutYears(buy.later, horizon)}`;
  return "не окупается";
}

const laterLine = (buy: Side, horizon: number) =>
  buy.payback == null && buy.later != null ? `Это ${laterNote(horizon)}. ` : "";

function buyHead(buy: Side, horizon: number): string {
  return `${buyName(buy)} ${buyPayback(buy, horizon)}`;
}

function rentHead(rent: Side): string {
  return rent.effect > 0
    ? "Аренда выгоднее людей с первого года"
    : `Аренда дороже людей на ${mln(-rent.effect)} млн ₽ в год`;
}

/* Покупка против промежутка бюджета. Не влезает или на грани: говорим прямо и предлагаем аренду
   и кредит, если он посчитан */
function budgetLine(input: ChosenInput): Chosen["budget"] {
  const { buy, rent, budget: to, budgetFrom: from = null, wantBuy, loanStart } = input;
  if (!wantBuy || (to == null && from == null)) return null;
  const range = rangeText(from, to);
  // предлагаем только то, что в бюджет влезает: аренда на старте тоже бывает больше
  const fits = (start: number) => to == null || start <= to;
  const ways = [
    ...(fits(rent.start)
      ? [`аренду: на старте ${mln(rent.start)} млн ₽${rent.month ? `, дальше ${money(rent.month)} в месяц` : ""}`]
      : []),
    ...(loanStart != null && fits(loanStart) ? [`кредит: своих денег на старте ${mln(loanStart)} млн ₽`] : []),
  ];
  const need = `На старте нужно ${mln(buy.start)} млн ₽`;
  if (to != null && buy.start > to)
    return {
      tone: "over",
      title: "Покупка не влезает в ваш бюджет",
      text: ways.length
        ? `${need}, а ваш бюджет ${range}. Можно взять ${ways.join(" или ")}.`
        : `${need}, а ваш бюджет ${range}. Аренда тоже больше: на старте ${mln(rent.start)} млн ₽.`,
    };
  if (to != null && buy.start > to * (1 - EDGE))
    return {
      tone: "edge",
      title: "Покупка на грани бюджета",
      text: `${need} при бюджете ${range}: запас меньше 10%, при росте цен может не хватить. Тогда можно взять ${ways.join(" или ")}.`,
    };
  return {
    tone: "fit",
    title: "Покупка влезает в ваш бюджет",
    text: `${need}, ваш бюджет ${range}.${from != null && buy.start < from ? " Это меньше, чем вы готовы вложить." : ""}`,
  };
}

// "аренда", "аренда и кредит", "аренда, кредит и лизинг"
function listText(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}`;
}

/* Покупка не влезает в бюджет: заголовок про то, что влезает (аренда, а если отмечены, кредит или
   лизинг), а не "выгоднее покупка". Окна "почему не аренда" нет: аренда тут и есть ответ (решение Саши) */
function overBudget(input: ChosenInput, budget: Chosen["budget"]): Chosen | null {
  const { horizon, baselineTco, rent, budget: to, credit, loanStart, leasingStart } = input;
  if (budget?.tone !== "over" || to == null) return null;
  const rentFits = rent.start <= to;
  // кредит в заголовке, если его отметили; не отметили, но он единственный влезает, тоже говорим
  const loanFits = loanStart != null && loanStart <= to && (Boolean(credit) || !rentFits);
  const leasingFits = Boolean(credit) && leasingStart != null && leasingStart <= to;
  const fits = [...(rentFits ? ["аренда"] : []), ...(loanFits ? ["кредит"] : []), ...(leasingFits ? ["лизинг"] : [])];
  const rentGain = baselineTco - rent.tco;
  const parts = [
    ...(rentFits
      ? [
          `Аренда: на старте ${mln(rent.start)} млн ₽${monthly(rent)}, за ${horizon} лет ${cheaperWord(rentGain)}, чем без роботов, на ${mln(Math.abs(rentGain))} млн ₽.`,
        ]
      : []),
    ...(loanFits ? [`Кредит: своих денег на старте ${mln(loanStart ?? 0)} млн ₽.`] : []),
    ...(leasingFits ? [`Лизинг: своих денег на старте ${mln(leasingStart ?? 0)} млн ₽.`] : []),
  ];
  return {
    head: fits.length
      ? `В бюджет ${fits.length > 1 ? "влезают" : "влезает"} ${listText(fits)}`
      : "Покупка не влезает в бюджет",
    sub: parts.length
      ? parts.join(" ")
      : `Аренда тоже больше бюджета: на старте ${mln(rent.start)} млн ₽. Поменять бюджет можно на шаге 4.`,
    best: null,
    budget,
  };
}

export function chosen(input: ChosenInput): Chosen {
  const { horizon, baselineTco, buy, rent, wantBuy, wantRent } = input;
  const buyGain = baselineTco - buy.tco;
  const rentGain = baselineTco - rent.tco;
  const budget = budgetLine(input);
  const tight = overBudget(input, budget);
  if (tight) return tight;

  if (wantBuy && !wantRent)
    return {
      head: buyHead(buy, horizon),
      sub: `${laterLine(buy, horizon)}${buyStart(buy)}, экономия ${mln(buy.effect)} млн ₽ в год. За ${horizon} лет ${cheaperWord(buyGain)}, чем без роботов, на ${mln(Math.abs(buyGain))} млн ₽.`,
      best: null,
      budget,
    };

  if (wantRent && !wantBuy)
    return {
      head: rentHead(rent),
      sub: `На старте ${mln(rent.start)} млн ₽ на подготовку склада${monthly(rent)}. За ${horizon} лет ${cheaperWord(rentGain)}, чем без роботов, на ${mln(Math.abs(rentGain))} млн ₽.`,
      best: null,
      budget,
    };

  // отмечены обе
  if (buyGain <= 0 && rentGain <= 0)
    return {
      head: "Без роботов дешевле",
      sub: `И покупка, и аренда за ${horizon} лет дороже работы людьми: ${buyName(buy).toLowerCase()} на ${mln(-buyGain)} млн ₽, аренда на ${mln(-rentGain)} млн ₽.`,
      best: null,
      budget,
    };
  if (buy.tco <= rent.tco)
    return {
      head: `Выгоднее ${buyName(buy).toLowerCase()}${buy.payback == null && buy.later == null ? "" : `: ${buyPayback(buy, horizon)}`}`,
      sub: `${laterLine(buy, horizon)}За ${horizon} лет дешевле, чем без роботов, на ${mln(buyGain)} млн ₽. ${buyStart(buy)}, экономия ${mln(buy.effect)} млн ₽ в год.`,
      best: "buy",
      budget,
    };
  return {
    head: "Выгоднее аренда",
    sub: `За ${horizon} лет дешевле, чем без роботов, на ${mln(rentGain)} млн ₽. На старте ${mln(rent.start)} млн ₽${monthly(rent)}.`,
    best: "rent",
    budget,
  };
}

/* Что нужно от сценария сервера для строк кредита и лизинга под покупкой */
export type PayDetails = {
  financing?: { method: string; month_first_rub: number; interest_rub: number } | null;
};

/* Кредит и лизинг строками: платеж в месяц (у кредита первый, он самый большой) и переплата */
export function creditLines(way: "loan" | "leasing", one: PayDetails | undefined): string[] {
  const plan = one?.financing;
  if (!plan || plan.method !== way) return [];
  return [
    `платеж в месяц ${money(plan.month_first_rub)}`,
    `переплата ${way === "loan" ? "за проценты" : "за удорожание"} ${money(plan.interest_rub)}`,
  ];
}
