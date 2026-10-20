/* Четыре способа заплатить за тех же роботов рядом: свои деньги, кредит, лизинг, аренда.
   Числа из ответа сервера: покупка и аренда из расчета, кредит и лизинг из того же расчета с другим
   способом оплаты. Здесь только выбираем, что подписать. Модуль без браузера: npm test */

export type PayScenario = {
  investment_year0_rub: number;
  tco_rub: number;
  payback_cumulative_years?: number | null;
  payback_later_years?: number | null;
  annual_effect_year1_rub?: number | null;
};

export type PayRow = {
  id: "own" | "loan" | "leasing" | "raas";
  name: string;
  note: string;
  tone: "buy" | "rent";
  start: number;
  tco: number;
  payback: number | null;
  /* окупается дольше горизонта: год из досчета сервера, иначе пусто */
  later: number | null;
  /* экономия первого года против людей: у аренды главный ответ, выгодна ли она с первого года */
  first: number | null;
  badges: string[];
};

const ROWS: Omit<PayRow, "start" | "tco" | "payback" | "later" | "first" | "badges">[] = [
  { id: "own", name: "Свои деньги", note: "Вся покупка сразу", tone: "buy" },
  { id: "loan", name: "Кредит", note: "На старте своя часть, остальное в долг", tone: "buy" },
  { id: "leasing", name: "Лизинг", note: "Аванс на старте, остальное платежами", tone: "buy" },
  { id: "raas", name: "Аренда", note: "Платеж в месяц, роботы не ваши, выкуп по желанию", tone: "rent" },
];

export function payRows(sources: Partial<Record<PayRow["id"], PayScenario>>, horizon: number): PayRow[] {
  const rows = ROWS.flatMap((row) => {
    const one = sources[row.id];
    if (!one) return [];
    return [
      {
        ...row,
        start: one.investment_year0_rub,
        tco: one.tco_rub,
        payback: one.payback_cumulative_years ?? null,
        later: one.payback_cumulative_years == null ? (one.payback_later_years ?? null) : null,
        first: one.annual_effect_year1_rub ?? null,
        badges: [] as string[],
      },
    ];
  });
  if (rows.length < 2) return rows;
  const cheapest = rows.reduce((best, row) => (row.tco < best.tco ? row : best));
  const lightest = rows.reduce((best, row) => (row.start < best.start ? row : best));
  // аренда не окупается как покупка: роботы не наши, у нее окупается только внедрение, сравнивать не с чем
  const paying = rows.filter((row) => row.payback !== null && row.id !== "raas");
  const fastest = paying.length
    ? paying.reduce((best, row) => ((row.payback ?? 0) < (best.payback ?? 0) ? row : best))
    : null;
  return rows.map((row) => ({
    ...row,
    badges: [
      ...(row === cheapest ? [`дешевле всего за ${horizon} лет`] : []),
      ...(row === lightest ? ["меньше всего денег на старте"] : []),
      ...(row === fastest ? ["быстрее всего окупается"] : []),
    ],
  }));
}
