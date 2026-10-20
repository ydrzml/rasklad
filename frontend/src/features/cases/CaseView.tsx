import { useEffect, useState } from "react";

import { api, type RackType } from "../../api/client";
import { mln, term } from "../../app/format";
import { saveBlob } from "../../app/saving";
import { ShiftOnPlan } from "../../app/steps/ShiftOnPlan";
import { buyMarks } from "../../app/steps/yearPlan";
import { ActionBar, BlockHead, Button, CostChart } from "../../ui";
import { CASES, type DemoCase } from "./demoCases";
import { useCase, type CaseData } from "./load";
import { verdictNotes } from "./verdict";
import { StartFromCase, Why } from "./blocks";
import { CaseCard } from "./CaseList";
import { briefOf, CasesHeader, chargersText, Given, Sources } from "./parts";
import { CaseTop } from "./Reel";
import { twinResult } from "./twin";

const TONES: Record<string, "now" | "buy" | "rent"> = { baseline: "now", purchase: "buy", raas: "rent" };
// без правок кейса: одна и та же пустая запись, чтобы прогон смены не перезапрашивался на каждой отрисовке
const NO_OVERRIDES: Record<string, number> = {};
const NAMES: Record<string, string> = { baseline: "Без роботов", purchase: "Покупка", raas: "Аренда" };

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="u-page">
      <CasesHeader />
      <main className="u-main u-wrap k-page">
        <a className="k-back" href="/cases">
          ← Все разборы
        </a>
        {children}
      </main>
    </div>
  );
}

