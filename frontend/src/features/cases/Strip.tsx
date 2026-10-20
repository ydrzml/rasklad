import { useEffect, useState } from "react";

import { aboutYears, term } from "../../app/format";
import { plural } from "../../app/steps/economicsNames";
import { CASES } from "./demoCases";
import { loadCase } from "./load";
import "./strip.css";

/* Полоса над выбором объекта на шаге 1: тем, кто не знает, с чего начать, готовые разборы одной
   ссылкой. Цифры берем из тех же разборов на сервере; пока не пришли, ссылка стоит без них */
export function CasesStrip() {
  const [lines, setLines] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    for (const one of CASES)
      loadCase(one)
        .then((data) => {
          const purchase = (data.result.scenarios ?? []).find((scenario) => scenario.id === "purchase");
          const fleet = data.result.sizing?.fleet ?? 0;
          if (!live || !purchase || !fleet) return;
          // окупаемость как везде: дольше горизонта примерно целыми годами, дальше не окупается
          const back =
            purchase.payback_cumulative_years == null && purchase.payback_later_years != null
              ? `примерно ${aboutYears(purchase.payback_later_years, data.result.horizon_years)}`
              : term(purchase.payback_cumulative_years);
          const line = `${fleet} ${plural(fleet, "робот", "робота", "роботов")} · ${back}`;
          setLines((now) => ({ ...now, [one.id]: line }));
        })
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <aside className="k-strip" aria-label="Готовые разборы">
      <div className="k-strip-text">
        <b>Не знаете, с чего начать?</b>
        <span>Посмотрите, как посчитан готовый склад, и вернитесь к своему.</span>
      </div>
      <nav className="k-strip-links">
        {CASES.map((one) => (
          <a key={one.id} href={`/cases/${one.id}`}>
            <span>{one.title}</span>
            <small className="mono">{lines[one.id] ?? " "}</small>
          </a>
        ))}
      </nav>
    </aside>
  );
}
