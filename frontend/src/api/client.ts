import { ApiError, fieldsText } from "./http";
import type { components } from "./schema";

export type Facility = components["schemas"]["Facility"];
export type Operation = components["schemas"]["Operation"];
export type Solution = components["schemas"]["Solution"];
export type Parameter = components["schemas"]["Parameter"];
export type FacilitySolution = components["schemas"]["FacilitySolution"];
export type FacilitySolutions = components["schemas"]["FacilitySolutions"];
export type CalculationRequest = components["schemas"]["CalculationRequest"];
export type CalculationResult = components["schemas"]["CalculationResult"];
export type ScenarioResult = components["schemas"]["ScenarioResult"];
export type SourceInfo = components["schemas"]["SourceInfo"];
export type TcoPart = components["schemas"]["TcoPart"];
export type SensitivityResult = components["schemas"]["SensitivityResult"];
export type SensitivityAll = components["schemas"]["SensitivityAll"];
export type SimulationResult = components["schemas"]["SimulationResult"];
export type ReadinessRequest = components["schemas"]["ReadinessRequest"];
export type ReadinessResult = components["schemas"]["ReadinessResult"];
/* Запрос прогона смены: план в типе приложения, остальное как в API */
export type SimulateBody = {
  facility_id: string;
  operation_id: string;
  robot_id: string;
  fleet: number;
  plan?: Plan | null;
  with_events?: boolean;
  slotted_by_turnover?: boolean;
  overrides?: Record<string, number>;
  /* доля объема задачи у этого решения при смешанном парке */
  share?: number;
};
export type ShiftSegment = components["schemas"]["Segment"];
export type ShiftPlace = components["schemas"]["Place"];
/* Куда можно ехать по линии движения: против стрелки нельзя, поперек можно */
export type Direction = "east" | "west" | "north" | "south";
// У полей плана в описании API есть значения по умолчанию, поэтому в сгенерированных типах
// они необязательные. Сервер отдает их всегда: уточняем здесь, чтобы экран не проверял каждое.
export type PlanItem = Required<components["schemas"]["Item"]>;
export type PlanLevel = Required<components["schemas"]["Level"]>;
export type PlanSection = Required<components["schemas"]["Section"]>;
export type Plan = Omit<
  components["schemas"]["Plan"],
  "items" | "floor" | "levels" | "sections" | "template" | "edited"
> & {
  template: string;
  edited: boolean;
  items: PlanItem[];
  floor: string[];
  levels: PlanLevel[];
  sections: PlanSection[];
};
export type PlanCheck = Required<components["schemas"]["PlanCheck"]>;
export type RouteMap = { rows: string[]; bands_m: number[] };
export type PlanMeasures = Omit<
  components["schemas"]["Measures"],
  "warnings" | "checks" | "unreachable" | "closed_racks" | "route_map"
> & {
  warnings: string[];
  checks: PlanCheck[];
  unreachable: number[][];
  closed_racks: number;
  route_map: RouteMap;
};
export type PlanTemplate = components["schemas"]["Template"];
export type Wall = "west" | "east" | "south" | "north";
export type CustomLayout = {
  docks: { wall: Wall; count: number }[];
  racks: "across" | "along" | "none";
};
/* Ответы анкеты «Свой склад»: анкета плюс габариты здания */
export type CustomAnswers = CustomLayout & { width_m: number; length_m: number };
export type RackType = components["schemas"]["RackType"];
export type GeneratedPlan = { plan: Plan; measures: PlanMeasures };
export type Role = components["schemas"]["Role"];
export type StaffForm = components["schemas"]["StaffForm"];
export type BudgetFit = components["schemas"]["BudgetFit"];
export type BudgetFitRequest = components["schemas"]["BudgetFitRequest"];
export type BudgetCheck = components["schemas"]["BudgetCheck"];
export type StaffLine = components["schemas"]["StaffLine"];
export type StaffReview = components["schemas"]["StaffReview"];
export type StaffReviewRequest = components["schemas"]["StaffReviewRequest"];
export type ImportResult = components["schemas"]["DataImportResult"];
export type ImportRow = components["schemas"]["DataImportRow"];

