import { useEffect, useRef, useState } from "react";

// Столбики по дням за две недели: одна величина, один синий, без легенды (название над графиком).
// Рисуем в точках экрана по ширине блока, поэтому подписи одного размера на любой ширине.
// Числом подписаны пик и сегодня, остальное при наведении; цель наведения во всю высоту дня.

export type DayValue = { day: string; value: number };

const H = 116;
const PAD = { top: 18, bottom: 22 };
const short = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function DayBars({ title, days, unit }: { title: string; days: DayValue[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const max = Math.max(1, ...days.map((d) => d.value));
  const step = W / Math.max(1, days.length);
  const bar = Math.max(4, Math.min(18, step - 6));
  const plot = H - PAD.top - PAD.bottom;
  const peak = days.reduce((best, d, i) => (d.value > days[best].value ? i : best), 0);
  const total = days.reduce((sum, d) => sum + d.value, 0);
  const label = (d: DayValue) => `${short.format(new Date(d.day))}: ${d.value} ${unit}`;

  return (
    <figure className="h-chart">
      <figcaption>
        <b>{title}</b>
        <span className="mono h-faint">{total} за 14 дней</span>
      </figcaption>
      <div className="h-chart-plot" ref={ref}>
        {W > 0 && (
          <svg width={W} height={H} role="img" aria-label={`${title}: ${days.map(label).join(", ")}`}>
            <line x1={0} x2={W} y1={H - PAD.bottom} y2={H - PAD.bottom} className="h-chart-base" />
            {days.map((d, i) => {
              const h = (d.value / max) * plot;
              const r = Math.min(4, h / 2, bar / 2);
              const x = i * step + (step - bar) / 2;
              const y = H - PAD.bottom - h;
              const shown = d.value > 0 && (i === peak || i === days.length - 1);
              return (
                <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={i * step} y={0} width={step} height={H} fill="transparent" />
                  {h > 0 && (
                    <path
                      d={`M${x} ${H - PAD.bottom}V${y + r}q0 ${-r} ${r} ${-r}h${bar - 2 * r}q${r} 0 ${r} ${r}V${H - PAD.bottom}Z`}
                      className={hover === i ? "h-chart-bar is-hover" : "h-chart-bar"}
                    />
                  )}
                  {shown && (
                    <text x={x + bar / 2} y={y - 5} textAnchor="middle" className="h-chart-value">
                      {d.value}
                    </text>
                  )}
                  {(i === 0 || i === days.length - 1) && (
                    <text x={i === 0 ? 0 : W} y={H - 6} textAnchor={i === 0 ? "start" : "end"} className="h-chart-axis">
                      {i === days.length - 1 ? "сегодня" : short.format(new Date(d.day))}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {hover !== null && (
          <span className="h-chart-tip mono" style={{ left: (hover + 0.5) * step }} role="status">
            {label(days[hover])}
          </span>
        )}
      </div>
    </figure>
  );
}
