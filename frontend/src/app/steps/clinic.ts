/* Итог медучреждения словами: заголовок и строки по тем же правилам и тем же словам, что шаг 5 склада
   (chosen.ts). Свой модуль, потому что тесты идут в node без сборщика, а модули не импортируют друг друга.
   Все суммы считает сервер, здесь только слова. Модуль без браузера: npm test */

const mln = (value: number) =>
  (value / 1_000_000).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// окупаемость словами, как years в chosen.ts: 1 год, 4,1 года, 5 лет
export function years(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (!Number.isInteger(rounded)) return `${rounded.toLocaleString("ru-RU")} года`;
  const last = rounded % 10;
  const teen = rounded % 100 >= 11 && rounded % 100 <= 14;
  return `${rounded} ${!teen && last === 1 ? "год" : !teen && last >= 2 && last <= 4 ? "года" : "лет"}`;
}

export type ClinicScenarioWords = {
  id: "baseline" | "purchase" | "raas" | "loan";
  available: boolean;
  why_not: string;
  start_rub: number;
  tco_rub: number;
  effect_year1_rub: number;
  payback_years: number | null;
  month_rub: number | null;
  rent_period?: "month" | "year";
};

export type ClinicWords = {
  head: string;
  sub: string;
  best: "buy" | "rent" | null;
  /* окно про аренду: почему ее нет или чем она отличается от покупки */
  rent: { title: string; text: string };
};

const cheaper = (gain: number) => (gain >= 0 ? "дешевле" : "дороже");

/* Заголовок как у склада: покупка окупится или нет, а если есть и аренда, что выгоднее */
export function clinicWords(
  horizon: number,
  scenarios: ClinicScenarioWords[],
  cashShare = 1,
  serviceReady = true,
): ClinicWords | null {
  const baseline = scenarios.find((one) => one.id === "baseline");
  const buy = scenarios.find((one) => one.id === "purchase");
  const rent = scenarios.find((one) => one.id === "raas");
  if (!baseline || !buy || !rent) return null;
  const buyGain = baseline.tco_rub - buy.tco_rub;
  const rentGain = baseline.tco_rub - rent.tco_rub;
  const about = aboutRent(buy, rent, horizon);
  if (!serviceReady)
    return {
      head: "Достаточность парка не подтверждена",
      sub: "Цель доставки или уборки не достигнута. Денежный эффект относится только к выполненному объему; сначала устраните ограничения и повторите прогон.",
      best: null,
      rent: about,
    };
  if (cashShare === 0)
    return {
      head: "Сокращение бюджета не подтверждено",
      sub: "Роботы могут высвободить время для других задач. Зарплата остается в затратах: стоимость этого времени не считается денежной экономией.",
      best: null,
      rent: about,
    };
  const paysBack = (scenario: ClinicScenarioWords, gain: number) =>
    scenario.available &&
    gain > 0.01 &&
    scenario.payback_years != null &&
    Number.isFinite(scenario.payback_years) &&
    scenario.payback_years >= 0 &&
    scenario.payback_years <= horizon;
  const buyPays = paysBack(buy, buyGain);
  const rentPays = paysBack(rent, rentGain);
  if (!buyPays && !rentPays)
    return {
      head: "Окупаемость с положительным результатом не подтверждена",
      sub: `На текущих входных данных расходы не покрываются за ${horizon} лет. Можно выбрать любой вариант и сравнить его затраты; причины и порог безубыточности показаны ниже.`,
      best: null,
      rent: about,
    };
  const invest = `Вложить ${mln(buy.start_rub)} млн ₽, экономия ${mln(buy.effect_year1_rub)} млн ₽ в год.`;
  if (!rent.available)
    return {
      head:
        buy.payback_years == null
          ? `Покупка не окупается за ${horizon} лет`
          : `Покупка окупится за ${years(buy.payback_years)}`,
      sub: `${invest} За ${horizon} лет ${cheaper(buyGain)}, чем без роботов, на ${mln(Math.abs(buyGain))} млн ₽.`,
      best: null,
      rent: about,
    };
  if (buyPays && (!rentPays || buy.tco_rub <= rent.tco_rub))
    return {
      head:
        buy.payback_years == null ? "Выгоднее покупка" : `Выгоднее покупка: окупится за ${years(buy.payback_years)}`,
      sub: `За ${horizon} лет дешевле, чем без роботов, на ${mln(buyGain)} млн ₽. ${invest}`,
      best: "buy",
      rent: about,
    };
  return {
    head: "Выгоднее аренда",
    sub: `За ${horizon} лет дешевле, чем без роботов, на ${mln(rentGain)} млн ₽. ${rentPayment(rent)}.`,
    best: "rent",
    rent: about,
  };
}

function aboutRent(buy: ClinicScenarioWords, rent: ClinicScenarioWords, horizon: number) {
  if (!rent.available)
    return {
      title: "Аренду не считаем",
      text: `${rent.why_not}. Придумывать цену не будем: спросите аренду у поставщика, и ее можно будет сравнить с покупкой.`,
    };
  const diff = rent.tco_rub - buy.tco_rub;
  const month = rent.month_rub ? `, ${rentPayment(rent).toLowerCase()}` : "";
  if (diff > 0)
    return {
      title: "Почему не аренда",
      text: `Аренда за ${horizon} лет дороже покупки на ${mln(diff)} млн ₽${month}, роботы не ваши. Интеграция и первый платеж оплачиваются отдельно.`,
    };
  const back = buy.payback_years == null ? `не окупается за ${horizon} лет` : `окупится за ${years(buy.payback_years)}`;
  return {
    title: "Почему не покупка",
    text: `Аренда за ${horizon} лет дешевле покупки на ${mln(-diff)} млн ₽${month}, ремонт на поставщике. Покупка ${back}.`,
  };
}

function rentPayment(rent: ClinicScenarioWords): string {
  return rent.rent_period === "year"
    ? `Платеж ${mln((rent.month_rub ?? 0) * 12)} млн ₽ в год`
    : `Платеж ${mln(rent.month_rub ?? 0)} млн ₽ в месяц`;
}

/* Сколько людей это работы, словами: доли ставки и сколько санитаров по датасету */
export function staffWords(fte: number, orderlies: number): string {
  const share =
    fte < 0.1
      ? "меньше 0,1 ставки"
      : `${fte.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ставки`;
  return `Роботы забирают рейсы санитаров: это ${share} из ${orderlies.toLocaleString("ru-RU")} санитаров и транспортировщиков по датасету. Ставки не сокращаем, часы уходят на пациентов.`;
}

const MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

/* Когда проверили цифру: "2026-10" -> "проверено: октябрь 2026". Нет даты: так и пишем */
export function checkedWhen(date: string | null): string {
  const found = date && /^(\d{4})-(\d{2})/.exec(date);
  const month = found ? MONTHS[Number(found[2]) - 1] : undefined;
  return found && month ? `проверено: ${month} ${found[1]}` : "дата не указана";
}
