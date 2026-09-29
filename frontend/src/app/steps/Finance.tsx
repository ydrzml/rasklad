import { useState } from "react";

import type { CalculationResult, ScenarioResult } from "../../api/client";
import { Alert, Button, Check, FieldRow, Fold, Ledger, LedgerColumn, Pill, Slider, Toolbar } from "../../ui";
import { unitText } from "../../ui/digits";
import { TRUST_TITLES, term } from "../format";
import { irrText, mln2 } from "./economicsNames";

type Props = {
  result: CalculationResult;
  purchase: ScenarioResult;
  overrides: Record<string, number>;
  onChange: (path: string, value: number | null) => void;
  readOnly?: boolean;
  /* сервер пересчитывает после правки: числа плиток тихо приглушены, ползунки нет */
  busy?: boolean;
};

const METHODS = [
  { value: 0, id: "own", name: "Свои деньги" },
  { value: 1, id: "loan", name: "Кредит" },
  { value: 2, id: "leasing", name: "Лизинг" },
];

/* Выход на режим: два допущения на вид задачи, без источника. Показываем те, что участвуют в расчете:
   их сервер отдает в списке источников (ramp_up.simple, ramp_up.station) */
export function Ramp({
  result,
  overrides,
  onChange,
}: {
  result: CalculationResult;
  overrides: Record<string, number>;
  onChange: (path: string, value: number | null) => void;
}) {
  const fields = (result.sources ?? []).filter((source) => source.path.startsWith("ramp_up."));
  if (fields.length === 0) return null;
  const purchase = (result.scenarios ?? []).find((one) => one.id === "purchase");
  const lost = purchase?.years[0]?.ramp_rub ?? 0;
  return (
    <Fold title={`Выход на режим: в первый год экономия меньше на ${mln2(lost)} млн ₽`}>
      <p className="u-frow-hint">
        Первые месяцы роботы работают не на полную: маршруты и расписание настраивают по живой работе, и людей отпускают
        не сразу. Помесячных данных не публикует ни один производитель, поэтому это наши допущения. Доля эффекта растет
        от первого месяца до полного ровно.
      </p>
      {fields.map((source) => {
        const share = source.path.endsWith("first_month_share");
        const raw = overrides[source.path] ?? source.value;
        const value = typeof raw === "number" ? raw : 0;
        return (
          <FieldRow
            key={source.path}
            label={source.name || source.path}
            unit={share ? "%" : "мес"}
            value={share ? Math.round(value * 100) : value}
            trust={source.trust}
            trustTitle={`${TRUST_TITLES[source.trust] ?? source.trust}. Источник: ${source.source}`}
            onChange={(next) => onChange(source.path, next === "" ? null : share ? Number(next) / 100 : Number(next))}
          />
        );
      })}
    </Fold>
  );
}

/* Способ оплаты, который выбрал человек. При неверных условиях сервер считает за свои деньги,
   а на экране остается выбранное, чтобы поле с ошибкой было на месте (payment_problems) */
function methodOf(result: CalculationResult, purchase: ScenarioResult, overrides: Record<string, number>) {
  const wrong = (result.payment_problems ?? []).some((one) => one.path.startsWith("financing."));
  const chosen = METHODS.find((one) => one.value === overrides["financing.method"]);
  return (wrong && chosen) || METHODS.find((one) => one.id === purchase.financing?.method) || METHODS[0];
}

const percentText = (share: number) => `${(share * 100).toFixed(1).replace(".", ",")}%`;

/* Чем платить за покупку, строкой над главным ответом, как в калькуляторах банков. Кредит или
   лизинг сразу открывают панель условий: без ставки и срока выбор ничего не говорит */
