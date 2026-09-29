import { useEffect, useState } from "react";

import { api, type CalculationRequest, type CalculationResult } from "../../api/client";
import { mln, term } from "../../app/format";
import { BlockHead, CostChart, Fold, Formula, Header, Hero, Panel, Waiting } from "../../ui";
import "./method.css";

// Как мы считаем, вторая версия: меньше текста, больше картинок. Формулы те же, что в
// docs/calculation.md. Числа на графиках не нарисованы руками: страница берет с сервера расчет
// эталона склада (перевозка паллет, 10 000 м², Ronavi H1500, по формуле), тот же, что по умолчанию
// в мастере. Подробности словами лежат под "подробнее".

const PATH = [
  { name: "Объект и задачи", note: "склад и что заберут роботы" },
  { name: "Параметры и штат", note: "объем, смены, кто работает сейчас" },
  { name: "План", note: "размеры, ворота, ряды" },
  { name: "Решение", note: "подбор из каталога с проверками" },
  { name: "Смена и деньги", note: "прогон на плане и три сценария" },
];

// Сколько значений модели с какой оценкой: docs/data-sources.md, раздел «Оценка достоверности»
const TRUST: { level: string; name: string; count: number; tone: string }[] = [
  { level: "S", name: "закон, норматив", count: 8, tone: "strong" },
  { level: "A", name: "проверено", count: 8, tone: "strong" },
  { level: "B", name: "два источника", count: 19, tone: "good" },
  { level: "C", name: "один источник", count: 94, tone: "mid" },
  { level: "D", name: "только организатор", count: 232, tone: "weak" },
  { level: "E", name: "источники расходятся", count: 22, tone: "bad" },
  { level: "F", name: "наше допущение", count: 159, tone: "bad" },
];

const NAMES: Record<string, string> = { baseline: "Без роботов", purchase: "Покупка", raas: "Аренда" };
const TONES: Record<string, "now" | "buy" | "rent"> = { baseline: "now", purchase: "buy", raas: "rent" };

