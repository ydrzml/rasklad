import { useEffect, useState } from "react";

import { api, type CalculationRequest, type CalculationResult, type ScenarioResult } from "../../api/client";
import { InlineField, TextButton } from "../../ui";
import { creditLines, parseMln, rangeError } from "./chosen";
import { cardLines, verdict, type CardFit, type PayWay } from "./paymentWays";
import "./payways.css";

/* Как человек хочет получить роботов: спрашиваем в начале шага решения, на карточках решений цены
   отмеченными способами, на шаге экономики итог по отмеченному против работы без роботов (ChosenResult).
   Без роботов считаем всегда, это база сравнения. Слова и выбор строк в paymentWays.ts и chosen.ts */

// financing.method в config/model.yaml: 0 свои деньги, 1 кредит, 2 лизинг
const METHOD: Partial<Record<PayWay, number>> = { own: 0, loan: 1, leasing: 2 };
const BY_SERVER: Record<string, PayWay> = { own: "own", loan: "loan", leasing: "leasing" };

/* Шаг 4, над подбором: покупка, аренда или обе. Если покупка, по желанию промежуток "сколько готовы
   вложить" от и до и отметка "рассматриваю кредит или лизинг": только тогда они считаются. Выбор
   хранится списком способов: покупка это own, кредит и лизинг loan и leasing, аренда raas */
