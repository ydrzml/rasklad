import type { ReactNode } from "react";

import type { CalculationResult, ScenarioResult } from "../../api/client";
import { Alert, Answer, BlockHead, Fold, Ledger, LedgerColumn, MoreLink, Pill, TextButton } from "../../ui";
import { aboutYears, laterNote, mln, term } from "../format";
import { heads, peopleWord, watchWords } from "../heads";
import { Plausibility, PlausibilitySources } from "./Plausibility";
import {
  buyoutText,
  CAPEX_NAMES,
  mln2,
  OPEX_NAMES,
  overBudget,
  plural,
  scenarioWord,
  TCO_NAMES,
} from "./economicsNames";

type Props = {
  result: CalculationResult;
  robotName: string;
  /* какой сценарий с роботами раскрыт в сводке: покупка или аренда */
  pick: ScenarioResult;
  choices: ScenarioResult[];
  onPick: (id: string) => void;
  /* бюджет на старте, если клиент его назвал: рядом с вложениями пишем, укладываются ли они */
  budget?: number | null;
  /* покупка не влезает в бюджет: ссылки из строки над ответом. Аренда открывает аренду,
     кредит ставит способ оплаты «Кредит». Без onLoan (расчет по ссылке) ссылки на кредит нет */
  onRent?: () => void;
  onLoan?: () => void;
  /* служебные строки под ответом (отбор по робозоне), уходят в свернутые оговорки */
  aside?: ReactNode;
  /* подробности под карточкой итога: карточка и есть выбор, заголовок и бюджет у итога */
  inline?: boolean;
};

/* Коротко наверху шага: один главный ответ, окупится ли и насколько дешевле, и строка из четырех
   чисел со ссылками вниз, к статьям. Переключатель покупка или аренда меняет ответ.
   Все суммы посчитал сервер, здесь только раскладываем их по местам */
