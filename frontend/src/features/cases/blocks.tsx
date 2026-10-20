import type { ScenarioResult } from "../../api/client";
import { aboutYears, laterNote, mln, term } from "../../app/format";
import { buyoutText } from "../../app/steps/economicsNames";
import { DRAFT_KEY, draftOf, draftTitle } from "../../app/saving";
import { ask, BlockHead, Button } from "../../ui";
import type { CaseData } from "./load";
import { payRows, type PayRow } from "./payments";
import { caseDraft, WIZARD_URL } from "./start";
import { verdictOf } from "./verdict";

function verdictFor(data: CaseData, robotName: string) {
  const purchase = (data.result.scenarios ?? []).find((one) => one.id === "purchase");
  if (!purchase || !data.result.sizing) return null;
  return verdictOf(
    { robotName, horizon: data.result.horizon_years, sizing: data.result.sizing, purchase },
    { mln, term },
  );
}

/* Аренда как найм: выгодна ли она людей с первого года, а не "окупаемость" */
function rentNote(first: number | null | undefined): string {
  if (first == null) return "";
  return first > 0 ? "аренда выгоднее людей с 1 года" : "аренда дороже людей";
}

/* Три коротких абзаца: откуда окупаемость, что остается людям, что может сдвинуть вывод */
export function Why({ data, robotName }: { data: CaseData; robotName: string }) {
  const verdict = verdictFor(data, robotName);
  if (!verdict) return null;
  return (
    <div className="k-why">
      {verdict.parts.map((part) => (
        <div key={part.title}>
          <h3>{part.title}</h3>
          <p>{part.text}</p>
        </div>
      ))}
    </div>
  );
}

/* Свои деньги, кредит, лизинг и аренда рядом: что дешевле за горизонт, что легче на старте */
export function Payments({ data }: { data: CaseData }) {
  const scenarios = data.result.scenarios ?? [];
  const find = (id: string): ScenarioResult | undefined => scenarios.find((one) => one.id === id);
  const baseline = find("baseline");
  const horizon = data.result.horizon_years;
  const rows = payRows(
    { own: find("purchase"), loan: data.financing?.loan, leasing: data.financing?.leasing, raas: find("raas") },
    horizon,
  );
  if (rows.length < 2 || !baseline) return null;
  const buyout = find("raas")?.buyout;
  const scale = Math.max(baseline.tco_rub, ...rows.map((row) => row.tco));
  return (
    <section className="k-block">
      <BlockHead
        title="Как платить за тех же роботов"
        note={`Все расходы за ${horizon} лет: вложения, люди, операторы, обслуживание. Без роботов за ${horizon} лет уйдет ${mln(baseline.tco_rub)} млн ₽`}
      />
      <div className="k-pay">
        {rows.map((row) => (
          <PayCard key={row.id} row={row} scale={scale} horizon={horizon} />
        ))}
      </div>
      {buyout && <p className="k-pay-note">{buyoutText(buyout)}</p>}
    </section>
  );
}

/* warn: строка под отметками, например что на старте больше бюджета (шаг экономики мастера) */
export function PayCard({ row, scale, horizon, warn }: { row: PayRow; scale: number; horizon: number; warn?: string }) {
  const best = row.badges.some((badge) => badge.startsWith("дешевле"));
  return (
    <article className={best ? `k-pay-card is-${row.tone} is-best` : `k-pay-card is-${row.tone}`}>
      <header>
        <i aria-hidden="true" />
        <h3>{row.name}</h3>
      </header>
      <p className="k-pay-note">{row.note}</p>
      <p className="k-pay-badges">{row.badges.join(", ") || " "}</p>
      {warn && <p className="k-pay-warn">{warn}</p>}
      <dl>
        <div>
          <dt>своих денег на старте</dt>
          <dd>
            <span className="mono">{mln(row.start)}</span>
            <small>млн ₽</small>
          </dd>
        </div>
        {row.id === "raas" ? (
          <div>
            <dt>против людей</dt>
            <dd>
              <span className="mono">{rentNote(row.first)}</span>
            </dd>
          </div>
        ) : (
          <div>
            <dt>окупаемость</dt>
            <dd>
              {/* как везде (format.paybackPhrase): дольше горизонта примерно и мелко пометка */}
              <span className="mono">
                {row.payback !== null
                  ? term(row.payback)
                  : row.later !== null
                    ? `примерно ${aboutYears(row.later, horizon)}`
                    : "нет"}
              </span>
              {row.payback === null && row.later !== null && <small>{laterNote(horizon)}</small>}
            </dd>
          </div>
        )}
        <div>
          <dt>все расходы за {horizon} лет</dt>
          <dd>
            <span className="mono">{mln(row.tco)}</span>
            <small>млн ₽</small>
          </dd>
        </div>
      </dl>
      <span className="k-pay-bar" aria-hidden="true">
        <i style={{ width: `${Math.round((row.tco / scale) * 100)}%` }} />
      </span>
    </article>
  );
}

/* Начать с этого разбора: мастер откроется на экономике с теми же задачей, решением и планом.
   Несохраненный расчет в браузере пропал бы молча, поэтому сначала спрашиваем, как мастер */
export function StartFromCase({ data }: { data: CaseData }) {
  const start = async () => {
    const draft = draftOf(readDraft());
    if (
      draft &&
      !(await ask({
        title: "Начать с этого разбора?",
        text: `В этом браузере есть несохраненный расчет: ${draftTitle(draft)}. Если начать с разбора, он пропадет.`,
        yes: "Начать с разбора",
        no: "Оставить мой расчет",
        danger: true,
      }))
    )
      return;
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(caseDraft(data.request, data.plan)));
    } catch {
      // без хранилища мастер откроется с чистого листа: значения по умолчанию те же, что в разборе
    }
    window.location.assign(WIZARD_URL);
  };
  return (
    <Button kind="light" onClick={() => void start()}>
      <span>
        Начать с<span className="u-wide"> этого</span> разбора
      </span>
    </Button>
  );
}

function readDraft(): string | null {
  try {
    return window.localStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
}
