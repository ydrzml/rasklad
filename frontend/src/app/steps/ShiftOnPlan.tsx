import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  api,
  type GeneratedPlan,
  type Plan,
  type PlanMeasures,
  type RackType,
  type SimulationResult,
} from "../../api/client";
import { Alert, BlockHead, Button, Check, Fold, Legend, Pill, Player, Timeline, useClock, Waiting } from "../../ui";
import { number } from "../format";
import { fleetVerdict, plural } from "./economicsNames";
import { formulaLine } from "./formulaLine";
import { Editor } from "../plan/Editor";
import { rackRows } from "../plan/geometry";
import {
  ACTION_COLOR,
  ACTIONS,
  actionsOf,
  heatColor,
  heatOf,
  heatRanks,
  minutesOf,
  mixOf,
  queuesOf,
  replayOf,
} from "../shift/replay";
import { frameOf, save } from "../shift/frame";
import { Score } from "../shift/Score";
import { ShiftLayer } from "../shift/ShiftLayer";

type Props = {
  /* якорь блока: на него ведет ссылка из сводки */
  id?: string;
  facilityId: string;
  operationId: string;
  robotId: string;
  robotName: string;
  fleet: number;
  plan: Plan | null;
  measures: PlanMeasures | null;
  rackTypes: RackType[];
  /* товар разложен по ходовости: это параметр объекта, тот же, что на шаге параметров */
  slotted: boolean;
  onSlotted: (next: boolean) => void;
  /* правки параметров: от них зависят спрос и схема, прогон берет их, как и расчет */
  overrides: Record<string, number>;
  onChangePlan: (plan: Plan) => void;
  /* вернуться на шаг плана: очередь в проезде или у ворот лечится правкой плана */
  onEditPlan?: () => void;
  /* Парк рядом со сменой: сколько роботов и во что обходится. Числа дает шаг экономики из ответа
     сервера. budget: строка «укладывается ли в бюджет», когда клиент бюджет назвал */
  park?: {
    facts: { name: string; value: string; unit: string }[];
    budget?: ReactNode;
    chargers?: number;
    /* парк по формуле из расчета: рядом с парком прогона, чтобы было видно, откуда разница */
    formula?: number;
  };
  /* расчет по ссылке: смотрят, но не правят, поэтому галочек, меняющих объект и план, нет */
  readOnly?: boolean;
  /* задач несколько: переключатель справа от заголовка, каждая задача гоняется своими роботами */
  switcher?: ReactNode;
  /* доля объема задачи у этого решения при смешанном парке: прогон гоняет только ее */
  share?: number;
  /* готовый разбор для гостя: план не его, поэтому в подписях "план склада", а не "ваш план" */
  sample?: boolean;
  /* готовый разбор: дошла до конца, начинается снова. Пауза человека остается паузой */
  loop?: boolean;
  /* смена идет сама на x240, как только прогон пришел. Кто просил меньше движения, видит ее на паузе */
  autoplay?: boolean;
  /* прогон пришел: шаг экономики берет из него кривую парка для блока "Откуда цифры" */
  onRun?: (result: SimulationResult | null) => void;
  /* длительность смены в часах: если прогон короче, подпись говорит "8 часов из 11-часовой смены" */
  shiftHours?: number;
  /* на складе разные роботы: строка рядом с итогами, что помехи между ними на проездах не считаем */
  mixed?: boolean;
};

type Paint = "robots" | "share" | "visits";

/* Ускорение показа: смена идет быстрее жизни, роботы едут с обычной скоростью. Подсказка
   переводит множитель в минуты смены на одну секунду экрана */
const speedOf = (value: number) => ({
  value,
  name: `×${value}`,
  hint: `×${value}: 1 секунда на экране = ${value / 60} ${plural(value / 60, "минута", "минуты", "минут")} смены. Роботы при этом едут с обычной скоростью`,
});
export const SPEEDS = [speedOf(60), speedOf(240), speedOf(900)];

/* Смена на плане. Роботы выбранного решения едут по плану клиента, как посчитал сервер: плеер
   только проигрывает лог. Прогон подтверждает расчет, а не заменяет его (ТЗ, п. 3.6.2): парк
   берем из экономики, а строка у парка говорит, сколько вытянул бы парк на одного меньше.
   Сама кривая парка стоит в блоке "Откуда цифры": под сменой она ломала размер блока */
