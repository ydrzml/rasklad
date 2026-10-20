import type { KeyboardEvent, ReactNode } from "react";

import type { CalculationResult, ScenarioResult } from "../../api/client";
import { Answer, TextButton } from "../../ui";
import { aboutYears, mln, term } from "../format";
import { heads, peopleWord } from "../heads";
import { chosen, type Side } from "./chosen";
import type { PayWay } from "./paymentWays";
import type { Purchases } from "./PayWays";
import type { Shown } from "./ScenarioSwitch";
import { YEAR_PLAN_ID } from "./yearPlan";
import "./chosen.css";

const IN_WAY = { loan: "в кредит", leasing: "в лизинг" } as const;
const BUY_NOTES = {
  own: "Роботы ваши: деньги на старте, дальше обслуживание и операторы",
  loan: "Роботы ваши, часть суммы в кредит: на старте свои деньги, дальше платежи банку",
  leasing: "Роботы ваши после лизинга: аванс на старте, дальше платежи лизинговой компании",
} as const;

/* Шаг 5 сверху: вывод одной фразой и три карточки одного вида: без роботов, покупка и аренда.
   Карточки сравнивают сценарии и выбирают, по какому показать все ниже; тот же выбор в полосе
   переключателя (ScenarioSwitch), она липнет к экрану при прокрутке. Покупка считается способом
   оплаты из переключателя: свои деньги, кредит или лизинг. Суммы считает сервер, слова в chosen.ts */