export function MoneyBlock({
  budget,
  onBudget,
  budgetFrom = null,
  onBudgetFrom,
  ways,
  onWays,
}: {
  budget: number | null;
  onBudget: (value: number | null) => void;
  budgetFrom?: number | null;
  onBudgetFrom?: (value: number | null) => void;
  ways: PayWay[];
  onWays: (ways: PayWay[]) => void;
}) {
  // поля пишут текстом: неверное значение видно с подсказкой, а в расчет идет только верный промежуток
  const asText = (value: number | null) => (value ? String(value / 1_000_000).replace(".", ",") : "");
  const [from, setFrom] = useState(() => asText(budgetFrom));
  const [to, setTo] = useState(() => asText(budget));
  const problem = rangeError(from, to);
  const apply = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    if (rangeError(nextFrom, nextTo)) return;
    const low = parseMln(nextFrom);
    const high = parseMln(nextTo);
    onBudgetFrom?.(low === "bad" ? null : low);
    onBudget(high === "bad" ? null : high);
  };
  const buy = ways.includes("own");
  const rent = ways.includes("raas");
  const credit = ways.includes("loan") || ways.includes("leasing");
  const pick = (nextBuy: boolean, nextRent: boolean, nextCredit: boolean) => {
    const next: PayWay[] = [
      ...(nextBuy ? (["own"] as PayWay[]) : []),
      ...(nextBuy && nextCredit ? (["loan", "leasing"] as PayWay[]) : []),
      ...(nextRent ? (["raas"] as PayWay[]) : []),
    ];
    // хотя бы один способ остается всегда
    if (next.length > 0) onWays(next);
  };
  const options = [
    {
      id: "own",
      on: buy,
      name: "Покупка",
      note: "роботы ваши, деньги на старте",
      toggle: () => pick(!buy, rent, credit),
    },
    {
      id: "raas",
      on: rent,
      name: "Аренда",
      note: "платеж в месяц, роботы не ваши",
      toggle: () => pick(buy, !rent, credit),
    },
  ];
  // Бюджет и кредит свернуты под ссылкой: блок оплаты одной строкой, и карточки решений видны
  // на первом экране. Если что-то из них уже задано, раскрыты сразу
  const [more, setMore] = useState(() => Boolean(budget || budgetFrom || credit));
  const moreOpen = more || Boolean(problem);
  const moreName = [budget || budgetFrom ? "бюджет задан" : "", credit ? "кредит и лизинг" : ""].filter(Boolean);
  return (
    <section
      // свернутая строка стоит на фоне страницы, без своей панели: так карточки подбора выше
      className={moreOpen ? "u-panel u-money-block" : "u-money-block is-line"}
      aria-labelledby="money-title"
    >
      <div className="u-money-line">
        <h2 id="money-title">Как хотите получить роботов</h2>
        <fieldset className="u-ways is-two is-line">
          <legend className="u-sr">Покупка или аренда</legend>
          {options.map((one) => (
            <label key={one.id} className={one.on ? `u-way is-on is-${one.id}` : `u-way is-${one.id}`} title={one.note}>
              <input type="checkbox" checked={one.on} onChange={one.toggle} />
              <span className="u-way-box" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 6.3l2.3 2.2 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
              <span className="u-way-text">
                <b>{one.name}</b>
                <span>{one.note}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <span className="u-money-hint">можно оба: покажем, что выгоднее</span>
        {buy && (
          <button
            type="button"
            className="u-textbtn u-money-more"
            aria-expanded={moreOpen}
            aria-controls="money-buy"
            onClick={() => setMore(!moreOpen)}
          >
            {moreOpen ? "Скрыть бюджет и кредит" : "Бюджет и кредит"}
            {!moreOpen && moreName.length > 0 && <small>: {moreName.join(", ")}</small>}
          </button>
        )}
      </div>
      {buy && moreOpen && (
        <div className="u-money-buy" id="money-buy">
          <div className="u-money-bands" role="group" aria-label="Сколько готовы вложить в покупку">
            <span className="u-money-q">
              Сколько готовы вложить в покупку? <small>необязательно, можно одно поле</small>
            </span>
            <InlineField
              label="от"
              unit="млн ₽"
              placeholder="не задано"
              value={from}
              onChange={(text) => apply(text, to)}
            />
            <InlineField
              label="до"
              unit="млн ₽"
              placeholder="не задано"
              value={to}
              onChange={(text) => apply(from, text)}
            />
            {problem && (
              <span className="u-money-error" role="alert">
                {problem}
              </span>
            )}
          </div>
          <label className="u-money-credit">
            <input type="checkbox" checked={credit} onChange={() => pick(buy, rent, !credit)} />
            Своих денег нет или не хватает: посчитать кредит и лизинг
          </label>
        </div>
      )}
    </section>
  );
}

/* На карточке решения: весь нужный парк отмеченными способами, крупно. Суммы считает сервер
   (POST /api/budget/fit), то, что на старте больше бюджета, помечено */
export function CardWays({
  fit,
  ways,
  budget,
  withVat = false,
}: {
  fit?: CardFit;
  ways: PayWay[];
  budget?: number | null;
  /* итог парка посчитан с НДС или без: цена за штуку выше всегда с НДС, подписываем, чтобы не сравнивали в лоб */
  withVat?: boolean;
}) {
  const lines = cardLines(fit, ways, budget);
  if (lines.length === 0) return null;
  return (
    <span className="u-card-ways">
      <span className="u-card-ways-head">
        весь парк по формуле {fit?.fleet_needed} шт., своих денег на старте {withVat ? "с НДС" : "без НДС"}
      </span>
      {lines.map((line) => (
        <span key={line.id} className={line.over ? `u-card-way is-${line.id} is-over` : `u-card-way is-${line.id}`}>
          <i aria-hidden="true" />
          <span className="u-card-way-name">{line.name}</span>
          <span className="u-card-way-sum">
            <b className="mono">{line.value}</b> {line.unit}
          </span>
          {line.over && <span className="u-card-way-over">больше бюджета</span>}
        </span>
      ))}
    </span>
  );
}

function withMethod(request: CalculationRequest, method: number): CalculationRequest {
  const overrides = { ...(request.overrides ?? {}) };
  if (method === 0) delete overrides["financing.method"];
  else overrides["financing.method"] = method;
  return { ...request, overrides };
}

export type Purchases = Partial<Record<PayWay, ScenarioResult>>;

/* Покупка за свои, в кредит и в лизинг: сервер считает одним способом за раз (financing.method).
   Покупку текущим способом берем из расчета, остальные отмеченные просим отдельно. Прогон смены
   сервер помнит, такой запрос идет около секунды */
export function usePurchases(
  result: CalculationResult | null,
  request: CalculationRequest | undefined,
  ways: PayWay[],
) {
  const purchase = (result?.scenarios ?? []).find((one) => one.id === "purchase");
  const currentWay = BY_SERVER[purchase?.financing?.method ?? "own"] ?? "own";
  const wanted = ways.filter((one) => METHOD[one] !== undefined && one !== currentWay);
  // пока расчета нет, и спрашивать нечего: ключ ждет готовый расчет
  const key = purchase ? `${JSON.stringify(request ?? null)}|${wanted.join(",")}` : "";
  const [found, setFound] = useState<{ key: string; byWay: Purchases; failed: boolean }>({
    key: "",
    byWay: {},
    failed: false,
  });
  useEffect(() => {
    if (!request || !key || wanted.length === 0) return;
    const abort = new AbortController();
    // по очереди, не разом: расчет и так тяжелый, а второй запрос берет прогон, который запомнил первый
    const run = async () => {
      const byWay: Purchases = {};
      let failed = false;
      for (const way of wanted) {
        try {
          // сервер мог не ответить под нагрузкой: второй раз спрашиваем один раз
          const ask = () => api.preview(withMethod(request, METHOD[way] ?? 0), abort.signal, true);
          const answer = await ask().catch(() => (abort.signal.aborted ? Promise.reject(new Error("aborted")) : ask()));
          const one = (answer.scenarios ?? []).find((scenario) => scenario.id === "purchase");
          if (one) byWay[way] = one;
        } catch {
          if (abort.signal.aborted) return;
          // не посчиталось: карточки этого способа нет, остальные на месте, под выводом строка
          failed = true;
        }
      }
      setFound({ key, byWay, failed });
    };
    void run();
    return () => abort.abort();
    // key собирает request и wanted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const ready = Boolean(key) && found.key === key;
  const byWay: Purchases = { ...(ready ? found.byWay : {}) };
  if (purchase) byWay[currentWay] = purchase;
  return { byWay, waiting: wanted.length > 0 && !ready, failed: ready && found.failed };
}

/* Шаг 5, под переключателем, когда показана покупка: свои деньги, кредит и лизинг одной строкой
   (что дешевле за горизонт и что легче на старте), условия выбранного способа и панель условий.
   Сами способы выбираются переключателем, суммы считает сервер */
export function PayLine({
  result,
  byWay,
  waiting,
  failed,
  budget,
  onTerms,
}: {
  result: CalculationResult;
  byWay: Purchases;
  waiting: boolean;
  failed: boolean;
  budget?: number | null;
  /* панель условий кредита и лизинга: ставка, срок, господдержка */
  onTerms?: () => void;
}) {
  const scenarios = result.scenarios ?? [];
  const baseline = scenarios.find((one) => one.id === "baseline");
  const purchase = scenarios.find((one) => one.id === "purchase");
  if (!baseline || !purchase) return null;
  const horizon = result.horizon_years;
  const rows = (["own", "loan", "leasing"] as const).flatMap((way) => {
    const one = byWay[way];
    return one ? [{ id: way, start: one.investment_year0_rub, tco: one.tco_rub }] : [];
  });
  const plan = purchase.financing;
  const way = plan && (plan.method === "loan" || plan.method === "leasing") ? plan.method : null;
  const terms =
    plan && way
      ? `${way === "loan" ? "Кредит" : "Лизинг"} ${(plan.rate * 100).toFixed(1).replace(".", ",")}% на ${plan.term_months} мес: ${creditLines(way, purchase).join(", ")}.`
      : null;
  return (
    <div className="u-payline" aria-busy={waiting}>
      <p>
        {waiting
          ? "Считаем свои деньги, кредит и лизинг на тех же роботах."
          : rows.length > 1
            ? verdict(rows, baseline.tco_rub, horizon, budget ?? null)
            : ""}
        {failed && " Часть способов посчитать не удалось, сравниваем то, что посчиталось."}
      </p>
      <p className="u-payline-terms">
        {terms && `${terms} `}
        {onTerms && <TextButton onClick={onTerms}>Условия кредита, лизинга и господдержка</TextButton>}
      </p>
    </div>
  );
}
