import type { CalculationResult } from "../../api/client";
import { Fold } from "../../ui";
import "./decision.css";

const WAYS = [
  { id: "baseline", name: "без роботов" },
  { id: "purchase", name: "покупка" },
  { id: "raas", name: "аренда" },
];

/* Рубли за одну операцию: до ста рублей с десятыми, дальше целыми */
export function unitPrice(value: number): string {
  const digits = Math.abs(value) < 100 ? 1 : 0;
  return `${value.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ₽`;
}

/* Что сделать с расчетом дальше: цена одной операции в трех сценариях одной строкой на задачу и
   список вопросов поставщику. Оба блока считает сервер, они же стоят в PDF и Excel. У старых
   сохраненных расчетов этих полей нет, тогда блока просто нет */
export function ForDecision({ result }: { result: CalculationResult }) {
  const costs = result.unit_costs ?? [];
  const questions = result.supplier_questions ?? [];
  if (costs.length === 0 && questions.length === 0) return null;
  return (
    <section className="u-decision" aria-label="Цена операции и вопросы поставщику">
      {costs.map((cost) => (
        <p key={cost.operation_id} className="u-unitcost">
          <b>За {cost.per}</b>
          {WAYS.map((way) => {
            const one = cost.scenarios.find((row) => row.id === way.id);
            return one ? (
              <span key={way.id}>
                {way.name} <b className="mono">{unitPrice(one.rub_per_unit)}</b>
              </span>
            ) : null;
          })}
          <small>все расходы за {result.horizon_years} лет на одну операцию</small>
        </p>
      ))}
      {questions.length > 0 && (
        <Fold title={`Что спросить у поставщика: ${questions.length} ${questions.length < 5 ? "вопроса" : "вопросов"}`}>
          <ol className="u-asklist">
            {questions.map((one) => (
              <li key={one.topic}>
                <b>{one.topic}.</b> {one.question}
                {one.why && <small>{one.why}</small>}
              </li>
            ))}
          </ol>
        </Fold>
      )}
    </section>
  );
}
