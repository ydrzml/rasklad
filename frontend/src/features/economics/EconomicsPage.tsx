import { useEffect, useState } from "react";

import { api, type CalculationResult, type SensitivityAll } from "../../api/client";
import { mln, term } from "../../app/format";
import { Answer, Button, Header, Hero, Notice, Waiting } from "../../ui";
import { Assumptions, Impacts, Limits } from "./Assumptions";
import { DEMO, PAY_METHODS, demoRequest, mergeSources, valueText } from "./data";
import { Metrics } from "./Metrics";
import { Payment } from "./Payment";
import { ScenarioMoney } from "./Scenarios";
import "./economics.css";

// Как читать экономику: три сценария, показатели, способ оплаты, допущения и что не учтено.
// Отдельная страница рядом с методикой (/method): методика ведет от склада к деньгам, здесь только
// деньги и подробно. Пример это демо-расчет из документации, все числа считает сервер: план по
// шаблону, расчет с прогоном смены, чувствительность и та же покупка в кредит и в лизинг

export type Loaded = {
  base: CalculationResult;
  sensitivity: SensitivityAll | null;
  // покупка тем же расчетом при оплате кредитом и лизингом, null: сервер не ответил
  loan: CalculationResult | null;
  leasing: CalculationResult | null;
};

const SECTIONS = [
  { id: "scenarios", name: "Три сценария" },
  { id: "metrics", name: "Показатели" },
  { id: "payment", name: "Способ оплаты" },
  { id: "assumptions", name: "Допущения" },
  { id: "impact", name: "Что двигает итог" },
  { id: "limits", name: "Что не учтено" },
];

const READING = [
  {
    step: "Окупаемость",
    text: "Через сколько лет экономия вернет вложения. Чем короче, тем лучше: до 3 лет это хорошо.",
    href: "#metrics",
  },
  {
    step: "Стоимость владения",
    text: "Сколько всего придется заплатить за горизонт расчета в каждом сценарии. Сравнивайте с вариантом без роботов.",
    href: "#scenarios",
  },
  {
    step: "Насколько можно верить",
    text: "У каждого числа источник и оценка от S до F. F значит, что источника нет и это наше допущение.",
    href: "#assumptions",
  },
];

function useDemo(attempt: number) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    const run = async () => {
      const built = await api.planGenerate({
        facility_id: DEMO.facility_id,
        operation_ids: [DEMO.operation_id],
        template_id: DEMO.template_id,
        overrides: {},
      });
      const request = demoRequest(built.plan);
      const base = await api.preview(request, abort.signal);
      // прогон смены сервер уже сделал и помнит: кредит, лизинг и чувствительность приходят быстро
      const [sensitivity, loan, leasing] = await Promise.allSettled([
        api.sensitivityAll(request, abort.signal),
        api.preview(demoRequest(built.plan, PAY_METHODS[1].method), abort.signal),
        api.preview(demoRequest(built.plan, PAY_METHODS[2].method), abort.signal),
      ]);
      const value = <T,>(one: PromiseSettledResult<T>) => (one.status === "fulfilled" ? one.value : null);
      if (!abort.signal.aborted) {
        setLoaded({ base, sensitivity: value(sensitivity), loan: value(loan), leasing: value(leasing) });
      }
    };
    run().catch(() => !abort.signal.aborted && setFailed(true));
    return () => abort.abort();
  }, [attempt]);
  return { loaded, failed };
}

export function EconomicsPage() {
  const [attempt, setAttempt] = useState(0);
  const { loaded, failed } = useDemo(attempt);

  // на разделы ссылаются из методики (/economics#metrics): они встают после ответа сервера
  useEffect(() => {
    if (!loaded || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [loaded]);

  const scenarios = loaded?.base.scenarios ?? [];
  const purchase = scenarios.find((one) => one.id === "purchase");
  const sources = mergeSources([loaded?.base.sources, loaded?.loan?.sources, loaded?.leasing?.sources]);
  const discount = sources.find((one) => one.path === "economics.discount_rate");
  const rate = discount ? valueText(discount) : "дисконтирования";
  const years = term(loaded?.base.horizon_years ?? null);
  const area = sources.find((one) => one.path.endsWith(".active_area_m2"));

  return (
    <div className="u-page">
      <Header />
      <main className="u-main u-wrap e-page">
        <Hero
          compact
          title="Как читается экономика"
          lead="Как мы сравниваем жизнь без роботов, покупку и роботов как услугу по годам, и на каких допущениях. На живом примере: расчет считает сервер прямо сейчас."
        />

        <ol className="e-reading" aria-label="Как читать результат">
          {READING.map((one, index) => (
            <li key={one.step}>
              <span className="e-reading-idx mono">{index + 1}</span>
              <a href={one.href}>{one.step}</a>
              <span>{one.text}</span>
            </li>
          ))}
        </ol>

        <nav className="e-toc" aria-label="Разделы страницы">
          {SECTIONS.map((one) => (
            <a key={one.id} href={`#${one.id}`}>
              {one.name}
            </a>
          ))}
        </nav>

        {failed && (
          <Notice title="Пример не загрузился" level={2}>
            Сервер не ответил, поэтому чисел примера пока нет. Попробуйте еще раз через минуту.
          </Notice>
        )}
        {failed && (
          <p>
            <Button kind="ghost" onClick={() => setAttempt((one) => one + 1)}>
              Посчитать еще раз
            </Button>
          </p>
        )}
        {!loaded && !failed && (
          <Waiting title="Считаем пример" note="Типовой склад, прогон смены на плане. Обычно 10-15 секунд." />
        )}

        {loaded && purchase && (
          <>
            <section className="e-example" aria-labelledby="example-title">
              <h2 id="example-title" className="e-kicker">
                Пример: склад{area ? ` ${valueText(area)}` : ""}, перевозка паллет, робот Ronavi H1500, типовой план
              </h2>
              <Answer
                title={`Покупка окупится за ${term(purchase.payback_cumulative_years)}`}
                note={purchase.verdict?.text ?? ""}
                facts={[
                  { label: "Роботов", value: String(loaded.base.sizing?.fleet ?? "") },
                  { label: "Вложения на старте", value: mln(purchase.investment_year0_rub), unit: "млн ₽" },
                  {
                    label: `Дешевле, чем без роботов, за ${years}`,
                    value: mln(purchase.saving_rub ?? 0),
                    unit: "млн ₽",
                  },
                ]}
              />
            </section>

            <ScenarioMoney scenarios={scenarios} years={years} />
            <Metrics scenarios={scenarios} rate={rate} years={years} />
            <Payment years={years} base={purchase} loan={loaded.loan} leasing={loaded.leasing} />
            <Assumptions sources={sources} own={loaded.base.sources ?? []} />
            <Impacts sensitivity={loaded.sensitivity} />
            <Limits sources={sources} />
          </>
        )}

        <footer className="e-next">
          <p>Формулы с примерами руками на странице методики. Свой склад можно посчитать за пять шагов.</p>
          <div>
            <Button kind="ghost" href="/method">
              Как мы считаем
            </Button>
            <Button href="/calc" arrow>
              Посчитать свой склад
            </Button>
          </div>
        </footer>
      </main>
    </div>
  );
}