export function EconomicsSummary({
  result,
  robotName,
  pick,
  choices,
  onPick,
  budget,
  onRent,
  onLoan,
  aside,
  inline = false,
}: Props) {
  const sizing = result.sizing;
  const baseline = (result.scenarios ?? []).find((one) => one.id === "baseline");
  if (!sizing || !baseline) return null;
  const horizon = result.horizon_years;
  const rented = pick.id === "raas";
  const fleetWord = plural(sizing.fleet, "робот", "робота", "роботов");
  // задач несколько: парк складывается из парков задач, у каждой свой спрос в своих единицах
  const parts = (result.tasks ?? []).length > 1 ? (result.tasks ?? []) : [];
  const lineup = parts.map((task) => task.sizing.fleet).join(" + ");
  const taskCount = new Set(parts.map((task) => task.operation_id)).size;
  const pickingOnly = parts.length
    ? parts.every((task) => task.operation_id === "piece_picking")
    : result.operation_id === "piece_picking";
  const financed = pick.financing != null && pick.financing.method !== "own";
  // открыта покупка, и она не влезает в бюджет: говорим строкой над ответом, куда повернуть
  const over = !inline && budget != null && pick.id === "purchase" && overBudget(pick, budget);
  // за горизонт не окупается: сервер досчитал на более долгий срок, говорим, на каком году вернутся вложения
  const later = pick.payback_cumulative_years == null ? result.later_horizon_years : null;
  // упаковщики у станций отбора одни и те же до роботов и после: пишем рядом, в разницу не входят
  const packers = sizing.packing_per_shift ?? 0;
  const needs = pick.id === "purchase" && pick.payback_cumulative_years == null ? (result.payback_needs ?? []) : [];

  return (
    <section id="summary" className={inline ? "u-summary is-inline" : "u-summary"}>
      {!inline && (
        <BlockHead
          title={"Ответ"}
          note={
            parts.length
              ? `${scenarioWord(pick)}, ${taskCount > 1 ? `${taskCount} задачи` : "смешанный парк"}: ${sizing.fleet} ${fleetWord} (${lineup}), ${rented ? "платеж в месяц, роботы не ваши" : "дальше обслуживание и операторы"}`
              : rented
                ? `Аренда: ${sizing.fleet} ${fleetWord} ${robotName} за плату в месяц, роботы не ваши, выкуп по желанию`
                : `${scenarioWord(pick)}: ${sizing.fleet} ${fleetWord} ${robotName} ваши, дальше обслуживание и операторы`
          }
          aside={
            choices.length > 1 &&
            choices.map((one) => (
              <Pill key={one.id} active={one.id === pick.id} onClick={() => onPick(one.id)}>
                {one.id === "raas" ? "Аренда" : "Покупка"}
              </Pill>
            ))
          }
        />
      )}
      {over && (
        <div className="u-summary-over">
          <Alert>
            Ваш бюджет {mln(budget ?? 0)} млн ₽,{" "}
            {financed ? "свои деньги на старте в него не укладываются" : "покупка не укладывается"}: можно взять{" "}
            {onRent ? <TextButton onClick={onRent}>аренду</TextButton> : "аренду"}
            {onLoan && (
              <>
                {" или "}
                <TextButton onClick={onLoan}>{financed ? "поменять условия оплаты" : "кредит"}</TextButton>
              </>
            )}
          </Alert>
        </div>
      )}
      <Answer
        heading={!inline}
        title={
          inline ? undefined : rented ? (
            rentTitle(pick)
          ) : pick.payback_cumulative_years == null && pick.payback_later_years != null ? (
            <>
              {scenarioWord(pick)} окупится примерно за <b>{aboutYears(pick.payback_later_years, horizon)}</b>
            </>
          ) : pick.payback_cumulative_years == null ? (
            <>{scenarioWord(pick)} не окупается</>
          ) : (
            <>
              {scenarioWord(pick)} окупится за <b>{term(pick.payback_cumulative_years)}</b>
            </>
          )
        }
        note={
          <>
            {rented &&
              (pick.annual_effect_year1_rub ?? 0) > 0 &&
              `Экономия ${mln(pick.annual_effect_year1_rub ?? 0)} млн ₽ в год после платежей` +
                (pick.payback_cumulative_years != null && pick.investment_year0_rub > 0
                  ? `, внедрение ${mln(pick.investment_year0_rub)} млн ₽ вернется за ${term(pick.payback_cumulative_years)}. `
                  : ". ")}
            {/* под карточкой итога разница с людьми уже стоит на самой карточке */}
            {!inline && (
              <>
                За {horizon} лет {(pick.saving_rub ?? 0) >= 0 ? "дешевле" : "дороже"}, чем без роботов, на{" "}
                <b>{mln(Math.abs(pick.saving_rub ?? 0))} млн ₽</b>
              </>
            )}
            {budget && !over && !inline
              ? pick.investment_year0_rub <= budget
                ? financed
                  ? `, свои деньги на старте в бюджет ${mln(budget)} млн ₽ укладываются`
                  : `, в бюджет ${mln(budget)} млн ₽ укладывается`
                : `, вложения больше бюджета ${mln(budget)} млн ₽`
              : ""}
            {/* под карточкой фраза начинается с него: без точки в начале */}
            {later &&
              (inline
                ? laterText(later, pick.payback_later_years, horizon).slice(2)
                : pick.payback_later_years != null
                  ? `. Это ${laterNote(horizon)}`
                  : laterText(later, pick.payback_later_years, horizon))}
          </>
        }
        facts={[
          {
            label: "Роботов",
            value: String(sizing.fleet),
            unit: `${fleetWord}, ${sizing.chargers} ${plural(sizing.chargers, "зарядка", "зарядки", "зарядок")}`,
            more: { href: "#fleet", text: "как подобран парк" },
          },
          {
            label: rented
              ? "Внедрение на старте"
              : pick.financing && pick.financing.method !== "own"
                ? "Свои деньги на старте"
                : "Вложения на старте",
            value: mln(pick.investment_year0_rub),
            unit: "млн ₽",
            more: { href: "#capex", text: "как посчитано" },
          },
          {
            // экономия в минусе: "-0,2" не пишем, говорим, на сколько расходы с роботами выше
            label:
              (pick.annual_effect_year1_rub ?? 0) < 0
                ? "Экономии нет, расходы выше в год"
                : rented
                  ? "Экономия в год после платежей"
                  : "Экономия в год",
            value: mln(Math.abs(pick.annual_effect_year1_rub ?? 0)),
            unit: "млн ₽",
            more: { href: "#opex", text: "как посчитано" },
          },
          {
            // у отбора считаем только ходьбу отборщика к полкам: штат склада больше, это нужно сказать
            label: pickingOnly ? "Людей в смену на ходьбе к полкам" : "Людей в смену",
            // на операции людей целыми, присмотр за роботами словами: 9 роботов это 0,2 человека в смену,
            // часть работы начальника смены, а не отдельный дежурный (docs/calculation.md, раздел 2.2)
            value: `${heads(sizing.people_per_shift_before)} → ${heads(sizing.people_per_shift_after - sizing.operator_posts)}`,
            unit: `${peopleWord(heads(sizing.people_per_shift_after - sizing.operator_posts))}, присмотр за роботами: ${watchWords(sizing.operator_posts)}${packers ? `, на упаковке ${heads(packers)} до и после` : ""}`,
            more: { href: "#tco", text: "что это дает" },
          },
        ]}
      />
      {/* отбор не окупается за горизонт: сервер нашел, при какой одной цифре покупка выйдет в плюс */}
      {needs.length > 0 && (
        <p className="u-summary-note">
          Чтобы покупка окупилась за {horizon} лет, хватит одного из условий: {needs.map((one) => one.text).join("; ")}.
        </p>
      )}
      {/* склад работает не круглосуточно: сколько было бы при работе в 3 смены 365 дней. Это вывод,
          он стоит открыто; сверка одной строкой, служебные оговорки свернуты ниже */}
      {result.round_the_clock && <p className="u-summary-note">{result.round_the_clock.text}.</p>}
      <Plausibility checks={result.plausibility ?? []} scenario={pick.id} />
      <div className="u-summary-more">
        <Fold thin title="Оговорки и источники сверки">
          {rented && pick.buyout && <p className="u-summary-note">{buyoutText(pick.buyout)}</p>}
          {aside}
          <PlausibilitySources checks={result.plausibility ?? []} scenario={pick.id} />
          <p className="u-summary-note">
            Это оценка, а не коммерческое предложение: для проекта нужны замеры на объекте и предложения поставщиков.{" "}
            <a href="/method">Как мы считаем</a>
          </p>
        </Fold>
      </div>
    </section>
  );
}

