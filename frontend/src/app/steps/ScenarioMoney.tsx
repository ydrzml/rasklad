import type { CalculationResult, ScenarioResult } from "../../api/client";
import { BlockHead, Compare, Fold, Ledger, LedgerColumn, MoreLink } from "../../ui";
import { mln } from "../format";
import { mln2, OPEX_NAMES, scenarioWord } from "./economicsNames";

/* Деньги по годам у сценария, выбранного переключателем шага 5. Без роботов это только зарплаты
   людей на операции с ростом, у покупки и аренды вложения, долг, статьи затрат и экономия.
   Суммы сервера, здесь только строки таблицы */
export function YearsTable({ pick, baseline }: { pick: ScenarioResult; baseline: ScenarioResult }) {
  const some = (take: (year: ScenarioResult["years"][number]) => number | null | undefined) =>
    pick.years.some((year) => (take(year) ?? 0) > 0);
  const row = (
    label: string,
    take: (year: ScenarioResult["years"][number]) => number | null | undefined,
    hint?: string,
  ) => ({ label, hint, cells: ["", ...pick.years.map((year) => mln(take(year) ?? 0))] });
  const rows =
    pick.id === "baseline"
      ? [
          { label: "Вложения", hint: "без роботов вкладывать не во что", cells: ["0,0", ...pick.years.map(() => "")] },
          row("Люди на операции", (year) => year.staff_cost_rub, "зарплаты с ростом каждый год"),
        ]
      : [
          {
            label: "Вложения",
            hint: "на старте, потом выкуп и обновление парка",
            cells: [mln(pick.investment_year0_rub), ...pick.years.map((year) => mln(year.investment_rub))],
          },
          ...(some((year) => year.financing_rub)
            ? [row("Платежи по долгу", (y) => y.financing_rub, "кредит или лизинг")]
            : []),
          ...(some((year) => year.support_rub)
            ? [row("Господдержка", (y) => y.support_rub, "пришла в этом году")]
            : []),
          ...(some((year) => year.insurance_rub)
            ? [row("Страховка", (y) => y.insurance_rub, "залога или предмета лизинга, пока есть долг")]
            : []),
          {
            label: "Люди без роботов",
            hint: "с ростом зарплат",
            cells: ["", ...baseline.years.map((year) => mln(year.staff_cost_rub))],
          },
          row("Люди с роботами", (year) => year.staff_cost_rub, "кто остался на операции"),
          ...Object.keys(Object.assign({}, ...pick.years.map((year) => year.opex_rub))).map((item) =>
            row(OPEX_NAMES[item] ?? item, (year) => year.opex_rub[item]),
          ),
          row("Затраты на роботов", (year) => year.opex_total_rub, "сумма статей выше"),
          row("Экономия", (year) => year.effect_rub, "люди без роботов - люди с роботами - затраты на роботов"),
        ];
  return (
    <Fold id="years" title={`${scenarioWord(pick)}: деньги по годам`}>
      <Compare
        columns={[{ name: "старт" }, ...pick.years.map((year) => ({ name: `${year.year} год` }))]}
        rows={[
          ...rows,
          {
            label: "Накопленные затраты",
            hint: "как на графике",
            cells: (pick.cumulative_cost_rub ?? []).map((value) => mln(value)),
          },
          ...(pick.id === "baseline"
            ? []
            : [row("Амортизация", (year) => year.amortization_rub, "для учета, в затраты не входит")]),
        ]}
      />
      <p className="u-frow-hint">
        Все суммы в миллионах рублей. Годы считаем целиком: вложения на старте, затраты в конце каждого года.
      </p>
    </Fold>
  );
}

/* Куда уходят деньги без роботов: вложений нет, каждый год зарплаты людей на операции, за горизонт
   их сумма с ростом. Тот же вид, что у покупки и аренды, чтобы сравнивать по колонкам */
export function BaselineLedger({ result, baseline }: { result: CalculationResult; baseline: ScenarioResult }) {
  const horizon = result.horizon_years;
  const first = baseline.years[0]?.staff_cost_rub ?? 0;
  return (
    <section id="ledger" className="u-summary">
      <BlockHead title="Куда уходят деньги" note={`Без роботов: на старте, каждый год и за ${horizon} лет`} />
      <Ledger>
        <LedgerColumn
          id="capex"
          title="Разово на старте"
          note="роботов нет, вкладывать не во что"
          rows={[]}
          total={{ name: "Всего на старте, млн ₽", value: mln2(0) }}
        />
        <LedgerColumn
          id="opex"
          title="Каждый год"
          note="первый год, дальше зарплаты растут"
          rows={[{ key: "staff", name: "Люди на этой работе", value: mln2(first) }]}
          total={{ name: "Расходы в год, млн ₽", value: mln2(first) }}
        />
        <LedgerColumn
          id="tco"
          title={`За ${horizon} лет`}
          note="зарплаты людей на операции, с ростом"
          rows={[{ key: "staff", name: "Люди на этой работе", value: mln2(baseline.tco_rub) }]}
          total={{ name: `Все расходы за ${horizon} лет, млн ₽`, value: mln2(baseline.tco_rub) }}
        >
          <MoreLink href="#scenarios" text="Сравнить с покупкой и арендой" />
        </LedgerColumn>
      </Ledger>
    </section>
  );
}
