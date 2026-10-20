import type { ClinicFinance, ClinicMoney } from "../../api/client";
import { Alert, Answer, Compare, Fold } from "../../ui";
import { mln, number, percent, term } from "../format";
import type { BuyWay, Shown } from "../steps/ScenarioSwitch";
import { LoanFields } from "./ClinicPaymentOptions";

type Scenario = ClinicMoney["scenarios"][number];

export const CLINIC_NAMES: Record<Scenario["id"], string> = {
  baseline: "Без роботов",
  purchase: "Покупка",
  raas: "Аренда",
  loan: "Покупка в кредит",
};

/* Сценарий под переключателем: покупка за свои или в кредит, аренда, без роботов.
   Кредит сервер считает отдельным сценарием loan; пока он не пришел, показываем покупку */
export function clinicScenario(answer: ClinicMoney, shown: Shown, way: BuyWay): Scenario | undefined {
  const find = (id: Scenario["id"]) => answer.scenarios.find((one) => one.id === id);
  if (shown !== "purchase") return find(shown);
  const loan = find("loan");
  return way === "loan" && loan?.available ? loan : find("purchase");
}

const back = (one: Scenario, horizon: number) =>
  one.payback_years == null ? `не за ${horizon} лет` : term(one.payback_years);

/* Нарастающий итог затрат: старт и расходы каждого года */
export function cumulative(one: Scenario): number[] {
  return one.years_rub.reduce((points, value) => [...points, points[points.length - 1] + value], [one.start_rub]);
}

/* Подробности выбранного сценария под переключателем шага итога: суммы сервера, здесь только раскладка.
   Тот же порядок, что у склада: сценарий числами, условия способа оплаты, деньги по годам */
export function ClinicScenarioDetail({
  answer,
  shown,
  way,
  finance,
  onFinanceChange,
}: {
  answer: ClinicMoney;
  shown: Shown;
  way: BuyWay;
  finance: ClinicFinance;
  onFinanceChange: (next: ClinicFinance) => void;
}) {
  const horizon = answer.horizon_years;
  const baseline = answer.scenarios.find((one) => one.id === "baseline");
  const pick = clinicScenario(answer, shown, way);
  if (!baseline || !pick) return null;
  const rate = percent(answer.assumptions.discount_rate ?? 0);
  return (
    <>
      {pick.id === "baseline" && (
        <Answer
          note="Так сейчас: рейсы из аптеки делают санитары, коридоры моют уборщицы. Это база, с ней сравниваются покупка и аренда."
          facts={[
            {
              label: "Часов людей на этой работе",
              value: number(answer.people.manual_hours_per_shift, 1),
              unit: "ч в смену",
            },
            { label: "Зарплаты в первый год", value: mln(baseline.years_rub[0] ?? 0), unit: "млн ₽" },
            { label: `Всего за ${horizon} лет`, value: mln(baseline.tco_rub), unit: "млн ₽" },
          ]}
        />
      )}
      {pick.id === "purchase" && (
        <Answer
          note="Роботы ваши: парк и внедрение на старте, дальше обслуживание и сохраняющаяся зарплата."
          facts={[
            { label: "Вложить на старте", value: mln(pick.start_rub), unit: "млн ₽" },
            { label: "Эффект бюджета в 1-й год", value: mln(pick.effect_year1_rub), unit: "млн ₽" },
            { label: "Окупится", value: back(pick, horizon) },
            { label: `NPV при ставке ${rate}`, value: mln(pick.npv_rub), unit: "млн ₽" },
            {
              label: "С дисконтированием окупится",
              value:
                pick.discounted_payback_years == null ? `не за ${horizon} лет` : term(pick.discounted_payback_years),
            },
          ]}
        />
      )}
      {pick.id === "loan" && pick.financing && (
        <>
          <Answer
            note={`Кредит на оборудование, внедрение своими деньгами. Ставка ${percent(pick.financing.rate)}, срок ${pick.financing.term_months} мес.: сценарные условия, не предложение банка.`}
            facts={[
              { label: "Своих денег на старте", value: mln(pick.start_rub), unit: "млн ₽" },
              { label: "Взято в кредит", value: mln(pick.financing.principal_rub), unit: "млн ₽" },
              {
                label: "Платеж в месяц, первый и последний",
                value: `${number(pick.financing.first_month_rub, 0)} и ${number(pick.financing.last_month_rub, 0)}`,
                unit: "₽",
              },
              { label: `Проценты за ${horizon} лет`, value: mln(pick.financing.interest_rub), unit: "млн ₽" },
              { label: "Окупится с учетом долга", value: back(pick, horizon) },
            ]}
          />
          <Fold title="Условия кредита">
            <LoanFields finance={finance} onChange={onFinanceChange} />
          </Fold>
        </>
      )}
      {shown === "purchase" && way === "loan" && pick.id !== "loan" && (
        <Alert tone="note">Пересчитываем покупку в кредит: пока на экране покупка за свои деньги.</Alert>
      )}
      {pick.id === "raas" &&
        (pick.available ? (
          <Answer
            note={
              pick.rent_period === "year"
                ? "Годовая оплата: дешевле помесячной на этом горизонте. Внедрение и сохраняющаяся зарплата учтены."
                : "Помесячная оплата, ремонт на поставщике, роботы не ваши. Внедрение и сохраняющаяся зарплата учтены."
            }
            facts={[
              { label: "Внедрение и аванс на старте", value: mln(pick.start_rub), unit: "млн ₽" },
              {
                label: pick.rent_period === "year" ? "Платеж в год" : "Платеж в месяц",
                value: mln((pick.month_rub ?? 0) * (pick.rent_period === "year" ? 12 : 1)),
                unit: "млн ₽",
              },
              { label: "Эффект в 1-й год без аванса", value: mln(pick.effect_year1_rub), unit: "млн ₽" },
              { label: "Окупится", value: back(pick, horizon) },
            ]}
          />
        ) : (
          <Alert tone="note">
            {pick.why_not}. Отсутствие опубликованного тарифа не означает бесплатную аренду: спросите тариф у
            поставщика, его можно ввести в условиях расчета ниже.
          </Alert>
        ))}
      {pick.available && <Years pick={pick} baseline={baseline} />}
    </>
  );
}

function Years({ pick, baseline }: { pick: Scenario; baseline: Scenario }) {
  const own = cumulative(pick);
  const base = cumulative(baseline);
  return (
    <Fold id="clinic-years" title={`${CLINIC_NAMES[pick.id]}: деньги по годам`}>
      <Compare
        columns={[{ name: "старт" }, ...pick.years_rub.map((_, index) => ({ name: `${index + 1} год` }))]}
        rows={[
          {
            label: "Расходы года",
            hint: "на старте вложения, дальше все расходы года",
            cells: [pick.start_rub, ...pick.years_rub].map(mln),
          },
          { label: "Накопленные затраты", hint: "сколько всего потрачено к концу года", cells: own.map(mln) },
          ...(pick.id === "baseline"
            ? []
            : [{ label: "Без роботов, накопленные", hint: "для сравнения", cells: base.map(mln) }]),
        ]}
      />
      <p className="u-frow-hint">
        Все суммы в миллионах рублей, годы целиком: вложения на старте, расходы в конце года.
      </p>
    </Fold>
  );
}