export function PayRow({
  result,
  purchase,
  overrides,
  onChange,
  readOnly,
  onOpen,
}: Omit<Props, "readOnly"> & { readOnly?: boolean; onOpen: () => void }) {
  const plan = purchase.financing;
  if (!plan) return null;
  const method = methodOf(result, purchase, overrides);
  const own = method.id === "own";
  return (
    <div className="u-pay-row">
      <span className="u-pay-row-label">Чем платить</span>
      {readOnly ? (
        <span>{method.name}</span>
      ) : (
        <span className="u-pay-row-pills" role="group" aria-label="Чем платить за покупку">
          {METHODS.map((one) => (
            <Pill
              key={one.id}
              active={one.id === method.id}
              onClick={() => {
                if (one.id !== method.id) onChange("financing.method", one.value === 0 ? null : one.value);
                if (one.id !== "own") onOpen();
              }}
            >
              {one.name}
            </Pill>
          ))}
        </span>
      )}
      <span className="u-pay-row-note">
        {own ? "все вложения на старте" : `ставка ${percentText(plan.rate)}, ${plan.term_months} мес`}
      </span>
      <Button kind="ghost" arrow onClick={onOpen}>
        Условия и господдержка
      </Button>
    </div>
  );
}

/* Как платить за покупку и какие меры господдержки отмечены. Выбор уходит правкой значений
   (financing.method, subsidies.*.chosen), поэтому сохраняется в проекте вместе с остальными правками.
   Все суммы считает сервер (docs/calculation.md, "Кредит, лизинг и господдержка"), здесь только раскладка */
// Граница сервера (MAX_HORIZON_YEARS * 12 в calculation.py): срок дольше 30 лет не бывает
const MAX_MONTHS = 360;
// Дольше семи лет кредит и лизинг на оборудование мы не нашли: до 5 лет у Европлана и Альфа-Лизинга,
// до 7 у Сбербанк Лизинга и ВТБ Лизинга (источники в config/model.yaml, financing). Считаем, но предупреждаем
const LONGEST_FOUND_MONTHS = 84;

