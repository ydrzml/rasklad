import { useEffect, useState } from "react";

import { api, type CalculationRequest, type CalculationResult, type ReadinessResult } from "../../api/client";
import { Alert, BlockHead, Checklist } from "../../ui";

/* Что подготовить на складе до роботов. Считает сервер по тому же плану и парку, что расчет:
   проезды и ярусы против робота, пандусы, пол, навигация, связь, зарядка и очереди из прогона.
   Тот же список идет отдельным разделом в отчет PDF, его отдают инженеру склада */
export function Readiness({
  request,
  result,
  onBrief,
}: {
  request: CalculationRequest;
  result: CalculationResult;
  onBrief?: (data: ReadinessResult) => void;
}) {
  const [data, setData] = useState<ReadinessResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // у смешанного парка задача приходит несколькими частями: собираем их роботов в одну задачу
    const grouped = new Map<string, { robot_id: string; fleet: number; share: number }[]>();
    for (const part of result.tasks ?? []) {
      const robots = grouped.get(part.operation_id) ?? [];
      robots.push({ robot_id: part.robot_id, fleet: part.sizing.fleet, share: part.share ?? 1 });
      grouped.set(part.operation_id, robots);
    }
    const tasks = grouped.size
      ? [...grouped].map(([operation_id, robots]) => ({ operation_id, robots }))
      : [
          {
            operation_id: result.operation_id,
            robots: [{ robot_id: result.robot_id, fleet: result.sizing?.fleet ?? 0, share: 1 }],
          },
        ];
    const abort = new AbortController();
    api
      .readiness(
        { facility_id: request.facility_id, tasks, plan: request.plan, overrides: request.overrides },
        abort.signal,
      )
      .then((answer) => {
        setData(answer);
        onBrief?.(answer);
        setError("");
      })
      .catch((failure: Error) => {
        if (failure.name !== "AbortError") setError(`Список не собрался: ${failure.message}`);
      });
    return () => abort.abort();
    // список собираем заново по новому расчету: парк и план приходят вместе с ним
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <section id="readiness">
      <BlockHead
        title="Что подготовить на складе"
        note="До запуска роботов: по вашему плану, выбранным решениям и прогону смены. Этот же список отдельным разделом в отчете PDF, его можно отдать инженеру"
      />
      {error ? (
        <Alert>{error}</Alert>
      ) : !data ? (
        <p className="u-shift-note">Собираем список...</p>
      ) : (
        <Checklist
          items={data.items.map((item, index) => ({
            key: `${item.id}:${item.solution}:${index}`,
            status: item.status,
            title: item.title,
            tag: item.solution,
            text: item.why,
            basis: item.basis,
            trust: item.trust,
            link: item.link,
            cost: item.cost,
            costNote: item.cost_note,
          }))}
          foot={
            <>
              {!data.plan_edited && (
                <Alert>
                  План вы не чертили: пункты про проезды, стеллажи и пандусы посчитаны по типовой планировке
                </Alert>
              )}
              <Alert tone="note">{data.budget_note}</Alert>
            </>
          }
        />
      )}
    </section>
  );
}
