import { useEffect, useState } from "react";

import type { CalculationResult, Parameter, Plan, PlanMeasures, RackType, Solution, StaffLine } from "../api/client";
import { api } from "../api/client";
import { shared, type SharedCalculation } from "../api/projects";
import { ActionBar, ActionMore, Button, EmptyState, Header, Hero, Waiting } from "../ui";
import { Scout04 } from "../ui/robots";
import "./app.css";
import { picksOf, requestFrom, tasksOf } from "./saving";
import { Economics } from "./steps/Economics";

// Расчет по публичной ссылке /share/<token>. Одна сохраненная версия, только для просмотра:
// цифры такие, какими их сохранили, смена на плане гоняется заново по тому же плану.
// Почты владельца и других версий здесь нет: сервер их не отдает.

type State = {
  facilityId: string;
  taskIds: string[];
  picks?: Record<string, { robotId: string; share: number }[]>;
  choices?: Record<string, string>;
  robotId?: string;
  overrides: Record<string, number>;
  staff: StaffLine[];
  plan: Plan | null;
};

const dateTime = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow", // как в отчетах: сервис московский, а часы у компьютера бывают любые
});

export function Shared() {
  const token = window.location.pathname.split("/")[2] ?? "";
  const [data, setData] = useState<SharedCalculation | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Parameter[]>([]);
  const [rackTypes, setRackTypes] = useState<RackType[]>([]);
  const [measures, setMeasures] = useState<PlanMeasures | null>(null);
  // названия решений: у каждой задачи свой подбор
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    shared(token)
      .then(setData)
      .catch((error: Error) => setFailure(error.message));
  }, [token]);

  const state = data?.state as State | undefined;
  const counted = state ? tasksOf(state.taskIds ?? [], picksOf(state)) : [];
  const operationIds = [...new Set(counted.map((one) => one.operation_id))].join(",");

  // Справочники для экрана: подписи параметров, типы стеллажей, числа плана и название решения
  useEffect(() => {
    if (!state) return;
    api
      .parameters(state.facilityId, state.taskIds)
      .then(setParameters)
      .catch(() => undefined);
    api
      .rackTypes()
      .then(setRackTypes)
      .catch(() => undefined);
    Promise.all(operationIds.split(",").map((id) => api.solutions(state.facilityId, id)))
      .then((lists) => setSolutions(lists.flat()))
      .catch(() => undefined);
    if (state.plan)
      api
        .planMeasure(state.plan)
        .then((answer) => setMeasures(answer.measures))
        .catch(() => undefined);
  }, [state, operationIds]);

  // Битая или отозванная ссылка: не пустой экран, а объяснение и выход, как на 404
  if (failure)
    return (
      <div className="u-page">
        <Header />
        <main className="u-main u-wrap">
          <Hero title="Ссылка не работает" lead="Ее отозвали, или в адресе ошибка. Попросите прислать новую." compact />
          <EmptyState
            robot={<Scout04 />}
            actions={
              <>
                <Button arrow href="/">
                  На главную
                </Button>
                <Button kind="link" href="/calc">
                  Посчитать свой склад
                </Button>
              </>
            }
          >
            Владелец расчета мог закрыть доступ по ссылке или сохранить новую версию с другой ссылкой. Свой склад можно
            посчитать без регистрации: значения уже стоят, поправить их можно на любом шаге.
          </EmptyState>
        </main>
      </div>
    );

  if (!data || !state) return <Waiting title="Открываем расчет" />;

  // тот же запрос, что собирает кабинет: старые версии с одним решением считаются по первой задаче
  const request = { ...requestFrom(state), staff: state.staff, plan: state.plan };

  const download = (kind: "pdf" | "xlsx") => {
    setExporting(kind);
    setExportError(null);
    api
      .report(kind, request)
      .then(({ blob, name }) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.click();
        URL.revokeObjectURL(link.href);
      })
      .catch((error: Error) => setExportError(`Файл не собрался: ${error.message}`))
      .finally(() => setExporting(null));
  };

  const names = new Map(
    data.result
      ? ((data.result as CalculationResult).tasks ?? []).map((one) => [one.operation_id, one.operation_name])
      : [],
  );
  const lead =
    `Версия ${data.version}, сохранена ${dateTime.format(new Date(data.saved_at))}. Только просмотр: цифры такие, какими их сохранили.` +
    (data.same_data ? "" : " С тех пор мы обновили нормативы или каталог, свежий расчет может отличаться.");

  return (
    <div className="u-page">
      <Header
        nav={
          // главная кнопка страницы, синяя, как везде
          <Button arrow href="/calc">
            Посчитать свой склад
          </Button>
        }
      />
      <main className="u-main u-wrap">
        <Hero title={data.name} lead={lead} compact />
        <Economics
          readOnly
          request={request}
          parameters={parameters}
          overrides={state.overrides ?? {}}
          onChangeParameter={() => undefined}
          result={data.result as CalculationResult | null}
          loading={false}
          error={data.result ? null : "В этой версии нет посчитанного результата"}
          facilityId={state.facilityId}
          tasks={counted.map((one) => ({
            operationId: one.operation_id,
            name: names.get(one.operation_id) ?? one.operation_id,
            robotId: one.robot_id,
            robotName: solutions.find((item) => item.robot_id === one.robot_id)?.product.split(" (")[0] ?? one.robot_id,
            share: one.share,
          }))}
          plan={state.plan}
          measures={measures}
          rackTypes={rackTypes}
          onChangePlan={() => undefined}
        />
        <ActionBar
          summary={
            exportError ??
            (exporting
              ? `Собираем ${exporting === "pdf" ? "отчет" : "таблицы"}: сервер считает заново вместе со сменой, до полуминуты`
              : "Расчет открыт по ссылке. Свой склад можно посчитать без регистрации")
          }
        >
          <span className="u-action-end">
            <ActionMore label="Файлы">
              <Button kind="light" disabled={exporting !== null} onClick={() => download("xlsx")}>
                <span>
                  <span className="u-wide">Таблицы </span>Excel
                </span>
              </Button>
              <Button kind="light" disabled={exporting !== null} onClick={() => download("pdf")}>
                <span>
                  <span className="u-wide">Отчет </span>PDF
                </span>
              </Button>
            </ActionMore>
          </span>
        </ActionBar>
      </main>
    </div>
  );
}