/* Аренда как найм: главный вопрос не "когда окупится", а "выгоднее ли людей с первого года".
   Окупается тут только внедрение на старте, роботы не наши, платим каждый год */
function rentTitle(pick: ScenarioResult): ReactNode {
  const first = pick.annual_effect_year1_rub ?? 0;
  if (first <= 0) return <>Аренда дороже людей на {mln(-first)} млн ₽ в год</>;
  return (
    <>
      Аренда выгоднее людей <b>с первого года</b>
    </>
  );
}

/* Окупаемость за горизонтом (format.paybackPhrase): дольше горизонта пометка мелко, а если и досчет
   до years лет с заменой роботов по сроку службы не окупается, так и говорим */
function laterText(years: number, payback: number | null | undefined, horizon: number) {
  return payback == null
    ? `. Не окупается и за ${years} лет с заменой роботов по сроку службы`
    : `. Окупится примерно за ${aboutYears(payback, horizon)}, ${laterNote(horizon)}`;
}

/* Куда уходят деньги: статьи на старте, в год и за горизонт. Стоит под сменой на плане,
   к ним ведут ссылки "как посчитано" из главного ответа. children встают под статьями внутри
   секции, поэтому свернутый блок прячет их вместе со статьями (строка выхода на режим) */
export function EconomicsLedger({
  result,
  pick,
  children,
}: {
  result: CalculationResult;
  pick: ScenarioResult;
  children?: ReactNode;
}) {
  const baseline = (result.scenarios ?? []).find((one) => one.id === "baseline");
  if (!baseline) return null;
  const horizon = result.horizon_years;
  const first = pick.years[0];
  const rented = pick.id === "raas";
  const capex = Object.entries(pick.capex_rub).filter(([, value]) => value > 0);
  const opex = Object.entries(first?.opex_rub ?? {}).filter(([, value]) => value > 0);
  const amortization = pick.amortization;
  // сколько вложений на старте взяли в долг: разница между вложениями и своими деньгами
  const financed = (pick.capex_after_grant_rub ?? pick.investment_year0_rub) - pick.investment_year0_rub;

  return (
    <section id="ledger" className="u-summary">
      <BlockHead title="Куда уходят деньги" note={`${scenarioWord(pick)}: на старте, каждый год и за ${horizon} лет`} />
      <Ledger>
        <LedgerColumn
          id="capex"
          title={"Разово на старте"}
          note={"платите один раз до запуска, в экономике это CAPEX"}
          rows={[
            ...capex.map(([item, value]) => ({
              key: item,
              name: CAPEX_NAMES[item] ?? item,
              value: mln2(value),
              hint: item === "reserve" ? "10% от статей выше на непредвиденное" : undefined,
            })),
            ...(pick.grant_rub > 0 ? [{ key: "grant", name: "Господдержка", value: `-${mln2(pick.grant_rub)}` }] : []),
          ]}
          total={{
            name: "Всего на старте, млн ₽",
            value: mln2(pick.capex_after_grant_rub ?? pick.investment_year0_rub),
          }}
          after={
            financed > 0
              ? [
                  {
                    key: "financed",
                    name: pick.financing?.method === "leasing" ? "Берет лизинговая компания" : "Берем в кредит",
                    value: `-${mln2(financed)}`,
                  },
                  { key: "own", name: "Свои деньги на старте", value: mln2(pick.investment_year0_rub) },
                ]
              : []
          }
        />
        <LedgerColumn
          id="opex"
          title={"Каждый год"}
          note={"первый год, дальше растут вместе с зарплатами и ценами. В экономике это OPEX"}
          rows={opex.map(([item, value]) => ({
            key: item,
            name: OPEX_NAMES[item] ?? item,
            value: mln2(value),
            // расходники по легенде организатора это замена АКБ, у нее своя строка
            hint: item === "maintenance" ? "сервис производителя и запчасти, замена АКБ отдельной строкой" : undefined,
          }))}
          total={{
            name: "Расходы на роботов в год, млн ₽",
            value: mln2(first?.opex_total_rub ?? 0),
          }}
          after={[
            ...((first?.staff_cost_rub ?? 0) - (first?.ramp_rub ?? 0) > 0.5
              ? [
                  {
                    key: "staff",
                    name: "Люди, которые остались на операции",
                    value: mln2(first.staff_cost_rub - (first.ramp_rub ?? 0)),
                  },
                ]
              : []),
            ...((first?.ramp_rub ?? 0) > 0
              ? [
                  {
                    key: "ramp",
                    name: "Люди до выхода роботов на режим",
                    hint: "первый год: пока роботы настраиваются, часть людей еще работает. Допущение, правится ниже",
                    value: mln2(first.ramp_rub ?? 0),
                  },
                ]
              : []),
            ...(amortization
              ? [
                  {
                    key: "amortization",
                    name: "Амортизация, для учета",
                    hint:
                      amortization.years == null
                        ? `${amortization.method}: каждая задача на срок своего робота. В затраты не входит, вложения уже учтены на старте`
                        : `${amortization.method}: ${mln2(amortization.base_rub)} / ${amortization.years} ${rented ? "года договора" : `${plural(amortization.years, "год", "года", "лет")} службы`}. В затраты не входит, вложения уже учтены на старте`,
                    value: mln2(amortization.per_year_rub),
                  },
                ]
              : []),
            ...(amortization?.after_buyout_per_year_rub != null
              ? [
                  {
                    key: "buyout",
                    name: "Амортизация после выкупа",
                    hint:
                      amortization.after_buyout_years == null
                        ? `${mln2(amortization.after_buyout_base_rub ?? 0)}, каждая задача на остаток службы своего робота`
                        : `${mln2(amortization.after_buyout_base_rub ?? 0)} / ${amortization.after_buyout_years} ${plural(amortization.after_buyout_years, "год", "года", "лет")}`,
                    value: mln2(amortization.after_buyout_per_year_rub),
                  },
                ]
              : []),
          ]}
        />
        <LedgerColumn
          id="tco"
          title={`За ${horizon} лет`}
          note="все, что уйдет на операцию, вместе с людьми"
          rows={(pick.tco_parts ?? []).map((part) => ({
            key: part.id,
            name:
              part.id === "later" && rented
                ? "Выкуп роботов в конце договора"
                : (TCO_NAMES[part.id] ?? OPEX_NAMES[part.id] ?? part.id),
            value: mln2(part.rub),
          }))}
          total={{
            name: `Все расходы за ${horizon} лет, млн ₽`,
            value: mln2(pick.tco_rub),
          }}
          after={[
            {
              key: "baseline",
              name: `Без роботов за ${horizon} лет`,
              hint: "зарплаты людей на операции, с ростом",
              value: mln2(baseline.tco_rub),
            },
            {
              key: "saving",
              name: (pick.saving_rub ?? 0) >= 0 ? "С роботами дешевле на" : "С роботами дороже на",
              value: mln2(Math.abs(pick.saving_rub ?? 0)),
            },
          ]}
        >
          <MoreLink href="#scenarios" text="Три сценария рядом" />
        </LedgerColumn>
      </Ledger>
      {children}
    </section>
  );
}
