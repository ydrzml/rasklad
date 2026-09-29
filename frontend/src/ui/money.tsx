import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { unitText } from "./digits";
import "./money.css";

/* Сценарий по ТЗ: как сейчас, покупка, аренда. У каждого свой цвет из tokens.css,
   и он один на плитке, в графике и в таблице: цвет идет за сценарием, а не за местом. */
export type Tone = "now" | "buy" | "rent";

export type Fact = { label: string; value: string; unit?: string };

type TileProps = {
  tone: Tone;
  name: string;
  note: string;
  headline: Fact;
  facts: Fact[];
  badge?: string;
  best?: boolean;
  /* Как посчитано главное число: формула словами и та же формула в цифрах */
  how?: ReactNode;
};

/* Плитки сценариев рядом: главное число сверху, под ним два-три факта строками. */
export function Scenarios({ children }: { children: ReactNode }) {
  return <div className="u-scenarios">{children}</div>;
}

export function Scenario({ tone, name, note, headline, facts, badge, best, how }: TileProps) {
  return (
    <article className={best ? `u-scenario is-${tone} is-best` : `u-scenario is-${tone}`}>
      <header>
        <i className="u-scenario-key" aria-hidden="true" />
        <h3>{name}</h3>
        {badge && <span className="u-badge u-badge-blue">{badge}</span>}
      </header>
      <p className="u-scenario-note">{note}</p>
      <p className="u-scenario-head">
        <span className="u-scenario-label">{headline.label}</span>
        <span className="u-scenario-value mono">
          {headline.value}
          {headline.unit && <small>{headline.unit}</small>}
        </span>
      </p>
      <dl>
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className="mono">
              {fact.value}
              {fact.unit && <small>{fact.unit}</small>}
            </dd>
          </div>
        ))}
      </dl>
      {how && (
        <details className="u-scenario-how">
          <summary>как посчитано</summary>
          <div>{how}</div>
        </details>
      )}
    </article>
  );
}

/* Формула в две строки: словами и в цифрах. Числа подставил сервер, поэтому они моноширинные */
export function Formula({ words, numbers }: { words: string; numbers: string }) {
  return (
    <p className="u-formula">
      <span>{words}</span>
      <span className="mono">{numbers}</span>
    </p>
  );
}

export type Series = { tone: Tone; name: string; points: number[] };

/* Накопленные затраты по годам. Точки считает сервер, здесь только рисуем.
   Подписи у концов линий, поэтому сценарий узнается не только по цвету. */
