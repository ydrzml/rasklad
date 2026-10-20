import { useState } from "react";

import { Arrow } from "../../ui";
import { PlanSketch, type SketchPlan } from "../home/PlanSketch";
import { CASES, type DemoCase } from "./demoCases";
import { useCase } from "./load";
import { briefOf, CasesHeader, chargersText, OwnObject } from "./parts";
import { peopleOf, plural } from "./verdict";
import { aboutYears, laterNote, mln, number, term } from "../../app/format";

/* /cases: три разбора карточками. Карточка целиком ссылка на разбор, цифры на ней считает сервер */
/* Строка над карточками меняется три раза за пять секунд и останавливается на последней: что такое
   разбор и что пройти для своего склада. Ничего не ждет и не закрывает, карточки видны сразу */
const LEAD = [
  "Три реальных склада, посчитанных сервисом на их цифрах. Рядом то, что у них вышло по факту",
  "В каждом разборе парк роботов, вложения, срок окупаемости и смена на плане",
  "Для своего склада пять шагов: объект, задачи, план, решение, экономика. Значения уже стоят",
];

/* /cases: три разбора карточками. Карточка целиком ссылка на разбор, цифры на ней считает сервер */
export function CaseList() {
  return (
    <div className="u-page">
      <CasesHeader />
      <main className="u-main u-wrap k-page">
        <header className="k-title k-list-title">
          <h1>Готовые разборы</h1>
          <p className="k-lead">
            {LEAD.map((line, i) => (
              <span key={line} style={{ ["--i" as string]: i }}>
                {line}
              </span>
            ))}
          </p>
        </header>
        <div className="k-cards">
          {CASES.map((one, index) => (
            <CaseCard key={one.id} one={one} index={index} />
          ))}
        </div>
        <OwnObject />
      </main>
    </div>
  );
}

export function CaseCard({ one, index }: { one: DemoCase; index: number }) {
  const [attempt, setAttempt] = useState(0);
  const { data, failed } = useCase(one, attempt);
  const brief = data ? briefOf(data.result) : null;
  const horizon = data?.result.horizon_years ?? 5;
  return (
    <article className="k-card" aria-busy={!data && !failed}>
      <a className="k-card-link" href={`/cases/${one.id}`} aria-label={`Открыть разбор: ${one.title}`} />
      <div className="k-card-sheet">
        <span className="k-card-idx mono">{String(index + 1).padStart(2, "0")}</span>
        {data ? (
          <PlanSketch plan={data.plan as SketchPlan} title={`План склада: ${one.title.toLowerCase()}`} />
        ) : (
          <span className="k-card-wait">{failed ? "план не построился" : "строим план"}</span>
        )}
      </div>
      <div className="k-card-body">
        <h2>{one.title}</h2>
        <p className="k-card-about">{one.about}</p>
        <p className="k-card-robot">{one.robotName}</p>
        <p className="k-card-twin">
          Повторяем {one.twin.place}: {one.twin.given}. У них: {one.twin.fact}.<small>{one.twin.link.site}</small>
        </p>
        {failed ? (
          <p className="k-card-fail">
            Сервер не ответил.{" "}
            <button type="button" className="k-retry" onClick={() => setAttempt(attempt + 1)}>
              Посчитать еще раз
            </button>
          </p>
        ) : (
          <dl className="k-card-facts">
            <div>
              <dt>роботов</dt>
              <dd>
                <span className="mono">{brief ? brief.fleet : "…"}</span>
                {brief && <small>{chargersText(brief.chargers)}</small>}
              </dd>
            </div>
            <div>
              <dt>на старте, покупка</dt>
              <dd>
                <span className="mono">{brief ? mln(brief.purchase.investment_year0_rub) : "…"}</span>
                {brief && <small>млн ₽</small>}
              </dd>
            </div>
            <div>
              <dt>окупаемость покупки</dt>
              <dd>
                <Payback
                  years={brief?.purchase.payback_cumulative_years}
                  later={brief?.purchase.payback_later_years}
                  brief={brief != null}
                  horizon={horizon}
                />
              </dd>
            </div>
            <div>
              <dt>окупаемость аренды</dt>
              <dd>
                <Payback
                  years={brief?.raas.payback_cumulative_years}
                  later={brief?.raas.payback_later_years}
                  brief={brief != null}
                  horizon={horizon}
                />
              </dd>
            </div>
          </dl>
        )}
        {brief &&
          brief.purchase.payback_cumulative_years == null &&
          brief.purchase.payback_later_years == null &&
          data?.result.sizing && (
            <p className="k-card-why">{noPaybackText(data.result.sizing, data.result.payback_needs ?? [])}</p>
          )}
        <span className="k-card-go" aria-hidden="true">
          Открыть разбор <Arrow size={13} />
        </span>
      </div>
    </article>
  );
}

/* Срок окупаемости на карточке, как везде (format.paybackPhrase). "Окупаемость аренды: не окупается"
   читалось масло масляное: пишем "нет". Дольше горизонта примерно целыми годами и мелко пометка */
function Payback({
  years,
  later,
  brief,
  horizon,
}: {
  years: number | null | undefined;
  later: number | null | undefined;
  brief: boolean;
  horizon: number;
}) {
  if (!brief) return <span className="mono">…</span>;
  if (years == null && later != null)
    return (
      <>
        <span className="mono">примерно {aboutYears(later, horizon)}</span>
        <small>{laterNote(horizon)}</small>
      </>
    );
  if (years == null) return <span className="mono">нет</span>;
  return <span className="mono">{term(years)}</span>;
}

/* Почему покупка не окупается. Работы мало: сэкономить роботу не на чем. Работы много, но часть людей
   остается: экономии не хватает. Людей после роботов то же число, что в разборе (вместе с присмотром).
   Обещание "окупится, если" только при пороге от сервера */
function noPaybackText(sizing: Parameters<typeof peopleOf>[0], needs: { text: string }[]): string {
  const fte = sizing.fte_before;
  const { before, after } = peopleOf(sizing);
  const reason =
    fte < 2
      ? `Сейчас на этой работе ${number(fte, 1)} ${fte === 1 ? "ставка" : "ставки"}, сэкономить роботу почти не на чем`
      : `После роботов на этой работе остается ${after} из ${before} ${plural(before, "ставки", "ставок", "ставок")} вместе с присмотром: ` +
        "экономии не хватает вернуть вложения";
  return needs.length ? `${reason}. Окупится, если ${needs[0].text}` : reason;
}