export function ShiftOnPlan(props: Props) {
  const { plan, fleet, slotted, onRun } = props;
  const [paint, setPaint] = useState<Paint>("robots");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [exporting, setExporting] = useState<"" | "frame" | "log">("");
  const [exportError, setExportError] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();

  // Змейка это правка плана, та же, что кнопка у зоны на шаге плана: по этому плану считает
  // и экономика, иначе прогон и деньги считали бы разные склады. Полосы кладет сервер
  const shown = plan;
  const snake = Boolean(plan?.items.some((item) => item.kind === "flow"));
  const [laying, setLaying] = useState(false);
  const toggleSnake = () => {
    if (!plan) return;
    if (snake) {
      props.onChangePlan({ ...plan, edited: true, items: plan.items.filter((item) => item.kind !== "flow") });
      return;
    }
    setLaying(true);
    // змейку просим одну на группу рядов: сервер кладет ее на все ряды группы сразу
    [...new Set(plan.items.filter((item) => item.kind === "racks").map((item) => item.group || item.id))]
      .reduce<Promise<Plan>>(
        (next, zone) => next.then((one) => api.planSerpentine(one, zone).then((answer) => answer.plan)),
        Promise.resolve(plan),
      )
      .then((next) => props.onChangePlan({ ...next, edited: true }))
      .catch(() => setError("Не удалось положить змейку: сервер не ответил"))
      .finally(() => setLaying(false));
  };

  // Тот же запрос, что у прогона на экране: журнал собирает сервер из того же прогона
  const runBody = useMemo(
    () => ({
      facility_id: props.facilityId,
      operation_id: props.operationId,
      robot_id: props.robotId,
      fleet,
      plan: shown,
      slotted_by_turnover: slotted,
      overrides: props.overrides,
      share: props.share ?? 1,
    }),
    [props.facilityId, props.operationId, props.robotId, fleet, shown, slotted, props.overrides, props.share],
  );

  useEffect(() => {
    if (!shown || fleet < 1) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError("");
      api
        .simulate({ ...runBody, with_events: true }, abort.signal, true)
        .then(setResult)
        .catch((failure: Error) => {
          if (failure.name !== "AbortError") setError("Прогон смены не посчитался: сервер не ответил");
        })
        .finally(() => !abort.signal.aborted && setBusy(false));
    }, 150);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [runBody, shown, fleet, attempt]);

  useEffect(() => onRun?.(result), [result, onRun]);

  const hours = result?.hours ?? 8;
  const clock = useClock(hours * 3600);
  const replay = useMemo(() => (result ? replayOf(result.segments ?? [], result.hours) : null), [result]);
  const minutes = useMemo(() => (replay ? minutesOf(replay) : []), [replay]);
  const queues = useMemo(() => queuesOf(minutes), [minutes]);
  // весь парк по минутам для шкалы: какая доля роботов что делает
  const stack = useMemo(() => {
    const mix = replay ? mixOf(replay) : [];
    return ACTIONS.map((one) => ({
      id: one.id,
      name: one.name,
      color: ACTION_COLOR[one.id],
      shares: mix.map((minute) => minute[one.id] ?? 0),
    }));
  }, [replay]);

  // Ячейки стеллажей на сетке движка: тепловую карту кладем на них, а не в проезд
  // Отбор на плане под погрузчик сервер гонял по робозоне: смену рисуем на ней, а не на плане
  // сервер отдает план со всеми полями, как /api/plan/generate
  const zone = (result?.zone_plan ?? null) as GeneratedPlan | null;
  const drawn = zone?.plan ?? shown;
  const drawnMeasures = zone?.measures ?? props.measures;
  const rackCells = useMemo(() => {
    const found = new Set<string>();
    if (!drawn) return found;
    const row = (drawnMeasures?.rack_depth_m ?? 1.1) * 2;
    const cross = drawnMeasures?.cross_aisle_m ?? 4.5;
    for (const item of drawn.items.filter((one) => one.kind === "racks"))
      for (const band of rackRows(item, row, cross))
        for (let col = Math.floor(band.x); col < band.x + band.w; col++)
          for (let r = Math.floor(band.y); r < band.y + band.h; r++)
            if (col + 0.5 >= band.x && col + 0.5 <= band.x + band.w && r + 0.5 >= band.y && r + 0.5 <= band.y + band.h)
              found.add(`${col}:${r}`);
    return found;
  }, [drawn, drawnMeasures]);
  const heat = useMemo(() => {
    if (!result || paint === "robots") return null;
    const cells = heatOf(result.places ?? [], paint, (col, row) => rackCells.has(`${col}:${row}`));
    return { cells, ranks: heatRanks(cells) };
  }, [result, paint, rackCells]);

  // Сама смена запускается один раз: после пересчета или паузы человеком не перебиваем его выбор
  const started = useRef(false);
  useEffect(() => {
    if (!result || !props.autoplay || started.current) return;
    started.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    clock.setSpeed(240);
    clock.play(true);
  }, [result, clock, props.autoplay]);

  // По кругу: часы сами встают в конце смены, тогда запускаем с начала. Остановку на середине
  // сделал человек, ее не трогаем. При "меньше движения" смена не запускалась, и круга нет
  useEffect(() => {
    if (!props.loop) return;
    return clock.subscribe(() => {
      if (!clock.playing && clock.t >= clock.length && started.current) clock.play(true);
    });
  }, [clock, props.loop]);

  // Пробел ставит смену на паузу, где бы ни был фокус, кроме полей ввода
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

  // Кадр PNG собираем в браузере: это картинка экрана, а не расчет. Журнал CSV собирает сервер
  const saveFrame = () => {
    if (!stage.current) return;
    setExporting("frame");
    setExportError("");
    const at = clockText(clock.t);
    const word = plural(fleet, "робот", "робота", "роботов");
    frameOf(stage.current, `Смена на плане, ${at} от начала смены. ${props.robotName}, ${fleet} ${word}`)
      .then((blob) => save(blob, `kadr-smeny-${at.replace(":", "-")}.png`))
      .catch((failure: Error) => setExportError(`Кадр не собрался: ${failure.message}`))
      .finally(() => setExporting(""));
  };
  const saveLog = () => {
    setExporting("log");
    setExportError("");
    api
      .shiftLog(runBody)
      .then(({ blob, name }) => save(blob, name))
      .catch((failure: Error) => setExportError(`Журнал не собрался: ${failure.message}`))
      .finally(() => setExporting(""));
  };

  if (!plan) return null;
  const kpi = result?.kpi;
  // Спрос смены рядом с итогами: без него «в среднем 94 в час» рядом со «спросом 149» у кривой
  // читалось как «роботы не справились», а 149 это пик с запасом, под который взят парк
  const hourly = result?.demand_per_hour ?? [];
  const asked = hourly.reduce((sum, one) => sum + one, 0);
  const peak = hourly.length ? Math.max(...hourly) : 0;
  const idle = kpi ? Math.max(0, 1 - kpi.busy_share - kpi.waiting_share - kpi.charging_share) : 0;
  const demand = result?.design_demand ?? 0;
  // сколько роботов нужно смене: найдено поиском, парк подтвержден на всех прогонах
  const needed = result?.fleet_needed ?? null;
  // Уборщик моет площадь, а не возит рейсы: сервер отдает итоги уборки в м², а рейс у него это
  // участок от выезда с базы до смены воды. Подписи в тех же единицах, «средний рейс 5 534 секунд»
  // и «спрос в пик» у уборки ничего не говорили
  const washing = Boolean(result?.segments?.some((part) => part.action === "моет"));
  const words = (text: string) =>
    props.sample ? text.replace(/вашему плану/g, "плану склада").replace(/вашем плане/g, "плане склада") : text;

  // Высота листа по пропорции плана: лист вписывается в окно по ширине, а не сжимается по высоте.
  // Предел высоты в board.css (.u-shift), там же запас под цифры размеров и переключатель
  const sheet = drawn ? ({ "--plan-aspect": (drawn.length_m / drawn.width_m).toFixed(3) } as CSSProperties) : undefined;

  return (
    <section className="u-shift" id={props.id} style={sheet}>
      <BlockHead
        title="Смена на плане"
        note={words(
          `${props.robotName}, ${fleet} ${plural(fleet, "робот", "робота", "роботов")} ${zone ? "на робозоне: отбор считаем по ней, остальные задачи по вашему плану" : "на вашем плане"}, ${hours} ${plural(hours, "час", "часа", "часов")} ${props.shiftHours && props.shiftHours > hours ? `из ${props.shiftHours}-часовой смены` : "смены"}${washing ? ", площадь разложена по смене" : " с пиком спроса"}`,
        )}
      />
      {/* переключатель задач своей строкой под заголовком: в строке заголовка ему тесно рядом
          с кнопкой «Свернуть», плитки разъезжались на две строки */}
      {props.switcher && <div className="u-shift-switch">{props.switcher}</div>}

      <div className="u-shift-grid">
        <div className="u-shift-main">
          <div className="u-shift-bar">
            {!props.readOnly && (
              <>
                <Check
                  label="Товар разложен по ходовости"
                  checked={slotted}
                  onToggle={() => props.onSlotted(!slotted)}
                  title="20% мест у ворот дают 75% заданий. Это параметр объекта, он же стоит на шаге параметров"
                />
                {/* змейка правит план человека, а смена отбора идет на робозоне: здесь ее не предлагаем */}
                {!zone && (
                  <Check
                    label={laying ? "Кладем змейку..." : "Змейка по проездам"}
                    checked={snake}
                    onToggle={toggleSnake}
                    title="По каждому проезду едут в одну сторону, в соседних в разные. Это правка плана: ее видно на шаге плана, и по ней считаются деньги"
                  />
                )}
              </>
            )}
            <div className="u-shift-paint" role="group" aria-label="Что показать на плане">
              <Pill active={paint === "robots"} onClick={() => setPaint("robots")}>
                Роботы
              </Pill>
              <Pill active={paint === "share"} onClick={() => setPaint("share")}>
                План смены
              </Pill>
              <Pill active={paint === "visits"} onClick={() => setPaint("visits")}>
                Как прошла смена
              </Pill>
            </div>
          </div>
          {/* что сейчас на плане, строкой под переключателем: "как задумано / как вышло" без пояснения
              не понимали, а подсказки при наведении на телефоне нет */}
          <p className="u-frow-hint u-shift-paint-note">
            {zone && paint === "robots"
              ? PAINT_NOTES.robots.replace("вашему плану", "робозоне")
              : words(PAINT_NOTES[paint])}
          </p>

          <div ref={stage} className={busy && result ? "u-shift-stage is-stale" : "u-shift-stage"}>
            {error && !result ? (
              <div className="u-shift-empty">
                <Alert>{error}. Введенное не потерялось.</Alert>
                <Button kind="ghost" onClick={() => setAttempt(attempt + 1)}>
                  Повторить
                </Button>
              </div>
            ) : !result || !replay || !drawn ? (
              <div className="u-shift-empty">
                <Waiting
                  title="Гоняем смену"
                  note={words(
                    "Роботы выбранного решения едут по вашему плану восемь часов, с очередями и зарядкой. Обычно пара секунд, отбору с сотней роботов до двадцати",
                  )}
                />
              </div>
            ) : (
              <Editor
                plan={drawn}
                measures={drawnMeasures}
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
                fitKey={`shift:${drawn.width_m}:${drawn.length_m}`}
                still={narrow}
                watch
                rackTypes={props.rackTypes}
                side={null}
                underlay={null}
                status={
                  <span>
                    {narrow
                      ? "на телефоне лист только смотрят"
                      : "колесо: масштаб · протяжка: сдвиг листа · пробел: пауза"}
                    {/* места упаковки и конвейер ставит сервер у станций отбора: говорим, что из этого в расчете */}
                    {drawn.items.some((item) => item.role === "packing") &&
                      " · у станций упаковка · у стены конвейер к отгрузке, схема без расчета"}
                  </span>
                }
                layer={(boardView, area) => (
                  <ShiftLayer
                    view={boardView}
                    area={area}
                    length={drawn.length_m}
                    replay={replay}
                    clock={clock}
                    heat={heat}
                    robots={paint === "robots"}
                  />
                )}
              />
            )}
          </div>

          {result && replay && (
            <div className="u-shift-player">
              <Player clock={clock} speeds={SPEEDS}>
                {/* цвета действий нужны всегда: ими раскрашена шкала ниже */}
                <Legend
                  rows={actionsOf(replay).map((one) => ({ id: one.id, color: ACTION_COLOR[one.id], name: one.name }))}
                />
                {paint !== "robots" && <HeatLegend paint={paint} />}
              </Player>
              <Timeline
                clock={clock}
                demand={result.demand_per_hour ?? []}
                stack={stack}
                fleet={fleet}
                queues={queues}
              />
              <Score
                replay={replay}
                clock={clock}
                demand={result.demand_per_hour ?? []}
                waiting={result.kpi.waiting_share}
              />
              <div className="u-shift-export">
                <span>Выгрузить смену:</span>
                <Button kind="light" disabled={exporting !== ""} onClick={saveFrame}>
                  {exporting === "frame" ? "Собираем кадр..." : "Сохранить кадр"}
                </Button>
                <Button kind="light" disabled={exporting !== ""} onClick={saveLog}>
                  {exporting === "log" ? "Собираем журнал..." : "Журнал событий"}
                </Button>
                <small>
                  {exportError ||
                    "кадр: план с роботами в текущую минуту, PNG; журнал: робот, начало, конец, действие и координаты, CSV"}
                </small>
              </div>
            </div>
          )}
        </div>

        <aside className="u-side u-shift-side">
          {/* Справа три ответа: сколько роботов, хватает ли на пик, где узкое место. Остальные
              цифры смены и деньги парка свернуты ниже: пятнадцать строк подряд никто не читал */}
          <h3>Парк</h3>
          {/* узкое место первой строкой и крупно: на что смотреть в смене, с долей времени от сервера */}
          {kpi && <Bottleneck text={kpi.bottleneck} />}
          <p className="u-shift-fleet">
            <b className="mono">{fleet}</b> {plural(fleet, "робот", "робота", "роботов")}
            {props.park?.chargers !== undefined &&
              ` и ${props.park.chargers} ${plural(props.park.chargers, "зарядка", "зарядки", "зарядок")}`}
          </p>
          {result && <p className="u-shift-note">{fleetVerdict({ needed, fleet, demand, washing })}</p>}
          {kpi && props.park?.formula ? (
            <p className="u-shift-note">{formulaLine(props.park.formula, fleet, kpi)}</p>
          ) : null}
          {props.park?.budget}
          {kpi ? (
            <>
              <h3>Загрузка парка за смену</h3>
              <Load
                parts={[
                  { id: "едет", name: "в работе", share: kpi.busy_share },
                  { id: "ждет", name: "ждут в очереди", share: kpi.waiting_share },
                  { id: "заряжается", name: "на зарядке", share: kpi.charging_share },
                  { id: "без задания", name: "без задания", share: idle },
                ]}
              />
              {props.mixed && <MixedNote />}
              <Fold thin title="Все цифры смены">
                {props.park && (
                  <dl className="u-facts">
                    {props.park.facts.map((fact) => (
                      <Fact key={fact.name} {...fact} />
                    ))}
                  </dl>
                )}
                <dl className="u-facts">
                  {washing ? (
                    <>
                      <Fact
                        name="вымыто за смену"
                        value={number(kpi.done, 0)}
                        unit={asked ? `м² из ${number(asked, 0)}` : "м²"}
                      />
                      <Fact name="в среднем" value={number(kpi.ops_per_hour, 0)} unit="м² в час" />
                    </>
                  ) : (
                    <>
                      <Fact
                        name="сделано за смену"
                        value={number(kpi.done, 0)}
                        unit={asked ? `из ${number(asked, 0)} по спросу` : "операций"}
                      />
                      <Fact
                        name="в среднем"
                        value={number(kpi.ops_per_hour, 0)}
                        unit={hourly.length ? `в час при спросе ${number(asked / hourly.length, 0)}` : "в час"}
                      />
                      {peak > 0 && (
                        <Fact
                          name="спрос в пик"
                          value={number(peak, 0)}
                          unit={`в час, парк взят на ${number(demand, 0)}`}
                        />
                      )}
                    </>
                  )}
                  <Fact name="роботы в работе" value={percentOf(kpi.busy_share)} unit="% времени" />
                  <Fact name="без задания" value={percentOf(idle)} unit="% времени" />
                  <Fact name="ждут в очереди" value={percentOf(kpi.waiting_share)} unit="% времени" />
                  <Fact name="на зарядке" value={percentOf(kpi.charging_share)} unit="% времени" />
                  {washing ? (
                    <Fact name="на участок" value={spanText(kpi.avg_cycle_s)} unit="с дорогой и водой" />
                  ) : (
                    <Fact name="средний рейс" value={number(kpi.avg_cycle_s, 0)} unit="секунд" />
                  )}
                </dl>
              </Fold>
              {props.onEditPlan && (
                <div className="u-shift-plan">
                  {kpi.waiting_share >= 0.05 && (
                    <p className="u-shift-note">
                      Роботы стоят в очереди. Передвиньте ворота, раздвиньте ряды или проложите проезд: смена и деньги
                      пересчитаются.
                    </p>
                  )}
                  <Button kind="light" arrow onClick={props.onEditPlan}>
                    Поменять план
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="u-shift-note">Итоги появятся, когда посчитается смена.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

/* Узкое место смены: подпись сервера целиком, доли времени в ней крупнее */
function Bottleneck({ text }: { text: string }) {
  const parts = text.split(/(\d+%)/);
  return (
    <p className="u-shift-key">
      <span className="u-shift-key-name">Узкое место смены</span>
      <span>
        {parts.map((part, index) =>
          /^\d+%$/.test(part) ? (
            <b key={index} className="mono">
              {part}
            </b>
          ) : (
            <span key={index}>{index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part}</span>
          ),
        )}
      </span>
    </p>
  );
}

/* Аудит, пункт А6: прогон гоняет каждую задачу своими роботами, общих проездов между разными
   роботами он не видит. Говорим об этом одной строкой рядом с итогами, без тревоги */
export function MixedNote() {
  return (
    <p className="u-shift-note u-shift-mixed">
      Разные роботы на одном складе считаются по своим задачам: взаимные помехи на общих проездах не учтены,
      производительность может быть немного завышена.
    </p>
  );
}

const PAINT_NOTES: Record<Paint, string> = {
  robots: "Роботы едут по вашему плану, смена в ускоренном времени",
  share: "План смены: где по расчету чаще всего будут задания, до того как роботы поехали",
  visits: "Как прошла смена: куда роботы на самом деле заезжали за смену, с очередями и объездами",
};

/* Легенда тепловой карты: шкала одной полосой, от редко к часто */
function HeatLegend({ paint }: { paint: Paint }) {
  return (
    <div className="u-scale u-shift-heat" role="img" aria-label="Шкала тепловой карты: от редко к часто">
      <div className="u-scale-bar">
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((share) => (
          <span key={share} style={{ background: heatColor(share) }} />
        ))}
      </div>
      <div className="u-scale-ends">
        <span>{paint === "share" ? "реже задания" : "меньше заездов"}</span>
        <span>{paint === "share" ? "чаще задания" : "больше заездов"}</span>
      </div>
    </div>
  );
}

/* Загрузка парка за смену одной полосой: доли времени из итогов сервера, цвета как на шкале */
export function Load({ parts }: { parts: { id: string; name: string; share: number }[] }) {
  return (
    <div className="u-load">
      <div
        className="u-load-bar"
        role="img"
        aria-label={parts.map((part) => `${part.name} ${percentOf(part.share)}%`).join(", ")}
      >
        {parts.map((part) => (
          <span key={part.id} style={{ flexGrow: part.share, background: ACTION_COLOR[part.id] }} />
        ))}
      </div>
      <ul className="u-load-keys">
        {parts.map((part) => (
          <li key={part.id}>
            <i style={{ background: ACTION_COLOR[part.id] }} />
            {part.name} <b className="mono">{percentOf(part.share)}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Строка итога: подпись слева, число сервера справа моноширинным */
export function Fact({ name, value, unit }: { name: string; value: string; unit: string }) {
  return (
    <div className="u-fact">
      <dt>{name}</dt>
      <dd>
        <b className="mono">{value}</b> {unit}
      </dd>
    </div>
  );
}

/* Доля в процентах: меньше процента с десятой, иначе очередь в 0,4% выглядела бы как ее отсутствие */
export function percentOf(share: number): string {
  const value = share * 100;
  return number(value, value > 0 && value < 1 ? 1 : 0);
}

function noop() {}

/* На узком экране палец на листе прокручивает страницу, а не двигает лист */
export function useNarrow(): boolean {
  const query = "(max-width: 880px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const watch = () => setNarrow(media.matches);
    media.addEventListener("change", watch);
    return () => media.removeEventListener("change", watch);
  }, []);
  return narrow;
}

/* Сколько длится участок уборщика: «1 ч 32 мин», короткий «45 мин» */
export function spanText(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`;
}

/* Время смены часами и минутами: 01:23 */
function clockText(t: number): string {
  const pad = (value: number) => String(Math.floor(value)).padStart(2, "0");
  return `${pad(t / 3600)}:${pad((t % 3600) / 60)}`;
}