const SERVER_DOWN = "Сервер не отвечает. Проверьте связь и повторите: введенное не потерялось";
const GATEWAY = [502, 503, 504];

// Ошибку пишем человеку по-русски: что случилось и что сделать. Сервер объясняет отказ в detail,
// а если он не ответил совсем, так и говорим, а не показываем «Failed to fetch» (docs/ux-flow.md).
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === "AbortError") throw failure;
    throw new Error(SERVER_DOWN, { cause: failure });
  }
  // 502, 503 и 504 отвечает не наш сервер, а тот, что стоит перед ним: значит, наш не отвечает
  if (GATEWAY.includes(response.status)) throw new Error(SERVER_DOWN);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    // «Not Found» и «Method Not Allowed» FastAPI пишет сам и по-английски: это значит, что адреса на сервере нет
    const own = typeof data?.detail === "string" && !/^[A-Za-z ]+$/.test(data.detail);
    // отказ по полям приходит списком: в нем сказано, какое поле и что с ним не так
    const detail = own ? (data!.detail as string) : fieldsText(data?.detail);
    // код ответа нужен экрану: 422 это невозможный ввод, вести в параметры, 5xx повторить
    throw new ApiError(
      response.status,
      detail ??
        (response.status >= 500
          ? "Сервер не смог посчитать: это ошибка у нас. Повторите через минуту, введенное не потерялось"
          : `Сервер отклонил запрос, код ${response.status}`),
    );
  }
  return (await response.json()) as T;
}

