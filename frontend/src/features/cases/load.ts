import { useEffect, useState } from "react";

import { api, type DemoCase as CaseAnswer, type Parameter, type Plan, type PlanMeasures } from "../../api/client";
import type { DemoCase } from "./demoCases";

/* Разбор считает сервер (GET /api/cases/<id>) тем же расчетом, что мастер на значениях по
   умолчанию, и держит готовым в памяти. Здесь только просим его и подписи значений "Что дано".
   Список и страница разбора просят один и тот же разбор: запрос на вкладку один */

// План и его числа сервер отдает целиком, со всеми полями: те же типы, что у мастера
export type CaseData = Omit<CaseAnswer, "plan" | "measures"> & {
  plan: Plan;
  measures: PlanMeasures;
  parameters: Parameter[];
};

const running = new Map<string, Promise<CaseData>>();

export function loadCase(one: DemoCase): Promise<CaseData> {
  const known = running.get(one.id);
  if (known) return known;
  const next = Promise.all([api.demoCase(one.id), api.parameters("warehouse", [one.operationId])]).then(
    ([answer, parameters]) => ({
      ...answer,
      plan: answer.plan as Plan,
      measures: answer.measures as PlanMeasures,
      parameters,
    }),
    (error: unknown) => {
      running.delete(one.id);
      throw error;
    },
  );
  running.set(one.id, next);
  return next;
}

export type Loaded = { data: CaseData | null; failed: boolean };

export function useCase(one: DemoCase | undefined, attempt = 0): Loaded {
  const [state, setState] = useState<Loaded & { id: string }>({ data: null, failed: false, id: "" });
  useEffect(() => {
    if (!one) return;
    let live = true;
    loadCase(one)
      .then((data) => live && setState({ data, failed: false, id: one.id }))
      .catch(() => live && setState({ data: null, failed: true, id: one.id }));
    return () => {
      live = false;
    };
  }, [one, attempt]);
  // ответ другого разбора не показываем, пока свой не пришел
  return one && state.id === one.id ? state : { data: null, failed: false };
}
