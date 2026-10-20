/* Способы оплаты, которые человек отмечает на шаге решения, и слова о них: строки на карточке
   решения и вывод на шаге экономики. Все суммы считает сервер, здесь только выбираем, что
   подписать. Модуль без браузера: npm test */
import type { Solution } from "../../api/client";
import type { PayRow } from "../../features/cases/payments";

// миллионы с одной цифрой после запятой, как mln в format.ts: модуль без импортов, чтобы тесты шли без сборки
const mln = (value: number) =>
  (value / 1_000_000).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export type PayWay = PayRow["id"];

export const PAY_WAYS: { id: PayWay; name: string; note: string }[] = [
  { id: "own", name: "Свои деньги", note: "покупка, вся сумма на старте" },
  { id: "loan", name: "Кредит", note: "своя часть на старте, остальное в долг" },
  { id: "leasing", name: "Лизинг", note: "аванс на старте, дальше платежи" },
  { id: "raas", name: "Аренда", note: "роботы как услуга, платеж в месяц" },
];

// все способы: строка "С кредитом или лизингом" на шаге экономики сравнивает их рядом
export const ALL_WAYS: PayWay[] = PAY_WAYS.map((one) => one.id);

// по умолчанию покупка и аренда: шаг экономики показывает обе против работы без роботов. Кредит и
// лизинг считаем, только если человек отметил "своих денег нет или не хватает"
export const DEFAULT_WAYS: PayWay[] = ["own", "raas"];

/* Отметить или снять способ. Хотя бы один остается всегда, порядок как в PAY_WAYS */
export function toggled(ways: PayWay[], id: PayWay): PayWay[] {
  const next = ways.includes(id) ? ways.filter((one) => one !== id) : [...ways, id];
  return next.length > 0 ? PAY_WAYS.map((one) => one.id).filter((one) => next.includes(one)) : ways;
}

/* Сохраненный выбор из черновика: только знакомые способы, пустой или битый дает выбор по умолчанию */
export function savedWays(raw: unknown): PayWay[] {
  if (!Array.isArray(raw)) return DEFAULT_WAYS;
  const known = PAY_WAYS.map((one) => one.id).filter((id) => raw.includes(id));
  return known.length > 0 ? known : DEFAULT_WAYS;
}

/* Что сервер прислал по решению для карточки: POST /api/budget/fit */
export type CardFit = {
  fleet_needed: number | null;
  investment_needed_rub: number | null;
  loan_start_rub?: number | null;
  leasing_start_rub?: number | null;
  raas_start_rub?: number | null;
  raas_month_rub?: number | null;
};

export type CardLine = {
  id: PayWay;
  name: string;
  value: string;
  unit: string;
  /* свои деньги на старте больше бюджета */
  over: boolean;
};

/* Строки способов на карточке решения: весь нужный парк, только отмеченные способы и только те,
   что у решения есть. Аренда в месяц, остальное своими деньгами на старте; бюджет сравниваем
   с деньгами на старте, у аренды это подготовка объекта */
export function cardLines(fit: CardFit | undefined, ways: PayWay[], budget: number | null | undefined): CardLine[] {
  if (!fit?.fleet_needed || !fit.investment_needed_rub) return [];
  const over = (start: number | null | undefined) => Boolean(budget && start != null && start > budget);
  const lines: Record<PayWay, { value: number | null | undefined; unit: string; start: number | null | undefined }> = {
    own: { value: fit.investment_needed_rub, unit: "млн ₽", start: fit.investment_needed_rub },
    loan: { value: fit.loan_start_rub, unit: "млн ₽", start: fit.loan_start_rub },
    leasing: { value: fit.leasing_start_rub, unit: "млн ₽", start: fit.leasing_start_rub },
    raas: { value: fit.raas_month_rub, unit: "млн ₽ в месяц", start: fit.raas_start_rub },
  };
  return PAY_WAYS.flatMap((way) => {
    const line = lines[way.id];
    if (!ways.includes(way.id) || line.value == null) return [];
    return [{ id: way.id, name: way.name, value: mln(line.value), unit: line.unit, over: over(line.start) }];
  });
}

/* Цифра, по которой идет "сначала дешевые": та, что на карточке крупно первой строкой, то есть
   весь парк первым из отмеченных способов (свои деньги, кредит, лизинг, аренда в месяц). Цена
   штуки не годится: решения требуют разное число роботов. Нет цифры у сервера, решение в конце */
export function cardSortValue(fit: CardFit | undefined, ways: PayWay[]): number | null {
  if (!fit?.fleet_needed || !fit.investment_needed_rub) return null;
  const values: Record<PayWay, number | null | undefined> = {
    own: fit.investment_needed_rub,
    loan: fit.loan_start_rub,
    leasing: fit.leasing_start_rub,
    raas: fit.raas_month_rub,
  };
  const first = PAY_WAYS.find((way) => ways.includes(way.id) && values[way.id] != null);
  return first ? (values[first.id] ?? null) : null;
}

