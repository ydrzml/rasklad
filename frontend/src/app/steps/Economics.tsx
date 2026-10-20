import { useEffect, useMemo, useRef, useState } from "react";

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
import { TRUST_TITLES, mln, number, term } from "../format";
import {
  Alert,
  Digest,
  Digests,
  BlockHead,
  Button,
  Check,
  Compare,
  Drawer,
  FleetCurve,
  Fold,
  Pill,
  Progress,
  ShareBar,
  SourceList,
  TextButton,
  Waiting,
} from "../../ui";
import { type Trouble, troubleOf, waitingInsteadOfStale } from "../flow";
import { Assumptions } from "./Assumptions";
import { budgetLine, CAPEX_NAMES, fleetVerdict, mln2, OPEX_NAMES, plural, scenarioWord } from "./economicsNames";
import { readinessBrief, whatIfBrief } from "./digests";
import { zoneLine } from "./peak";
import { Finance, Ramp } from "./Finance";
import { BaselineDetail, ChosenResult } from "./ChosenResult";
import { CardsHow } from "./CardsHow";
import { PlanByYears } from "./PlanByYears";
import { hasYearPlan } from "./yearPlan";
import { PayLine, usePurchases } from "./PayWays";
import { DEFAULT_WAYS, shiftOverrides, type PayWay } from "./paymentWays";
import { BaselineLedger, YearsTable } from "./ScenarioMoney";
import { ScenarioSwitch, type BuyWay, type Shown } from "./ScenarioSwitch";
import { watchWords } from "../heads";
import { EconomicsLedger, EconomicsSummary } from "./EconomicsSummary";
import { ForDecision } from "./ForDecision";
import { Readiness } from "./Readiness";
import { Sensitivity } from "./Sensitivity";
import { ShiftOnPlan } from "./ShiftOnPlan";
import { ShiftTogether } from "./ShiftTogether";

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
  /* "готовы вложить в покупку от" (?v=e): нижняя граница бюджета */
  budgetFrom?: number | null;
  /* способы оплаты, отмеченные на шаге решения: считаем их рядом под главным ответом */
  payWays?: PayWay[];
  onEditPayWays?: () => void;
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

const TOGETHER = "together";
const keyOf = (one: { operationId: string; robotId: string }) => `${one.operationId}:${one.robotId}`;
/* Подпись части: задача, а при смешанном парке задача и доля решения */
const partName = (one: EconomicsTask) =>
  one.share < 1 ? `${one.name}: ${one.robotName} ${Math.round(one.share * 100)}%` : one.name;

const NAMES: Record<string, string> = { baseline: "Без роботов", purchase: "Покупка", raas: "Аренда" };
// покупку за свои, в кредит и в лизинг считаем рядом: строка способов оплаты под переключателем
const BUY_WAYS: PayWay[] = ["own", "loan", "leasing"];
const BY_METHOD: Record<string, BuyWay> = { own: "own", loan: "loan", leasing: "leasing" };

// Куда ведут ссылки "как посчитано" и "Все значения и источники": якорь и блок-сводка, в котором
// он лежит. Блок сначала раскрывается, потом страница едет к якорю. Смена на плане всегда открыта
const HOMES: Record<string, string> = {
  capex: "ledger",
  opex: "ledger",
  tco: "ledger",
  ledger: "ledger",
  years: "ledger",
  tasks: "tasks",
  whatif: "whatif",
  readiness: "readiness",
  fleet: "basis",
  sources: "basis",
  shift: "shiftplan",
};