/* /cases/<id>: один разбор, только просмотр. Полей ввода нет, план не правится */
export function CaseView({ one }: { one: DemoCase }) {
  const [attempt, setAttempt] = useState(0);
  const { data, failed } = useCase(one, attempt);
  const [rackTypes, setRackTypes] = useState<RackType[]>([]);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    api
      .rackTypes()
      .then(setRackTypes)
      .catch(() => undefined);
  }, []);

  // только просмотр видно по странице: полей нет, внизу полоса "Посчитать свой объект".
  // Пока разбор считается или не посчитался, ролик наверху стоит заглушкой с роботом по центру
  const lead = `${one.about}.`;
  const top = (
    <>
      <header className="k-title">
        <h1>{one.title}</h1>
        <p>{lead}</p>
        <TwinLines one={one} />
      </header>
      <CaseTop one={one} data={data} failed={failed} onRetry={() => setAttempt(attempt + 1)} />
    </>
  );
  if (!data) return <Frame>{top}</Frame>;

  const brief = briefOf(data.result);
  const horizon = data.result.horizon_years;
  const scenarios = data.result.scenarios ?? [];
  const costOf = (id: string) => scenarios.find((one) => one.id === id)?.cumulative_cost_rub ?? [];
  // точки "покупка окупилась" и "дешевле аренды", как на графике шага 5
  const marks = buyMarks(costOf("purchase"), costOf("baseline"), costOf("raas").length ? costOf("raas") : null).map(
    (mark) => ({ tone: "buy" as const, at: mark.at, label: mark.label, below: mark.below }),
  );
  const download = (kind: "pdf" | "xlsx") => {
    setExporting(kind);
    setExportError("");
    api
      .report(kind, data.request, one.id)
      .then(({ blob, name }) => saveBlob(blob, name))
      .catch((error: Error) => setExportError(`Файл не собрался: ${error.message}`))
      .finally(() => setExporting(null));
  };

  return (
    <Frame>
      {top}
      {brief ? (
        <>
          {/* под первым экраном: наш результат против факта кейса, порог, если покупка не окупается,
              и сколько при круглосуточной работе */}
          {data.result.sizing && (
            <p className="u-summary-note k-twin-result">
              {twinResult(
                one.twin,
                { sizing: data.result.sizing, scenarios, horizon: data.result.horizon_years },
                { term, mln },
              )}
            </p>
          )}
          {verdictNotes(data.result).map((text) => (
            <p key={text} className="u-summary-note">
              {text}
            </p>
          ))}
          <ShiftOnPlan
            id="shift"
            autoplay
            loop
            readOnly
            sample
            facilityId="warehouse"
            operationId={one.operationId}
            robotId={one.robotId}
            robotName={one.robotName}
            fleet={brief.fleet}
            plan={data.plan}
            measures={data.measures}
            rackTypes={rackTypes}
            shiftHours={shiftHoursOf(data.parameters, data.request.overrides)}
            slotted={false}
            overrides={data.request.overrides ?? NO_OVERRIDES}
            onSlotted={() => undefined}
            onChangePlan={() => undefined}
            park={{
              facts: [
                { name: "роботов", value: String(brief.fleet), unit: chargersText(brief.chargers) },
                { name: "купить роботов", value: mln(brief.purchase.capex_rub.hardware ?? 0), unit: "млн ₽" },
                { name: "все вложения, покупка", value: mln(brief.purchase.investment_year0_rub), unit: "млн ₽" },
              ],
            }}
          />

          <section className="k-block">
            <BlockHead
              title={`Экономика коротко: три сценария за ${horizon} лет`}
              note="Сколько всего уйдет на операцию к концу каждого года. Кредит, лизинг и все допущения в отчете и в мастере"
            />
            <div className="k-econ">
              <div className="u-panel k-chart">
                <h3>
                  Накопленные затраты<span>сколько всего потрачено к концу каждого года</span>
                </h3>
                <CostChart
                  unit="млн ₽"
                  scale={1_000_000}
                  format={mln}
                  marks={marks}
                  series={scenarios.map((s) => ({
                    tone: TONES[s.id] ?? "now",
                    name: NAMES[s.id] ?? s.name,
                    points: s.cumulative_cost_rub ?? [],
                  }))}
                />
              </div>
              <div className="k-econ-side">
                <Why data={data} robotName={one.robotName} />
                <h3 className="k-small-head">Что дано</h3>
                <Given parameters={data.parameters} paths={one.inputs} overrides={data.request.overrides} />
              </div>
            </div>
          </section>

          <div className="k-pair">
            <section className="k-block k-check">
              <BlockHead title="Сверка с реальным внедрением" />
              <div className="k-real">
                <p>{one.real.text}</p>
                <Sources links={one.real.links} />
              </div>
              <a className="k-method" href="/method">
                Как мы считаем
              </a>
            </section>

            <section className="k-block k-files">
              <BlockHead
                title="Отчет и таблицы"
                note="Тот же разбор файлом: сервер считает заново вместе со сменой, до полуминуты"
              />
              <div className="k-files-row">
                <Button kind="light" disabled={exporting !== null} onClick={() => download("pdf")}>
                  {exporting === "pdf" ? "Собираем отчет" : "Отчет PDF"}
                </Button>
                <Button kind="light" disabled={exporting !== null} onClick={() => download("xlsx")}>
                  {exporting === "xlsx" ? "Собираем таблицы" : "Таблицы Excel"}
                </Button>
                {exportError && <span className="k-files-error">{exportError}</span>}
              </div>
            </section>
          </div>
        </>
      ) : (
        <p className="k-real">{data.result.message ?? "Для этого разбора сервис не нашел решения."}</p>
      )}

      <section className="k-block">
        <BlockHead title="Другие разборы" />
        <div className="k-cards is-two is-compact">
          {CASES.map((other, index) => ({ other, index }))
            .filter(({ other }) => other.id !== one.id)
            .map(({ other, index }) => (
              <CaseCard key={other.id} one={other} index={index} />
            ))}
        </div>
      </section>
      {/* свой объект липкой полосой внизу экрана, как полоса действия в мастере */}
      <ActionBar summary="Хотите посчитать свой объект? Без регистрации, значения уже стоят">
        <span className="u-action-end">
          {data && <StartFromCase data={data} />}
          <Button arrow href="/calc">
            <span>
              Посчитать<span className="u-wide"> свой объект</span>
            </span>
          </Button>
        </span>
      </ActionBar>
    </Frame>
  );
}

/* Чей склад повторяет разбор и что у них было по факту, со ссылкой на публикацию */
function TwinLines({ one }: { one: DemoCase }) {
  const { twin } = one;
  return (
    <p className="k-twin">
      Повторяем {twin.place}: {twin.given}. У них: {twin.fact}.{" "}
      <a href={twin.link.href} target="_blank" rel="noopener noreferrer">
        {twin.link.site}
      </a>
    </p>
  );
}

// длительность смены из значений разбора: прогон на плане идет часы пика, их называем частью смены
function shiftHoursOf(
  parameters: CaseData["parameters"],
  overrides: Record<string, number> | undefined,
): number | undefined {
  const path = "facilities.warehouse.schedule.shift_hours";
  return overrides?.[path] ?? parameters.find((field) => field.path === path)?.value ?? undefined;
}
