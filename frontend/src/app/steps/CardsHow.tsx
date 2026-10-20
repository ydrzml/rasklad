import type { CalculationResult, ScenarioResult } from "../../api/client";
import { Compare, CostChart, Fold, Formula } from "../../ui";
import type { Tone } from "../../ui";
import { mln, money, percent, term } from "../format";
import { irrText, scenarioWord, times } from "./economicsNames";

const TONES: Record<string, Tone> = { baseline: "now", purchase: "buy", raas: "rent" };

/* Как посчитаны три карточки наверху шага 5: формулы каждой, накопленные затраты по годам, что
   может сдвинуть вывод и все показатели рядом. Раньше это был отдельный блок "Без роботов, покупка
   или аренда" с теми же тремя числами, что на карточках; теперь сравнение одно, а его прозрачность
   свернута прямо под ним. Все суммы посчитал сервер */
export function CardsHow({ result, onSources }: { result: CalculationResult; onSources: () => void }) {
  const scenarios = result.scenarios ?? [];
  const purchase = scenarios.find((one) => one.id === "purchase");
  const raas = scenarios.find((one) => one.id === "raas");
  if (scenarios.length < 3 || !purchase || !raas) return null;
  const horizon = result.horizon_years;
  const sources = result.sources ?? [];
  const weak = result.weak_value_paths ?? [];
  const financed = purchase.financing != null && purchase.financing.method !== "own";
  const risks = [...new Set([purchase, raas].flatMap((one) => one.verdict?.risks ?? []))];
  const columns = scenarios.map((s) => ({ name: scenarioWord(s), tone: TONES[s.id] ?? "now" }));
  const dash = (s: ScenarioResult, value: string) => (s.id === "baseline" ? "—" : value);

  return (
    <Fold id="scenarios" title="Как посчитаны карточки: формулы, график по годам, все показатели">
      <p className="u-cards-how-note">
        Крупно на карточках все расходы за {horizon} лет, в экономике это называют стоимостью владения (TCO): вложения,
        люди, операторы, обслуживание. Без роботов это только зарплаты людей на операции. На расчете держится значений:{" "}
        <span className="mono">{sources.length}</span>, без подтвержденного источника:{" "}
        <span className="mono">{weak.length}</span>.{" "}
        <a href="#sources" onClick={onSources}>
          Все значения и источники
        </a>
      </p>
      <div className="u-cards-how">
        {scenarios.map((s) => (
          <div key={s.id} className={`u-cards-how-col is-${TONES[s.id] ?? "now"}`}>
            <h3>
              <i aria-hidden="true" />
              {scenarioWord(s)}
            </h3>
            {s.id === "baseline" ? (
              <Formula
                words={`люди на операции за ${horizon} лет, зарплаты растут каждый год`}
                numbers={`${mln(s.years[0]?.staff_cost_rub ?? 0)} в первый год → ${mln(s.tco_rub)} за ${horizon} лет, млн ₽`}
              />
            ) : (
              <>
                <Formula
                  words={`все расходы за ${horizon} лет = вложения на старте + расходы за ${horizon} лет`}
                  numbers={`${mln(s.tco_rub)} = ${mln(s.investment_year0_rub)} + ${mln(s.running_cost_rub ?? 0)} млн ₽`}
                />
                <Formula
                  words="окупаемость = вложения / экономия первого года, так ее считает ТЗ"
                  numbers={`${mln(s.investment_year0_rub)} / ${mln(s.annual_effect_year1_rub ?? 0)} млн ₽ = ${term(s.payback_simple_years)}`}
                />
              </>
            )}
          </div>
        ))}
      </div>

      <div className="u-money-row">
        <div className="u-panel">
          <h3>
            Накопленные затраты<span>сколько всего потрачено к концу каждого года</span>
          </h3>
          <CostChart
            unit="млн ₽"
            scale={1_000_000}
            format={mln}
            series={scenarios.map((s) => ({
              tone: TONES[s.id] ?? "now",
              name: scenarioWord(s),
              points: s.cumulative_cost_rub ?? [],
            }))}
          />
        </div>
        <div className="u-panel">
          <h3>Что может сдвинуть вывод</h3>
          <ul className="u-risks">
            {risks.map((risk) => {
              const [head, ...rest] = risk.split(": ");
              return (
                <li key={risk}>
                  {rest.length > 0 ? (
                    <>
                      <b>{head}</b>
                      {rest.join(": ")}
                    </>
                  ) : (
                    risk
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <Fold title="Все показатели сценариев">
        <Compare
          columns={columns}
          rows={[
            { label: "Вложения на старте", cells: scenarios.map((s) => money(s.investment_year0_rub)) },
            {
              label: "Экономия в год",
              hint: "первый год, против работы без роботов",
              cells: scenarios.map((s) => dash(s, money(s.annual_effect_year1_rub))),
            },
            {
              label: "Окупаемость простая",
              hint: "вложения / экономия первого года, так считает ТЗ",
              cells: scenarios.map((s) => dash(s, term(s.payback_simple_years))),
            },
            {
              label: "Окупаемость с ростом цен",
              hint: "главная цифра наверху: год за годом, с ростом зарплат и цен",
              cells: scenarios.map((s) => dash(s, term(s.payback_cumulative_years))),
            },
            {
              label: "Заработали сверх вложений, ROI",
              hint: "сколько заработали сверх вложений: 0% значит, что вложения только вернулись",
              cells: scenarios.map((s) => dash(s, percent(s.roi_net))),
            },
            {
              label: "Экономия на рубль вложений",
              hint: "ROI по формуле ТЗ: экономия / вложения, 1 раз значит, что вложения только вернулись",
              cells: scenarios.map((s) => dash(s, times(s.roi_tz))),
            },
            { label: `Все расходы за ${horizon} лет`, cells: scenarios.map((s) => money(s.tco_rub)) },
            {
              label: "Выгода в сегодняшних деньгах, NPV",
              hint: "рубль через год стоит меньше сегодняшнего: экономию каждого года пересчитали на сегодня и вычли вложения. Больше нуля, значит выгодно",
              cells: scenarios.map((s) => money(s.npv_rub)),
            },
            {
              label: "Доходность вложений, IRR",
              hint: "под какой процент в год работают вложения: если выше ставки вклада или кредита, роботы выгоднее. Выше 100% вложения возвращаются быстрее года",
              cells: scenarios.map((s) =>
                dash(
                  s,
                  s.financing && s.financing.method !== "own"
                    ? irrText(s.financing.plain_irr, s.financing.plain_npv_rub, s.capex_after_grant_rub ?? 0)
                    : irrText(s.irr, s.npv_rub, s.investment_year0_rub),
                ),
              ),
            },
            ...(financed
              ? [
                  {
                    label: "IRR своих денег",
                    hint: "от первого взноса, с платежами по долгу: при маленьком взносе всегда высокий",
                    cells: scenarios.map((s) =>
                      dash(s, s.id === "purchase" ? irrText(s.irr, s.npv_rub, s.investment_year0_rub) : "без долга"),
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Fold>
    </Fold>
  );
}