export function Finance({ result, purchase, overrides, onChange, readOnly, busy }: Props) {
  // Срок, которого не бывает (0, 12,5, 400), в расчет не отправляем, а говорим у поля
  const [badMonths, setBadMonths] = useState<string | null>(null);
  const plan = purchase.financing;
  if (!plan) return null;
  const sources = new Map((result.sources ?? []).map((source) => [source.path, source]));
  // Неверные условия оплаты сервер не берет и считает покупку за свои деньги (payment_problems).
  // Блок при этом остается на выбранном способе, чтобы поле с ошибкой было на месте
  const problems = new Map((result.payment_problems ?? []).map((one) => [one.path, one.message]));
  const wrong = [...problems.keys()].some((path) => path.startsWith("financing."));
  const method = methodOf(result, purchase, overrides);
  const own = method.id === "own";
  const lease = method.id === "leasing";
  // платежи и "что это меняет" по тому, как посчитал сервер: при неверных условиях это свои деньги
  const paidOwn = plan.method === "own";
  const paidLease = plan.method === "leasing";
  const valueOf = (path: string) => {
    const value = overrides[path] ?? sources.get(path)?.value;
    return typeof value === "number" ? value : 0;
  };
  const trustOf = (path: string) => sources.get(path)?.trust;
  const titleOf = (path: string) => {
    const source = sources.get(path);
    if (!source) return undefined;
    return `${TRUST_TITLES[source.trust] ?? source.trust}. Источник: ${path in overrides ? "задано вами" : source.source}`;
  };
  // Ползунки как в банковских калькуляторах. Границы срока и ставки с сервера (config/parameters.yaml,
  // раздел financing), платеж и переплату считает сервер. Без границ ползунок идет до предела сервера
  const rateMax = Math.round(plan.rate_max * 100) || 100;
  const termMax = plan.term_max_months || MAX_MONTHS;
  // проценты на экране, доли в модели
  const percentField = (path: string, label: string, hint?: string) => (
    <Slider
      key={path}
      label={label}
      unit="%"
      min={0}
      max={rateMax}
      step={0.5}
      ends={["0%", `${rateMax}%`]}
      value={Math.round(valueOf(path) * 1000) / 10}
      hint={hint}
      warning={problems.get(path)}
      trust={trustOf(path)}
      trustTitle={titleOf(path)}
      onChange={(next) => onChange(path, next === "" ? null : Number(next) / 100)}
    />
  );
  // Сумма в долг в млн ₽. В модели хранится доля своих денег (кредит) или аванса (лизинг):
  // доля = 1 - сумма / что финансируем. Сумма от сервера, principal_rub
  const sumField = (path: string) => {
    const base = plan.base_rub / 1e6;
    return (
      <Slider
        key={path}
        label={lease ? "Сумма лизинга" : "Сумма кредита"}
        unit="млн ₽"
        min={0.1}
        max={Math.round(base * 10) / 10}
        step={0.1}
        ends={["0,1 млн ₽", `${mln2(plan.base_rub)} млн ₽, ${lease ? "без аванса" : "без своих денег"}`]}
        value={Math.round(plan.principal_rub / 1e4) / 100}
        hint={`${lease ? "Аванс" : "Свои деньги"} ${percentText(valueOf(path))}, ${mln2(plan.own_start_rub)} млн ₽ на старте`}
        warning={problems.get(path)}
        trust={trustOf(path)}
        trustTitle={titleOf(path)}
        onChange={(next) => {
          const sum = Number(next);
          if (next === "" || !(base > 0) || !(sum > 0)) return;
          onChange(path, Math.max(0, 1 - sum / base));
        }}
      />
    );
  };
  const monthsField = (path: string) => (
    <Slider
      key={path}
      label="Срок"
      unit="мес"
      min={12}
      max={termMax}
      step={1}
      ends={["1 год", `${Math.round(termMax / 12)} лет`]}
      value={valueOf(path)}
      trust={trustOf(path)}
      trustTitle={titleOf(path)}
      warning={
        badMonths ??
        problems.get(path) ??
        (valueOf(path) > LONGEST_FOUND_MONTHS
          ? "Дольше 7 лет условий у банков и лизинговых компаний мы не нашли: у Сбербанк Лизинга и ВТБ Лизинга до 7 лет"
          : undefined)
      }
      onChange={(next) => {
        const months = Number(next);
        if (next !== "" && (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS)) {
          setBadMonths(`Целое число месяцев от 1 до ${MAX_MONTHS}, в расчете пока прежний срок`);
          return;
        }
        setBadMonths(null);
        onChange(path, next === "" ? null : months);
      }}
    />
  );
  const cheap = (plan.supports ?? []).find((one) => one.kind === "loan_rate" && one.applied);
  const refunds = purchase.years.reduce((sum, year) => sum + (year.support_rub ?? 0), 0);
  const irr = irrText(purchase.irr, purchase.npv_rub, purchase.investment_year0_rub);
  const insured = purchase.years.reduce((sum, year) => sum + (year.insurance_rub ?? 0), 0);
  const paid = purchase.years.reduce((sum, year) => sum + (year.financing_rub ?? 0), 0);
  const open = (plan.supports ?? []).filter((one) => !one.blocked);
  const closed = (plan.supports ?? []).filter((one) => one.blocked);
  const weak = plan.weak_cover_years ?? [];
  const cover = String(plan.debt_cover_min ?? 1.2).replace(".", ",");

  // господдержка по способу оплаты: мера видна, когда может сработать. Заем ФРП на аванс только
  // у лизинга, льготная ставка только у кредита, возврат части затрат у любого способа
  const fits = (kind: string) =>
    kind === "capex_refund" ||
    (lease && kind === "leasing_advance_loan") ||
    (method.id === "loan" && kind === "loan_rate");
  const shown = open.filter((one) => fits(one.kind));
  const later = open.filter((one) => !fits(one.kind));
  // платеж в месяц по основному долгу считает сервер; у кредита тело равными долями, первый платеж
  // самый большой, поэтому показываем первый и последний
  const month = paidOwn ? null : plan.month_first_rub;
  const falls = !paidOwn && Math.abs(plan.month_first_rub - plan.month_last_rub) > 1;
  const tiles = [
    { label: "Свои деньги на старте", value: mln2(purchase.investment_year0_rub), unit: "млн ₽" },
    {
      label: falls ? `Платеж в месяц, первый; последний ${mln2(plan.month_last_rub)} млн ₽` : "Платеж в месяц",
      value: month == null ? "нет" : mln2(month),
      unit: month == null ? "" : "млн ₽",
    },
    { label: "Переплата", value: mln2(plan.interest_rub + insured), unit: "млн ₽" },
    { label: "Окупаемость", value: term(purchase.payback_cumulative_years), unit: "" },
  ];

  return (
    <div className="u-pay">
      {!readOnly && (
        <Toolbar>
          {METHODS.map((one) => (
            <Pill
              key={one.id}
              active={one.id === method.id}
              onClick={() => onChange("financing.method", one.value === 0 ? null : one.value)}
            >
              {one.name}
            </Pill>
          ))}
        </Toolbar>
      )}
      {wrong && !readOnly && (
        <div className="u-pay-wrong">
          <Alert>Условия неверные, покупку пока считаем за свои деньги. Поправьте поле ниже или верните как было</Alert>
          <Button
            kind="ghost"
            onClick={() =>
              Object.keys(overrides)
                .filter((path) => path.startsWith("financing."))
                .forEach((path) => onChange(path, null))
            }
          >
            Вернуть оплату как было
          </Button>
        </div>
      )}
      <p className="u-frow-hint">
        {own
          ? "Все вложения на старте из своих денег. Кредит или лизинг уменьшают деньги на старте, но добавляют проценты: выберите сверху, чтобы сравнить."
          : lease
            ? "В лизинг идут роботы, зарядки и ПО, остальное платите сами. Аренду это не меняет, у нее своя плата в месяц."
            : "Условия стоят средние, поправьте на свои. Аренду это не меняет, у нее своя плата в месяц."}
      </p>
      {!own && !readOnly && (
        <div className="u-pay-terms">
          {/* как в банковских калькуляторах: сумма, срок, ставка */}
          {sumField(lease ? "financing.leasing.advance_share" : "financing.loan.own_share")}
          {lease
            ? percentField(
                "financing.leasing.rate",
                "Внутренняя ставка лизинга",
                plan.markup_year != null
                  ? `удорожание ${percentText(plan.markup_year)} в год выходит из нее`
                  : undefined,
              )
            : percentField(
                "financing.loan.rate",
                "Ставка кредита",
                cheap
                  ? `по программе 1764 платите ${percentText(plan.rate)}`
                  : "средняя фактическая по малому и среднему бизнесу, ЦБ; в витрине Сбера от 18%",
              )}
          {monthsField(lease ? "financing.leasing.term_months" : "financing.loan.term_months")}
        </div>
      )}
      {!own && readOnly && (
        <p className="u-frow-hint">
          Ставка {percentText(plan.rate)}, срок {plan.term_months} мес.
        </p>
      )}
      <div className={busy ? "u-pay-tiles is-busy" : "u-pay-tiles"}>
        {tiles.map((tile) => (
          <div key={tile.label} className="u-pay-tile">
            <span>{tile.label}</span>
            <b className="mono">
              {tile.value}
              {tile.unit && <small>{unitText(tile.unit)}</small>}
            </b>
          </div>
        ))}
      </div>
      {weak.map((year) => (
        <p key={year} className="warn">
          В год {year} экономия покрывает платежи банку меньше чем в {cover} раза, банк может не дать кредит
        </p>
      ))}
      <section className="u-pay-support" aria-label="Господдержка">
        <h3>Господдержка</h3>
        {shown.map((one) => (
          <div key={one.id} className="u-pay-measure">
            {readOnly ? (
              <b>{one.name}</b>
            ) : (
              <Check
                checked={one.chosen}
                onToggle={() => onChange(`subsidies.${one.id}.chosen`, one.chosen ? null : 1)}
                label={one.name}
              />
            )}
            <span className="u-frow-hint">{one.conditions}</span>
            <span className="u-frow-hint">{one.operator}</span>
            {one.applied && (
              <span>
                {one.kind === "capex_refund"
                  ? `Вернет ${mln2(one.rub)} млн ₽ через год после запуска`
                  : one.kind === "loan_rate"
                    ? `Экономия на процентах ${mln2(one.rub)} млн ₽`
                    : `Заем на аванс ${mln2(one.rub)} млн ₽ под льготную ставку`}
              </span>
            )}
            {one.chosen && !one.applied && one.reason && <span className="warn">Не сработала: {one.reason}</span>}
          </div>
        ))}
        {later.map((one) => (
          <p key={one.id} className="u-frow-hint">
            {one.name}:{" "}
            {one.kind === "leasing_advance_loan" ? "работает только с лизингом" : "работает только с кредитом"}
          </p>
        ))}
        {!shown.length && !later.length && <p className="u-frow-hint">Для склада в Москве мер под эту покупку нет.</p>}
        <Fold title="Какие меры складу недоступны">
          {closed.map((one) => (
            <p key={one.id} className="u-frow-hint">
              {one.name}: для склада в Москве недоступна, {one.blocked}
            </p>
          ))}
          <p className="u-frow-hint">
            Московские меры ДПиИР и МФППиП и займы ФРП на развитие производства складу не положены: там получатели
            только обрабатывающие производства. Налоговые льготы (коэффициент 2 к расходам на российских роботов,
            ускоренная амортизация в лизинге) не считаем: налог на прибыль в модели не участвует.
          </p>
        </Fold>
      </section>
      <Fold title="Платежи по годам и что это меняет">
        <Ledger>
          <LedgerColumn
            title="Платежи по годам"
            note={
              paidOwn
                ? "платежей нет, все на старте"
                : paidLease
                  ? "равными суммами каждый месяц, млн ₽"
                  : "долг равными долями каждый месяц, проценты с остатка, млн ₽"
            }
            rows={[
              { key: "start", name: "На старте, свои", value: mln2(purchase.investment_year0_rub) },
              ...purchase.years.map((year) => ({
                key: String(year.year),
                name: `${year.year} год`,
                hint: (year.support_rub ?? 0) > 0 ? `господдержка +${mln2(year.support_rub ?? 0)}` : undefined,
                value: mln2(year.financing_rub ?? 0),
              })),
            ]}
            total={{
              name: "Заплатим за вложения, млн ₽",
              value: mln2(purchase.investment_year0_rub + paid + insured),
            }}
            after={[
              ...(plan.interest_rub > 0
                ? [
                    {
                      key: "interest",
                      name: paidLease ? "Удорожание сверх цены" : "Проценты",
                      hint: "входят в стоимость владения",
                      value: mln2(plan.interest_rub),
                    },
                  ]
                : []),
              ...(insured > 0
                ? [
                    {
                      key: "insurance",
                      name: paidLease ? "Страховка предмета лизинга" : "Страховка залога",
                      hint: "0,7% цены роботов и зарядок в год, пока есть долг; ее требует кредитор",
                      value: mln2(insured),
                    },
                  ]
                : []),
              ...(refunds > 0 ? [{ key: "refund", name: "Вернет господдержка", value: mln2(refunds) }] : []),
            ]}
          />
          <LedgerColumn
            title="Что это меняет"
            note="против покупки за свои деньги и без мер"
            rows={[
              {
                key: "start",
                name: "Свои деньги на старте",
                value: `${mln2(purchase.capex_after_grant_rub ?? 0)} → ${mln2(purchase.investment_year0_rub)}`,
              },
              {
                key: "payback",
                name: paidOwn ? "Окупаемость по потоку" : "Окупаемость с учетом долга",
                hint: paidOwn ? undefined : "когда экономия покрыла и свои деньги, и остаток долга",
                value: `${term(plan.plain_payback_years)} → ${term(purchase.payback_cumulative_years)}`,
              },
              ...(paidOwn
                ? []
                : [
                    {
                      key: "own",
                      name: "Свои деньги вернутся за",
                      hint: "только первый взнос: долг в это время еще гасится",
                      value: term(purchase.payback_own_years),
                    },
                  ]),
              {
                key: "npv",
                name: "NPV",
                hint: "при ставке дисконтирования из допущений",
                value: `${mln2(plan.plain_npv_rub ?? 0)} → ${mln2(purchase.npv_rub ?? 0)}`,
              },
              {
                key: "irr",
                name: "IRR проекта",
                hint: "как у покупки за свои деньги",
                value: irrText(plan.plain_irr, plan.plain_npv_rub, purchase.capex_after_grant_rub ?? 0),
              },
              ...(paidOwn
                ? []
                : [
                    {
                      key: "irr-own",
                      name: "IRR своих денег",
                      hint: "от первого взноса: при маленьком взносе всегда высокий",
                      value: irr,
                    },
                  ]),
            ]}
            total={{
              name: "Стоимость владения, млн ₽",
              value: `${mln2(plan.plain_tco_rub ?? 0)} → ${mln2(purchase.tco_rub)}`,
            }}
          />
        </Ledger>
      </Fold>
    </div>
  );
}
