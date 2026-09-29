import type { ReactNode } from "react";

import type { CalculationResult, ScenarioResult } from "../../api/client";
import { Alert, Answer, BlockHead, Ledger, LedgerColumn, MoreLink, Pill, TextButton } from "../../ui";
import { mln, term } from "../format";
import { CAPEX_NAMES, mln2, OPEX_NAMES, overBudget, plural, scenarioWord, TCO_NAMES } from "./economicsNames";

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
  /* строка «Чем платить» над ответом, только у покупки */
  payRow?: ReactNode;
};

/* Коротко наверху шага: один главный ответ, окупится ли и насколько дешевле, и строка из четырех
   чисел со ссылками вниз, к статьям. Переключатель покупка или аренда меняет ответ.
   Все суммы посчитал сервер, здесь только раскладываем их по местам */
export function EconomicsSummary({ result, robotName, pick, choices, onPick, budget, onRent, onLoan, payRow }: Props) {
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
  const financed = pick.financing != null && pick.financing.method !== "own";
  // открыта покупка, и она не влезает в бюджет: говорим строкой над ответом, куда повернуть
  const over = budget != null && pick.id === "purchase" && overBudget(pick, budget);
  // за горизонт не окупается: сервер досчитал на более долгий срок, говорим, на каком году вернутся вложения
  const later = pick.payback_cumulative_years == null ? result.later_horizon_years : null;

  return (
    <section id="summary" className="u-summary" style={{ marginTop: "var(--s-6)" }}>
      <BlockHead
        title="Коротко"
        note={
          parts.length
            ? `${scenarioWord(pick)}, ${taskCount > 1 ? `${taskCount} задачи` : "смешанный парк"}: ${sizing.fleet} ${fleetWord} (${lineup}), ${rented ? "в конце договора выкуп" : "дальше обслуживание и операторы"}`
            : rented
              ? `Аренда: ${sizing.fleet} ${fleetWord} ${robotName} за плату в месяц, в конце договора выкуп`
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
        heading
        title={
          pick.payback_cumulative_years == null ? (
            <>
              {scenarioWord(pick)} не окупается за {horizon} лет
            </>
          ) : (
            <>
              {scenarioWord(pick)} окупится за <b>{term(pick.payback_cumulative_years)}</b>
            </>
          )
        }
        note={
          <>
            За {horizon} лет {(pick.saving_rub ?? 0) >= 0 ? "дешевле" : "дороже"}, чем без роботов, на{" "}
            <b>{mln(Math.abs(pick.saving_rub ?? 0))} млн ₽</b>
            {budget && !over
              ? pick.investment_year0_rub <= budget
                ? financed
                  ? `, свои деньги на старте в бюджет ${mln(budget)} млн ₽ укладываются`
                  : `, в бюджет ${mln(budget)} млн ₽ укладывается`
                : `, вложения больше бюджета ${mln(budget)} млн ₽`
              : ""}
            {later && laterText(later, pick.payback_later_years)}
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
            label: pick.financing && pick.financing.method !== "own" ? "Свои деньги на старте" : "Вложения на старте",
            value: mln(pick.investment_year0_rub),
            unit: "млн ₽",
            more: { href: "#capex", text: "как посчитано" },
          },
          {
            label: "Экономия в год",
            value: mln(pick.annual_effect_year1_rub ?? 0),
            unit: "млн ₽",
            more: { href: "#opex", text: "как посчитано" },
          },
          {
            label: "Людей в смену",
            value: `${heads(sizing.people_per_shift_before)} → ${heads(sizing.people_per_shift_after)}`,
            unit: plural(heads(sizing.people_per_shift_after), "человек", "человека", "человек"),
            more: { href: "#tco", text: "что это дает" },
          },
        ]}
      />
      {pick.id === "purchase" && payRow}
      {/* оговорка рядом с ответом, к которому относится, а не крупно в подвале */}
      <p className="u-summary-note">
        Это оценка, а не коммерческое предложение: для проекта нужны замеры на объекте и предложения поставщиков.{" "}
        <a href="/method">Как мы считаем</a>
      </p>
    </section>
  );
}

/* Людей в смену на экране целыми, с округлением вверх: полчеловека в смену не выйдет.
   Расчет ведется в ставках, 7,5 ставки это 8 человек на смене */
function heads(people: number): number {
  return Math.ceil(people - 1e-9);
}

/* Окупаемость за горизонтом: номер года, в котором накопленная экономия покрыла вложения.
   8,0 года это конец 8-го года, 8,3 уже 9-й год */
function laterText(years: number, payback: number | null | undefined) {
  return payback == null
    ? `. Если считать ${years} лет с заменой изношенных роботов, тоже не окупается`
    : `. Если считать ${years} лет с заменой изношенных роботов, окупится на ${Math.ceil(payback - 1e-9)}-м году`;
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
          title="На старте, CAPEX"
          note="капитальные затраты: разово, до запуска"
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
            name: "Вложения на старте (CAPEX), млн ₽",
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
          title="Каждый год, OPEX"
          note="операционные затраты за первый год, дальше растут вместе с зарплатами и ценами"
          rows={opex.map(([item, value]) => ({
            key: item,
            name: OPEX_NAMES[item] ?? item,
            value: mln2(value),
            // расходники по легенде организатора это замена АКБ, у нее своя строка
            hint: item === "maintenance" ? "сервис производителя и запчасти, замена АКБ отдельной строкой" : undefined,
          }))}
          total={{ name: "Затраты на роботов в год (OPEX), млн ₽", value: mln2(first?.opex_total_rub ?? 0) }}
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
          total={{ name: "Стоимость владения, млн ₽", value: mln2(pick.tco_rub) }}
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