export function Method() {
  const [result, setResult] = useState<CalculationResult | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    api
      .preview({} as CalculationRequest, abort.signal)
      .then(setResult)
      .catch(() => !abort.signal.aborted && setFailed(true));
    return () => abort.abort();
  }, []);

  // На разделы страницы ссылаются подвал мастера и главная вошедшего (/method#fleet). Часть
  // разделов появляется после ответа сервера, поэтому к якорю докручиваем, когда они встали
  useEffect(() => {
    if (!result || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [result]);

  const scenarios = result?.scenarios ?? [];
  const purchase = scenarios.find((one) => one.id === "purchase");
  const sizing = result?.sizing;
  const demand = sizing?.design_demand_ops_per_hour ?? 0;
  const fleet = sizing?.fleet ?? 0;
  const perRobot = fleet ? demand / fleet : 0;
  const total = TRUST.reduce((sum, one) => sum + one.count, 0);

  return (
    <div className="u-page">
      <Header />
      <main className="u-main u-wrap m-page">
        <Hero
          compact
          title="Как мы считаем"
          lead="Пять шагов от склада до денег. Все считает сервер, у каждой цифры есть источник и оценка доверия."
        />
        <p className="m-lead">
          <b>Это оценка, а не коммерческое предложение.</b> Для проекта нужны замеры на объекте и предложения
          поставщиков.
        </p>

        <section id="path">
          <BlockHead title="Путь расчета" />
          <ol className="m-path">
            {PATH.map((step, index) => (
              <li key={step.name}>
                <span className="m-path-idx mono">{String(index + 1).padStart(2, "0")}</span>
                <b>{step.name}</b>
                <span>{step.note}</span>
              </li>
            ))}
          </ol>
        </section>

        {failed && (
          <p className="m-note">Пример расчета не загрузился: сервер не ответил. Формулы ниже от этого не зависят.</p>
        )}
        {!result && !failed && <Waiting title="Считаем пример склада" />}

        {result && sizing && purchase && (
          <>
            <section id="fleet">
              <BlockHead title="Сколько роботов" note="пример: перевозка паллет, Ronavi H1500" />
              <Panel>
                <div className="m-body">
                  <div className="m-bars" aria-label={`Спрос ${Math.round(demand)} в час, ${fleet} роботов`}>
                    <div className="m-bar">
                      <span className="m-bar-col" />
                      <span className="m-bar-cap">
                        спрос в пик
                        <b className="mono">{Math.round(demand)} в час</b>
                      </span>
                    </div>
                    <span className="m-bars-sign" aria-hidden="true">
                      =
                    </span>
                    <div className="m-bar">
                      <span className="m-bar-stack">
                        {Array.from({ length: fleet }, (_, n) => (
                          <i key={n} />
                        ))}
                      </span>
                      <span className="m-bar-cap">
                        по {(Math.round(perRobot * 10) / 10).toLocaleString("ru-RU")} в час на робота
                        <b className="mono">{fleet} роботов</b>
                      </span>
                    </div>
                  </div>
                  <p>
                    Каждый робот делает свою долю спроса. Сколько он успевает, считаем по маршруту на вашем плане, а
                    потом проверяем прогоном смены: там видны очереди у ворот и в проездах и зарядка.
                  </p>
                  <Fold title="подробнее">
                    <Formula
                      words="пиковый спрос = объем в сутки * доля для роботов / часов в сутки * пиковый коэффициент"
                      numbers="с запасом на пик"
                    />
                    <Formula
                      words="производительность = 3600 / (туда и обратно по маршруту / скорость + погрузка) * операций за рейс"
                      numbers="с учетом загрузки робота"
                    />
                    <p>
                      Парк это самый маленький, который вытянул спрос в прогоне смены на вашем плане. Формула рядом
                      остается проверкой руками.
                    </p>
                  </Fold>
                </div>
              </Panel>
            </section>

            <section id="scenarios">
              <BlockHead title="Три сценария за пять лет" note="накопленные затраты, пример склада" />
              <Panel>
                <div className="m-body">
                  <CostChart
                    unit="млн ₽"
                    scale={1_000_000}
                    format={mln}
                    series={scenarios.map((one) => ({
                      tone: TONES[one.id] ?? "now",
                      name: NAMES[one.id] ?? one.name,
                      points: one.cumulative_cost_rub ?? [],
                    }))}
                  />
                  <Fold title="подробнее: что входит в каждый сценарий">
                    <p>
                      Без роботов: зарплаты людей на операции с ростом каждый год. Покупка: вложения на старте, дальше
                      обслуживание, электроэнергия, лицензии, операторы и обновление парка. Аренда: плата за робота в
                      месяц, в ней ТО и ремонт, в конце договора выкуп по остаточной стоимости.
                    </p>
                  </Fold>
                </div>
              </Panel>
            </section>

            <section id="payback">
              <BlockHead title="Окупаемость" note="по ТЗ: вложения делим на экономию первого года" />
              <Panel>
                <div className="m-body">
                  <p className="m-big">
                    <span>
                      <small>вложения, млн ₽</small>
                      <b className="mono">{mln(purchase.investment_year0_rub)}</b>
                    </span>
                    <i aria-hidden="true">/</i>
                    <span>
                      <small>экономия в год, млн ₽</small>
                      <b className="mono">{mln(purchase.annual_effect_year1_rub ?? 0)}</b>
                    </span>
                    <i aria-hidden="true">=</i>
                    <span>
                      <small>окупится за</small>
                      <b className="mono">{term(purchase.payback_simple_years)}</b>
                    </span>
                  </p>
                  <Fold title="подробнее: ROI, стоимость владения, NPV">
                    <Formula
                      words="экономия в год = люди без роботов - люди, которые остались, - затраты на роботов"
                      numbers="на каждый год горизонта"
                    />
                    <Formula
                      words="окупаемость по потоку = год, когда накопленная экономия покрыла вложения"
                      numbers="с ростом зарплат и цен, выкупом и обновлением парка"
                    />
                    <Formula words="ROI = сумма экономии за 5 лет / все вложения" numbers="по ТЗ" />
                    <Formula
                      words="стоимость владения = вложения + люди, которые остались, + затраты на роботов за 5 лет"
                      numbers="то, что на графике выше в последний год"
                    />
                  </Fold>
                </div>
              </Panel>
            </section>
          </>
        )}

        <section id="trust">
          <BlockHead title="Откуда цифры" note={`оценка у каждого из ${total} значений модели`} />
          <Panel>
            <div className="m-body">
              <div className="m-scale" role="img" aria-label="Сколько значений с какой оценкой">
                {TRUST.map((one) => (
                  <span key={one.level} className={`is-${one.tone}`} style={{ flexGrow: one.count }}>
                    {one.level}
                  </span>
                ))}
              </div>
              <ul className="m-scale-legend">
                {TRUST.map((one) => (
                  <li key={one.level}>
                    <i className={`is-${one.tone}`} aria-hidden="true" />
                    <b className="mono">{one.level}</b> {one.name}
                    <span className="mono">{one.count}</span>
                  </li>
                ))}
              </ul>
              <Fold title="подробнее: как ставим оценку">
                <p>
                  Значения сходятся, если отличаются не больше чем на 10%. На E и F опираться нельзя, такие места мы
                  называем сами. Отметка "Протестировано ФЦ БАС" подтверждает, что решение работает, но не его цифры.
                  Полный список значений с источниками есть на шаге экономики и в отчете.
                </p>
              </Fold>
            </div>
          </Panel>
        </section>

        <section id="limits">
          <Fold title="Что пока не учли">
            <ul className="m-list">
              <li>Остаточную стоимость роботов в конце пяти лет: без нее расчет осторожнее.</li>
              <li>Налог на прибыль, налоговую экономию от амортизации и возврат НДС.</li>
              <li>Поэтапный запуск парка частями и выход на режим дольше года.</li>
              <li>Экономию на ошибках и травмах.</li>
              <li>Выгоду через выручку, когда людей не сокращают, а объем растет.</li>
            </ul>
          </Fold>
        </section>
      </main>
    </div>
  );
}
