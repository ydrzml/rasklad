/* Проигрыватель смены: часы, кнопки, шкала смены и кривая парка.

   Часы живут вне React: кадр идет шестьдесят раз в секунду, и если бы время лежало в состоянии
   экрана, на каждом кадре перерисовывался бы весь лист с тысячами ячеек. Слой с роботами и шкала
   подписываются на часы сами, остальной экран о кадрах не знает. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { IconButton } from "./board";

export class Clock {
  t = 0;
  playing = false;
  speed = 120;
  private listeners = new Set<() => void>();
  private frame = 0;
  private last = 0;

  constructor(public length: number) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private tell() {
    for (const listener of this.listeners) listener();
  }

  set(t: number) {
    this.t = Math.min(this.length, Math.max(0, t));
    this.tell();
  }

  play(on = !this.playing) {
    if (on && this.t >= this.length) this.t = 0;
    this.playing = on;
    cancelAnimationFrame(this.frame);
    if (on) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
    this.tell();
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.tell();
  }

  private tick = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.t = Math.min(this.length, this.t + dt * this.speed);
    if (this.t >= this.length) this.playing = false;
    this.tell();
    if (this.playing) this.frame = requestAnimationFrame(this.tick);
  };

  stop() {
    cancelAnimationFrame(this.frame);
    this.playing = false;
  }
}

export function useClock(length: number): Clock {
  const clock = useMemo(() => new Clock(length), [length]);
  useEffect(() => () => clock.stop(), [clock]);
  return clock;
}

/* Время часов для небольших частей экрана: кнопки, подписи, шкала */
function useClockTime(clock: Clock): { t: number; playing: boolean; speed: number } {
  const [now, setNow] = useState({ t: clock.t, playing: clock.playing, speed: clock.speed });
  useEffect(() => clock.subscribe(() => setNow({ t: clock.t, playing: clock.playing, speed: clock.speed })), [clock]);
  return now;
}

