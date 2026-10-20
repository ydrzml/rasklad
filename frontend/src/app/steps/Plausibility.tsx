import type { CalculationResult } from "../../api/client";
import { number, percent, term, TRUST_TITLES } from "../format";

type Check = NonNullable<CalculationResult["plausibility"]>[number];

/* Как показатель звучит словами и в каких единицах диапазон */
const NAMES: Record<Check["id"], { name: string; value: (v: number | null) => string; band: (c: Check) => string }> = {
  payback_years: {
    name: "окупаемость",
    value: (v) => (v === null ? "дольше горизонта" : term(v)),
    band: (c) => `${number(c.low)}-${number(c.high)} года`,
  },
  staff_cut_share: {
    name: "людей на отборе меньше на",
    value: (v) => percent(v),
    band: (c) => `${percent(c.low)}-${percent(c.high)}`,
  },
};

/* Сверка итога с реальными внедрениями (аудит Б2). Сравнение и диапазоны посчитал сервер, у каждого
   диапазона источник в config/model.yaml. Окупаемость сервер сверяет только у покупки: у аренды
   кейс один. Поэтому у раскрытой аренды строки окупаемости нет.
   Нет данных по показателю: строки нет, а не "в диапазоне" */
export function Plausibility({ checks, scenario }: { checks: Check[]; scenario: string }) {
  const shown = checks.filter((one) => !one.scenario_id || one.scenario_id === scenario);
  if (!shown.length) return null;
  // компактно, одной строкой под ответом: заголовок и показатели рядом. Откуда диапазоны лежит в
  // свернутом блоке оговорок (PlausibilitySources)
  return (
    <div className="u-sanity is-compact">
      <span className="u-sanity-head">Сверка с реальными внедрениями:</span>
      <ul className="u-sanity-list">
        {shown.map((one) => {
          const meta = NAMES[one.id];
          const inside = one.status === "inside";
          return (
            <li key={`${one.id}:${one.scenario_id ?? ""}`} className={inside ? "is-inside" : "is-off"}>
              <span className="u-sanity-mark" aria-hidden="true">
                {inside ? "✓" : "!"}
              </span>
              <span>
                {meta.name} <b className="mono">{meta.value(one.value)}</b>:{" "}
                {inside
                  ? "в диапазоне реальных внедрений"
                  : `${one.status === "above" ? "выше" : "ниже"} обычного, проверьте`}{" "}
                <span className="u-sanity-band">(у внедрений {meta.band(one)})</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* Откуда диапазоны сверки: источник, доверие и дата каждого */
export function PlausibilitySources({ checks, scenario }: { checks: Check[]; scenario: string }) {
  const shown = checks.filter((one) => !one.scenario_id || one.scenario_id === scenario);
  if (!shown.length) return null;
  return (
    <div className="u-sanity">
      <p className="u-sanity-head">Откуда диапазоны сверки</p>
      <ul className="u-sanity-sources">
        {shown.map((one) => (
          <li key={`${one.id}:${one.scenario_id ?? ""}`}>
            <b>{NAMES[one.id].name}</b>, {NAMES[one.id].band(one)}, доверие {one.trust} (
            {TRUST_TITLES[one.trust] ?? one.trust}
            {one.date ? `, ${one.date}` : ""}): {one.source}
          </li>
        ))}
      </ul>
    </div>
  );
}