/* Порядок "сначала дешевые": по возрастанию цифры с карточки, без цифры в конце, при равных по
   цене штуки с НДС */
export function byCardPrice(list: Solution[], fits: Record<string, CardFit> | undefined, ways: PayWay[]): Solution[] {
  const key = (one: Solution) => cardSortValue(fits?.[one.robot_id ?? ""], ways) ?? Infinity;
  return [...list].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left !== right) return left < right ? -1 : 1;
    return (a.price_rub ?? Infinity) - (b.price_rub ?? Infinity) || 0;
  });
}

const WORDS: Record<PayWay, string> = {
  own: "покупка за свои",
  loan: "кредит",
  leasing: "лизинг",
  raas: "аренда",
};

// с чем сравниваем: "дешевле кредита на 13,5 млн ₽"
const THAN: Record<PayWay, string> = {
  own: "покупки за свои",
  loan: "кредита",
  leasing: "лизинга",
  raas: "аренды",
};

// почему дороже покупки за свои: одна причина на способ, без чисел, числа в карточках
const WHY: Record<PayWay, string> = {
  own: "",
  loan: "кредит на проценты",
  leasing: "лизинг на удорожание",
  raas: "аренда на ежемесячную плату весь срок",
};

/* Вывод словами на шаге экономики: что дешевле за горизонт и насколько, почему, что легче на
   старте и что из этого влезает в бюджет */
export function verdict(
  rows: Pick<PayRow, "id" | "start" | "tco">[],
  baselineTco: number,
  horizon: number,
  budget: number | null,
): string {
  if (rows.length === 0) return "";
  const cheapest = rows.reduce((best, row) => (row.tco < best.tco ? row : best));
  const lightest = rows.reduce((best, row) => (row.start < best.start ? row : best));
  const parts: string[] = [];
  if (rows.length === 1) {
    const name = WORDS[cheapest.id];
    const head = name.charAt(0).toUpperCase() + name.slice(1);
    parts.push(
      cheapest.tco < baselineTco
        ? `${head}: за ${horizon} лет дешевле, чем без роботов, на ${mln(baselineTco - cheapest.tco)} млн ₽.`
        : `${head}: за ${horizon} лет дороже, чем без роботов, на ${mln(cheapest.tco - baselineTco)} млн ₽.`,
    );
  } else {
    const others = rows.filter((row) => row !== cheapest);
    const gaps = others.map((row) => `${THAN[row.id]} на ${mln(row.tco - cheapest.tco)}`).join(", ");
    // все способы дороже работы без роботов: "выгоднее всего" было бы неправдой, говорим это первым
    parts.push(
      cheapest.tco >= baselineTco
        ? `Любым способом за ${horizon} лет дороже, чем без роботов. Меньше всего потерь: ${WORDS[cheapest.id]}, дешевле ${gaps} млн ₽.`
        : `Выгоднее всего ${WORDS[cheapest.id]}: за ${horizon} лет дешевле ${gaps} млн ₽.`,
    );
    const why = cheapest.id === "own" ? others.map((row) => WHY[row.id]) : [];
    if (why.length) parts.push(`Дороже ${why.join(", ")}.`);
    if (lightest !== cheapest)
      parts.push(`Меньше всего своих денег на старте: ${WORDS[lightest.id]}, ${mln(lightest.start)} млн ₽.`);
  }
  if (budget) {
    const fitting = rows.filter((row) => row.start <= budget);
    const best = fitting.length ? fitting.reduce((one, row) => (row.tco < one.tco ? row : one)) : null;
    parts.push(
      fitting.length === rows.length
        ? `В бюджет ${mln(budget)} млн ₽ на старте укладывается все отмеченное.`
        : best
          ? `В бюджет ${mln(budget)} млн ₽ на старте укладывается: ${fitting.map((row) => WORDS[row.id]).join(", ")}. Из них выгоднее всего ${WORDS[best.id]}.`
          : `В бюджет ${mln(budget)} млн ₽ на старте не укладывается ничего из отмеченного.`,
    );
  }
  return parts.join(" ");
}

/* Правки, от которых зависит прогон смены на плане: без способа оплаты, господдержки, выхода на режим
   и окладов. Те же корни сервер не берет в ключ прогона (MONEY_ROOTS в backend/app/services/simulation.py).
   Без этого смена на плане гонялась заново на каждый щелчок "Кредит" и на больших складах шла
   до минуты, а расчет кредита ждал ее в очереди */
const MONEY_ROOTS = ["financing.", "subsidies.", "ramp_up.", "roles."];

export function shiftOverrides(overrides: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([path]) => !MONEY_ROOTS.some((root) => path.startsWith(root))),
  );
}