export function CostChart({
  series,
  unit,
  scale,
  format,
}: {
  series: Series[];
  unit: string;
  scale: number;
  format: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<SVGSVGElement>(null);
  const frame = useRef<HTMLElement>(null);
  // Лист рисуем в точках экрана, а не растягиваем: подписи на телефоне остаются читаемыми
  const [W, setW] = useState(640);
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const watch = new ResizeObserver(([entry]) => setW(Math.max(280, Math.round(entry.contentRect.width))));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  const narrow = W < 520;
  const H = narrow ? 220 : 260;
  const pad = { l: 46, r: narrow ? 78 : 150, t: 16, b: 30 };
  const years = Math.max(1, ...series.map((one) => one.points.length - 1));
  const top = niceTop(Math.max(1, ...series.flatMap((one) => one.points)) / scale);
  const x = (year: number) => pad.l + (year / years) * (W - pad.l - pad.r);
  const y = (value: number) => H - pad.b - (value / scale / top) * (H - pad.t - pad.b);
  const ticks = [0, top / 2, top];
  const ends = spread(
    series.map((one) => y(one.points[one.points.length - 1] ?? 0)),
    18,
  );

  return (
    <figure className="u-cost" ref={frame}>
      <svg
        ref={box}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={series
          .map((one) => `${one.name}: ${format(one.points[one.points.length - 1] ?? 0)} ${unit} за ${years} лет`)
          .join("; ")}
        onPointerMove={(event) => {
          const rect = box.current?.getBoundingClientRect();
          if (!rect) return;
          const px = ((event.clientX - rect.left) / rect.width) * W;
          const year = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * years);
          setHover(year >= 0 && year <= years ? year : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={W - pad.r} y1={y(tick * scale)} y2={y(tick * scale)} className="u-cost-grid" />
            <text x={pad.l - 8} y={y(tick * scale)} className="u-cost-tick" textAnchor="end" dominantBaseline="middle">
              {Math.round(tick).toLocaleString("ru-RU")}
            </text>
          </g>
        ))}
        {Array.from({ length: years + 1 }, (_, year) => (
          <text key={year} x={x(year)} y={H - 8} className="u-cost-tick" textAnchor="middle">
            {year === 0 ? "старт" : `${year} год`}
          </text>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="u-cost-hover" />}
        {series.map((one, index) => (
          <g key={one.tone} className={`u-cost-series is-${one.tone}`}>
            <path d={one.points.map((v, n) => `${n ? "L" : "M"}${x(n).toFixed(1)} ${y(v).toFixed(1)}`).join("")} />
            {hover !== null && one.points[hover] !== undefined && (
              <circle cx={x(hover)} cy={y(one.points[hover])} r={4.5} />
            )}
            <text x={W - pad.r + 10} y={ends[index]} dominantBaseline="middle" className="u-cost-end">
              {one.name}
              {!narrow && <tspan className="mono"> {format(one.points[one.points.length - 1] ?? 0)}</tspan>}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="u-cost-cap">
        <span>
          {hover === null
            ? `за ${years} лет, ${unit}`
            : hover === 0
              ? `на старте, ${unit}`
              : `к концу ${hover} года, ${unit}`}
          :
        </span>
        {series.map((one) => (
          <span key={one.tone} className={`u-cost-pick is-${one.tone}`}>
            <i aria-hidden="true" />
            {one.name} <b className="mono">{format(one.points[hover ?? years] ?? 0)}</b>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

// Круглая верхняя граница шкалы: 256 -> 300, 44 -> 50
function niceTop(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((one) => one * power >= value) ?? 10;
  return step * power;
}

// Подписи у концов линий не налезают друг на друга: раздвигаем их по высоте
function spread(ys: number[], gap: number): number[] {
  const order = ys.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  for (let n = 1; n < order.length; n += 1) {
    order[n].value = Math.max(order[n].value, order[n - 1].value + gap);
  }
  const out = [...ys];
  order.forEach((one) => (out[one.index] = one.value));
  return out;
}

export type CompareRow = { label: string; hint?: string; cells: ReactNode[]; muted?: boolean };

/* Таблица сравнения сценариев. На узком экране строка складывается в карточку,
   и у каждого числа появляется название сценария. */
export function Compare({ columns, rows }: { columns: { name: string; tone?: Tone }[]; rows: CompareRow[] }) {
  return (
    <table className="u-compare">
      <thead>
        <tr>
          <th scope="col">Показатель</th>
          {columns.map((column) => (
            <th key={column.name} scope="col" className={column.tone ? `is-${column.tone}` : undefined}>
              {column.tone && <i aria-hidden="true" />}
              {column.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className={row.muted ? "is-muted" : undefined}>
            <th scope="row">
              {row.label}
              {row.hint && <small>{row.hint}</small>}
            </th>
            {row.cells.map((cell, index) => (
              <td key={columns[index]?.name ?? index} className="mono" data-label={columns[index]?.name}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type SourceItem = {
  key: string;
  name: string;
  value: string;
  source: string;
  trust: string;
  trustTitle: string;
};

/* Откуда цифры: буква оценки доверия, название значения, само значение и источник под ним. */
export function SourceList({ items }: { items: SourceItem[] }) {
  return (
    <ul className="u-sources">
      {items.map((item) => (
        <li key={item.key}>
          <span className="u-trust" title={item.trustTitle}>
            {item.trust}
          </span>
          <span className="u-sources-name">
            {item.name}
            <small>{item.source}</small>
          </span>
          <span className="u-sources-value mono">{unitText(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/* Ссылка вниз, к подробностям: если там свернутый блок, раскрываем его */
export function MoreLink({ href, text }: { href: string; text: string }) {
  return (
    <a
      className="u-more"
      href={href}
      onClick={() => {
        const target = document.getElementById(href.slice(1));
        const fold = target instanceof HTMLDetailsElement ? target : target?.closest("details");
        if (fold) fold.open = true;
        // свернутый блок шага раскрываем, иначе ссылка ведет в пустоту
        target?.closest(".u-collapse.is-closed")?.querySelector<HTMLButtonElement>(".u-collapse-btn")?.click();
      }}
    >
      {text}
    </a>
  );
}

export type LedgerRow = { key: string; name: string; value: string; hint?: string };

/* Куда уходят деньги: колонки «на старте», «каждый год», «за горизонт». В колонке статьи строками
   и итог под чертой. Суммы и итоги приходят с сервера, здесь только раскладываем */
export function Ledger({ children }: { children: ReactNode }) {
  return <div className="u-ledger">{children}</div>;
}

export function LedgerColumn({
  id,
  title,
  note,
  rows,
  total,
  after = [],
  children,
}: {
  id?: string;
  title: string;
  note?: string;
  rows: LedgerRow[];
  total: { name: string; value: string };
  /* строки под итогом, для сравнения: в итог не входят */
  after?: LedgerRow[];
  children?: ReactNode;
}) {
  return (
    <div className="u-ledger-col" id={id}>
      <h3>
        {title}
        {note && <span>{note}</span>}
      </h3>
      <dl>
        {rows.map((row) => (
          <div key={row.key}>
            <dt>
              {row.name}
              {row.hint && <small>{row.hint}</small>}
            </dt>
            <dd className="mono">{row.value}</dd>
          </div>
        ))}
        <div className="u-ledger-total">
          <dt>{total.name}</dt>
          <dd className="mono">{total.value}</dd>
        </div>
        {after.map((row) => (
          <div key={row.key} className="u-ledger-after">
            <dt>
              {row.name}
              {row.hint && <small>{row.hint}</small>}
            </dt>
            <dd className="mono">{row.value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </div>
  );
}

export type WhatIfRow = {
  key: string;
  name: string;
  base: string;
  what: string;
  cells: { key: string; main: string; sub: string; bad?: boolean; base?: boolean }[];
};

/* Что будет, если: строка на параметр, колонки это сдвиг на -20, -10, 0, +10, +20%.
   В ячейке крупно окупаемость, мельче стоимость владения. Базовый вариант выделен */
export function WhatIf({ heads, rows }: { heads: string[]; rows: WhatIfRow[] }) {
  return (
    <table className="u-whatif">
      <thead>
        <tr>
          <th scope="col">Если меняется</th>
          {heads.map((head) => (
            <th key={head} scope="col" className="mono">
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">
              {row.name}
              <small>{row.base}</small>
              <small>{row.what}</small>
            </th>
            {row.cells.map((cell, index) => (
              <td key={cell.key} className={cell.base ? "is-base" : undefined} data-label={heads[index]}>
                <b className={cell.bad ? "mono is-bad" : "mono"}>{cell.main}</b>
                <span className="mono">{cell.sub}</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* Все числа по силе влияния, "торнадо". Строка на число, полоса от выгоды при -20% до выгоды при
   +20%. Черта посередине это выгода как сейчас: левее хуже, правее лучше. Шкала у всех строк одна,
   поэтому длина полосы сравнима между строками, а строки идут по убыванию длины. */
export type TornadoRow = {
  key: string;
  name: string;
  note: string;
  /* выгода за горизонт при -20% и при +20%, рубли; null: вариант не считается */
  low: number | null;
  high: number | null;
  /* подписи концов: на сколько процентов число сдвинулось на самом деле, у доли 95% это "+5" */
  lowLabel: string;
  highLabel: string;
  min: number;
  max: number;
  size: string;
};

export function Tornado({
  rows,
  base,
  color,
  heads,
}: {
  rows: TornadoRow[];
  base: number;
  /* цвет сценария: полоса в сторону "лучше" */
  color: string;
  heads: { left: string; center: string; right: string; size: string };
}) {
  const reach = Math.max(1, ...rows.map((row) => Math.max(base - row.min, row.max - base)));
  // доля ширины от центра: 0 это черта "как сейчас", 1 это край шкалы
  const at = (value: number) => 50 + ((value - base) / reach) * 50;
  // у короткой полосы подписи концов налезли бы друг на друга: там их не ставим, размах справа
  const labeled = (value: number | null): value is number => value !== null && Math.abs(at(value) - 50) >= 4;
  return (
    <div className="u-tornado" style={{ "--tornado": color } as CSSProperties}>
      <div className="u-tornado-head">
        <span />
        <span className="u-tornado-axis">
          <span>{heads.left}</span>
          <b>{heads.center}</b>
          <span>{heads.right}</span>
        </span>
        <span>{heads.size}</span>
      </div>
      <ol>
        {rows.map((row) => (
          <li key={row.key}>
            <span className="u-tornado-name">
              {row.name}
              <small>{row.note}</small>
            </span>
            <span className="u-tornado-track" aria-hidden="true">
              {row.min < base && (
                <i className="is-worse" style={{ left: `${at(row.min)}%`, width: `${at(base) - at(row.min)}%` }} />
              )}
              {row.max > base && <i className="is-better" style={{ left: "50%", width: `${at(row.max) - 50}%` }} />}
              {labeled(row.low) && (
                <em className="mono" style={{ left: `${at(row.low)}%` }}>
                  {row.lowLabel}
                </em>
              )}
              {labeled(row.high) && (
                <em className="mono" style={{ left: `${at(row.high)}%` }}>
                  {row.highLabel}
                </em>
              )}
            </span>
            <b className="mono u-tornado-size">{row.size}</b>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* Главный ответ шага: одна фраза крупно, под ней вторая и строка ключевых чисел. У каждого числа
   ссылка вниз, к статьям, где видно, из чего оно сложилось. Сравнили с четырьмя одинаковыми
   карточками: там ответ "окупится за 1,3 года" терялся среди равных по весу чисел */
export type AnswerFact = { label: string; value: string; unit?: string; more?: { href: string; text: string } };

export function Answer({
  title,
  note,
  facts,
  heading,
}: {
  title: ReactNode;
  note: ReactNode;
  facts: AnswerFact[];
  /* ответ и есть заголовок экрана: h1, на него App ставит фокус при смене шага */
  heading?: boolean;
}) {
  const main = useRef<HTMLHeadingElement>(null);
  // Ответ приходит после расчета, когда шаг уже открыт и заголовок-заглушка с фокусом ушел.
  // Фокус без места (на body) переводим на ответ, чужой фокус не трогаем
  useEffect(() => {
    const active = document.activeElement;
    if (!heading || !main.current || (active && active !== document.body)) return;
    main.current.tabIndex = -1;
    main.current.focus({ preventScroll: true });
  }, [heading]);
  return (
    <div className="u-answer">
      {heading ? (
        <h1 ref={main} className="u-answer-main">
          {title}
        </h1>
      ) : (
        <p className="u-answer-main">{title}</p>
      )}
      <p className="u-answer-sub">{note}</p>
      <dl className="u-answer-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className="mono">
              {fact.value}
              {fact.unit && <small> {unitText(fact.unit)}</small>}
            </dd>
            {/* в dl внутри группы только dt и dd: ссылка в своем dd, иначе читалка теряет список */}
            {fact.more && (
              <dd className="u-answer-more">
                <MoreLink href={fact.more.href} text={fact.more.text} />
              </dd>
            )}
          </div>
        ))}
      </dl>
    </div>
  );
}

/* Полоса долей: одна сумма, разложенная по частям. Сегменты по порядку частей, цвет части задан
   индексом гаммы синьки, общее на объект серым. Подписи под полосой: часть, число, доля */
export type SharePart = { key: string; name: string; value: number; grey?: boolean };

const SHARE_COLORS = ["var(--lvl-5)", "var(--lvl-3)", "var(--lvl-2)", "var(--lvl-1)"];

/* Проценты долей так, чтобы в сумме вышло ровно 100: округляем вниз и раздаем недостающие
   единицы тем, у кого остаток больше. Иначе 4 + 95 + 2 давали 101 */
function wholePercents(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const floors = exact.map((value) => Math.floor(value));
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - floors[index] }))
    .filter((one) => values[one.index] > 0)
    .sort((a, b) => b.rest - a.rest);
  for (const one of order) {
    if (left <= 0) break;
    floors[one.index] += 1;
    left -= 1;
  }
  return floors;
}

export function ShareBar({
  label,
  parts,
  format,
  unit,
}: {
  label: string;
  parts: SharePart[];
  format: (value: number) => string;
  unit: string;
}) {
  const positive = parts.filter((part) => part.value > 0);
  const total = positive.reduce((sum, part) => sum + part.value, 0);
  const percents = wholePercents(parts.map((part) => Math.max(part.value, 0)));
  let tone = 0;
  const colored = parts.map((part, index) => ({
    ...part,
    percent: percents[index],
    color: part.grey ? "var(--sc-now)" : SHARE_COLORS[Math.min(tone++, SHARE_COLORS.length - 1)],
  }));
  return (
    <div className="u-sharebar">
      <span className="u-sharebar-label">
        {label} <b className="mono">{format(total)}</b> <span className="u-unit">{unit}</span>
      </span>
      <div
        className="u-sharebar-track"
        role="img"
        aria-label={`${label}: ${colored.map((p) => `${p.name} ${format(p.value)}`).join(", ")}`}
      >
        {colored
          .filter((part) => part.value > 0)
          .map((part) => (
            <i key={part.key} style={{ width: `${(part.value / total) * 100}%`, background: part.color }} />
          ))}
      </div>
      <span className="u-sharebar-legend">
        {colored.map((part) => (
          <span key={part.key}>
            <i style={{ background: part.color }} />
            {part.name} <b className="mono">{format(part.value)}</b>
            {total > 0 && part.value > 0 && <small className="mono">{part.percent}%</small>}
          </span>
        ))}
      </span>
    </div>
  );
}