// Шаг 5. Сверху вывод и три карточки: без роботов, покупка и аренда (ChosenResult), под ними свернуто,
// как они посчитаны (CardsHow). Ниже один переключатель сценария, он липнет к экрану (ScenarioSwitch):
// у покупки способ оплаты, свои деньги, кредит или лизинг. Все ниже по выбранному: подробности и строки-
// сводки смены на плане, куда уходят деньги, по задачам, что будет, если, что подготовить и откуда цифры.
// Полный блок раскрывается под своей строкой, можно несколько сразу (docs/decisions.md, "Шаг 5: один
// переключатель сценария")
export function Economics({
  result,
  request,
  loading,
  error,
  parameters,
  overrides,
  onChangeParameter,
  budget,
  budgetFrom = null,
  payWays,
  onEditPayWays,
  trouble,
  onFix,
  onRetry,
  excluded = [],
  onExclude,
  ...shift
}: Props) {
  // что показано ниже: без роботов, покупка или аренда. Пусто: по выбору с шага 4
  const [picked, setPicked] = useState<Shown | null>(null);
  const [shiftTask, setShiftTask] = useState<string | null>(null);
  // панель "Как платить за покупку": условия кредита и лизинга, господдержка
  const [payOpen, setPayOpen] = useState(false);
  // какие блоки раскрыты под своими строками-сводками: можно несколько сразу. Смена на плане
  // не сворачивается совсем, она здесь только для ссылок "как подобран парк"
  // Только то, что человек раскрыл или свернул сам. Остальное по умолчанию: смена на плане всегда
  // раскрыта, "Что будет, если" раскрыт, когда расчет не в пользу показанного
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // куда прокрутить, когда блок раскроется по ссылке "как посчитано": якорь внутри блока
  const goal = useRef<string | null>(null);
  // ответы сервера, из которых собраны сводки "Что будет, если" и "Что подготовить"
  const [whatif, setWhatif] = useState<SensitivityResult | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  // прогон смены на плане: из него кривая парка в блоке "Откуда цифры"
  const [run, setRun] = useState<SimulationResult | null>(null);
  // покупка за свои, в кредит и в лизинг на тех же роботах: для строки способов оплаты и бюджета.
  // Покупку текущим способом берем из расчета, остальные сервер досчитывает отдельными запросами
  // Пока идет основной пересчет, не спрашиваем: иначе тот же расчет шел бы дважды разом
  const pay = usePurchases(result?.feasible && !loading ? result : null, request, BUY_WAYS);
  // смене на плане только правки, от которых она зависит: щелчок "Кредит" ее не перегоняет
  const shiftKey = JSON.stringify(shiftOverrides(overrides));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- ключ собирает те же правки
  const forShift = useMemo(() => shiftOverrides(overrides), [shiftKey]);
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
  // Что показано ниже по умолчанию: то, что человек выбрал на шаге 4; если оба, более дешевое за
  // горизонт. Дальше выбор переключателем или карточкой
  const wantBuy = !payWays || payWays.some((one) => one !== "raas");
  const wantRent = !payWays || payWays.includes("raas");
  const chosenFirst = wantRent && (!wantBuy || raas.tco_rub < purchase.tco_rub) ? raas : purchase;
  const shown: Shown = picked ?? (chosenFirst.id === "raas" ? "raas" : "purchase");
  const shownScenario = shown === "baseline" ? baseline : shown === "raas" ? raas : purchase;
  // блокам только про роботов (по задачам, что будет, если) при "без роботов" нужен сценарий с
  // роботами: берем тот, что выбран на шаге 4
  const pick = shown === "baseline" ? chosenFirst : shownScenario;
  const choices = [purchase, raas];
  const financed = purchase.financing != null && purchase.financing.method !== "own";
  // Способ оплаты покупки: чем посчитал сервер. Пока идет пересчет, уже то, что человек выбрал. Если
  // условия кредита неверные, сервер считает за свои деньги, и переключатель показывает так же
  const asked = overrides["financing.method"];
  const wrongTerms = (result.payment_problems ?? []).some((one) => one.path.startsWith("financing."));
  const way: BuyWay =
    loading && asked != null
      ? asked === 1
        ? "loan"
        : asked === 2
          ? "leasing"
          : "own"
      : (BY_METHOD[purchase.financing?.method ?? ""] ?? "own");
  // кредит и лизинг на шаге 5: тот же способ оплаты, что в панели условий, сервер пересчитывает
  const onWay = (next: BuyWay) => {
    onChangeParameter("financing.method", next === "own" ? null : next === "loan" ? 1 : 2);
    setPicked("purchase");
  };
  const toLoan = () => onWay("loan");
  // Расчет не в пользу показанного: дороже людей, покупка не окупается за горизонт или не влезает в
  // бюджет. Тогда сначала что поменять, а смена на плане ниже (замечание Саши 19.10)
  const losing = (one: ScenarioResult) =>
    (one.saving_rub ?? 0) < 0 || (one.id === "purchase" && one.payback_cumulative_years == null);
  const bad =
    shown === "baseline"
      ? losing(purchase) && losing(raas)
      : losing(shownScenario) ||
        // у кредита и лизинга с бюджетом сравниваем свои деньги на старте, у аренды подготовку склада
        (budget != null && shownScenario.investment_year0_rub > budget);
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
  // Все задачи вместе: прогоны частей наложены на один план. Плитка последней, по умолчанию
  // открыта первая задача, как было: цифры справа у смены не меняются
  const together = shiftTask === TOGETHER && shift.tasks.length > 1;
  const togetherParts = shift.tasks.map((one) => ({
    key: keyOf(one),
    operationId: one.operationId,
    robotId: one.robotId,
    name: pillName(one),
    share: one.share,
    fleet:
      parts.find((part) => part.operation_id === one.operationId && part.robot_id === one.robotId)?.sizing.fleet ?? 0,
  }));
  // разные роботы на складе: строка рядом с итогами смены, что помехи между ними не считаем (аудит А6)
  const mixed = new Set(shift.tasks.map((one) => one.robotId)).size > 1;
  // плитки нужны, когда в расчете больше одной части: одна задача после снятия
  // остальных обходится заголовком, плитка «AMR 1500 100%» только путала
  const switcher =
    shift.tasks.length > 1 ? (
      <>
        {shift.tasks.map((one) => (
          <Pill
            key={keyOf(one)}
            active={!together && onShift !== undefined && keyOf(one) === keyOf(onShift)}
            onClick={() => setShiftTask(keyOf(one))}
          >
            {pillName(one)}
          </Pill>
        ))}
        <Pill active={together} onClick={() => setShiftTask(TOGETHER)}>
          Все задачи вместе
        </Pill>
      </>
    ) : undefined;

  // в кредит и в лизинг на старте платим только свои деньги, остальное в долг: так и подписываем
  const startLabel = (words: string) =>
    pick.id === "raas"
      ? `${words}, аренда`
      : financed && pick.id === "purchase"
        ? `свои деньги на старте, ${purchase.financing?.method === "leasing" ? "лизинг" : "кредит"}`
        : `${words}, покупка`;
  const nameOf = (s: ScenarioResult) => (s.id === "purchase" ? scenarioWord(s) : (NAMES[s.id] ?? s.name));
  // Прозрачность: путь к источникам из свертки "Как посчитаны карточки"
  const openSources = () => {
    const fold = document.getElementById("sources");
    if (fold instanceof HTMLDetailsElement) fold.open = true;
  };

  // Расчет не в пользу показанного: "Что будет, если" раскрыт сразу, пока его не свернули.
  // Раскрытость держим как отличие от этого по умолчанию: щелчок переворачивает
  const isOpen = (id: string) => opened[id] ?? (id === "shiftplan" || (bad && id === "whatif"));
  // "Подробнее" раскрывает блок прямо под строкой, остальные открытые не закрываются
  const toggle = (id: string) => setOpened((now) => ({ ...now, [id]: !isOpen(id) }));
  // Ссылки "как посчитано", "Все значения и источники" и другие якоря шага: свертки на пути к якорю
  // раскрыть, блок-сводку раскрыть, потом прокрутить к якорю в нем
  const follow = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a[href^='#']");
    const target = link?.getAttribute("href")?.slice(1) ?? "";
    const place = target ? document.getElementById(target) : null;
    const home = HOMES[target];
    // ссылка на блок, которого сейчас на шаге нет (по задачам при одной задаче): обычная ссылка
    if (!place && (!home || !document.querySelector(`[data-digest="${home}"]`))) return;
    event.preventDefault();
    for (let fold = place?.closest("details"); fold; fold = fold.parentElement?.closest("details")) fold.open = true;
    if (!home || isOpen(home)) {
      place?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    goal.current = target;
    toggle(home);
  };

  const whatifBrief = whatIfBrief(whatif, pick.id, term);
  const readyBrief = readinessBrief(readiness);
  // кривая той задачи, что сейчас на смене: при нескольких задачах подписываем, какой
  const curve = (run?.curve_points ?? []) as [number, number][];
  const washing = Boolean(run?.segments?.some((part) => part.action === "моет"));

  // Блоки шага по отдельности: итог сверху, остальное под "Как посчитано" строками-сводками

  const zonesBlock = (result.picking_zones ?? []).map((zone) => (
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
  ));

  const summaryBlock = (
    <div className={loading ? "u-stale" : undefined} aria-busy={loading}>
      <EconomicsSummary
        result={result}
        robotName={shift.tasks.map((one) => one.robotName).join(", ")}
        pick={pick}
        choices={choices}
        onPick={(id) => setPicked(id === "raas" ? "raas" : "purchase")}
        budget={budget}
        onRent={() => setPicked("raas")}
        onLoan={shift.readOnly || !purchase.financing ? undefined : toLoan}
        aside={zonesBlock}
        inline
      />
      {wrongTerms && shown === "purchase" && (
        <Alert>
          Условия кредита или лизинга неверные, покупку считаем за свои деньги.{" "}
          <TextButton onClick={() => setPayOpen(true)}>Поправить</TextButton>
        </Alert>
      )}
    </div>
  );

  const shiftBlock = (
    <>
      {together && (
        <ShiftTogether
          id="shift"
          autoplay
          facilityId={shift.facilityId}
          parts={togetherParts}
          plan={shift.plan}
          measures={shift.measures}
          rackTypes={shift.rackTypes}
          slotted={slotted?.value === 1}
          overrides={forShift}
          switcher={switcher}
        />
      )}
      {onShift && !together && (
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
          switcher={switcher}
          mixed={mixed}
          plan={shift.plan}
          measures={shift.measures}
          rackTypes={shift.rackTypes}
          slotted={slotted?.value === 1}
          overrides={forShift}
          onChangePlan={shift.onChangePlan}
          onSlotted={(next) => slotted && onChangeParameter(slotted.path, next ? 1 : 0)}
          onEditPlan={shift.readOnly ? undefined : shift.onEditPlan}
          readOnly={shift.readOnly}
          onRun={setRun}
          park={{
            chargers: several ? (shiftPart?.sizing.chargers ?? 0) : sizing.chargers,
            formula: several ? shiftPart?.sizing.formula_fleet : sizing.formula_fleet,
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
    </>
  );

  const ledgerDigest = (
    <Digest
      key="ledger"
      id="ledger"
      title="Куда уходят деньги"
      open={isOpen("ledger")}
      onToggle={() => toggle("ledger")}
      facts={[
        {
          label: "на старте",
          value: mln(shownScenario.capex_after_grant_rub ?? shownScenario.investment_year0_rub),
          unit: "млн ₽",
        },
        {
          label: "в год",
          value: mln(
            shownScenario.id === "baseline"
              ? (shownScenario.years[0]?.staff_cost_rub ?? 0)
              : (shownScenario.years[0]?.opex_total_rub ?? 0),
          ),
          unit: "млн ₽",
        },
        { label: `за ${horizon} лет`, value: mln(shownScenario.tco_rub), unit: "млн ₽" },
      ]}
      line={`${nameOf(shownScenario)}: что платите разово на старте, что каждый год и сколько всего за ${horizon} лет`}
    >
      <div className={loading ? "u-stale" : undefined} aria-busy={loading}>
        {shownScenario.id === "baseline" ? (
          <BaselineLedger result={result} baseline={baseline} />
        ) : (
          <EconomicsLedger result={result} pick={pick}>
            {!shift.readOnly && <Ramp result={result} overrides={overrides} onChange={onChangeParameter} />}
          </EconomicsLedger>
        )}
        <YearsTable pick={shownScenario} baseline={baseline} />
      </div>
    </Digest>
  );

  const tasksDigest = several && (
    <Digest
      key="tasks"
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
  );

  const whatifDigest = (
    <Digest
      key="whatif"
      id="whatif"
      title="Что будет, если"
      open={isOpen("whatif")}
      onToggle={() => toggle("whatif")}
      facts={whatifBrief.facts}
      line={whatifBrief.line}
    >
      <Sensitivity request={request} scenario={pick.id} version={result} onBrief={setWhatif} />
    </Digest>
  );

  const readyDigest = (
    <Digest
      key="readiness"
      id="readiness"
      title="Что подготовить на складе"
      open={isOpen("readiness")}
      onToggle={() => toggle("readiness")}
      facts={readyBrief.facts}
      line={readyBrief.line}
    >
      <Readiness request={request} result={result} onBrief={setReadiness} />
    </Digest>
  );

  const basisDigest = (
    <Digest
      key="basis"
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
                source.path in overrides ? `Задал пользователь. У нас был источник: ${source.source}` : source.source,
              trust: source.trust,
              trustTitle: TRUST_TITLES[source.trust] ?? source.trust,
            }))}
          />
        </Fold>
      </section>
    </Digest>
  );

  const drawerBlock = purchase.financing && (
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
  );

  const shiftDigest = (
    <Digest
      key="shiftplan"
      id="shiftplan"
      title="Смена на вашем плане"
      // главное, что показывает расчет: всегда раскрыт, кнопки "Свернуть" нет, случайно не спрячешь
      open
      facts={[
        { label: "роботов", value: String(sizing.fleet) },
        { label: "зарядок", value: String(sizing.chargers) },
      ]}
      line="Роботы едут по вашему плану в ускоренном времени: так проверено, что их хватает"
    >
      {shiftBlock}
    </Digest>
  );
  // Порядок блоков. Расчет в пользу роботов: сначала смена на плане, она доказывает парк. Не в
  // пользу: сначала что поменять и куда уходят деньги, смена ниже
  const blocks = bad
    ? [whatifDigest, ledgerDigest, shiftDigest, tasksDigest, readyDigest, basisDigest]
    : [shiftDigest, ledgerDigest, tasksDigest, whatifDigest, readyDigest, basisDigest];

  // Сверху вывод и три карточки, под ними один переключатель сценария: он липнет к экрану, и все
  // ниже по выбранному в нем. Ниже вся прозрачность строками-сводками
  return (
    <div className="u-econ" onClickCapture={follow}>
      {/* Пока идет пересчет, внизу экрана метка "Считаем новые цифры": одно приглушение читалось как
          "ничего не происходит". Щелкают "Кредит" в полосе посередине шага, а карточки в это время
          часто за краем экрана, поэтому метка не у блока, а всегда на виду */}
      {loading && (
        <div className="u-recount" role="status">
          <span className="u-beacon" aria-hidden="true" />
          Считаем новые цифры
        </div>
      )}
      <div className={loading ? "u-stale" : undefined}>
        <ChosenResult
          result={result}
          ways={payWays ?? DEFAULT_WAYS}
          byWay={pay.byWay}
          budget={budget}
          budgetFrom={budgetFrom}
          onEdit={shift.readOnly ? undefined : onEditPayWays}
          selected={shown}
          onSelect={setPicked}
          onRent={() => setPicked("raas")}
          onLoan={shift.readOnly ? undefined : toLoan}
          how={<CardsHow result={result} onSources={openSources} />}
          planLink={hasYearPlan(result)}
        />
      </div>
      <ScenarioSwitch shown={shown} way={way} onShow={setPicked} onWay={shift.readOnly ? undefined : onWay} />
      <div
        className={`u-chosen-detail is-${shown === "baseline" ? "now" : shown === "raas" ? "rent" : "buy"}${loading ? " u-stale" : ""}`}
        id="step5-detail"
        role="tabpanel"
        aria-labelledby={`card-${shown}`}
      >
        {shown === "purchase" && (
          <PayLine
            result={result}
            byWay={pay.byWay}
            waiting={pay.waiting}
            failed={pay.failed}
            budget={budget}
            onTerms={shift.readOnly ? undefined : () => setPayOpen(true)}
          />
        )}
        {shown === "baseline" ? <BaselineDetail result={result} baseline={baseline} /> : summaryBlock}
      </div>
      <div className="u-econ-more">
        <BlockHead
          title="Как посчитано"
          note={`${
            shown === "baseline"
              ? `Куда уходят деньги без роботов, блоки про роботов по сценарию "${nameOf(pick)}".${bad ? " Роботы здесь не окупаются: сначала что поменять, смена на плане ниже." : ""}`
              : bad
                ? `${nameOf(shownScenario)}: расчет не в пользу роботов. Сначала что поменять и куда уходят деньги, смена на плане ниже.`
                : `Все ниже по выбранному: ${nameOf(shownScenario).toLowerCase()}.`
          } Откройте строку, под ней все цифры и откуда они`}
        />
        <Digests>{blocks}</Digests>
        {/* план на 5 лет ниже смены и разбора: вывод строкой и график, таблица по годам по щелчку */}
        <div className={loading ? "u-stale" : undefined}>
          <PlanByYears result={result} shown={shown} />
        </div>
        <ForDecision result={result} />
      </div>
      {drawerBlock}
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
  // срок объекта целиком дольше, чем у каждой окупающейся задачи: общее на объект ложится сверху
  const whole = pick.payback_cumulative_years;
  const paying = parts.map((task) => partOf(task)?.payback_years).filter((own): own is number => own != null);
  const slower = whole != null && paying.length > 0 && paying.every((own) => own < whole);
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

      {/* объект целиком окупается дольше каждой задачи: так и должно быть, общее на объект ложится сверху.
          Без подписи это читалось как ошибка */}
      {common && (
        <p className="u-frow-hint">
          Общее на объект добавляет {mln2(common.investment_year0_rub)} млн ₽ на старте и {mln2(common.opex_year1_rub)}{" "}
          млн ₽ в год: интеграция, связь и присмотр за всем парком.
          {slower
            ? ` Поэтому объект целиком окупается за ${term(whole)}, дольше, чем ${paying.length < parts.length ? "окупающиеся задачи" : "задачи"} по отдельности.`
            : ""}
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
              интеграция, инфраструктура, связь и присмотр за всем парком ({watchWords(shared.operator_posts)} в смену).
              Делается один раз, сколько бы задач ни было
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
