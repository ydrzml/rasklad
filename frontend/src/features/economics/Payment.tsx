import type { CalculationResult, ScenarioResult } from "../../api/client";
import { mln, percent, term } from "../../app/format";
import { BlockHead, Compare, Panel } from "../../ui";

// Кредит, лизинг и господдержка меняют только покупку. Сервер считает ту же покупку тремя способами
// оплаты (docs/calculation.md, раздел 8), здесь три колонки рядом и меры поддержки с причинами

const purchaseOf = (result: CalculationResult | null) =>
  result?.scenarios?.find((one) => one.id === "purchase") ?? null;

export function Payment({
  base,
  loan,
  leasing,
  years,
}: {
  years: string;
  base: ScenarioResult;
  loan: CalculationResult | null;
  leasing: CalculationResult | null;
}) {
  const withLoan = purchaseOf(loan);
  const withLeasing = purchaseOf(leasing);
  const columns = [
    { name: "Свои деньги", one: base },
    ...(withLoan ? [{ name: `Кредит ${percent(withLoan.financing?.rate)}`, one: withLoan }] : []),
    ...(withLeasing ? [{ name: `Лизинг ${percent(withLeasing.financing?.rate)}`, one: withLeasing }] : []),
  ];
  const cell = (pick: (one: ScenarioResult) => string) => columns.map((column) => pick(column.one));
  const supports = withLoan?.financing?.supports ?? base.financing?.supports ?? [];

  return (
    <section id="payment" className="e-section">
      <BlockHead title="Способ оплаты" note="меняет только покупку, аренда остается как есть" />
      <Panel>
        <div className="e-body">
          {columns.length > 1 ? (
            <Compare
              columns={columns.map((column) => ({ name: column.name }))}
              rows={[
                {
                  label: "Своих денег на старте",
                  hint: "остальное дает банк или лизинговая компания",
                  cells: cell((one) => `${mln(one.investment_year0_rub)} млн ₽`),
                },
                {
                  label: "Окупаемость",
                  hint: "с кредитом и лизингом: когда сэкономленное покрыло и вложения, и остаток долга",
                  cells: cell((one) => term(one.payback_cumulative_years)),
                },
                {
                  label: "Первый взнос вернется за",
                  cells: cell((one) =>
                    one.financing?.method === "own" ? "как окупаемость" : term(one.payback_own_years),
                  ),
                },
                {
                  label: "Проценты или удорожание за срок",
                  cells: cell((one) =>
                    one.financing?.interest_rub ? `${mln(one.financing.interest_rub)} млн ₽` : "нет",
                  ),
                },
                {
                  label: `Стоимость владения за ${years}`,
                  cells: cell((one) => `${mln(one.tco_rub)} млн ₽`),
                },
                {
                  label: "NPV",
                  hint: "от потока своих денег",
                  cells: cell((one) => (one.npv_rub === null ? "нет" : `${mln(one.npv_rub)} млн ₽`)),
                },
              ]}
            />
          ) : (
            <p className="e-text">Кредит и лизинг для примера не посчитались: сервер не ответил.</p>
          )}
          <p className="e-text">
            Кредит и лизинг обычно окупаются чуть дольше своих денег и стоят дороже на проценты, зато на старте нужно в
            несколько раз меньше. Кредит: тело долга равными долями, проценты с остатка. Лизинг: равный платеж, аванс и
            страховка на клиенте. Налоговых выгод лизинга не считаем: вычеты НДС при покупке те же, разница только во
            времени.
          </p>
        </div>
      </Panel>

      {supports.length > 0 && (
        <div className="e-supports">
          <h3 className="e-subhead">Господдержка для склада в Москве</h3>
          <ul>
            {supports.map((one) => (
              <li key={one.id} className={one.blocked ? "is-blocked" : undefined}>
                <span className="e-support-state">{one.blocked ? "недоступна" : "с условиями"}</span>
                <span className="e-support-name">{one.name}</span>
                <span className="e-support-why">{one.blocked ? `Почему: ${one.blocked}` : one.conditions}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
