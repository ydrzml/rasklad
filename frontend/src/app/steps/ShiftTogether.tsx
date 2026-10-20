import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api, type Plan, type PlanMeasures, type RackType, type SimulationResult } from "../../api/client";
import { Alert, BlockHead, Button, Player, useClock, Waiting } from "../../ui";
import { number } from "../format";
import { Editor } from "../plan/Editor";
import { ShiftLayer } from "../shift/ShiftLayer";
import { type Replay, replayOf } from "../shift/replay";
import { plural } from "./economicsNames";
import { Fact, MixedNote, percentOf, SPEEDS, useNarrow } from "./ShiftOnPlan";

/* Часть парка на смене вместе: задача и решение на нее, как в переключателе задач */
export type TogetherPart = {
  key: string;
  operationId: string;
  robotId: string;
  /* подпись в легенде: задача, а у смешанного парка задача, робот и доля */
  name: string;
  share: number;
  fleet: number;
};

type Props = {
  id?: string;
  facilityId: string;
  parts: TogetherPart[];
  plan: Plan | null;
  measures: PlanMeasures | null;
  rackTypes: RackType[];
  slotted: boolean;
  overrides: Record<string, number>;
  switcher?: ReactNode;
  autoplay?: boolean;
};

/* Цвета задач в постоянном порядке: цвет держится за задачу, а не за место в списке. Проверены
   на различимость при дальтонизме на светлом листе (лист светлый и в темной теме), и у каждой
   задачи еще своя форма корпуса. Пятая часть и дальше одним серым, новых цветов не выдумываем */
const TEAM_COLORS = ["var(--team-1)", "var(--team-2)", "var(--team-3)", "var(--team-4)"];
const colorOf = (index: number) => TEAM_COLORS[index] ?? "var(--team-other)";

type Run = { part: TogetherPart; index: number; result: SimulationResult };

/* Все задачи вместе на одном плане. Сервер гоняет смену по одной задаче: у каждой свои роботы,
   свой спрос и свои очереди. Общего прогона нет, поэтому здесь честно накладываем прогоны задач
   на один план и подписываем, что помехи между задачами на общих проездах не учтены. Цифры
   каждой задачи те же, что при показе задачи отдельно: запрос к серверу тот же */
