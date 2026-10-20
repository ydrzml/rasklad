import type { ScenarioResult } from "../../api/client";
import { mln, percent, term } from "../../app/format";
import { irrText, times } from "../../app/steps/economicsNames";
import { BlockHead } from "../../ui";
import { NAMES, TONES } from "./Scenarios";

// Пять показателей по ТЗ: что значит одной фразой, как читать и значения примера. Значения
// приходят с сервера, формулы те же, что в docs/calculation.md, раздел 6

// ставка дисконтирования и горизонт словами, из ответа сервера: "14% в год", "5 лет"
type Ctx = { rate: string; years: string };

type Metric = {
  id: string;
  name: string;
  what: (ctx: Ctx) => string;
  read: (ctx: Ctx) => string;
  value: (one: ScenarioResult) => string;
  sub?: (one: ScenarioResult) => string;
};

const METRICS: Metric[] = [
  {
    id: "payback",
    name: "Окупаемость",
    what: () =>
      "Через сколько лет накопленная экономия покроет все вложения. Считаем по годам с ростом зарплат и цен, выкупом и заменой аккумуляторов.",
    read: () => "Меньше лучше. По ТЗ: до 3 лет, 3-5 лет, больше 5 лет или не окупается.",
    value: (one) => term(one.payback_cumulative_years),
    sub: (one) => `по ТЗ, вложения / экономия первого года: ${term(one.payback_simple_years)}`,
  },
  {
    id: "tco",
    name: "Стоимость владения",
    what: (ctx) =>
      `Все, что заплатите за ${ctx.years}: вложения, люди, которые остались на операции, и все затраты на роботов.`,
    read: () => "Меньше лучше. Сравнивайте со строкой без роботов: разница и есть выгода.",
    value: (one) => `${mln(one.tco_rub)} млн ₽`,
    sub: (one) => (one.saving_rub ? `дешевле, чем без роботов, на ${mln(one.saving_rub)} млн ₽` : "база сравнения"),
  },
  {
    id: "npv",
    name: "NPV, выгода в сегодняшних деньгах",
    what: (ctx) =>
      `Та же выгода за ${ctx.years}, но рубль через год стоит меньше сегодняшнего: поток каждого года пересчитываем по ставке ${ctx.rate}.`,
    read: (ctx) => `Больше нуля значит, что роботы выгоднее, чем держать деньги под ставку ${ctx.rate}.`,
    value: (one) => (one.npv_rub === null ? "нет" : `${mln(one.npv_rub)} млн ₽`),
  },
  {
    id: "irr",
    name: "IRR, внутренняя доходность",
    what: () => "Под какой процент годовых вложения работают: ставка, при которой NPV равен нулю.",
    read: (ctx) =>
      `Выше ставки дисконтирования ${ctx.rate} или ставки кредита значит выгодно. Выше 100% пишем словами: деньги возвращаются быстрее года.`,
    value: (one) => irrText(one.irr, one.npv_rub, one.investment_total_rub),
  },
  {
    id: "roi",
    name: "ROI",
    what: (ctx) =>
      `Сколько заработали сверх вложений за ${ctx.years}, в процентах от всех вложений. Рядом экономия на рубль вложений: ROI по формуле ТЗ, экономия / вложения.`,
    read: () =>
      "Больше нуля лучше: 0% значит, что вложения только вернулись. Экономия на рубль: 1 раз значит то же самое.",
    value: (one) => percent(one.roi_net),
    sub: (one) => `экономия на рубль вложений ${times(one.roi_tz)}`,
  },
];

export function Metrics({ scenarios, rate, years }: { scenarios: ScenarioResult[]; rate: string; years: string }) {
  const ctx = { rate, years };
  const robots = scenarios.filter((one) => one.id !== "baseline");
  const baseline = scenarios.find((one) => one.id === "baseline");
  const purchase = robots.find((one) => one.id === "purchase");
  const raas = robots.find((one) => one.id === "raas");
  const buyout = raas?.years.find((row) => row.investment_rub > 0)?.year;
  return (
    <section id="metrics" className="e-section">
      <BlockHead title="Показатели" note="что значит каждый и как его читать, числа примера справа" />
      <ol className="e-metrics">
        {METRICS.map((metric) => (
          <li key={metric.id} className="e-metric">
            <div className="e-metric-text">
              <h3>
                {metric.name}
                {metric.id === "tco" || metric.id === "roi" ? ` за ${years}` : ""}
              </h3>
              <p>{metric.what(ctx)}</p>
              <p className="e-metric-read">
                <span className="e-tag">Как читать</span> {metric.read(ctx)}
              </p>
            </div>
            <dl className="e-metric-values">
              {metric.id === "tco" && baseline && (
                <div className="is-now">
                  <dt>
                    <i aria-hidden="true" />
                    {NAMES.baseline}
                  </dt>
                  <dd className="mono">{metric.value(baseline)}</dd>
                </div>
              )}
              {robots.map((one) => (
                <div key={one.id} className={`is-${TONES[one.id] ?? "buy"}`}>
                  <dt>
                    <i aria-hidden="true" />
                    {NAMES[one.id] ?? one.name}
                  </dt>
                  <dd className="mono">{metric.value(one)}</dd>
                  {metric.sub && <dd className="e-metric-sub">{metric.sub(one)}</dd>}
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>

      {purchase && raas && raas.tco_rub > purchase.tco_rub && (raas.npv_rub ?? 0) > (purchase.npv_rub ?? 0) && (
        <aside className="e-callout">
          <h3>Почему аренда дороже за {years}, а NPV у нее больше</h3>
          <p>
            Стоимость владения складывает рубли как есть: за {years} аренда стоит {mln(raas.tco_rub)} млн ₽, покупка{" "}
            {mln(purchase.tco_rub)}. NPV учитывает, когда платим: на старте аренда просит{" "}
            {mln(raas.investment_year0_rub)} млн ₽ вместо {mln(purchase.investment_year0_rub)}
            {buyout ? `, а выкуп роботов приходится только на ${buyout} год` : ", а плата растянута на все годы"}.
            Поздние рубли дешевле, поэтому NPV аренды выше. Какой показатель важнее, решает компания: есть ли деньги на
            старте.
          </p>
        </aside>
      )}
    </section>
  );
}