export function ChosenResult({
  result,
  ways,
  byWay,
  budget,
  budgetFrom = null,
  onEdit,
  selected,
  onSelect,
  onRent,
  onLoan,
  how,
  planLink = false,
}: {
  result: CalculationResult;
  /* что отмечено на шаге 4: от этого вывод в заголовке */
  ways: PayWay[];
  /* покупка за свои, в кредит и в лизинг: для бюджета и заголовка "что влезает" */
  byWay: Purchases;
  budget?: number | null;
  /* "готовы вложить от", верхняя граница это budget */
  budgetFrom?: number | null;
  /* вернуться на шаг 4 и поменять покупку, аренду или бюджет */
  onEdit?: () => void;
  /* какая карточка выбрана и как ее сменить: карточки это тот же переключатель */
  selected: Shown;
  onSelect: (id: Shown) => void;
  /* покупка не влезает в бюджет: кнопки в окне бюджета показать аренду или покупку в кредит */
  onRent?: () => void;
  onLoan?: () => void;
  /* как посчитаны карточки: свернуто под ними (CardsHow) */
  how?: ReactNode;
  /* внизу шага есть план на 5 лет: под карточками ссылка к нему (PlanByYears, YEAR_PLAN_ID) */
  planLink?: boolean;
}) {
  const scenarios = result.scenarios ?? [];
  const baseline = scenarios.find((one) => one.id === "baseline");
  const purchase = scenarios.find((one) => one.id === "purchase");
  const raas = scenarios.find((one) => one.id === "raas");
  if (!baseline || !purchase || !raas) return null;
  const wantBuy = ways.includes("own") || ways.includes("loan") || ways.includes("leasing");
  const wantRent = ways.includes("raas");
  const credit = ways.includes("loan") || ways.includes("leasing");
  const horizon = result.horizon_years;
  const fee = raas.years[0]?.opex_rub.raas_fee ?? 0;
  const plan = purchase.financing;
  const way = plan?.method === "loan" || plan?.method === "leasing" ? plan.method : null;
  const side = (one: ScenarioResult, month?: number): Side => ({
    start: one.investment_year0_rub,
    tco: one.tco_rub,
    payback: one.payback_cumulative_years ?? null,
    later: one.payback_later_years ?? null,
    effect: one.annual_effect_year1_rub ?? 0,
    month,
  });
  // в кредит и в лизинг с бюджетом сравниваем всю сумму покупки, а свои деньги говорим отдельно
  const buy: Side = way
    ? {
        ...side(purchase),
        start: purchase.capex_after_grant_rub ?? purchase.investment_year0_rub,
        way,
        own: purchase.investment_year0_rub,
      }
    : side(purchase);
  const view = chosen({
    horizon,
    baselineTco: baseline.tco_rub,
    buy,
    rent: side(raas, fee / 12),
    wantBuy,
    wantRent,
    budget: budget ?? null,
    budgetFrom,
    loanStart: byWay.loan?.financing?.method === "loan" ? byWay.loan.investment_year0_rub : null,
    leasingStart: byWay.leasing?.financing?.method === "leasing" ? byWay.leasing.investment_year0_rub : null,
    credit,
  });
  // стрелки влево и вправо ходят по карточкам, как по вкладкам
  const ids: Shown[] = ["baseline", "purchase", "raas"];
  const tab = (id: Shown) => ({
    id: `card-${id}`,
    selected: selected === id,
    onSelect: () => onSelect(id),
    onKeyDown: (event: KeyboardEvent) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = ids[(ids.indexOf(id) + step + ids.length) % ids.length];
      onSelect(next);
      document.getElementById(`card-${next}`)?.focus();
    },
  });
  const people = result.sizing ? heads(result.sizing.people_per_shift_before) : null;
  // окупаемость как везде (format.paybackPhrase); дольше горизонта пометка мелко под карточкой
  const later = purchase.payback_cumulative_years == null ? (purchase.payback_later_years ?? null) : null;
  const payback = {
    label: "окупится",
    value:
      purchase.payback_cumulative_years != null
        ? term(purchase.payback_cumulative_years)
        : later != null
          ? `примерно за ${aboutYears(later, horizon)}`
          : "нет",
    plain: true,
  };
  // платеж меньше 0,1 млн в тысячах, иначе на экране "0,0 млн"
  const monthRow = (value: number) =>
    value < 100_000
      ? { label: "платеж в месяц", value: `${Math.round(value / 1_000).toLocaleString("ru-RU")} тыс. ₽`, plain: true }
      : { label: "платеж в месяц", value: mln(value) };
  const buyRows = way
    ? [
        { label: "своих денег на старте", value: mln(purchase.investment_year0_rub) },
        monthRow(plan?.month_first_rub ?? 0),
        payback,
      ]
    : [
        { label: "вложить на старте", value: mln(purchase.investment_year0_rub) },
        (purchase.annual_effect_year1_rub ?? 0) < 0
          ? { label: "экономии нет, расходы выше в год", value: mln(-(purchase.annual_effect_year1_rub ?? 0)) }
          : { label: "экономия в год", value: mln(purchase.annual_effect_year1_rub ?? 0) },
        payback,
      ];

  return (
    <section id="chosen" className="u-chosen">
      <h1 className="u-chosen-head">{view.head}</h1>
      <p className="u-chosen-sub">
        {view.sub}
        {onEdit && (
          <>
            {" "}
            <TextButton onClick={onEdit}>Поменять выбор</TextButton>
          </>
        )}
      </p>
      {view.budget && (
        <aside className={`u-chosen-budget is-${view.budget.tone}`}>
          <h3>{view.budget.title}</h3>
          <p>{view.budget.text}</p>
          {/* что поменять, рядом с выводом: сразу показать то, что в бюджет влезает */}
          {view.budget.tone !== "fit" && (onRent || onLoan) && (
            <p className="u-chosen-budget-do">
              {onRent && raas.investment_year0_rub <= (budget ?? Infinity) && (
                <TextButton onClick={onRent}>Показать аренду</TextButton>
              )}
              {onLoan && way !== "loan" && <TextButton onClick={onLoan}>Показать покупку в кредит</TextButton>}
            </p>
          )}
        </aside>
      )}
      <div className="u-chosen-cards" data-count={3} role="tablist" aria-label="Что показать подробно">
        <Card
          {...tab("baseline")}
          tone="now"
          name="Без роботов"
          note="Работу делают люди, это база для сравнения"
          total={baseline.tco_rub}
          horizon={horizon}
          rows={[
            { label: "вложить на старте", value: "не нужно", plain: true },
            { label: "люди на этой работе в год", value: mln(baseline.years[0]?.staff_cost_rub ?? 0) },
            ...(people != null
              ? [{ label: "людей в смену", value: `${people} ${peopleWord(people)}`, plain: true }]
              : []),
          ]}
        />
        <Card
          {...tab("purchase")}
          tone="buy"
          name={way ? `Покупка ${IN_WAY[way]}` : "Покупка"}
          note={BUY_NOTES[way ?? "own"]}
          best={view.best === "buy"}
          rows={buyRows}
          more={later != null ? [`Дольше горизонта расчета в ${horizon} лет`] : []}
          total={purchase.tco_rub}
          gain={baseline.tco_rub - purchase.tco_rub}
          horizon={horizon}
        />
        <Card
          {...tab("raas")}
          tone="rent"
          name="Аренда"
          note="Платеж в месяц, ремонт на поставщике, роботы не ваши"
          best={view.best === "rent"}
          rows={[
            { label: "на старте, подготовка склада", value: mln(raas.investment_year0_rub) },
            monthRow(fee / 12),
            {
              label: "против людей",
              value: (raas.annual_effect_year1_rub ?? 0) > 0 ? "выгоднее с первого года" : "дороже уже в первый год",
              plain: true,
            },
          ]}
          total={raas.tco_rub}
          gain={baseline.tco_rub - raas.tco_rub}
          horizon={horizon}
        />
      </div>
      <p className="u-chosen-under">
        <span>Крупно все расходы за {horizon} лет вместе с людьми: чем меньше, тем выгоднее</span>
        {planLink && (
          <a className="u-chosen-plan" href={`#${YEAR_PLAN_ID}`}>
            План на {horizon} лет, график
          </a>
        )}
      </p>
      {how && <div className="u-chosen-how">{how}</div>}
    </section>
  );
}

