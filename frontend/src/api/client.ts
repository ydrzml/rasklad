import { ApiError, fieldsText } from "./http";
import type { DxfBuilt, DxfDrawing } from "../app/plan/dxf";
import type { Building } from "../app/clinic/building";
import type { ClinicSegment, LiftSegment } from "../app/clinic/shift";
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
export type DemoCase = components["schemas"]["DemoCase"];
/* Запрос прогона смены: план в типе приложения, остальное как в API */
/* Итог медучреждения (POST /api/clinic/economics). Описан руками: schema.d.ts в main отстал от
   сервера, и перегенерация тянет чужие адреса */
export type ClinicScenario = {
  id: "baseline" | "purchase" | "raas" | "loan";
  available: boolean;
  why_not: string;
  start_rub: number;
  years_rub: number[];
  tco_rub: number;
  saving_rub: number;
  effect_year1_rub: number;
  payback_years: number | null;
  month_rub: number | null;
  first_payment_rub: number | null;
  robot_cost_rub: number;
  rent_period: "month" | "year";
  rental_options_rub: Record<string, number>;
  financing: {
    principal_rub: number;
    rate: number;
    term_months: number;
    first_month_rub: number;
    last_month_rub: number;
    payments_rub: number[];
    debt_left_rub: number[];
    interest_rub: number;
    insurance_rub: number[];
    equity_payback_years: number | null;
  } | null;
  cash_share_for_break_even: number | null;
  minimum_cash_saving_year_rub: number;
  annual_gap_rub: number;
  npv_rub: number;
  discounted_payback_years: number | null;
  residual_rub?: number;
};
export type ClinicQuote = { source?: string } & Partial<
  Record<
    | "price_rub"
    | "maintenance_rub_year"
    | "commissioning_rub"
    | "life_years"
    | "rent_month_rub"
    | "rent_first_month_rub"
    | "rent_year_rub"
    | "rent_first_year_rub",
    number
  >
> & { rent_service_included?: number };
export type ClinicQuotes = Record<string, ClinicQuote>;
export type ClinicFinance = Partial<
  Record<
    | "cash_realization_share"
    | "cleaning_time_saving_share"
    | "delivery_support_min_per_job"
    | "cleaner_support_min_per_shift"
    | "manual_door_assist_s"
    | "integration_rub"
    | "extra_annual_rub"
    | "rent_service_included"
    | "days_per_year"
    | "cleaner_hour_rub"
    | "loan_enabled"
    | "loan_rate"
    | "loan_months"
    | "loan_own_share"
    | "loan_insurance_share",
    number
  >
> &
  Partial<
    Record<
      | "delivery_hour_rub"
      | "manual_delivery_min_per_job"
      | "manual_cleaning_m2_per_hour"
      | "delivery_staff_per_shift"
      | "cleaning_staff_per_shift"
      | "cash_saving_cap_rub_year"
      | "annual_work_hours"
      | "paid_leave_hours"
      | "wage_growth"
      | "inflation"
      | "discount_rate",
      number
    >
  >;
export type ClinicMoney = {
  horizon_years: number;
  tasks: string[];
  skipped: string[];
  fleets: {
    operation_id: string;
    robot_id: string;
    task: string;
    name: string;
    count: number;
    price_rub: number;
    price_source: string;
  }[];
  people: {
    hours_per_shift: number;
    hours_per_year: number;
    hour_rub: number;
    fte: number;
    orderlies: number | null;
    manual_hours_per_shift: number;
    manual_delivery_hours_per_shift: number;
    manual_cleaning_hours_per_shift: number;
    remaining_hours_per_shift: number;
    support_hours_per_shift: number;
    delivery_hours_per_shift: number;
    cleaning_hours_per_shift: number;
    extra_hours_per_shift: number;
    cleaner_hour_rub: number;
    released_value_year_rub: number;
    cash_saving_year_rub: number;
    positions_released?: number;
  };
  shift: {
    service: ClinicServiceScore;
    hours: number;
    shift_start_h: number;
    expected_jobs: number;
    checks: ClinicCheckLine[];
    fleet: number;
    cleaners: Record<string, number>;
    search: ClinicSearch | null;
    floors: number;
    wards: number;
    lifts: number;
    jobs: number;
    on_time_share: number | null;
    avg_delivery_min: number | null;
    bottleneck: string;
    lift_busy_share: number | null;
    cleaned_m2: number;
    done: number;
    due: number;
    cleaning_required_m2: number;
    cleaning_coverage: number | null;
  };
  scenarios: ClinicScenario[];
  not_counted: string[];
  assumptions: Record<string, number>;
  warnings: string[];
  readiness: string[];
  sources: {
    group: "Объект" | "Роботы" | "Смена" | "Деньги";
    name: string;
    value: string;
    source: string;
    date: string | null;
    trust: string;
  }[];
};