export const api = {
  facilities: () => request<Facility[]>("/api/catalog/facilities"),
  // С планом подбор берет ширину проезда, верхний ярус и пандусы из него, а не из датасета.
  // Эти числа посчитал сервер в /api/plan/measure, здесь они только передаются дальше.
  solutions: (
    facility: string,
    operation: string,
    plan?: Pick<PlanMeasures, "aisle_m" | "rack_top_m" | "ramps" | "closed_racks"> | null,
    // масса груза с шага параметров, если человек ее поправил: по ней отсеиваются слабые роботы
    loadKg?: number,
  ) =>
    request<Solution[]>(
      `/api/catalog/solutions?facility=${facility}&operation=${operation}` +
        (plan
          ? `&aisle_mm=${Math.round(plan.aisle_m * 1000)}&rack_top_mm=${Math.round(plan.rack_top_m * 1000)}` +
            `&ramps=${plan.ramps}&closed_racks=${plan.closed_racks}`
          : "") +
        (loadKg !== undefined ? `&load_kg=${loadKg}` : ""),
    ),
  parameters: (facility: string, operations: string[]) =>
    request<Parameter[]>(`/api/catalog/parameters?facility=${facility}&operations=${operations.join(",")}`),
  // Цена, обслуживание и срок службы выбранных роботов: допущения шага экономики
  robotParameters: (robots: string[]) =>
    request<Parameter[]>(`/api/catalog/robot-parameters?robots=${robots.map(encodeURIComponent).join(",")}`),
  // Аэропорт и медучреждение: список решений с проверками по параметрам второго шага
  facilitySolutions: (
    body: { facility_id: string; operation_ids: string[]; overrides: Record<string, number> },
    signal?: AbortSignal,
  ) =>
    request<FacilitySolutions>("/api/catalog/facility-solutions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  /* штат по умолчанию под объем клиента: с правками объема численность датасета пересчитывается */
  staffForm: (facility: string, operations: string[], overrides: Record<string, number> = {}) =>
    request<StaffForm>("/api/staff/form", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facility_id: facility, operation_ids: operations, overrides }),
    }),
  // сколько роботов каждого решения влезает в бюджет со всеми вложениями на старте
  budgetFit: (body: BudgetFitRequest, signal?: AbortSignal) =>
    request<BudgetFit[]>("/api/budget/fit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  staffCheck: (body: StaffReviewRequest, signal?: AbortSignal) =>
    request<StaffReview>("/api/staff/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  planTemplates: () => request<PlanTemplate[]>("/api/plan/templates"),
  rackTypes: () => request<RackType[]>("/api/plan/rack-types"),
  planGenerate: (body: {
    facility_id: string;
    operation_ids: string[];
    template_id: string;
    overrides: Record<string, number>;
    width_m?: number | null;
    length_m?: number | null;
    custom?: CustomLayout | null;
  }) =>
    request<GeneratedPlan>("/api/plan/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  // План возвращается вместе с числами: зарядку ставит программа, и ее место могло измениться
  planMeasure: (plan: Plan, signal?: AbortSignal) =>
    request<GeneratedPlan>("/api/plan/measure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan),
      signal,
    }),
  // Змейка по проездам зоны: сервер кладет полосы в одну сторону и заменяет прежние полосы этой зоны
  planSerpentine: (plan: Plan, zone: string, first: Direction | "" = "") =>
    request<GeneratedPlan>("/api/plan/serpentine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, zone_id: zone, first }),
    }),
  simulate: (body: SimulateBody, signal?: AbortSignal) =>
    request<SimulationResult>("/api/simulation/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ with_events: false, ...body }),
      signal,
    }),
  // Отчет по тому же запросу, что и расчет: сервер считает заново и отдает файл
  report: async (kind: "pdf" | "xlsx", body: CalculationRequest): Promise<{ blob: Blob; name: string }> => {
    const response = await fetch(`/api/reports/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { detail?: unknown } | null;
      throw new Error(typeof data?.detail === "string" ? data.detail : `сервер ответил ${response.status}`);
    }
    const header = response.headers.get("Content-Disposition") ?? "";
    const named = /filename\*=UTF-8''([^;]+)/.exec(header);
    return { blob: await response.blob(), name: named ? decodeURIComponent(named[1]) : `otsenka.${kind}` };
  },
  // Что подготовить на складе до роботов: по плану, решениям и прогону смены тем же парком
  readiness: (body: ReadinessRequest, signal?: AbortSignal) =>
    request<ReadinessResult>("/api/readiness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  // Что будет, если зарплаты, цена робота, объем и остальное окажутся на 10-20% другими
  sensitivity: (body: CalculationRequest, signal?: AbortSignal) =>
    request<SensitivityResult>("/api/calculations/sensitivity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  // Все числа расчета по одному, по убыванию силы влияния: около секунды, поэтому по кнопке
  sensitivityAll: (body: CalculationRequest, signal?: AbortSignal) =>
    request<SensitivityAll>("/api/calculations/sensitivity/all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  // Журнал событий смены CSV: тот же прогон, что на экране, строками собирает сервер
  shiftLog: async (body: SimulateBody): Promise<{ blob: Blob; name: string }> => {
    const response = await fetch("/api/simulation/log.csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.text()) || `Сервер ответил ${response.status}`);
    const header = response.headers.get("Content-Disposition") ?? "";
    const named = /filename\*=UTF-8''([^;]+)/.exec(header);
    return { blob: await response.blob(), name: named ? decodeURIComponent(named[1]) : "zhurnal-smeny.csv" };
  },
  // Данные объекта из файла: шаблон Excel с текущими значениями и разбор заполненного файла.
  // Разбор ничего не сохраняет, он отвечает отчетом по строкам, а подставляет пользователь
  importTemplate: async (body: {
    facility_id: string;
    operation_ids: string[];
    overrides: Record<string, number>;
    staff: StaffLine[] | null;
  }): Promise<Blob> => {
    const response = await fetch("/api/import/template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`шаблон не собрался, сервер ответил ${response.status}`);
    return response.blob();
  },
  // Правки человека уходят вместе с файлом: смены из файла сервер проверяет вместе с ними
  importFile: (file: File, facility: string, operations: string[], overrides: Record<string, number> = {}) => {
    const form = new FormData();
    form.append("file", file);
    form.append("facility_id", facility);
    form.append("operation_ids", operations.join(","));
    form.append("overrides", JSON.stringify(overrides));
    return request<ImportResult>("/api/import", { method: "POST", body: form });
  },
  preview: (body: CalculationRequest, signal?: AbortSignal) =>
    request<CalculationResult>("/api/calculations/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
};
