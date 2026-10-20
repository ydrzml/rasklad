import { useEffect, useRef, useState, type CSSProperties } from "react";

import { mln, number } from "../../app/format";
import { CARD, CARD_LIGHT, FACE, INK, PALLET } from "../../ui/robots";
import type { Refill } from "./teaser";
import { plural } from "./verdict";

/* Сцены ролика разбора. Каждая показывает ровно то, что написано рядом: роботы везут паллеты,
   вложение наполняется экономией, люди сменяются роботами. Рисунок в одной системе координат
   640 x 360, движение на CSS (reel.css), счетчики на requestAnimationFrame */

const W = 640;
const H = 360;

const vars = (values: Record<string, number | string>): CSSProperties => values as CSSProperties;

/* Число, которое набирается от нуля за ms после delay. Идет, пока running; при still сразу итог */
export function useCount(target: number, ms: number, delay: number, running: boolean, still: boolean): number {
  const [value, setValue] = useState(still ? target : 0);
  const spent = useRef(0);
  useEffect(() => {
    if (still || !running) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      spent.current += now - last;
      last = now;
      const share = Math.min(1, Math.max(0, (spent.current - delay) / ms));
      setValue(target * share);
      if (share < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms, delay, running, still]);
  return still ? target : value;
}

type Live = { running: boolean; still: boolean };

/* Робот семьи 07 сверху, крупно: белый корпус, лицо спереди, на нем паллета с коробкой */
function Carrier({ loaded = true }: { loaded?: boolean }) {
  return (
    <g>
      <rect x="-22" y="-15" width="44" height="30" rx="7" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <rect x="17" y="-7" width="3" height="14" rx="1.5" fill={FACE} />
      <circle cx="-17" cy="-10" r="2.2" fill="#4a86cf" />
      {loaded && (
        <g className="rl-load">
          <rect x="-15" y="-11" width="26" height="22" rx="1.5" fill={PALLET} stroke={INK} strokeWidth="1" />
          <rect x="-12" y="-8" width="20" height="16" rx="1.5" fill={CARD} stroke={INK} strokeWidth="1" />
        </g>
      )}
    </g>
  );
}

function Box({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="-14" y="-11" width="28" height="22" rx="1.5" fill={PALLET} stroke={INK} strokeWidth="1" />
      <rect x="-11" y="-8" width="22" height="16" rx="1.5" fill={CARD_LIGHT} stroke={INK} strokeWidth="1" />
    </g>
  );
}

/* Сцена 1: от ворот роботы везут паллеты в стеллажи и возвращаются за следующей. Роботов столько,
   сколько в парке (до 18), счетчик сверху набирает пик в час */
export function WorkScene({
  fleet,
  peak,
  unit,
  running,
  still,
}: Live & { fleet: number; peak: number; unit: [string, string, string] }) {
  const shown = Math.max(1, Math.min(fleet, 18));
  const lanes = Math.min(3, shown);
  const perLane = Math.ceil(shown / lanes);
  const counted = Math.round(useCount(peak, 6200, 600, running, still));
  const band = (H - 110) / lanes;
  const laneY = (lane: number) => 110 + lane * band + band * 0.62;
  const bayX = (slot: number) => (perLane < 2 ? 450 : 300 + slot * ((W - 350) / (perLane - 1)));
  const robots = Array.from({ length: shown }, (_, i) => ({ lane: i % lanes, slot: Math.floor(i / lanes), i }));
  const [a, b, c] = unit;
  return (
    <svg className="rl-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <rect x="0" y="70" width={W} height={H - 70} rx="14" className="rl-floor" />
      <rect x="10" y="90" width="14" height={H - 110} rx="4" className="rl-gate" />
      <text x="32" y="98" className="rl-small">
        ворота
      </text>
      {Array.from({ length: lanes }, (_, lane) => (
        <g key={lane}>
          <path d={`M50 ${laneY(lane)}H${W - 16}`} className="rl-lane" />
          <rect x="270" y={laneY(lane) - 50} width={W - 290} height="28" rx="3" className="rl-rack" />
          {Array.from({ length: perLane }, (_, slot) =>
            slot * lanes + lane < shown ? (
              <g key={slot} className="rl-drop" style={vars({ "--d": `${(slot * lanes + lane) * 0.3 + 1.2}s` })}>
                <Box x={bayX(slot)} y={laneY(lane) - 36} />
              </g>
            ) : null,
          )}
        </g>
      ))}
      {robots.map(({ lane, slot, i }) => (
        <g key={i} transform={`translate(0 ${laneY(lane)})`}>
          <g
            className="rl-drive"
            style={vars({ "--x": `${bayX(slot) - 60}px`, "--d": `${(slot * lanes + lane) * 0.3}s` })}
          >
            <g transform="translate(60 0)">
              <Carrier />
            </g>
          </g>
        </g>
      ))}
      <text className="rl-count" x="20" y="48">
        {counted}
        <tspan className="rl-small" dx="10">
          {plural(Math.round(peak), a, b, c)} в час
        </tspan>
      </text>
      <text className="rl-count" x={W - 20} y="48" textAnchor="end">
        <tspan className="rl-small" dx="0">
          {plural(fleet, "робот", "робота", "роботов")}{" "}
        </tspan>
        {fleet}
      </text>
    </svg>
  );
}

/* Счетчики над сценой, как у паллет: слева работа в час набирается, справа роботов */
function Counters({
  counted,
  peak,
  fleet,
  unit,
}: {
  counted: number;
  peak: number;
  fleet: number;
  unit: [string, string, string];
}) {
  const [a, b, c] = unit;
  return (
    <>
      <text className="rl-count" x="20" y="48">
        {counted}
        <tspan className="rl-small" dx="10">
          {plural(Math.round(peak), a, b, c)} в час
        </tspan>
      </text>
      <text className="rl-count" x={W - 20} y="48" textAnchor="end">
        <tspan className="rl-small" dx="0">
          {plural(fleet, "робот", "робота", "роботов")}{" "}
        </tspan>
        {fleet}
      </text>
    </>
  );
}

/* Робот-уборщик сверху: тот же белый корпус и лицо, что у паллетника, сзади щетка */
function Scrubber() {
  return (
    <g>
      <rect x="-27" y="-13" width="6" height="26" rx="3" className="rl-brush" />
      <rect x="-22" y="-15" width="44" height="30" rx="7" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <rect x="17" y="-7" width="3" height="14" rx="1.5" fill={FACE} />
      <circle cx="-17" cy="-10" r="2.2" fill="#4a86cf" />
      <circle cx="-1" cy="0" r="7" fill="none" stroke={INK} strokeWidth="1" opacity="0.3" />
    </g>
  );
}

// пыль на полу: точки на одних и тех же местах, без случайности, чтобы кадр не прыгал
const DUST = Array.from({ length: 70 }, (_, i) => ({ x: 46 + ((i * 97) % 548), y: 104 + ((i * 53) % 236) }));

/* Сцена 1 уборки: каждый робот проходит свою пару полос змейкой, туда и обратно, за щеткой
   остается чистая полоса. Роботов столько, сколько в парке (до 4), счетчик набирает м² в час */
export function CleanScene({
  fleet,
  peak,
  unit,
  running,
  still,
}: Live & { fleet: number; peak: number; unit: [string, string, string] }) {
  const shown = Math.max(1, Math.min(fleet, 4));
  const lanes = shown * 2;
  const band = (H - 120) / lanes;
  const laneY = (lane: number) => 100 + lane * band + band / 2;
  const strip = Math.min(34, band * 0.8);
  const counted = Math.round(useCount(peak, 6200, 600, running, still));
  return (
    <svg className="rl-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <rect x="0" y="70" width={W} height={H - 70} rx="14" className="rl-floor" />
      <text x="20" y="94" className="rl-small">
        проезды
      </text>
      {DUST.map((dot, i) => (
        <circle key={i} cx={dot.x} cy={dot.y} r="1.6" className="rl-dust" />
      ))}
      {Array.from({ length: lanes }, (_, lane) => (
        <rect
          key={lane}
          x="36"
          y={laneY(lane) - strip / 2}
          width={W - 72}
          height={strip}
          rx={strip / 2}
          className={lane % 2 ? "rl-clean is-back" : "rl-clean"}
          style={vars({ "--d": `${Math.floor(lane / 2) * 0.35}s` })}
        />
      ))}
      {Array.from({ length: shown }, (_, robot) => (
        <g key={robot} transform={`translate(60 ${laneY(robot * 2)})`}>
          <g
            className="rl-sweep"
            style={vars({ "--x": `${W - 120}px`, "--dy": `${band}px`, "--d": `${robot * 0.35}s` })}
          >
            <g className="rl-turn">
              <Scrubber />
            </g>
          </g>
        </g>
      ))}
      <Counters counted={counted} peak={peak} fleet={fleet} unit={unit} />
    </svg>
  );
}

/* Стеллаж-полка сверху, такой робот товар к человеку подвозит целиком */
function Pod() {
  return (
    <g>
      <rect x="-14" y="-14" width="28" height="28" rx="2" className="rl-pod" />
      <path d="M-14 -4.7H14M-14 4.7H14M-4.7 -14V14M4.7 -14V14" className="rl-pod-cells" />
    </g>
  );
}

/* Сцена 1 отбора: роботы подлезают под полку, везут ее к станции, где стоит отборщик, и
   возвращают на место. Роботов столько, сколько в парке (до 12), счетчик набирает строки в час */
export function PickScene({
  fleet,
  peak,
  unit,
  running,
  still,
}: Live & { fleet: number; peak: number; unit: [string, string, string] }) {
  const shown = Math.max(1, Math.min(fleet, 12));
  const lanes = Math.min(3, shown);
  const perLane = Math.ceil(shown / lanes);
  const counted = Math.round(useCount(peak, 6200, 600, running, still));
  const band = (H - 110) / lanes;
  const laneY = (lane: number) => 110 + lane * band + band * 0.55;
  const bayX = (slot: number) => (perLane < 2 ? 470 : 330 + slot * ((W - 370) / (perLane - 1)));
  const dockX = 132;
  const robots = Array.from({ length: shown }, (_, i) => ({ lane: i % lanes, slot: Math.floor(i / lanes), i }));
  return (
    <svg className="rl-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <rect x="0" y="70" width={W} height={H - 70} rx="14" className="rl-floor" />
      <text x="20" y="94" className="rl-small">
        станции
      </text>
      <text x={W - 20} y="94" className="rl-small" textAnchor="end">
        полки
      </text>
      {Array.from({ length: lanes }, (_, lane) => (
        <g key={lane}>
          <path d={`M${dockX} ${laneY(lane)}H${W - 16}`} className="rl-lane" />
          <rect x="66" y={laneY(lane) - 22} width="36" height="44" rx="5" className="rl-station" />
          <g className="rl-picker">
            <Person x={40} y={laneY(lane) + 4} />
          </g>
          {Array.from({ length: perLane }, (_, slot) => (
            <rect
              key={slot}
              x={bayX(slot) - 16}
              y={laneY(lane) - 16}
              width="32"
              height="32"
              rx="3"
              className="rl-slot"
            />
          ))}
        </g>
      ))}
      {robots.map(({ lane, slot, i }) => (
        <g key={i} transform={`translate(${bayX(slot)} ${laneY(lane)})`}>
          <g
            className="rl-drive"
            style={vars({ "--x": `${dockX - bayX(slot)}px`, "--d": `${(slot * lanes + lane) * 0.3}s` })}
          >
            {/* лицом к станции: туда едет вперед, обратно задом, как паллетник от стеллажа */}
            <g transform="scale(-1 1)">
              <Carrier loaded={false} />
            </g>
            <Pod />
          </g>
        </g>
      ))}
      <Counters counted={counted} peak={peak} fleet={fleet} unit={unit} />
    </svg>
  );
}

/* Сцена 2: вложение как сосуд, месячная экономия падает в него монетами, уровень растет по месяцам.
   Наполнился: вложение вернулось. Не наполнился за горизонт: видно, какая доля вернулась */
export function MoneyScene({
  investment,
  refill,
  horizon,
  running,
  still,
}: Live & { investment: number; refill: Refill; horizon: number }) {
  const months = refill.months ?? horizon * 12;
  const month = Math.round(useCount(months, 5000, 600, running, still));
  const level = refill.share;
  const jar = { x: 180, y: 96, w: 230, h: 244 };
  const done = refill.months != null;
  // экономии нет: монетам падать неоткуда, пишем, на сколько расходы с роботами выше
  const loss = refill.loss ?? 0;
  const mid = jar.x + jar.w / 2;
  return (
    <svg className="rl-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <text className="rl-small" x={mid} y="34" textAnchor="middle">
        {loss > 0
          ? `экономии нет, расходы выше на ${mln(loss)} млн ₽ в год`
          : `экономия ${number(refill.perMonth / 1_000_000, 1)} млн ₽ в месяц`}
      </text>
      {Array.from({ length: loss > 0 ? 0 : 6 }, (_, i) => (
        <g key={i} className="rl-coin" style={vars({ "--i": i, "--x": `${((i * 37) % 120) - 60}px` })}>
          <circle cx={mid} cy="62" r="14" />
          <text x={mid} y="68" textAnchor="middle">
            ₽
          </text>
        </g>
      ))}
      <clipPath id="rl-jar-clip">
        <rect x={jar.x} y={jar.y} width={jar.w} height={jar.h} rx="20" />
      </clipPath>
      <rect x={jar.x} y={jar.y} width={jar.w} height={jar.h} rx="20" className="rl-jar" />
      <g clipPath="url(#rl-jar-clip)">
        <rect
          x={jar.x}
          y={jar.y + jar.h * (1 - level)}
          width={jar.w}
          height={jar.h * level}
          className={done ? "rl-fill is-done" : "rl-fill"}
        />
      </g>
      <text className="rl-jar-label" x={mid} y={jar.y + 34} textAnchor="middle">
        вложено {mln(investment)} млн ₽
      </text>
      <text className="rl-small" x="450" y="150">
        {done ? "месяц" : "месяцев прошло"}
      </text>
      <text className="rl-count is-big" x="450" y="206">
        {month}
      </text>
      <text className="rl-small" x="450" y="238">
        из {months}
        {done ? "" : `, это ${horizon} лет`}
      </text>
      <g transform={`translate(${mid} ${jar.y + jar.h / 2 + 24})`}>
        <g className="rl-stamp">
          <rect x="-120" y="-26" width="240" height="52" rx="26" className={done ? "is-done" : "is-short"} />
          <text textAnchor="middle" y="8">
            {done ? "вложение вернулось" : loss > 0 ? "не вернется" : `вернется ${Math.round(level * 100)}%`}
          </text>
        </g>
      </g>
    </svg>
  );
}

function Person({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cx="0" cy="-10" r="6.5" />
      <path d="M-10 15v-8c0-5.5 4.5-9 10-9s10 3.5 10 9v8z" />
    </g>
  );
}

/* Сцена 3: сначала люди на этой работе, потом большинство уходит на другую работу, приезжают
   роботы, рядом остаются операторы. Под ними набираются затраты за горизонт: без роботов и с ними */
export function PeopleScene({
  before,
  after,
  fleet,
  baselineTotal,
  purchaseTotal,
  horizon,
}: {
  before: number;
  after: number;
  fleet: number;
  baselineTotal: number;
  purchaseTotal: number;
  horizon: number;
}) {
  const people = Math.min(before, 36);
  const robots = Math.min(fleet, 24);
  const stay = Math.min(after, people);
  const cols = 12;
  const top = Math.max(baselineTotal, purchaseTotal) || 1;
  const spot = (i: number) => ({ x: 60 + (i % cols) * 44, y: 84 + Math.floor(i / cols) * 50 });
  // полосы сразу под фигурками: сколько рядов заняли люди или роботы, столько и отступаем. Под
  // фигурками подпись, кто есть кто: черная фигурка это ставка, которая останется
  const rows = Math.max(Math.ceil(people / cols), Math.ceil((stay + robots) / cols), 1);
  const legendY = 84 + rows * 50 - 14;
  const sumsY = legendY + 44;
  const span = W - 72;
  const height = sumsY + 112;
  return (
    <svg className="rl-svg" viewBox={`0 0 ${W} ${height}`} aria-hidden="true">
      <text className="rl-head rl-phase is-before" x="36" y="40">
        без роботов: {before} {plural(before, "ставка", "ставки", "ставок")}
      </text>
      <text className="rl-head rl-phase is-after" x="36" y="40">
        с роботами: {fleet} {plural(fleet, "робот", "робота", "роботов")}
        {stay ? ` и ${stay} ${plural(stay, "ставка", "ставки", "ставок")}` : ""}
      </text>
      {Array.from({ length: people }, (_, i) => {
        const { x, y } = spot(i);
        return (
          <g key={`p${i}`} className={i < stay ? "rl-person is-stay" : "rl-person"} style={vars({ "--i": i })}>
            <Person x={x} y={y} />
          </g>
        );
      })}
      {Array.from({ length: robots }, (_, i) => {
        const { x, y } = spot(stay + i);
        return (
          <g key={`r${i}`} className="rl-arrive" style={vars({ "--i": i })}>
            <g transform={`translate(${x} ${y}) scale(0.7)`}>
              <Carrier loaded={false} />
            </g>
          </g>
        );
      })}
      <g className="rl-legend" transform={`translate(36 ${legendY})`}>
        {stay > 0 && (
          <>
            <g className="rl-person-icon" transform="scale(0.7)">
              <Person x={10} y={10} />
            </g>
            <text className="rl-small" x="22" y="12">
              {stay} {plural(stay, "ставка останется", "ставки останутся", "ставок останутся")} рядом с роботами
            </text>
          </>
        )}
        <g transform={`translate(${stay > 0 ? 400 : 0} 6) scale(0.5)`}>
          <Carrier loaded={false} />
        </g>
        <text className="rl-small" x={stay > 0 ? 418 : 18} y="12">
          робот
        </text>
      </g>
      {/* затраты за горизонт: подпись над полосой видна сразу, полоса дорастает до числа графика */}
      <g className="rl-sums" transform={`translate(36 ${sumsY})`}>
        <text className="rl-bar-text" x="0" y="0">
          без роботов за {horizon} лет {mln(baselineTotal)} млн ₽
        </text>
        <rect
          x="0"
          y="10"
          width={Math.max(2, span * (baselineTotal / top))}
          height="22"
          rx="6"
          className="rl-bar is-now"
        />
        <text className="rl-bar-text is-buy" x="0" y="62">
          с роботами {mln(purchaseTotal)} млн ₽
        </text>
        <rect
          x="0"
          y="72"
          width={Math.max(2, span * (purchaseTotal / top))}
          height="22"
          rx="6"
          className="rl-bar is-buy"
        />
      </g>
    </svg>
  );
}