export type ClinicMoneyRequest = {
  quotes?: ClinicQuotes;
  operation_ids: string[];
  overrides: Record<string, number>;
  robot_id?: string;
  cleaner_id?: string;
  building?: Building | null;
  assumptions?: ClinicFinance;
  fleet?: number;
  cleaners?: Record<string, number>;
};
export type ClinicServiceScore = {
  on_time_share: number | null;
  urgent_on_time_share: number | null;
  completion_share: number | null;
  cleaning_coverage: number | null;
  overdue_unfinished: number;
  carryover_jobs: number;
};
export type ClinicStressProfile = {
  id: string;
  name: string;
  demand_factor: number;
  speed_factor: number;
  runtime_factor: number;
  cleaning_factor: number;
  handling_factor: number;
  lift_traffic_factor: number;
  door_wait_factor: number;
  support_factor: number;
  arrival_spread: number;
};
export type ClinicCaseAssessment = {
  profile: ClinicStressProfile;
  training: ClinicServiceScore;
  validation: ClinicServiceScore | null;
  incremental_cost_range_rub: [number, number];
  labour_balance_range_hours: [number, number];
  payback_years: number | null;
  payback_met: boolean;
  runs: number;
};
export type ClinicOptimizationCandidate = {
  id: string;
  robot_id: string;
  cleaner_id: string;
  robot_name: string;
  cleaner_name: string;
  fleet: number;
  cleaners: Record<string, number>;
  payment_id: "purchase" | "raas" | "loan";
  upfront_rub: number;
  incremental_cost_rub: number;
  incremental_npv_cost_rub?: number | null;
  incremental_cost_range_rub: [number, number];
  released_hours_year: number;
  training: ClinicServiceScore;
  validation: ClinicServiceScore | null;
  validated: boolean;
  payback_years: number | null;
  payback_met: boolean;
  payback_why_not: string[];
  why_not: string[];
  conditions: string[];
  assessments: ClinicCaseAssessment[];
};
export type ClinicOptimization = {
  objective: "min_cost" | "max_time";
  horizon_years: number;
  training_seeds: number[];
  validation_seeds: number[];
  targets: Record<string, number>;
  candidates: ClinicOptimizationCandidate[];
  recommended_id: string | null;
  configurations_checked: number;
  simulations: number;
  fully_enumerated: boolean;
  stopped: string;
  elapsed_s: number;
  excluded: string[];
  notes: string[];
  stress_profiles: ClinicStressProfile[];
};
export type ClinicOptimizationRequest = ClinicMoneyRequest & {
  objective: "min_cost" | "max_time";
  delivery_ids?: string[];
  cleaner_ids?: string[];
  max_delivery_fleet: number;
  max_cleaners_per_floor: number;
  max_upfront_rub?: number | null;
  on_time_target: number;
  completion_target: number;
  cleaning_target: number;
  time_budget_s: number;
  urgent_on_time_target?: number;
  stress_profiles?: ClinicStressProfile[];
};
export type ClinicPortfolio = {
  options: {
    id: string;
    automated: string[];
    manual: string[];
    candidate: ClinicOptimizationCandidate | null;
    complete: boolean;
    message: string;
  }[];
  recommended_id: string | null;
  manual_is_cheapest: boolean;
  complete: boolean;
  manual_service_verified: false;
  notes: string[];
};

