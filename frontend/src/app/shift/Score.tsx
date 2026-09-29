import { useEffect, useMemo, useRef, useState } from "react";

import { Button, type Clock } from "../../ui";
import { number } from "../format";
import { ACTION_COLOR, type Replay, summaryOf } from "./replay";
import { useDark, withAlpha } from "../../ui/theme";
import { tokenColor } from "./ShiftLayer";

const HEAD = 24; // строка часов сверху
// Строки роботов стоят в плеере ровно под шкалой смены: отступ слева это колонка подписей
// шкалы и зазор до полосы. Тогда час в строках под тем же часом шкалы
const LEFT = 64 + 10;
const RIGHT = 0;
const LEAST_ROW = 8; // строка робота тоньше не читается

/* Строки по каждому роботу под шкалой смены. Весь парк по минутам показывает шкала, а по кнопке
   под ней раскрывается каждый робот отдельно: час в строках под тем же часом шкалы. Сверху выводы
   словами, иначе двести строк по точке не читаются. Отдельного вида «Партитура» больше нет: план
   от него пропадал, а та же шкала и так стояла внизу.

   Картинка рисуется один раз, на каждом кадре двигается только черта текущего времени. Щелчок
   и протяжка ставят время */
export function Score({
  replay,
  clock,
  demand,
  waiting,
}: {
  replay: Replay;
  clock: Clock;
  /* спрос по часам смены: по нему видно, когда пик */
  demand: number[];
  /* доля времени в очередях из итогов смены сервера */
  waiting: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [open, setOpen] = useState(false);
  // холст рисуется цветами страницы: по смене темы перерисовываем
  const dark = useDark();

  useEffect(() => {
    const node = wrap.current;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    const watch = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  const all = Math.max(1, replay.robots.length);
  const row = Math.max(LEAST_ROW, Math.min(22, 430 / all));
  const top0 = HEAD;
  const tall = Math.round(top0 + row * all + 8);
  const summary = useMemo(() => summaryOf(replay, demand), [replay, demand]);

  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext("2d");
    if (!open || !node || !context || width <= LEFT) return;
    const ratio = window.devicePixelRatio || 1;
    node.width = Math.round(width * ratio);
    node.height = Math.round(tall * ratio);
    const length = replay.hours * 3600;
    const span = width - LEFT - RIGHT;
    const x = (t: number) => LEFT + (t / length) * span;
    const ink = tokenColor("var(--ink-soft)");
    const faint = withAlpha(tokenColor("var(--ink)"), 0.07);
    const colors = Object.fromEntries(Object.entries(ACTION_COLOR).map(([key, value]) => [key, tokenColor(value)]));

    const base = document.createElement("canvas");
    base.width = node.width;
    base.height = node.height;
    const b = base.getContext("2d");
    if (!b) return;
    b.setTransform(ratio, 0, 0, ratio, 0, 0);
    b.font = "11px 'JetBrains Mono', monospace";
    b.textBaseline = "middle";
    for (let hour = 0; hour <= replay.hours; hour++) {
      b.fillStyle = faint;
      b.fillRect(x(hour * 3600), HEAD - 4, 1, tall - HEAD - 4);
      b.fillStyle = ink;
      b.textAlign = hour === 0 ? "left" : hour === replay.hours ? "right" : "center";
      b.fillText(`${hour} ч`, x(hour * 3600), HEAD / 2);
    }
    {
      const gap = row >= 8 ? 2 : 1;
      replay.robots.forEach((legs, robot) => {
        const top = top0 + robot * row;
        if (row >= 11 || (robot + 1) % 10 === 0) {
          b.fillStyle = ink;
          b.textAlign = "right";
          b.fillText(String(robot + 1), LEFT - 8, top + row / 2);
        }
        for (const leg of legs) {
          b.fillStyle = colors[leg.action] ?? colors["без задания"];
          // короткие отрезки не пропадают: не уже половины точки
          b.fillRect(x(leg.from), top + gap / 2, Math.max(0.5, x(leg.to) - x(leg.from)), row - gap);
        }
      });
    }

    const draw = () => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, node.width, node.height);
      context.drawImage(base, 0, 0);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = tokenColor("var(--ink)");
      context.fillRect(x(clock.t) - 1, HEAD - 6, 2, tall - HEAD - 2);
    };
    draw();
    return clock.subscribe(draw);
  }, [replay, clock, width, row, tall, top0, open, dark]);

  const seek = (event: { clientX: number }) => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box) return;
    const share = (event.clientX - box.left - LEFT) / (box.width - LEFT - RIGHT);
    clock.set(Math.min(1, Math.max(0, share)) * replay.hours * 3600);
  };

  const hhmm = (hour: number) => `${hour}:00`;
  const whole = summary.peakTo - summary.peakFrom >= replay.hours;
  return (
    <div ref={wrap} className="u-score">
      <div className="u-score-more">
        <Button kind="ghost" onClick={() => setOpen(!open)}>
          {open ? "Свернуть строки роботов" : `По каждому роботу, ${all}`}
        </Button>
      </div>
      {open && (
        <>
          <ul className="u-score-facts">
            {whole ? (
              <li>
                Спрос ровный всю смену, в работе в среднем <b className="mono">{number(summary.peakBusy * 100, 0)}%</b>{" "}
                роботов.
              </li>
            ) : (
              <li>
                Пик спроса с <b className="mono">{hhmm(summary.peakFrom)}</b> до{" "}
                <b className="mono">{hhmm(summary.peakTo)}</b>: в работе{" "}
                <b className="mono">{number(summary.peakBusy * 100, 0)}%</b> роботов, вне пика{" "}
                <b className="mono">{number(summary.offBusy * 100, 0)}%</b>. Парк берем под пик, поэтому вне его часть
                роботов стоит.
              </li>
            )}
            <li>
              Одновременно заряжаются не больше <b className="mono">{summary.charging}</b> из{" "}
              <b className="mono">{all}</b>: садятся по очереди, а не все разом.
            </li>
            <li>
              {waiting < 0.01 ? (
                <>
                  В очередях роботы почти не стоят: <b className="mono">{number(waiting * 100, 1)}%</b> времени.
                </>
              ) : (
                <>
                  В очередях роботы стоят <b className="mono">{number(waiting * 100, 1)}%</b> времени, красным на
                  полосе.
                </>
              )}
            </li>
          </ul>
        </>
      )}
      {open && (
        <canvas
          ref={canvas}
          style={{ height: tall }}
          role="img"
          aria-label={`Смена по каждому роботу: ${all} строк, ${replay.hours} часов слева направо`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            seek(event);
          }}
          onPointerMove={(event) => event.buttons === 1 && seek(event)}
        />
      )}
    </div>
  );
}