/* Кнопки проигрывателя: пуск и пауза, скорость, время смены. Пробел ставит на паузу */
export function Player({
  clock,
  speeds,
  children,
}: {
  clock: Clock;
  speeds: { value: number; name: string }[];
  children?: ReactNode;
}) {
  const now = useClockTime(clock);
  return (
    <div className="u-player">
      <IconButton
        label={now.playing ? "Пауза, пробел" : "Пуск, пробел"}
        active={now.playing}
        onClick={() => clock.play()}
      >
        {now.playing ? <path d="M5 3.5v8M10 3.5v8" /> : <path d="M4.5 3l8 4.5-8 4.5z" strokeLinejoin="round" />}
      </IconButton>
      <span className="u-player-time mono" aria-live="off">
        {hhmm(now.t)} <span className="u-player-of">из {hhmm(clock.length)}</span>
      </span>
      <div className="u-player-speeds" role="group" aria-label="Скорость">
        {speeds.map((one) => (
          <button
            key={one.value}
            type="button"
            className={now.speed === one.value ? "u-player-speed is-on" : "u-player-speed"}
            aria-pressed={now.speed === one.value}
            onClick={() => clock.setSpeed(one.value)}
          >
            {one.name}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

function hhmm(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/* Шкала смены. Две полосы с общим временем слева направо, у каждой своя величина: сверху спрос
   по часам, снизу весь парк по минутам, цветом, какая доля роботов что делает. Одной осью их не
   показать, единицы разные. Красные отметки внизу это минуты, когда роботы стояли в очереди.
   Шкалу тянут мышью, наведение показывает, что было в эту минуту */
export type TimelineLayer = { id: string; name: string; color: string; shares: number[] };

export function Timeline({
  clock,
  demand,
  stack,
  fleet,
  queues,
}: {
  clock: Clock;
  demand: number[];
  /* доли парка по минутам по действиям, снизу вверх */
  stack: TimelineLayer[];
  fleet: number;
  queues: { from: number; to: number }[];
}) {
  const now = useClockTime(clock);
  const box = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const hours = clock.length / 3600;
  const minutes = stack[0]?.shares.length || Math.round(hours * 60);
  const W = 1000;
  const top = Math.max(1, ...demand);
  const at = (event: { clientX: number }) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };
  const drag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.buttons !== 1) return;
    clock.set(at(event) * clock.length);
  };
  // весь парк: по одному контуру на действие, столбик на минуту. Контуры собираются один раз,
  // кадры плеера их не перерисовывают
  const strip = useMemo(() => {
    const step = W / Math.max(1, minutes);
    const base = new Float64Array(minutes);
    return stack.map((layer) => {
      let d = "";
      layer.shares.forEach((share, m) => {
        if (share <= 0) return;
        const h = share * STRIP_H;
        const y = STRIP_Y + STRIP_H - base[m] - h;
        base[m] += h;
        d += `M${(m * step).toFixed(2)} ${y.toFixed(2)}h${(step + 0.3).toFixed(2)}v${h.toFixed(2)}h${(-step - 0.3).toFixed(2)}z`;
      });
      return <path key={layer.id} d={d} fill={layer.color} />;
    });
  }, [stack, minutes]);
  const x = (now.t / clock.length) * W;
  const hoverMinute = hover === null ? null : Math.min(minutes - 1, Math.floor(hover * minutes));
  const hoverHour = hover === null ? null : Math.min(demand.length - 1, Math.floor(hover * demand.length));
  return (
    <div className="u-timeline">
      <div className="u-timeline-names" aria-hidden="true">
        <span>спрос</span>
        <span>роботы</span>
      </div>
      <div className="u-timeline-track">
        <svg
          ref={box}
          viewBox={`0 0 ${W} 76`}
          preserveAspectRatio="none"
          role="slider"
          tabIndex={0}
          aria-label="Время смены"
          aria-valuemin={0}
          aria-valuemax={Math.round(hours * 60)}
          aria-valuenow={Math.round(now.t / 60)}
          aria-valuetext={hhmm(now.t)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            clock.set(at(event) * clock.length);
          }}
          onPointerMove={(event) => {
            setHover(at(event));
            drag(event);
          }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 3600 : 600;
            if (event.key === "ArrowRight") clock.set(clock.t + step);
            else if (event.key === "ArrowLeft") clock.set(clock.t - step);
            else if (event.key === " ") {
              event.preventDefault();
              clock.play();
            } else return;
            event.preventDefault();
          }}
        >
          {demand.map((value, hour) => (
            <rect
              key={hour}
              className="u-timeline-demand"
              x={(hour / demand.length) * W + 2}
              y={22 - (value / top) * 20}
              width={W / demand.length - 4}
              height={(value / top) * 20}
              rx={2}
            />
          ))}
          {strip}
          {queues.map((queue) => (
            <rect
              key={queue.from}
              className="u-timeline-queue"
              x={(queue.from / minutes) * W}
              y={68}
              width={Math.max(3, ((queue.to - queue.from) / minutes) * W)}
              height={8}
              rx={1.5}
            />
          ))}
          {Array.from({ length: Math.floor(hours) + 1 }, (_, hour) => (
            <line
              key={hour}
              x1={(hour / hours) * W}
              x2={(hour / hours) * W}
              y1={0}
              y2={76}
              className="u-timeline-hour"
            />
          ))}
          {hover !== null && <line x1={hover * W} x2={hover * W} y1={0} y2={76} className="u-timeline-hover" />}
          <line x1={x} x2={x} y1={0} y2={76} className="u-timeline-head" />
        </svg>
        <div className="u-timeline-hours mono" aria-hidden="true">
          {Array.from({ length: Math.floor(hours) + 1 }, (_, hour) => (
            <span key={hour} style={{ left: `${(hour / hours) * 100}%` }}>
              {hour} ч
            </span>
          ))}
        </div>
        {hover !== null && hoverMinute !== null && hoverHour !== null && (
          <div className="u-timeline-tip" style={{ left: `${hover * 100}%` }}>
            <b className="mono">{hhmm(hover * clock.length)}</b>
            <span>
              спрос <b className="mono">{Math.round(demand[hoverHour] ?? 0)}</b> в час
            </span>
            {stack
              .map((layer) => ({ layer, count: Math.round((layer.shares[hoverMinute] ?? 0) * fleet) }))
              .filter((one) => one.count > 0)
              .map(({ layer, count }) => (
                <span key={layer.id}>
                  {layer.name} <b className="mono">{count}</b>
                </span>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

const STRIP_Y = 28; // где начинается полоса парка на шкале
const STRIP_H = 36; // ее высота

/* Кривая парка: сколько операций в час вытягивает парк. Точки это замеры поиска парка, между
   ними прямые. Пунктир это спрос, на который берем парк, отметка это выбранный парк. Там, где
   кривая ложится, парк упирается в проезды, ворота или станции. Наведение показывает ближайший
   замер */
export function FleetCurve({ points, demand, fleet }: { points: [number, number][]; demand: number; fleet: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<SVGSVGElement>(null);
  const W = 300;
  const H = 150;
  const pad = { l: 34, r: 10, t: 12, b: 22 };
  // По горизонтали только то, что мерили, с запасом по краям: замеров два-три у самого ответа,
  // и шкала от нуля сжала бы их в угол, а линию от нуля дорисовала бы без замера
  const sizes = [...points.map(([n]) => n), fleet];
  const spare = Math.max(1, (Math.max(...sizes) - Math.min(...sizes)) * 0.25);
  const from = Math.max(0, Math.floor(Math.min(...sizes) - spare));
  const to = Math.ceil(Math.max(...sizes) + spare);
  // По вертикали тоже от замеров, а не от нуля: смысл графика в том, что парк на робота меньше
  // не дотягивает до спроса, и от нуля эта разница была бы в пару точек экрана
  const values = [...points.map(([, v]) => v), demand];
  const top = Math.max(1, ...values) * 1.08;
  const floor = Math.max(0, Math.floor(Math.min(...values) * 0.85));
  const x = (n: number) => pad.l + ((n - from) / Math.max(1, to - from)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - ((v - floor) / Math.max(1, top - floor)) * (H - pad.t - pad.b);
  const line = points.map(([n, v], k) => `${k ? "L" : "M"}${x(n).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  // выбранный парк на кривой: между замерами по прямой
  const at = (n: number) => {
    const right = points.findIndex(([m]) => m >= n);
    if (right <= 0) return right === 0 ? points[0][1] : (points.at(-1)?.[1] ?? 0);
    const [n1, v1] = points[right - 1];
    const [n2, v2] = points[right];
    return v1 + ((v2 - v1) * (n - n1)) / Math.max(1e-9, n2 - n1);
  };
  const picked = points.length ? at(fleet) : 0;
  const shown = hover === null ? null : points[hover];
  return (
    <figure className="u-curve">
      <svg
        ref={box}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Кривая парка: ${fleet} роботов дают ${Math.round(picked)} операций в час при спросе ${Math.round(demand)}`}
        onPointerMove={(event) => {
          const rect = box.current?.getBoundingClientRect();
          if (!rect || !points.length) return;
          const px = ((event.clientX - rect.left) / rect.width) * W;
          let best = 0;
          points.forEach(([n], k) => {
            if (Math.abs(x(n) - px) < Math.abs(x(points[best][0]) - px)) best = k;
          });
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="u-curve-axis" />
        <line x1={pad.l} x2={W - pad.r} y1={y(demand)} y2={y(demand)} className="u-curve-demand" />
        <text x={pad.l + 4} y={y(demand) - 5} className="u-curve-note">
          спрос {Math.round(demand)}
        </text>
        <path d={line} className="u-curve-line" />
        {points.map(([n, v]) => (
          <circle key={n} cx={x(n)} cy={y(v)} r={2} className="u-curve-mark" />
        ))}
        <line x1={x(fleet)} x2={x(fleet)} y1={pad.t} y2={H - pad.b} className="u-curve-fleet" />
        <circle cx={x(fleet)} cy={y(picked)} r={4.5} className="u-curve-dot" />
        <text x={pad.l - 6} y={H - pad.b} className="u-curve-tick" textAnchor="end" dominantBaseline="middle">
          {floor}
        </text>
        <text x={pad.l - 6} y={y(demand)} className="u-curve-tick" textAnchor="end" dominantBaseline="middle">
          {Math.round(demand)}
        </text>

        {points
          .filter(([n]) => Math.abs(n - fleet) > 0.5)
          .map(([n]) => (
            <text key={`n${n}`} x={x(n)} y={H - 6} className="u-curve-tick" textAnchor="middle">
              {number1(n)}
            </text>
          ))}
        <text x={x(fleet)} y={H - 6} className="u-curve-tick is-fleet" textAnchor="middle">
          {fleet}
        </text>
        {shown && (
          <>
            <line x1={x(shown[0])} x2={x(shown[0])} y1={pad.t} y2={H - pad.b} className="u-curve-hover" />
            <circle cx={x(shown[0])} cy={y(shown[1])} r={3.5} className="u-curve-hover-dot" />
          </>
        )}
      </svg>
      <figcaption className="u-curve-cap">
        <span className="u-curve-axes">по горизонтали роботов, по вертикали операций в час, точки это замеры</span>
        {shown ? (
          <>
            <b className="mono">{number1(shown[0])}</b> роботов: <b className="mono">{Math.round(shown[1])}</b> операций
            в час
          </>
        ) : (
          <>
            выбранный парк <b className="mono">{fleet}</b>: <b className="mono">{Math.round(picked)}</b> операций в час
          </>
        )}
      </figcaption>
    </figure>
  );
}

function number1(value: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}
