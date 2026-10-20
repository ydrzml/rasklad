import type { ScenarioResult } from "../../api/client";
import { mln, term } from "../../app/format";
import { buyoutText, CAPEX_NAMES, OPEX_NAMES } from "../../app/steps/economicsNames";
import { BlockHead, CostChart, Fold, Panel, type Tone } from "../../ui";

// Три сценария по ТЗ: что платим на старте, в первый год и позже. Суммы и статьи из ответа сервера,
// здесь их только раскладываем по карточкам. Названия как на шаге экономики: Аренда это роботы как услуга

export const NAMES: Record<string, string> = { baseline: "Без роботов", purchase: "Покупка", raas: "Аренда" };
export const TONES: Record<string, Tone> = { baseline: "now", purchase: "buy", raas: "rent" };

const ROLE: Record<string, string> = {
  baseline: "Люди делают работу сами, как сейчас. С этим вариантом сравниваем оба других.",
  purchase: "Платим за роботов сразу. Дальше обслуживание, энергия, лицензии и операторы.",
  raas: "Роботы как услуга, как найм: плата за робота в месяц, в ней ТО и ремонт. Роботы не ваши, по окончании договора аренда продлевается, выкуп по желанию.",
};

type Line = { key: string; name: string; rub: number };

const nonzero = (lines: Line[]) => lines.filter((line) => line.rub > 0);

function Lines({ lines }: { lines: Line[] }) {
  return (
    <dl className="e-lines">
      {lines.map((line) => (
        <div key={line.key}>
          <dt>{line.name}</dt>
          <dd className="mono">{mln(line.rub)}</dd>
        </div>
      ))}
    </dl>
  );
}

function later(scenario: ScenarioResult): string[] {
  const out: string[] = [];
  scenario.years.forEach((row) => {
    if (row.opex_rub.battery > 0) out.push(`${row.year} год: замена аккумуляторов, ${mln(row.opex_rub.battery)} млн ₽`);
    if (row.investment_rub > 0)
      out.push(
        scenario.id === "raas"
          ? `${row.year} год: выкуп роботов по остаточной стоимости, ${mln(row.investment_rub)} млн ₽. Дальше затраты как при покупке`
          : `${row.year} год: обновление парка, ${mln(row.investment_rub)} млн ₽`,
      );
  });
  if (scenario.id === "baseline") out.push("Затраты на людей растут каждый год вместе с зарплатами");
  if (scenario.id === "raas" && scenario.buyout) out.push(buyoutText(scenario.buyout));
  return out;
}

function ScenarioCard({ scenario }: { scenario: ScenarioResult }) {
  const first = scenario.years[0];
  const capex = nonzero(
    Object.entries(scenario.capex_rub).map(([key, rub]) => ({ key, name: CAPEX_NAMES[key] ?? key, rub })),
  );
  const year1 = first
    ? nonzero([
        {
          key: "staff",
          name: first.ramp_rub > 0 ? "Люди, пока роботы выходят на режим" : "Люди на операции",
          rub: first.staff_cost_rub,
        },
        ...Object.entries(first.opex_rub).map(([key, rub]) => ({ key, name: OPEX_NAMES[key] ?? key, rub })),
      ])
    : [];
  const after = later(scenario);
  return (
    <article className={`e-scen is-${TONES[scenario.id] ?? "now"}`}>
      <header>
        <i className="u-scenario-key" aria-hidden="true" />
        <h3>{NAMES[scenario.id] ?? scenario.name}</h3>
      </header>
      <p className="e-scen-role">{ROLE[scenario.id]}</p>

      <div className="e-scen-part">
        <h4>
          На старте <span className="mono">{mln(scenario.investment_year0_rub)} млн ₽</span>
        </h4>
        {capex.length ? <Lines lines={capex} /> : <p className="e-muted">Вложений нет</p>}
      </div>

      <div className="e-scen-part">
        <h4>Первый год, млн ₽</h4>
        <Lines lines={year1} />
        {scenario.annual_effect_year1_rub !== null && (
          <p className="e-scen-effect">
            Экономия против варианта без роботов{" "}
            <span className="mono">{mln(scenario.annual_effect_year1_rub)} млн ₽</span>
          </p>
        )}
      </div>

      {after.length > 0 && (
        <div className="e-scen-part">
          <h4>Позже</h4>
          <ul className="e-after">
            {after.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function YearTable({ scenarios }: { scenarios: ScenarioResult[] }) {
  const baseline = scenarios.find((one) => one.id === "baseline");
  const robots = scenarios.filter((one) => one.id !== "baseline");
  const years = baseline?.years ?? [];
  const sign = (value: number) => (value < 0 ? `-${mln(-value)}` : mln(value));
  return (
    <div className="e-table-wrap">
      <table className="e-table">
        <caption>Деньги по годам, млн ₽</caption>
        <thead>
          <tr>
            <th scope="col">Год</th>
            <th scope="col">Без роботов: люди</th>
            {robots.map((one) => (
              <th key={one.id} scope="col">
                {NAMES[one.id] ?? one.name}: экономия минус вложения
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">старт</th>
            <td className="mono">0,0</td>
            {robots.map((one) => (
              <td key={one.id} className="mono">
                {sign(-one.investment_year0_rub)}
              </td>
            ))}
          </tr>
          {years.map((row, index) => (
            <tr key={row.year}>
              <th scope="row">{row.year}</th>
              <td className="mono">{mln(row.staff_cost_rub)}</td>
              {robots.map((one) => (
                <td key={one.id} className="mono">
                  {sign(one.years[index]?.cash_flow_rub ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScenarioMoney({ scenarios, years }: { scenarios: ScenarioResult[]; years: string }) {
  const marks = scenarios
    .filter((one) => one.id !== "baseline" && one.payback_cumulative_years !== null)
    .map((one) => ({
      tone: TONES[one.id] ?? "buy",
      at: one.payback_cumulative_years ?? 0,
      label: term(one.payback_cumulative_years),
    }));
  return (
    <section id="scenarios" className="e-section">
      <BlockHead title="Три сценария" note="что платим на старте, в первый год и позже" />
      <div className="e-scens">
        {scenarios.map((one) => (
          <ScenarioCard key={one.id} scenario={one} />
        ))}
      </div>

      <Panel>
        <div className="e-body">
          <h3 className="e-subhead">Сколько заплачено к концу каждого года</h3>
          <CostChart
            unit="млн ₽"
            scale={1_000_000}
            format={mln}
            marks={marks}
            series={scenarios.map((one) => ({
              tone: TONES[one.id] ?? "now",
              name: NAMES[one.id] ?? one.name,
              points: one.cumulative_cost_rub ?? [],
            }))}
          />
          <p className="e-text">
            Линия растет на все, что заплачено за год: люди, роботы, вложения. Где линия сценария пересекает серую линию
            без роботов, сэкономленное вернуло вложения. Это и есть окупаемость, точка на линии. Последняя точка справа
            это стоимость владения за {years}.
          </p>
          <Fold title="по годам числами">
            <YearTable scenarios={scenarios} />
            <p className="e-text">
              Экономия года это затраты на людей без роботов минус люди, которые остались, и все затраты на роботов.
              Минус вложения этого года: на старте, выкуп, обновление парка.
            </p>
          </Fold>
        </div>
      </Panel>
    </section>
  );
}