export function ShiftTogether(props: Props) {
  const { plan, slotted, overrides, facilityId } = props;
  // список частей экран собирает заново на каждой отрисовке: держим его по содержимому, иначе
  // прогоны запрашивались бы по кругу
  const partsKey = JSON.stringify(props.parts);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- ключ и есть содержимое списка
  const parts = useMemo(() => props.parts, [partsKey]);
  const [runs, setRuns] = useState<(SimulationResult | null)[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const narrow = useNarrow();

  useEffect(() => {
    if (!plan || !parts.length) return;
    const abort = new AbortController();
    Promise.allSettled(
      parts.map((part) =>
        api.simulate(
          {
            facility_id: facilityId,
            operation_id: part.operationId,
            robot_id: part.robotId,
            fleet: part.fleet,
            plan,
            slotted_by_turnover: slotted,
            overrides,
            share: part.share,
            with_events: true,
          },
          abort.signal,
          true,
        ),
      ),
    ).then((answers) => {
      if (abort.signal.aborted) return;
      const found = answers.map((one) => (one.status === "fulfilled" ? one.value : null));
      setError(found.every((one) => one === null) ? "Прогон смены не посчитался: сервер не ответил" : "");
      setRuns(found);
    });
    return () => abort.abort();
  }, [plan, parts, slotted, overrides, facilityId, attempt]);

  // Отбор под погрузчик сервер гоняет на робозоне, у нее свои координаты: на план клиента его не
  // кладем, а называем строкой. Остальные задачи едут по одному плану
  const done = useMemo<Run[]>(
    () => (runs ?? []).flatMap((result, index) => (result ? [{ part: parts[index], index, result }] : [])),
    [runs, parts],
  );
  const onPlan = useMemo(() => done.filter((one) => !one.result.zone_plan), [done]);
  const elsewhere = done.filter((one) => one.result.zone_plan);
  const failed = (runs ?? []).flatMap((result, index) => (result ? [] : [parts[index]]));

  // часы смены у всех прогонов одни (config/model.yaml, engine.simulation.hours); до ответа их не знаем
  const hours = Math.max(1, ...onPlan.map((one) => one.result.hours));
  const clock = useClock(hours * 3600);
  // один лог на всех: роботы задач подряд, у каждого номер его задачи
  const merged = useMemo(() => {
    const robots: Replay["robots"] = [];
    const of: number[] = [];
    for (const one of onPlan) {
      const replay = replayOf(one.result.segments ?? [], one.result.hours);
      for (const legs of replay.robots) {
        robots.push(legs);
        of.push(one.index);
      }
    }
    return { replay: { robots, hours } as Replay, owners: { of, colors: parts.map((_, index) => colorOf(index)) } };
  }, [onPlan, parts, hours]);

  const started = useRef(false);
  useEffect(() => {
    if (!onPlan.length || !props.autoplay || started.current) return;
    started.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    clock.setSpeed(240);
    clock.play(true);
  }, [onPlan.length, clock, props.autoplay]);

  // Пробел ставит смену на паузу, как у одной задачи
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code !== "Space" || target?.closest("input, textarea, select, button, [role=slider]")) return;
      event.preventDefault();
      clock.play();
    };
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, [clock]);

  if (!plan) return null;
  // пока прогоны идут, считаем роботов по частям расчета: тот же парк, что поедет на плане
  const robots = (runs === null ? parts : onPlan.map((one) => one.part)).reduce((sum, one) => sum + one.fleet, 0);
  const mixed = new Set(parts.map((one) => one.robotId)).size > 1;
  const tasks = new Set(parts.map((one) => one.operationId)).size;

  return (
    <section className="u-shift" id={props.id}>
      <BlockHead
        title="Смена на плане"
        note={`Все задачи вместе: ${robots} ${plural(robots, "робот", "робота", "роботов")} на вашем плане${onPlan.length ? `, ${hours} ${plural(hours, "час", "часа", "часов")} смены` : ""}`}
      />
      {props.switcher && <div className="u-shift-switch">{props.switcher}</div>}

      <div className="u-shift-grid">
        <div className="u-shift-main">
          <p className="u-frow-hint u-together-hint">
            Каждая задача посчитана своим прогоном, здесь они наложены на один план
          </p>
          <div className="u-shift-stage">
            {error ? (
              <div className="u-shift-empty">
                <Alert>{error}. Введенное не потерялось.</Alert>
                <Button kind="ghost" onClick={() => setAttempt(attempt + 1)}>
                  Повторить
                </Button>
              </div>
            ) : runs === null || !onPlan.length ? (
              <div className="u-shift-empty">
                <Waiting
                  title="Гоняем смену по всем задачам"
                  note="Каждая задача едет своими роботами по вашему плану восемь часов. Обычно несколько секунд"
                />
              </div>
            ) : (
              <Editor
                plan={plan}
                measures={props.measures}
                mode="furnish"
                tool="select"
                onTool={noop}
                tools={[]}
                colorBy="level"
                picked=""
                onPick={noop}
                onCommit={noop}
                onSerpentine={noop}
                onUndo={noop}
                onRedo={noop}
                aisle={3.5}
                fitKey={`together:${plan.width_m}:${plan.length_m}`}
                still={narrow}
                watch
                rackTypes={props.rackTypes}
                side={null}
                underlay={null}
                status={<span>{narrow ? "на телефоне лист только смотрят" : "колесо: масштаб · пробел: пауза"}</span>}
                layer={(boardView, area) => (
                  <ShiftLayer
                    view={boardView}
                    area={area}
                    length={plan.length_m}
                    replay={merged.replay}
                    clock={clock}
                    heat={null}
                    robots
                    owners={merged.owners}
                  />
                )}
              />
            )}
          </div>

          {onPlan.length > 0 && (
            <div className="u-shift-player">
              <Player clock={clock} speeds={SPEEDS}>
                <TeamKeys runs={onPlan} />
              </Player>
              <p className="u-frow-hint u-together-hint">
                Цвет и форма корпуса это задача. Огонек сзади показывает, что робот делает: синий едет, сиреневый
                грузит, красный ждет, зеленый заряжается. Бледные стоят без задания
              </p>
            </div>
          )}
        </div>

        <aside className="u-side u-shift-side">
          <h3>Парк на плане</h3>
          <p className="u-shift-fleet">
            <b className="mono">{robots}</b> {plural(robots, "робот", "робота", "роботов")}
            {tasks > 1
              ? ` на ${tasks} ${plural(tasks, "задаче", "задачах", "задачах")}`
              : parts.length > 1
                ? ", смешанный парк"
                : ""}
          </p>
          {onPlan.length ? (
            <>
              <h3>Итоги смены по задачам</h3>
              {onPlan.map((one) => (
                <TeamTotals key={one.part.key} run={one} />
              ))}
            </>
          ) : (
            <p className="u-shift-note">Итоги появятся, когда посчитается смена.</p>
          )}
          {elsewhere.length > 0 && (
            <p className="u-shift-note">
              {elsewhere.map((one) => one.part.name).join(", ")}: отбор идет на робозоне, а не на вашем плане, его
              смотрите отдельной задачей.
            </p>
          )}
          {failed.length > 0 && !error && (
            <p className="u-shift-note">
              {failed.map((one) => one.name).join(", ")}: прогон не посчитался, на плане этой задачи нет.
            </p>
          )}
          {mixed ? (
            <MixedNote />
          ) : (
            <p className="u-shift-note u-shift-mixed">
              Задачи посчитаны отдельно: помехи между ними на общих проездах не учтены.
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}

/* Легенда задач: корпус робота той же формы и цвета, что на плане, и сколько роботов */
function TeamKeys({ runs }: { runs: Run[] }) {
  return (
    <ul className="u-together-keys">
      {runs.map((one) => (
        <li key={one.part.key}>
          <TeamIcon index={one.index} />
          <span>{one.part.name}</span>
          <b className="mono">{one.part.fleet}</b>
        </li>
      ))}
    </ul>
  );
}

/* Значок задачи: тот же корпус, что рисует холст (bodyPath), на светлом квадрате листа, чтобы
   цвета были те же, что на плане, и в темной теме */
function TeamIcon({ index }: { index: number }) {
  return (
    <span className="u-light u-together-icon" aria-hidden="true">
      <svg viewBox="-9 -9 18 18" width="18" height="18">
        <path d={svgPath(index)} fill="var(--paper)" stroke={colorOf(index)} strokeWidth="2" />
      </svg>
    </span>
  );
}

/* Корпус bodyPath строкой пути SVG: прямоугольник, круг, ромб, шестигранник */
function svgPath(shape: number): string {
  const long = 6;
  if (shape === 1) return `M ${long} 0 A ${long} ${long} 0 1 1 ${-long} 0 A ${long} ${long} 0 1 1 ${long} 0 Z`;
  if (shape === 2) {
    const d = long * 1.15;
    return `M ${d} 0 L 0 ${d} L ${-d} 0 L 0 ${-d} Z`;
  }
  if (shape === 3)
    return `${Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 3) * k;
      return `${k ? "L" : "M"} ${(Math.cos(a) * long * 1.05).toFixed(2)} ${(Math.sin(a) * long * 1.05).toFixed(2)}`;
    }).join(" ")} Z`;
  return "M -6.5 -4.5 H 6.5 V 4.5 H -6.5 Z";
}

/* Итоги одной задачи: сделано из спроса и доли времени, те же числа, что у задачи отдельно */
function TeamTotals({ run }: { run: Run }) {
  const { kpi, demand_per_hour: hourly = [] } = run.result;
  const asked = hourly.reduce((sum, one) => sum + one, 0);
  const washing = Boolean(run.result.segments?.some((part) => part.action === "моет"));
  return (
    <div className="u-together-team">
      <h4>
        <TeamIcon index={run.index} />
        <span>{run.part.name}</span>
        <span className="mono">{run.part.fleet}</span>
      </h4>
      <dl className="u-facts">
        <Fact
          name={washing ? "вымыто за смену" : "сделано за смену"}
          value={number(kpi.done, 0)}
          unit={washing ? `м² из ${number(asked, 0)}` : asked ? `из ${number(asked, 0)} по спросу` : "операций"}
        />
        <Fact name="роботы в работе" value={percentOf(kpi.busy_share)} unit="% времени" />
        <Fact name="ждут в очереди" value={percentOf(kpi.waiting_share)} unit="% времени" />
      </dl>
    </div>
  );
}

function noop() {}
