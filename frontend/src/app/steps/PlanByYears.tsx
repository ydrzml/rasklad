import { useState } from "react";
import type { CalculationResult } from "../../api/client";
import { Drawer } from "../../ui/drawer";
import { mln } from "../format";
import { scenarioWord } from "./economicsNames";
import { buyMarks, buyoutLine, planRows, verdict, YEAR_PLAN_ID, type PlanInput, type PlanWay } from "./yearPlan";
import "./chosen.css";

/* План на 5 лет: внизу шага одна кнопка, по ней окно. В окне один вывод, маленький график накопленных
   затрат (покупка, аренда, без роботов, точки "окупилась" и "дешевле аренды") и таблица по годам.
   Числа сервера, слова и точки в yearPlan.ts */
const WAY_OF = { baseline: "none", purchase: "buy", raas: "rent" } as const;

export function PlanByYears({
  result,
  shown,
}: {
  result: CalculationResult;
  /* что выбрано переключателем шага 5: его линия и колонка выделены, остальные для сравнения */
  shown?: keyof typeof WAY_OF;
}) {
  const [open, setOpen] = useState(false);
  const scenarios = result.scenarios ?? [];
  const baseline = scenarios.find((one) => one.id === "baseline");
  const purchase = scenarios.find((one) => one.id === "purchase");
  const raas = scenarios.find((one) => one.id === "raas");
  if (!baseline?.cumulative_cost_rub?.length || !purchase?.cumulative_cost_rub?.length) return null;
  const horizon = result.horizon_years;
  const trial = raas?.trial ?? null;
  const buyout = raas?.buyout ?? null;
  const input: PlanInput = {
    horizon,
    none: baseline.cumulative_cost_rub,
    buy: purchase.cumulative_cost_rub,
    rent: raas?.cumulative_cost_rub?.length ? raas.cumulative_cost_rub : null,
    trial: trial?.cumulative_cost_rub ?? null,
    buyPayback: purchase.payback_cumulative_years ?? null,
    buyout: buyout
      ? {
          year: buyout.year,
          price: buyout.price_rub,
          tco: buyout.tco_rub,
          cheaper: buyout.cheaper_rub,
          payback: buyout.payback_years ?? null,
        }
      : null,
  };
  const buyoutText = buyoutLine(input.buyout, horizon);
  // покупка в кредит и в лизинг так и подписана: "Покупка в кредит"
  const names = { buy: scenarioWord(purchase), rent: "Аренда", none: "Без роботов" };
  const picked = shown ? WAY_OF[shown] : null;

  const title = `План на ${horizon} лет по годам`;
  return (
    <>
      <div className="u-yplan-bar" id={YEAR_PLAN_ID}>
        <button className="u-btn u-btn-ghost u-yplan-open" type="button" onClick={() => setOpen(true)}>
          {title}
        </button>
      </div>
      <Drawer open={open} title={title} onClose={() => setOpen(false)} wide>
        <div className="u-yplan">
          <p className="u-yplan-advice">{verdict(input)}</p>
          <div className="u-yplan-scroll">
            <PlanChart input={input} names={names} picked={picked} />
          </div>
          {buyoutText && <p className="u-yplan-note">{buyoutText}</p>}
          <h3 className="u-yplan-sub">Сколько уходит в каждый год</h3>
          <PlanTable input={input} names={names} picked={picked} />
          {trial && (
            <p className="u-yplan-note">
              Год аренды с выкупом это допущение: поставщики в наших данных дают договоры от 30-36 месяцев. Выкуп в
              конце года по остаточной стоимости, {mln(trial.price_rub)} млн ₽, дальше роботы ваши.
            </p>
          )}
        </div>
      </Drawer>
    </>
  );
}

const LINES: { way: Exclude<PlanWay, "trial">; name: string; tone: string }[] = [
  { way: "buy", name: "Покупка", tone: "buy" },
  { way: "rent", name: "Аренда", tone: "rent" },
  { way: "none", name: "Без роботов", tone: "now" },
];

/* Накопленные затраты по годам: где линия ниже, там дешевле. Точка "окупилась": покупка
   догнала работу без роботов; точка "дешевле аренды": покупка опустилась ниже аренды */
type Names = Record<Exclude<PlanWay, "trial">, string>;

