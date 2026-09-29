import { useEffect, useRef, useState } from "react";

import type {
  BudgetCheck,
  ReadinessResult,
  SensitivityResult,
  CalculationRequest,
  CalculationResult,
  Parameter,
  Plan,
  PlanMeasures,
  RackType,
  ScenarioResult,
  SimulationResult,
} from "../../api/client";
import { TRUST_TITLES, mln, money, number, percent, term } from "../format";
import {
  Alert,
  Digest,
  Digests,
  BlockHead,
  Button,
  Check,
  Compare,
  CostChart,
  Drawer,
  FleetCurve,
  Fold,
  Formula,
  Pill,
  Progress,
  Scenario,
  Scenarios,
  ShareBar,
  SourceList,
  TextButton,
  Waiting,
} from "../../ui";
import type { Tone } from "../../ui";
import { type Trouble, troubleOf, waitingInsteadOfStale } from "../flow";
import { Assumptions } from "./Assumptions";
import {
  budgetLine,
  CAPEX_NAMES,
  firstScenario,
  fleetVerdict,
  irrText,
  mln2,
  OPEX_NAMES,
  plural,
  scenarioWord,
} from "./economicsNames";
import { readinessBrief, whatIfBrief } from "./digests";
import { zoneLine } from "./peak";
import { Finance, PayRow, Ramp } from "./Finance";
import { EconomicsLedger, EconomicsSummary } from "./EconomicsSummary";
import { Readiness } from "./Readiness";
import { Sensitivity } from "./Sensitivity";
import { ShiftOnPlan } from "./ShiftOnPlan";

type Props = {
  parameters: Parameter[];
  overrides: Record<string, number>;
  onChangeParameter: (path: string, value: number | null) => void;
  result: CalculationResult | null;
  /* запрос, по которому посчитан результат: по нему же сервер считает «что будет, если» */
  request: CalculationRequest;
  loading: boolean;
  error: string | null;
  /* что мешает показать расчет и куда вести; onFix ведет на шаг с причиной, onRetry повторяет */
  trouble?: Trouble | null;
  onFix?: (step: number) => void;
  onRetry?: () => void;
  /* для смены на плане: задачи с выбранным решением и план клиента */
  facilityId: string;
  tasks: EconomicsTask[];
  plan: Plan | null;
  measures: PlanMeasures | null;
  rackTypes: RackType[];
  onEditPlan?: () => void;
  /* перейти на робозону: та же кнопка, что на шаге плана. Пусто: только смотреть */
  onRobotZone?: () => void;
  onChangePlan: (plan: Plan) => void;
  /* Задачи, снятые с расчета галочкой "без этой задачи": объект считается без них, а строка
     в разбивке остается, чтобы вернуть. Ключ задачи operationId */
  excluded?: { operationId: string; name: string }[];
  onExclude?: (operationId: string, excluded: boolean) => void;
  /* Бюджет на старте в рублях. Спрашивает его другой шаг, здесь только сравниваем.
     Если покупка в него не влезает, сводка все равно открывается на покупке, а строка над ответом
     предлагает аренду или кредит */
  budget?: number | null;
  /* расчет по ссылке: только смотреть, допущения и план не правятся */
  readOnly?: boolean;
};

/* Задача объекта и решение на нее: смена на плане гоняет роботов одной задачи за раз */
export type EconomicsTask = {
  operationId: string;
  name: string;
  robotId: string;
  robotName: string;
  /* доля объема задачи у этого решения: при смешанном парке частей у задачи две */
  share: number;
};

const keyOf = (one: { operationId: string; robotId: string }) => `${one.operationId}:${one.robotId}`;
/* Подпись части: задача, а при смешанном парке задача и доля решения */
const partName = (one: EconomicsTask) =>
  one.share < 1 ? `${one.name}: ${one.robotName} ${Math.round(one.share * 100)}%` : one.name;

const TONES: Record<string, Tone> = { baseline: "now", purchase: "buy", raas: "rent" };
const NAMES: Record<string, string> = { baseline: "Без роботов", purchase: "Покупка", raas: "Аренда" };
const NOTES: Record<string, string> = {
  baseline: "Как сейчас: работу делают люди, зарплаты растут каждый год",
  purchase: "Роботы ваши: вложения сразу, дальше обслуживание и операторы",
  raas: "Платеж в месяц вместо покупки, в конце срока выкуп",
};

// Куда ведут ссылки "как посчитано" и "Все значения и источники": якорь и блок-сводка, в котором
// он лежит. Блок сначала раскрывается, потом страница едет к якорю. Смена на плане всегда открыта
const HOMES: Record<string, string> = {
  capex: "ledger",
  opex: "ledger",
  tco: "ledger",
  ledger: "ledger",
  scenarios: "scenarios",
  years: "scenarios",
  tasks: "tasks",
  whatif: "whatif",
  readiness: "readiness",
  fleet: "basis",
  sources: "basis",
};