type Row = { label: string; value: string; plain?: boolean };

export function Card({
  tone,
  name,
  note,
  rows,
  best = false,
  gain,
  horizon,
  more = [],
  total,
  totalText,
  id,
  selected,
  onSelect,
  onKeyDown,
}: {
  tone: "now" | "buy" | "rent";
  name: string;
  note: string;
  rows: Row[];
  best?: boolean;
  /* крупно у всех карточек одно и то же: сколько уйдет за горизонт, вместе с людьми и вложениями */
  total: number;
  /* суммы нет (у аренды нет тарифа): слова вместо числа */
  totalText?: string;
  horizon: number;
  /* на сколько меньше, чем без роботов, строкой под числом; у "без роботов" нет */
  gain?: number;
  /* строки под карточкой, например кредит и лизинг у покупки */
  more?: string[];
  /* карточка-вкладка итога шага 5: выбрана, сменить; без onSelect обычная карточка */
  id?: string;
  selected?: boolean;
  onSelect?: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}) {
  const tab = onSelect
    ? {
        id,
        role: "tab",
        tabIndex: selected ? 0 : -1,
        "aria-selected": Boolean(selected),
        // подробности выбранной карточки под переключателем шага (Economics.tsx)
        "aria-controls": "step5-detail",
        onClick: onSelect,
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
          onKeyDown?.(event);
        },
      }
    : {};
  return (
    <article
      className={`u-chosen-card is-${tone}${best ? " is-best" : ""}${onSelect ? " is-tab" : ""}${selected ? " is-selected" : ""}`}
      {...tab}
    >
      <header>
        <i aria-hidden="true" />
        <h3>{name}</h3>
        {best && <span className="u-chosen-badge">выгоднее</span>}
      </header>
      <p className="u-chosen-note">{note}</p>
      <p className="u-chosen-total">
        <span>за {horizon} лет уйдет</span>
        {totalText ? (
          <b>{totalText}</b>
        ) : (
          <b className="mono">
            {mln(total)}
            <small> млн ₽</small>
          </b>
        )}
        {totalText ? null : gain === undefined ? (
          <span className="u-chosen-gain">так сейчас: зарплаты людей на этой работе</span>
        ) : (
          <span className={gain >= 0 ? "u-chosen-gain" : "u-chosen-gain is-minus"}>
            на {mln(Math.abs(gain))} млн {gain >= 0 ? "меньше" : "больше"}, чем без роботов
          </span>
        )}
      </p>
      <dl>
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.plain ? undefined : "mono"}>
              {row.value}
              {!row.plain && <small> млн ₽</small>}
            </dd>
          </div>
        ))}
      </dl>
      {more.map((line) => (
        <p key={line} className="u-chosen-more">
          {line}
        </p>
      ))}
      {/* у карточки-вкладки внизу одно и то же место: выбрана она или ее можно показать */}
      {onSelect && (
        <p className="u-chosen-pick" aria-hidden="true">
          {selected ? "Выбрано: все ниже по этой карточке" : "Показать ниже"}
        </p>
      )}
    </article>
  );
}

/* Подробности без роботов: сколько людей на этой работе и во что они обходятся.
   Это база, с ней сравниваются покупка и аренда */
export function BaselineDetail({ result, baseline }: { result: CalculationResult; baseline: ScenarioResult }) {
  const sizing = result.sizing;
  const horizon = result.horizon_years;
  const people = sizing ? heads(sizing.people_per_shift_before) : null;
  return (
    <Answer
      note="Так сейчас: работу делают люди, зарплаты растут каждый год. Это база, с ней сравниваются покупка и аренда."
      facts={[
        ...(people != null ? [{ label: "Людей в смену", value: String(people), unit: peopleWord(people) }] : []),
        { label: "Зарплаты в первый год", value: mln(baseline.years[0]?.staff_cost_rub ?? 0), unit: "млн ₽" },
        { label: `Всего за ${horizon} лет`, value: mln(baseline.tco_rub), unit: "млн ₽" },
      ]}
    />
  );
}