function PlanChart({ input, names, picked }: { input: PlanInput; names: Names; picked: PlanWay | null }) {
  const W = 1100;
  const H = 190;
  const pad = { l: 46, r: 170, t: 16, b: 26 };
  const lines = LINES.flatMap((line) => {
    const points = input[line.way];
    return points && points.length > 1 ? [{ ...line, name: names[line.way], points }] : [];
  });
  const top = Math.max(1, ...lines.flatMap((one) => one.points));
  const x = (t: number) => pad.l + (t / input.horizon) * (W - pad.l - pad.r);
  const y = (value: number) => pad.t + (1 - value / top) * (H - pad.t - pad.b);
  const at = (points: number[], t: number) => {
    const left = Math.min(points.length - 2, Math.floor(t));
    return points[left] + (points[left + 1] - points[left]) * (t - left);
  };
  const marks = buyMarks(input.buy, input.none, input.rent ?? null);
  // подписи у концов линий раздвигаем, чтобы не налезали
  const ends = lines
    .map((one, index) => ({ index, at: y(one.points[one.points.length - 1]) }))
    .sort((a, b) => a.at - b.at);
  for (let n = 1; n < ends.length; n += 1) ends[n].at = Math.max(ends[n].at, ends[n - 1].at + 16);
  const endOf = (index: number) => ends.find((one) => one.index === index)?.at ?? 0;
  const label = lines.map((one) => `${one.name} ${mln(one.points[one.points.length - 1])} млн ₽`).join(", ");
  return (
    <svg
      className="u-yplan-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Накопленные затраты за ${input.horizon} лет: ${label}`}
    >
      {[0, top / 2, top].map((tick) => (
        <g key={tick}>
          <line x1={pad.l} x2={W - pad.r} y1={y(tick)} y2={y(tick)} className="u-yplan-grid" />
          <text x={pad.l - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" className="u-yplan-tick">
            {Math.round(tick / 1_000_000).toLocaleString("ru-RU")}
          </text>
        </g>
      ))}
      {Array.from({ length: input.horizon + 1 }, (_, t) => (
        <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="u-yplan-tick">
          {t === 0 ? "старт" : `${t} год`}
        </text>
      ))}
      {lines.map((one, index) => (
        <g key={one.way} className={`u-yplan-line is-${one.tone}${picked && picked !== one.way ? " is-dim" : ""}`}>
          <path d={one.points.map((v, n) => `${n ? "L" : "M"}${x(n).toFixed(1)} ${y(v).toFixed(1)}`).join("")} />
          <text x={W - pad.r + 10} y={endOf(index)} dominantBaseline="middle" className="u-yplan-end">
            {one.name} {mln(one.points[one.points.length - 1])}
          </text>
        </g>
      ))}
      {marks.map((mark) => {
        const cx = x(mark.at);
        const cy = y(at(input.buy, mark.at));
        return (
          <g key={mark.key} className="u-yplan-dot">
            <circle cx={cx} cy={cy} r={5.5} />
            <text x={cx} y={mark.below ? cy + 20 : cy - 12} textAnchor="middle">
              {mark.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* Таблица по годам: за год крупно, всего с начала строкой ниже. Отметки говорят, с чем сравнивали */
function PlanTable({ input, names, picked }: { input: PlanInput; names: Names; picked: PlanWay | null }) {
  const rows = planRows(input);
  const columns: { way: PlanWay; name: string; tone: string }[] = [
    { way: "buy" as const, name: names.buy === "Покупка" ? "Покупка сразу" : names.buy, tone: "buy" },
    { way: "rent" as const, name: "Аренда", tone: "rent" },
    // свой знак, штрихованный: это не аренда, а допущение рядом с ней, путать колонки нельзя
    { way: "trial" as const, name: "Год аренды, потом выкуп", tone: "trial" },
    { way: "none" as const, name: "Без роботов", tone: "now" },
  ].filter((column) => rows[0]?.cells[column.way]);
  return (
    <div className="u-yplan-scroll">
      <table className="u-yplan-table">
        <thead>
          <tr>
            <th scope="col">Год</th>
            {columns.map((column) => (
              <th
                key={column.way}
                scope="col"
                className={`is-${column.tone}${picked === column.way ? " is-picked" : ""}`}
              >
                <i aria-hidden="true" />
                {column.name}
                {column.way === "trial" && <small className="u-yplan-tag">допущение</small>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.year} className={row.paidBack || row.buyBeatsRent ? "is-marked" : undefined}>
              <th scope="row">
                {row.year === 0 ? "старт" : `${row.year} год`}
                {row.paidBack && <span className="u-yplan-mark">покупка окупилась: дешевле, чем без роботов</span>}
                {row.buyBeatsRent && <span className="u-yplan-mark">с этого года покупка дешевле аренды</span>}
              </th>
              {columns.map((column) => {
                const cell = row.cells[column.way];
                return (
                  <td key={column.way}>
                    {cell && (
                      <>
                        <span className="mono">{mln(cell.year)}</span>
                        <small>
                          всего <span className="mono">{mln(cell.total)}</span>
                        </small>
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