// Шаг 5. Сначала главный ответ словами и четыре числа, сразу под ними смена на плане, открытая,
// она идет сама. Дальше остальные блоки списком строк-сводок: три сценария, куда уходят деньги,
// по задачам, что будет, если, что подготовить и откуда цифры. Полный блок раскрывается под своей
// строкой, можно несколько сразу (docs/decisions.md, "Шаг 5: блоки списком строк-сводок")
export function Economics({
  result,
  request,
  loading,
  error,
  parameters,
  overrides,
  onChangeParameter,
  budget,
  trouble,
  onFix,
  onRetry,
  excluded = [],
  onExclude,
  ...shift
}: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  const [shiftTask, setShiftTask] = useState<string | null>(null);
  // панель "Как платить за покупку": условия кредита и лизинга, господдержка
  const [payOpen, setPayOpen] = useState(false);
  // какие блоки раскрыты под своими строками-сводками: можно несколько сразу
  const [opened, setOpened] = useState<string[]>([]);
  // куда прокрутить, когда блок раскроется по ссылке "как посчитано": якорь внутри блока
  const goal = useRef<string | null>(null);
  // ответы сервера, из которых собраны сводки "Что будет, если" и "Что подготовить"
  const [whatif, setWhatif] = useState<SensitivityResult | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  // прогон смены на плане: из него кривая парка в блоке "Откуда цифры"
  const [run, setRun] = useState<SimulationResult | null>(null);
  useEffect(() => {
    if (!goal.current) return;
    // блок раскрыт этим рендером, якорь в нем уже виден
    document.getElementById(goal.current)?.scrollIntoView({ behavior: "smooth", block: "start" });
    goal.current = null;
  }, [opened]);
  // Пока идет пересчет, прежние цифры остаются на экране приглушенными, а смена на плане
  // не пропадает и не сбрасывается (docs/ux-flow.md, «Возврат и правка»). Старую ошибку или
  // старое "не сошлось" при этом не держим: после смены решения казалось, что расчет не пошел
  if (waitingInsteadOfStale(loading, result, error ? { message: error } : null))
    return <Counting title={result || error ? "Считаем заново" : "Считаем три сценария"} />;
  if (!result && !error) return <Counting title="Считаем три сценария" />;
  if (error || !result || !result.feasible) {
    const stop = trouble ?? troubleOf(result, error ? { message: error } : null);
    return (
      <Alert tone="warn">
        <span className="u-rescale">
          <span>{stop?.text ?? error ?? result?.message}</span>
          {stop && !shift.readOnly && (
            <span className="u-action-end">
              <Button kind="ghost" onClick={() => (stop.step === null ? onRetry?.() : onFix?.(stop.step))}>
                {stop.action}
              </Button>
            </span>
          )}
        </span>
      </Alert>
    );
  }

  const sizing = result.sizing;
  // товар разложен по ходовости: параметр объекта, переключатель у смены правит его же
  const slottedField = parameters.find((one) => one.path.endsWith("slotted_by_turnover"));
  const slotted = slottedField && {
    path: slottedField.path,
    value: overrides[slottedField.path] ?? slottedField.value,
  };
  const scenarios = result.scenarios ?? [];
  const [baseline, purchase, raas] = scenarios;
  const sources = result.sources ?? [];
  const weak = result.weak_value_paths ?? [];
  if (!sizing || !baseline || !purchase || !raas) return <Waiting title="Считаем три сценария" />;
  const horizon = result.horizon_years;
  // Какой из двух сценариев с роботами дешевле за горизонт. В макете выбираем по TCO здесь,
  // в итоговой версии рекомендацию отдаст сервер вместе с выводом.
  const cheaper = purchase.tco_rub <= raas.tco_rub ? purchase : raas;
  // В сводке раскрыт один сценарий с роботами: сначала дешевый за горизонт, а если человек
  // выбрал кредит или лизинг или покупка не влезает в бюджет, покупка. Дальше выбор человека
  const choices = [purchase, raas];
  const financed = purchase.financing != null && purchase.financing.method !== "own";
  const first = firstScenario(purchase);
  const pick = choices.find((one) => one.id === picked) ?? first;
  // «кредит» из строки про бюджет: тот же выбор, что в строке «Чем платить», и сразу панель
  // условий, там ставка и срок кредита
  const toLoan = () => {
    if (!financed) onChangeParameter("financing.method", 1);
    setPicked("purchase");
    setPayOpen(true);
  };
  const risks = [...new Set([purchase, raas].flatMap((one) => one.verdict?.risks ?? []))];
  const labels = new Map(parameters.map((field) => [field.path, field.label]));
  // Разбивка по задачам. У старых сохраненных расчетов ее нет: там одна задача, и это весь объект
  const parts = result.tasks ?? [];
  // разбивка нужна и когда осталась одна задача, а другую сняли: там галочка "вернуть в расчет"
  const several = parts.length > 1 || excluded.length > 0;
  const onShift = shift.tasks.find((one) => keyOf(one) === shiftTask) ?? shift.tasks[0];
  // задача одна, а решений два: в переключателе только решения с долей, без названия задачи
  const oneTask = new Set(shift.tasks.map((one) => one.operationId)).size === 1;
  const pillName = (one: EconomicsTask) =>
    oneTask ? `${one.robotName} ${Math.round(one.share * 100)}%` : partName(one);
  const shiftPart = parts.find(
    (one) => onShift && one.operation_id === onShift.operationId && one.robot_id === onShift.robotId,
  );
  const shiftFleet = several ? (shiftPart?.sizing.fleet ?? 0) : sizing.fleet;
  const partOf = (id: string) => shiftPart?.scenarios.find((one) => one.id === id);

  const tile = (s: ScenarioResult) =>
    s.id === "baseline"
      ? [
          { label: "вложения на старте", value: "0", unit: "₽" },
          { label: "люди на операции, первый год", value: mln(s.years[0]?.staff_cost_rub ?? 0), unit: "млн ₽" },
          { label: "окупаемость", value: "вложений нет" },
        ]
      : [
          { label: "вложения на старте", value: mln(s.investment_year0_rub), unit: "млн ₽" },
          { label: "окупаемость", value: term(s.payback_cumulative_years) },
          { label: "дешевле, чем без роботов", value: mln(s.saving_rub ?? 0), unit: "млн ₽" },
        ];

  // в кредит и в лизинг на старте платим только свои деньги, остальное в долг: так и подписываем
  const startLabel = (words: string) =>
    pick.id === "raas"
      ? `${words}, аренда`
      : financed && pick.id === "purchase"
        ? `свои деньги на старте, ${purchase.financing?.method === "leasing" ? "лизинг" : "кредит"}`
        : `${words}, покупка`;
  const nameOf = (s: ScenarioResult) => (s.id === "purchase" ? scenarioWord(s) : (NAMES[s.id] ?? s.name));
  const columns = scenarios.map((s) => ({ name: nameOf(s), tone: TONES[s.id] ?? "now" }));
  const dash = (s: ScenarioResult, value: string) => (s.id === "baseline" ? "—" : value);

  // Прозрачность: у главного числа плитки видна формула словами и в цифрах, и путь к источникам
  const openSources = () => {
    const fold = document.getElementById("sources");
    if (fold instanceof HTMLDetailsElement) fold.open = true;
  };
  const how = (s: ScenarioResult) => (
    <>
      {s.id === "baseline" ? (
        <Formula
          words={`люди на операции за ${horizon} лет, зарплаты растут каждый год`}
          numbers={`${mln(s.years[0]?.staff_cost_rub ?? 0)} в первый год → ${mln(s.tco_rub)} за ${horizon} лет, млн ₽`}
        />
      ) : (
        <>
          <Formula
            words={`стоимость владения = вложения на старте + затраты за ${horizon} лет`}
            numbers={`${mln(s.tco_rub)} = ${mln(s.investment_year0_rub)} + ${mln(s.running_cost_rub ?? 0)} млн ₽`}
          />
          <Formula
            words="окупаемость по ТЗ = вложения / эффект первого года"
            numbers={`${mln(s.investment_year0_rub)} / ${mln(s.annual_effect_year1_rub ?? 0)} млн ₽ = ${term(s.payback_simple_years)}`}
          />
        </>
      )}
      <p>
        На расчете держится значений: <span className="mono">{sources.length}</span>, без подтвержденного источника:{" "}
        <span className="mono">{weak.length}</span>.{" "}
        <a href="#sources" onClick={openSources}>
          Все значения и источники
        </a>
      </p>
    </>
  );

  const isOpen = (id: string) => opened.includes(id);
  // "Подробнее" раскрывает блок прямо под строкой, остальные открытые не закрываются
  const toggle = (id: string) =>
    setOpened((now) => (now.includes(id) ? now.filter((one) => one !== id) : [...now, id]));
  // Ссылки "как посчитано", "Три сценария рядом", "Все значения и источники" ведут в блоки под
  // строками-сводками: сначала раскрыть блок, потом прокрутить к якорю в нем
  const follow = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a[href^='#']");
    const target = link?.getAttribute("href")?.slice(1) ?? "";
    const home = HOMES[target];
    if (!home) return;
    event.preventDefault();
    if (opened.includes(home)) {
      document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    goal.current = target;
    setOpened([...opened, home]);
  };

  const whatifBrief = whatIfBrief(whatif, pick.id, term);
  const readyBrief = readinessBrief(readiness);
  // кривая той задачи, что сейчас на смене: при нескольких задачах подписываем, какой
  const curve = (run?.curve_points ?? []) as [number, number][];
  const washing = Boolean(run?.segments?.some((part) => part.action === "моет"));

  return (
    <div className="u-econ" onClickCapture={follow}>
      <div className={loading ? "u-stale" : undefined} aria-busy={loading}>
        <EconomicsSummary
          result={result}
          robotName={shift.tasks.map((one) => one.robotName).join(", ")}
          pick={pick}
          choices={choices}
          onPick={setPicked}
          budget={budget}
          onRent={() => setPicked("raas")}
          onLoan={shift.readOnly || !purchase.financing ? undefined : toLoan}
          payRow={
            <PayRow
              result={result}
              purchase={purchase}
              overrides={overrides}
              onChange={onChangeParameter}
              readOnly={shift.readOnly}
              onOpen={() => setPayOpen(true)}
            />
          }
        />
        {(result.payment_problems ?? []).some((one) => one.path.startsWith("financing.")) && (
          <Alert>
            Условия кредита или лизинга неверные, покупку считаем за свои деньги.{" "}
            <TextButton onClick={() => setPayOpen(true)}>Поправить</TextButton>
          </Alert>
        )}
      </div>

      {/* Отбор на плане под погрузчик посчитан по робозоне: одна строка у задачи и путь на робозону */}
      {(result.picking_zones ?? []).map((zone) => (
        <div key={zone.operation_id} className="u-plan-warn">
          <Alert tone="note">
            {zoneLine(several ? shift.tasks.find((one) => one.operationId === zone.operation_id)?.name : "")}
          </Alert>
          {shift.onRobotZone && !shift.readOnly && (
            <Button kind="ghost" onClick={shift.onRobotZone}>
              Перейти на робозону
            </Button>
          )}
        </div>
      ))}

      {/* Сразу под ответом смена на плане, открыта: наша фишка, идет сама */}
      {onShift && (
        <ShiftOnPlan
          key={keyOf(onShift)}
          id="shift"
          autoplay
          facilityId={shift.facilityId}
          operationId={onShift.operationId}
          robotId={onShift.robotId}
          robotName={
            onShift.share < 1 ? `${onShift.robotName}, ${Math.round(onShift.share * 100)}% объема` : onShift.robotName
          }
          share={onShift.share}
          fleet={shiftFleet}
          switcher={
            // плитки нужны, когда в расчете больше одной части: одна задача после снятия
            // остальных обходится заголовком, плитка «AMR 1500 100%» только путала
            shift.tasks.length > 1
              ? shift.tasks.map((one) => (
                  <Pill
                    key={keyOf(one)}
                    active={keyOf(one) === keyOf(onShift)}
                    onClick={() => setShiftTask(keyOf(one))}
                  >
                    {pillName(one)}
                  </Pill>
                ))
              : undefined
          }
          plan={shift.plan}
          measures={shift.measures}
          rackTypes={shift.rackTypes}
          slotted={slotted?.value === 1}
          overrides={overrides}
          onChangePlan={shift.onChangePlan}
          onSlotted={(next) => slotted && onChangeParameter(slotted.path, next ? 1 : 0)}
          onEditPlan={shift.readOnly ? undefined : shift.onEditPlan}
          readOnly={shift.readOnly}
          onRun={setRun}
          park={{
            facts: several
              ? [
                  // у нескольких задач справа парк этой задачи, а вложения всего объекта
                  {
                    name: "роботов",
                    value: String(shiftFleet),
                    unit: `и ${shiftPart?.sizing.chargers ?? 0} ${plural(shiftPart?.sizing.chargers ?? 0, "зарядка", "зарядки", "зарядок")}`,
                  },
                  { name: "купить роботов", value: mln(partOf("purchase")?.capex_rub?.hardware ?? 0), unit: "млн ₽" },
                  ...(partOf("raas")?.opex_year1_items_rub?.raas_fee
                    ? [
                        {
                          name: "или аренда",
                          value: mln(partOf("raas")?.opex_year1_items_rub?.raas_fee ?? 0),
                          unit: "млн ₽ в год",
                        },
                      ]
                    : []),
                  {
                    name: startLabel("вложения объекта"),
                    value: mln(pick.investment_year0_rub),
                    unit: "млн ₽",
                  },
                ]
              : [
                  {
                    name: "роботов",
                    value: String(sizing.fleet),
                    unit: `и ${sizing.chargers} ${plural(sizing.chargers, "зарядка", "зарядки", "зарядок")}`,
                  },
                  { name: "купить роботов", value: mln(purchase.capex_rub.hardware ?? 0), unit: "млн ₽" },
                  ...(raas.years[0]?.opex_rub.raas_fee
                    ? [{ name: "или аренда", value: mln(raas.years[0].opex_rub.raas_fee), unit: "млн ₽ в год" }]
                    : []),
                  {
                    name: startLabel("все вложения"),
                    value: mln(pick.investment_year0_rub),
                    unit: "млн ₽",
                  },
                ],
            budget: budget ? <BudgetNote budget={budget} check={result.budget} pick={pick} /> : null,
          }}
        />
      )}

      {/* Остальные блоки списком: строка-сводка с главными цифрами, полный блок под ней по "Подробнее" */}
      <Digests>
        <Digest
          id="scenarios"
          title={`Три сценария за ${horizon} лет`}
          open={isOpen("scenarios")}
          onToggle={() => toggle("scenarios")}
          facts={scenarios.map((s) => ({ label: nameOf(s), value: mln(s.tco_rub), unit: "млн ₽" }))}
          line={`Стоимость владения. Дешевле: ${NAMES[cheaper.id].toLowerCase()}, окупаемость ${term(cheaper.payback_cumulative_years)}`}
        >
          <section id="scenarios" className={loading ? "u-stale" : undefined} aria-busy={loading}>
            <BlockHead
              title="Три сценария за пять лет"
              note={`Стоимость владения это все, что уйдет на операцию за ${horizon} лет: вложения, люди, операторы, обслуживание. Без роботов это только зарплаты`}
            />
            <Scenarios>
              {scenarios.map((s) => (
                <Scenario
                  key={s.id}
                  tone={TONES[s.id] ?? "now"}
                  name={nameOf(s)}
                  note={NOTES[s.id] ?? ""}
                  headline={{ label: `стоимость владения за ${horizon} лет`, value: mln(s.tco_rub), unit: "млн ₽" }}
                  facts={tile(s)}
                  how={how(s)}
                  best={s.id === cheaper.id}
                  badge={s.id === cheaper.id ? `дешевле за ${horizon} лет` : undefined}
                />
              ))}
            </Scenarios>

            <div className="u-money-row">
              <div className="u-panel">
                <h3>
                  Накопленные затраты<span>сколько всего потрачено к концу каждого года</span>
                </h3>
                <CostChart
                  unit="млн ₽"
                  scale={1_000_000}
                  format={mln}
                  series={scenarios.map((s) => ({
                    tone: TONES[s.id] ?? "now",
                    name: nameOf(s),
                    points: s.cumulative_cost_rub ?? [],
                  }))}
                />
              </div>
              <div className="u-panel">
                <h3>Что может сдвинуть вывод</h3>
                <ul className="u-risks">
                  {risks.map((risk) => {
                    const [head, ...rest] = risk.split(": ");
                    return (
                      <li key={risk}>
                        {rest.length > 0 ? (
                          <>
                            <b>{head}</b>
                            {rest.join(": ")}
                          </>
                        ) : (
                          risk
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            <Fold title="Все показатели сценариев">
              <Compare
                columns={columns}
                rows={[
                  { label: "Вложения на старте", cells: scenarios.map((s) => money(s.investment_year0_rub)) },
                  {
                    label: "Годовой эффект",
                    hint: "первый год, против работы без роботов",
                    cells: scenarios.map((s) => dash(s, money(s.annual_effect_year1_rub))),
                  },
                  {
                    label: "Окупаемость по ТЗ",
                    hint: "вложения / эффект первого года",
                    cells: scenarios.map((s) => dash(s, term(s.payback_simple_years))),
                  },
                  {
                    label: "Окупаемость по потоку",
                    hint: financed
                      ? "с ростом цен и выкупом, в кредит и в лизинг с учетом остатка долга"
                      : "с ростом цен и выкупом",
                    cells: scenarios.map((s) => dash(s, term(s.payback_cumulative_years))),
                  },
                  { label: "ROI по ТЗ", cells: scenarios.map((s) => dash(s, percent(s.roi_tz))) },
                  { label: "Чистый ROI", cells: scenarios.map((s) => dash(s, percent(s.roi_net))) },
                  { label: `Стоимость владения за ${horizon} лет`, cells: scenarios.map((s) => money(s.tco_rub)) },
                  { label: "NPV", hint: "чистая приведенная стоимость", cells: scenarios.map((s) => money(s.npv_rub)) },
                  {
                    label: financed ? "IRR проекта" : "IRR",
                    hint: "ставка, при которой NPV = 0. Выше 100% вложения возвращаются быстрее, чем за год, точная ставка ничего не добавляет",
                    cells: scenarios.map((s) =>
                      dash(
                        s,
                        s.financing && s.financing.method !== "own"
                          ? irrText(s.financing.plain_irr, s.financing.plain_npv_rub, s.capex_after_grant_rub ?? 0)
                          : irrText(s.irr, s.npv_rub, s.investment_year0_rub),
                      ),
                    ),
                  },
                  ...(financed
                    ? [
                        {
                          label: "IRR своих денег",
                          hint: "от первого взноса, с платежами по долгу: при маленьком взносе всегда высокий",
                          cells: scenarios.map((s) =>
                            dash(
                              s,
                              s.id === "purchase" ? irrText(s.irr, s.npv_rub, s.investment_year0_rub) : "без долга",
                            ),
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </Fold>
            <Fold id="years" title={`${nameOf(pick)}: деньги по годам`}>
              <Compare
                columns={[{ name: "старт" }, ...pick.years.map((y) => ({ name: `${y.year} год` }))]}
                rows={[
                  {
                    label: "Вложения",
                    hint: "на старте, потом выкуп и обновление парка",
                    cells: [mln(pick.investment_year0_rub), ...pick.years.map((y) => mln(y.investment_rub))],
                  },
                  ...(pick.years.some((y) => (y.financing_rub ?? 0) > 0)
                    ? [
                        {
                          label: "Платежи по долгу",
                          hint: "кредит или лизинг",
                          cells: ["", ...pick.years.map((y) => mln(y.financing_rub ?? 0))],
                        },
                      ]
                    : []),
                  ...(pick.years.some((y) => (y.support_rub ?? 0) > 0)
                    ? [
                        {
                          label: "Господдержка",
                          hint: "пришла в этом году",
                          cells: ["", ...pick.years.map((y) => mln(y.support_rub ?? 0))],
                        },
                      ]
                    : []),
                  ...(pick.years.some((y) => (y.insurance_rub ?? 0) > 0)
                    ? [
                        {
                          label: "Страховка",
                          hint: "залога или предмета лизинга, пока есть долг",
                          cells: ["", ...pick.years.map((y) => mln(y.insurance_rub ?? 0))],
                        },
                      ]
                    : []),
                  {
                    label: "Люди без роботов",
                    hint: "с ростом зарплат",
                    cells: ["", ...baseline.years.map((y) => mln(y.staff_cost_rub))],
                  },
                  {
                    label: "Люди с роботами",
                    hint: "кто остался на операции",
                    cells: ["", ...pick.years.map((y) => mln(y.staff_cost_rub))],
                  },
                  ...Object.keys(Object.assign({}, ...pick.years.map((y) => y.opex_rub))).map((item) => ({
                    label: OPEX_NAMES[item] ?? item,
                    cells: ["", ...pick.years.map((y) => mln(y.opex_rub[item] ?? 0))],
                  })),
                  {
                    label: "Затраты на роботов",
                    hint: "сумма статей выше",
                    cells: ["", ...pick.years.map((y) => mln(y.opex_total_rub))],
                  },
                  {
                    label: "Экономия",
                    hint: "люди без роботов - люди с роботами - затраты на роботов",
                    cells: ["", ...pick.years.map((y) => mln(y.effect_rub))],
                  },
                  {
                    label: "Накопленные затраты",
                    hint: "как на графике",
                    cells: (pick.cumulative_cost_rub ?? []).map((value) => mln(value)),
                  },
                  {
                    label: "Амортизация",
                    hint: "для учета, в затраты не входит",
                    cells: ["", ...pick.years.map((y) => mln(y.amortization_rub))],
                  },
                ]}
              />
              <p className="u-frow-hint">
                Все суммы в миллионах рублей. Годы считаем целиком: вложения на старте, затраты в конце каждого года.
              </p>
            </Fold>
          </section>
        </Digest>
        <Digest
          id="ledger"
          title="Куда уходят деньги"
          open={isOpen("ledger")}
          onToggle={() => toggle("ledger")}
          facts={[
            { label: "на старте", value: mln(pick.capex_after_grant_rub ?? pick.investment_year0_rub), unit: "млн ₽" },
            { label: "в год", value: mln(pick.years[0]?.opex_total_rub ?? 0), unit: "млн ₽" },
            { label: `за ${horizon} лет`, value: mln(pick.tco_rub), unit: "млн ₽" },
          ]}
          line={`${nameOf(pick)}: CAPEX, OPEX и стоимость владения по статьям`}
        >
          <div className={loading ? "u-stale" : undefined} aria-busy={loading}>
            <EconomicsLedger result={result} pick={pick}>
              {!shift.readOnly && <Ramp result={result} overrides={overrides} onChange={onChangeParameter} />}
            </EconomicsLedger>
          </div>
        </Digest>
        {several && (
          <Digest
            id="tasks"
            title="По задачам"
            open={isOpen("tasks")}
            onToggle={() => toggle("tasks")}
            facts={parts.slice(0, 3).map((part) => ({
              label:
                (part.share ?? 1) < 1
                  ? `${part.operation_name}, ${Math.round((part.share ?? 1) * 100)}%`
                  : part.operation_name,
              value: term(part.scenarios.find((one) => one.id === pick.id)?.payback_years),
            }))}
            line="Окупаемость каждой задачи самой по себе, общее на объект отдельно"
          >
            <section id="tasks" className={loading ? "u-stale" : undefined} aria-busy={loading}>
              <TasksBreakdown
                result={result}
                pick={pick}
                tasks={shift.tasks}
                excluded={excluded}
                onExclude={shift.readOnly ? undefined : onExclude}
              />
            </section>
          </Digest>
        )}
        <Digest
          id="whatif"
          title="Что будет, если"
          open={isOpen("whatif")}
          onToggle={() => toggle("whatif")}
          facts={whatifBrief.facts}
          line={whatifBrief.line}
        >
          <Sensitivity request={request} scenario={pick.id} version={result} onBrief={setWhatif} />
        </Digest>
        <Digest
          id="readiness"
          title="Что подготовить на складе"
          open={isOpen("readiness")}
          onToggle={() => toggle("readiness")}
          facts={readyBrief.facts}
          line={readyBrief.line}
        >
          <Readiness request={request} result={result} onBrief={setReadiness} />
        </Digest>
        <Digest
          id="basis"
          title="Откуда цифры"
          open={isOpen("basis")}
          onToggle={() => toggle("basis")}
          facts={[
            { label: "значений", value: String(sources.length) },
            { label: "без источника", value: String(weak.length) },
            { label: "вы поправили", value: String(Object.keys(overrides).length) },
          ]}
          line="Как подобран парк, что мы приняли за вас и источник каждой цифры"
        >
          <section>
            <BlockHead
              title="На чем держится расчет"
              note={`${sources.length} значений, из них ${weak.length} без подтвержденного источника`}
            />
            {/* Обоснование числа роботов (ТЗ): кривая парка из прогона смены. Под сменой она ломала
                размер блока, поэтому здесь, а у смены осталась строка вывода. Ссылка "как подобран
                парк" под числом роботов ведет сюда */}
            <div id="fleet" className="u-shift-curve u-fleet">
              <h3>Как подобран парк{onShift && shift.tasks.length > 1 ? `: ${pillName(onShift)}` : ""}</h3>
              {run && <FleetCurve points={curve} demand={run.design_demand ?? 0} fleet={shiftFleet} />}
              <p className="u-shift-note">
                {run ? (
                  <>
                    {fleetVerdict({
                      needed: run.fleet_needed ?? null,
                      fleet: shiftFleet,
                      demand: run.design_demand ?? 0,
                      washing,
                    })}
                    .{" "}
                    {washing
                      ? "Парк подобран прогоном смены на вашем плане: самый маленький, который успевает площадь смены с запасом."
                      : "Парк подобран прогоном смены на вашем плане, с очередями у ворот и в проездах и зарядкой: это самый маленький парк, который вытянул спрос часа пик с резервом."}{" "}
                    <a href="#shift">Смена на плане</a>
                  </>
                ) : (
                  "Кривая появится, когда посчитается смена на плане."
                )}
              </p>
            </div>
            {!shift.readOnly && (
              <Assumptions
                parameters={parameters}
                robots={shift.tasks.map((one) => one.robotId)}
                overrides={overrides}
                onChange={onChangeParameter}
              />
            )}
            <Fold id="sources" title={`Откуда цифры: ${sources.length}`}>
              <SourceList
                items={sources.map((source) => ({
                  key: source.path,
                  name: labels.get(source.path) ?? (source.name || source.path),
                  value: `${Array.isArray(source.value) ? source.value.join("-") : number(source.value, 3)}${source.unit ? ` ${source.unit}` : ""}`,
                  // правку человека видно сразу, а наш источник остается рядом: с чем он спорит
                  source:
                    source.path in overrides
                      ? `Задал пользователь. У нас был источник: ${source.source}`
                      : source.source,
                  trust: source.trust,
                  trustTitle: TRUST_TITLES[source.trust] ?? source.trust,
                }))}
              />
            </Fold>
          </section>
        </Digest>
      </Digests>

      {purchase.financing && (
        <Drawer open={payOpen} title="Как платить за покупку" onClose={() => setPayOpen(false)}>
          {/* Всю панель на пересчете больше не гасим: она мигала на каждом отпускании ползунка.
              Приглушаются только числа плиток, и то если сервер думает дольше мгновения */}
          <div aria-busy={loading}>
            {/* ключ по способу оплаты: ошибка срока у лизинга не переезжает к полю кредита */}
            <Finance
              key={overrides["financing.method"] ?? 0}
              result={result}
              purchase={purchase}
              overrides={overrides}
              onChange={onChangeParameter}
              readOnly={shift.readOnly}
              busy={loading}
            />
          </div>
        </Drawer>
      )}
    </div>
  );
}

/* По задачам: сколько стоит каждая задача сама по себе и что общее на объект. Сумму строк посчитал
   сервер: объект целиком это задачи и общее, здесь только раскладываем по строкам */
// Бюджет рядом с парком. Укладывается: одна строка. Нет: сколько роботов бюджет покупает и какую
// долю спроса смены они вытянут по прогону, это считает сервер вместе с расчетом
function BudgetNote({ budget, check, pick }: { budget: number; check?: BudgetCheck | null; pick: ScenarioResult }) {
  // в кредит и в лизинг с бюджетом сравниваем свои деньги на старте: долг для того и берут
  const financed = pick.financing != null && pick.financing.method !== "own";
  if (pick.investment_year0_rub <= budget)
    return (
      <Alert tone="note">
        {financed
          ? `Свои деньги на старте укладываются в бюджет ${mln(budget)} млн ₽, остальное в ${pick.financing?.method === "leasing" ? "лизинг" : "кредит"}`
          : `Укладывается в бюджет ${mln(budget)} млн ₽`}
      </Alert>
    );
  // по строке на задачу, простыми словами: сколько роботов можно купить и сколько работы они сделают
  const rows = (check?.tasks ?? []).map(budgetLine);
  return (
    <Alert tone="warn">
      Больше бюджета {mln(budget)} млн ₽
      {rows.map((row) => (
        <span key={row} className="u-alert-line">
          {row}
        </span>
      ))}
      {check?.raas_fits && pick.id !== "raas" && (
        <span className="u-alert-line">Аренда в бюджет укладывается: роботы в ней оплачиваются помесячно</span>
      )}
    </Alert>
  );
}

function TasksBreakdown({
  result,
  pick,
  tasks,
  excluded,
  onExclude,
}: {
  result: CalculationResult;
  pick: ScenarioResult;
  tasks: EconomicsTask[];
  excluded: { operationId: string; name: string }[];
  onExclude?: (operationId: string, excluded: boolean) => void;
}) {
  const horizon = result.horizon_years;
  const shared = result.shared;
  const common = shared?.scenarios.find((one) => one.id === pick.id);
  const parts = result.tasks ?? [];
  const counted = new Set(parts.map((one) => one.operation_id));
  const canExclude = Boolean(onExclude) && counted.size + excluded.length > 1;
  const nameOf = (task: (typeof parts)[number]) => {
    const share = task.share ?? 1;
    return share < 1 ? `${task.operation_name}, ${Math.round(share * 100)}% объема` : task.operation_name;
  };
  const robotOf = (task: (typeof parts)[number]) =>
    tasks.find((one) => one.operationId === task.operation_id && one.robotId === task.robot_id)?.robotName ??
    task.robot_id;
  const partOf = (task: (typeof parts)[number]) => task.scenarios.find((one) => one.id === pick.id);
  // Галочка "в расчете": стоит у всех задач, сняли, и объект считается без задачи. Последнюю
  // оставшуюся снять нельзя: считать было бы нечего
  const toggle = (operationId: string, name: string, off: boolean) => {
    const last = !off && counted.size === 1;
    return (
      onExclude && (
        <Check
          label="в расчете"
          checked={!off}
          disabled={last}
          onToggle={() => onExclude(operationId, !off)}
          title={
            last
              ? "Последнюю задачу снять нельзя: без нее считать нечего"
              : off
                ? `${name}: вернуть задачу в расчет`
                : `${name}: посмотреть объект без этой задачи. Задача остается выбранной, ее можно вернуть`
          }
        />
      )
    );
  };
  // доли: задачи и общее на объект в вложениях, затратах на роботов в год и экономии
  const shareParts = (
    take: (part: { investment_year0_rub: number; opex_year1_rub: number; effect_year1_rub: number }) => number,
  ) => [
    ...parts.map((task) => ({
      key: `${task.operation_id}:${task.robot_id}`,
      name: nameOf(task),
      value: take(partOf(task)!),
    })),
    ...(common ? [{ key: "shared", name: "общее на объект", value: take(common), grey: true }] : []),
  ];
  const effects = shareParts((part) => part.effect_year1_rub);
  const items = (part: { capex_rub?: Record<string, number>; opex_year1_items_rub?: Record<string, number> }) => [
    ...Object.entries(part.capex_rub ?? {})
      .filter(([, value]) => value > 0)
      .map(([item, value]) => ({ label: CAPEX_NAMES[item] ?? item, hint: "разово, на старте", cells: [mln2(value)] })),
    ...Object.entries(part.opex_year1_items_rub ?? {})
      .filter(([, value]) => value > 0)
      .map(([item, value]) => ({ label: OPEX_NAMES[item] ?? item, hint: "первый год", cells: [mln2(value)] })),
  ];
  const fact = (name: string, value: string, warn = false) => (
    <span className="u-taskrow-fact">
      {name}
      <b className={warn ? "warn" : undefined}>{value}</b>
    </span>
  );
  return (
    <>
      <BlockHead
        title="По задачам"
        note={`${pick.id === "purchase" ? scenarioWord(pick) : (NAMES[pick.id] ?? pick.name)}, как в сводке: объект целиком ${mln2(pick.capex_after_grant_rub ?? pick.investment_year0_rub)} млн ₽ на старте, ${term(pick.payback_cumulative_years)}. Ниже, сколько из этого берет каждая задача и что общее на объект`}
      />
      <ShareBar
        label="Вложения на старте"
        unit="млн ₽"
        format={mln2}
        parts={shareParts((part) => part.investment_year0_rub)}
      />
      <ShareBar
        label="Затраты на роботов в год"
        unit="млн ₽"
        format={mln2}
        parts={shareParts((part) => part.opex_year1_rub)}
      />
      {effects.every((part) => part.value >= 0) ? (
        <ShareBar label="Экономия в год" unit="млн ₽" format={mln2} parts={effects} />
      ) : (
        <p className="u-frow-hint">
          Экономия в год:{" "}
          {effects.map((part) => `${part.name} ${part.value >= 0 ? "+" : "-"}${mln2(Math.abs(part.value))}`).join(", ")}{" "}
          млн ₽. Полосой не показываем: у части задач она меньше нуля
        </p>
      )}

      {parts.map((task, index, all) => {
        const part = partOf(task);
        const firstPart = all.findIndex((one) => one.operation_id === task.operation_id) === index;
        return (
          <div key={`${task.operation_id}:${task.robot_id}`} className="u-taskrow">
            <span className="u-taskrow-name">
              {nameOf(task)}
              <small>{robotOf(task)}</small>
            </span>
            {fact("роботов", String(task.sizing.fleet))}
            {fact("на старте", part ? `${mln2(part.investment_year0_rub)} млн` : "—")}
            {fact("в год", part ? `${mln2(part.opex_year1_rub)} млн` : "—")}
            {fact(`за ${horizon} лет`, part ? `${mln2(part.tco_rub)} млн` : "—")}
            {fact(
              "окупаемость сама по себе",
              part?.payback_years == null ? "не окупается" : term(part.payback_years),
              part?.payback_years == null,
            )}
            {canExclude && firstPart && toggle(task.operation_id, task.operation_name, false)}
            {part && (
              <Fold title="статьи задачи" thin>
                <Compare columns={[{ name: "млн ₽" }]} rows={items(part)} />
              </Fold>
            )}
          </div>
        );
      })}
      {excluded.map((one) => (
        <div key={one.operationId} className="u-taskrow is-muted">
          <span className="u-taskrow-name">
            {one.name}
            <small>снята с расчета: объект посчитан без нее</small>
          </span>
          {canExclude && toggle(one.operationId, one.name, true)}
        </div>
      ))}
      {shared && common && (
        <div className="u-taskrow">
          <span className="u-taskrow-name">
            Общее на объект
            <small>
              интеграция, инфраструктура, связь и {shared.operator_posts}{" "}
              {plural(shared.operator_posts, "дежурный", "дежурных", "дежурных")} в смену на весь парк. Делается один
              раз, сколько бы задач ни было
            </small>
          </span>
          {fact("на старте", `${mln2(common.investment_year0_rub)} млн`)}
          {fact("в год", `${mln2(common.opex_year1_rub)} млн`)}
          {fact(`за ${horizon} лет`, `${mln2(common.tco_rub)} млн`)}
          <Fold title="статьи общего" thin>
            <Compare columns={[{ name: "млн ₽" }]} rows={items(common)} />
          </Fold>
        </div>
      )}
    </>
  );
}

/* Ожидание расчета: полоса и этапы. Сервер отвечает целиком, поэтому этапы примерные, по времени:
   парк подбирается быстро, дольше всего идет прогон смены на плане */
const STAGES = [
  { name: "Подбираем парк", share: 0.2 },
  { name: "Гоняем смену на вашем плане", share: 0.6 },
  { name: "Считаем деньги на пять лет", share: 0.2 },
];

function Counting({ title }: { title: string }) {
  return (
    <Progress
      title={title}
      stages={STAGES}
      seconds={12}
      note="Обычно это несколько секунд, с прогоном смены до полуминуты. Этапы примерные: сервер присылает ответ целиком."
    />
  );
}