export type ClinicCheckLine = {
  level: "error" | "warning" | "info";
  code: string;
  text: string;
  floor: number | null;
  target: string;
};
/* Прогон смены в корпусе (POST /api/clinic/runs): только то, что показывает проигрыватель */
export type ClinicRun = {
  fleet: number;
  cleaners: Record<string, number>;
  demand_per_hour: number[];
  search: ClinicSearch | null;
  hours: number;
  shift_start_h: number;
  kpi: {
    created: number;
    done: number;
    blocked: number;
    shares: Record<string, number>;
    cleaned_m2: number;
    cleaning: { floor: number; area_m2: number; done_m2: number }[];
    on_time_share: number | null;
    avg_delivery_min: number | null;
    bottleneck: string;
    lifts: { lift: string; busy_share: number; robot_rides: number; people_rides: number }[];
  };
  segments: ClinicSegment[];
  lift_segments: LiftSegment[];
};
export type ClinicSearch = { needed: number | null; target: number; curve: [number, number][]; stopped: string };
export type ClinicRobot = {
  id: string;
  product: string;
  operation: string;
  missing: string[];
  speed_m_s: number | null;
  lift?: string | null;
  specs?: { field: string; value: number; text: string; trust: string; note: string }[];
};
export type ClinicRobots = { delivery: ClinicRobot[]; cleaning: ClinicRobot[] };
export type ClinicFit = components["schemas"]["FitResult"];
export type ClinicCheck = { valid: boolean; checks: ClinicCheckLine[]; corridor_m2: Record<string, number> };
export type ClinicWorkload = {
  floors: number;
  area_m2: number;
  points: number;
  effective_points: number;
  reference_points: number;
  shift_start_h: number;
  shift_hours: number;
  daily_share: number;
  demand_per_hour: number[];
  processes: { kind: string; per_day: number; in_window: number; routes: number }[];
  cleaning_m2: Record<string, number>;
  warnings: string[];
};

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
export type ShiftSegment = components["schemas"]["app__schemas__simulation__Segment"];
export type ShiftPlace = components["schemas"]["Place"];
/* Куда можно ехать по линии движения: против стрелки нельзя, поперек можно */
export type Direction = "east" | "west" | "north" | "south";
// У полей плана в описании API есть значения по умолчанию, поэтому в сгенерированных типах
// они необязательные. Сервер отдает их всегда: уточняем здесь, чтобы экран не проверял каждое.
export type PlanItem = Required<components["schemas"]["app__schemas__plan__Item"]>;
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
// Досчет страницы, а не ответ на нажатие: сервер считает его после основного расчета и не считает,
// если страница его уже отменила (backend/app/services/priority.py)
const BACKGROUND = { "X-Priority": "background" };

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
          : response.status === 413
            ? "Файл больше, чем принимает сервер. Уменьшите его и загрузите снова"
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
  // Медучреждение: итог на типовом корпусе, роботы, деньги трех сценариев и люди
  clinicMoney: (body: ClinicMoneyRequest, signal?: AbortSignal) =>
    request<ClinicMoney>("/api/clinic/economics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  clinicOffers: (body: ClinicMoneyRequest & { robot_ids: string[] }, signal?: AbortSignal) =>
    request<{ offers: Record<string, ClinicMoney>; errors: Record<string, string> }>("/api/clinic/offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  clinicOptimize: (body: ClinicOptimizationRequest, signal?: AbortSignal) =>
    request<ClinicOptimization>("/api/clinic/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  clinicPortfolio: (body: ClinicOptimizationRequest, signal?: AbortSignal) =>
    request<ClinicPortfolio>("/api/clinic/portfolio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  // Корпус медучреждения: типовой для старта и проверка плана из редактора (docs/medical.md)
  clinicTemplate: () => request<Building>("/api/clinic/template"),
  clinicGenerate: (
    body: {
      layout?: "linear" | "mixed";
      width_m: number;
      length_m: number;
      floors: number;
      wards_per_floor: number;
      lifts: number;
      furnished: boolean;
      floor_height_m: number;
    },
    signal?: AbortSignal,
  ) =>
    request<Building>("/api/clinic/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  clinicImport: (body: unknown, signal?: AbortSignal) =>
    request<Building>("/api/clinic/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  clinicRobots: (signal?: AbortSignal) => request<ClinicRobots>("/api/clinic/robots", { signal }),
  clinicWorkload: (
    body: { building: Building; overrides: Record<string, number>; operation_ids: string[] },
    signal?: AbortSignal,
  ) =>
    request<ClinicWorkload>("/api/clinic/workload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  clinicFit: (building: Building, signal?: AbortSignal) =>
    request<ClinicFit>("/api/clinic/fit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ building }),
      signal,
    }),
  clinicCheck: (
    building: Building,
    signal?: AbortSignal,
    selection?: { robot_id?: string; cleaner_id?: string | null; operation_ids?: string[] },
  ) =>
    request<ClinicCheck>("/api/clinic/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ building, ...selection }),
      signal,
    }),
  clinicRun: (
    body: {
      building: Building | null;
      fleet: number;
      robot_id: string;
      cleaner_id: string | null;
      cleaners: Record<string, number>;
      operation_ids: string[];
      overrides: Record<string, number>;
    },
    signal?: AbortSignal,
  ) =>
    request<ClinicRun>("/api/clinic/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, with_events: true }),
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
  // Чертеж DXF для подложки: сервер разбирает файл и отдает линии по слоям, ничего не сохраняя
  planDxf: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<DxfDrawing>("/api/plan/dxf", { method: "POST", body: form });
  },
  // План по слоям чертежа: сервер строит здание, ряды и ворота, человек правит их дальше на листе
  planDxfBuild: (file: File, roles: Record<string, string>, unitM: number) => {
    const form = new FormData();
    form.append("file", file);
    form.append("roles", JSON.stringify(roles));
    form.append("unit_m", String(unitM));
    return request<DxfBuilt>("/api/plan/dxf/build", { method: "POST", body: form });
  },
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
  // background: досчет страницы, сервер ставит его после ответа на нажатие (backend/app/services/priority.py)
  simulate: (body: SimulateBody, signal?: AbortSignal, background = false) =>
    request<SimulationResult>("/api/simulation/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(background ? BACKGROUND : {}) },
      body: JSON.stringify({ with_events: false, ...body }),
      signal,
    }),
  // Отчет по тому же запросу, что и расчет: сервер считает заново и отдает файл
  // caseId: запрос собран из готового разбора, у файла свое имя и нет пунктов про план, которого гость не чертил
  report: async (
    kind: "pdf" | "xlsx",
    body: CalculationRequest,
    caseId?: string,
  ): Promise<{ blob: Blob; name: string }> => {
    const query = caseId ? `?case=${encodeURIComponent(caseId)}` : "";
    const response = await fetch(`/api/reports/${kind}${query}`, {
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
  // Отчет медучреждения по тому же запросу, что итог: сервер считает заново и отдает файл
  clinicReport: async (kind: "pdf" | "xlsx", body: ClinicMoneyRequest): Promise<{ blob: Blob; name: string }> => {
    const response = await fetch(`/api/reports/clinic/${kind}`, {
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
    return { blob: await response.blob(), name: named ? decodeURIComponent(named[1]) : `otsenka-clinic.${kind}` };
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
  // Готовый разбор для гостя: сервер считает его тем же расчетом, что мастер, и держит в памяти
  demoCase: (id: string, signal?: AbortSignal) => request<DemoCase>(`/api/cases/${id}`, { signal }),
  preview: (body: CalculationRequest, signal?: AbortSignal, background = false) =>
    request<CalculationResult>("/api/calculations/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(background ? BACKGROUND : {}) },
      body: JSON.stringify(body),
      signal,
    }),
};
