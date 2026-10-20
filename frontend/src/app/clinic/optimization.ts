import type {
  ClinicMoneyRequest,
  ClinicOptimizationCandidate,
  ClinicServiceScore,
  ClinicCaseAssessment,
  ClinicStressProfile,
} from "../../api/client";

export type ClinicSizing = {
  basis: string;
  robot_id: string;
  cleaner_id: string;
  fleet: number;
  cleaners: Record<string, number>;
  operation_ids?: string[];
  assessment?: {
    cases: number;
    runs: number;
    onTimeTarget: number;
    urgentTarget: number;
    profiles: ClinicStressProfile[];
    incrementalCostRangeRub: [number, number];
    minimumLabourHours: number;
    paymentId: "purchase" | "raas" | "loan";
    paybackYears: number | null;
    horizonYears: number;
  };
};

export function sizingBasis(request: ClinicMoneyRequest): string {
  return JSON.stringify(
    [
      "clinic-project-v3",
      request.operation_ids,
      request.overrides,
      request.building ?? null,
      request.assumptions ?? {},
      request.quotes ?? {},
    ],
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
  );
}

export function sizingFor(request: ClinicMoneyRequest, sizing: ClinicSizing | null): ClinicSizing | null {
  return sizing &&
    sizing.basis === sizingBasis(request) &&
    sizing.robot_id === request.robot_id &&
    sizing.cleaner_id === request.cleaner_id
    ? sizing
    : null;
}

export function candidateSizing(
  request: ClinicMoneyRequest,
  candidate: ClinicOptimizationCandidate,
  targets?: Record<string, number>,
): ClinicSizing {
  return {
    basis: sizingBasis(request),
    robot_id: candidate.robot_id,
    cleaner_id: candidate.cleaner_id,
    fleet: candidate.fleet,
    cleaners: candidate.cleaners,
    ...(candidate.assessments?.length
      ? {
          assessment: {
            cases: candidate.assessments.length,
            runs: candidate.assessments.reduce((sum, one) => sum + one.runs, 0),
            onTimeTarget: targets?.on_time_share ?? 0.95,
            urgentTarget: targets?.urgent_on_time_share ?? 1,
            profiles: candidate.assessments.map((one) => one.profile),
            incrementalCostRangeRub: candidate.incremental_cost_range_rub,
            minimumLabourHours: candidate.released_hours_year,
            paymentId: candidate.payment_id,
            paybackYears: candidate.payback_years,
            horizonYears: targets?.payback_horizon_years ?? 7,
          },
        }
      : {}),
  };
}

export function restoreClinicSizing(raw: unknown): ClinicSizing | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ClinicSizing>;
  if (
    typeof value.basis !== "string" ||
    value.basis.length > 2000000 ||
    typeof value.robot_id !== "string" ||
    typeof value.cleaner_id !== "string" ||
    !Number.isInteger(value.fleet) ||
    value.fleet! < 0 ||
    value.fleet! > 30 ||
    !value.cleaners ||
    typeof value.cleaners !== "object" ||
    Array.isArray(value.cleaners)
  )
    return null;
  if (
    Object.entries(value.cleaners).some(
      ([floor, count]) =>
        !/^-?\d+$/.test(floor) ||
        Number(floor) < -2 ||
        Number(floor) > 40 ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > 4,
    )
  )
    return null;
  if (
    value.operation_ids &&
    (!Array.isArray(value.operation_ids) ||
      !value.operation_ids.length ||
      value.operation_ids.some((id) => !["floor_delivery", "cleaning"].includes(id)))
  )
    return null;
  if (
    value.assessment &&
    (!Number.isInteger(value.assessment.cases) ||
      value.assessment.cases < 1 ||
      value.assessment.cases > 4 ||
      !Number.isInteger(value.assessment.runs) ||
      value.assessment.runs < value.assessment.cases ||
      value.assessment.runs > 1000 ||
      !Number.isFinite(value.assessment.onTimeTarget) ||
      value.assessment.onTimeTarget < 0.5 ||
      value.assessment.onTimeTarget > 1 ||
      !Number.isFinite(value.assessment.urgentTarget) ||
      value.assessment.urgentTarget < 0.5 ||
      value.assessment.urgentTarget > 1 ||
      !Array.isArray(value.assessment.profiles) ||
      value.assessment.profiles.length !== value.assessment.cases ||
      !value.assessment.profiles.every(validProfile))
  )
    return null;
  if (
    value.assessment &&
    (!Array.isArray(value.assessment.incrementalCostRangeRub) ||
      value.assessment.incrementalCostRangeRub.length !== 2 ||
      !value.assessment.incrementalCostRangeRub.every(Number.isFinite) ||
      value.assessment.incrementalCostRangeRub[0] > value.assessment.incrementalCostRangeRub[1] ||
      !Number.isFinite(value.assessment.minimumLabourHours) ||
      !["purchase", "raas", "loan"].includes(value.assessment.paymentId) ||
      !Number.isFinite(value.assessment.horizonYears) ||
      value.assessment.horizonYears <= 0 ||
      (value.assessment.paybackYears !== null &&
        (!Number.isFinite(value.assessment.paybackYears) ||
          value.assessment.paybackYears < 0 ||
          value.assessment.paybackYears > value.assessment.horizonYears)))
  )
    return null;
  return value as ClinicSizing;
}

export function serviceReady(score: ClinicServiceScore, target = 0.95, urgent = 1): boolean {
  return (
    (score.on_time_share == null || score.on_time_share >= target - 1e-9) &&
    (score.urgent_on_time_share == null || score.urgent_on_time_share >= urgent - 1e-9) &&
    (score.completion_share == null || score.completion_share >= 1 - 1e-9) &&
    (score.cleaning_coverage == null || score.cleaning_coverage >= 1 - 1e-9)
  );
}

export function assessReady(assessments: ClinicCaseAssessment[], targets: Record<string, number>): boolean {
  return (
    assessments.length > 0 &&
    assessments.every(
      (one) =>
        one.validation &&
        serviceReady(one.training, targets.on_time_share, targets.urgent_on_time_share) &&
        serviceReady(one.validation, targets.on_time_share, targets.urgent_on_time_share),
    )
  );
}

export function paybackReady(candidate: ClinicOptimizationCandidate, horizon: number): boolean {
  const withinHorizon = (term: number | null) => term != null && Number.isFinite(term) && term >= 0 && term <= horizon;
  return (
    candidate.payback_met === true &&
    candidate.incremental_cost_range_rub[1] < -0.01 &&
    withinHorizon(candidate.payback_years) &&
    candidate.assessments.length > 0 &&
    candidate.assessments.every(
      (one) => one.payback_met && one.incremental_cost_range_rub[1] < -0.01 && withinHorizon(one.payback_years),
    )
  );
}

function validProfile(profile: ClinicStressProfile): boolean {
  if (!profile || typeof profile.id !== "string" || typeof profile.name !== "string" || profile.name.length > 80)
    return false;
  const bounds = {
    demand_factor: [1, 4],
    speed_factor: [0.2, 1],
    runtime_factor: [0.2, 1],
    cleaning_factor: [0.2, 1],
    handling_factor: [1, 4],
    lift_traffic_factor: [1, 4],
    door_wait_factor: [1, 4],
    support_factor: [1, 4],
    arrival_spread: [0.1, 1],
  };
  return Object.entries(bounds).every(([key, [lo, hi]]) => {
    const value = profile[key as keyof ClinicStressProfile];
    return typeof value === "number" && Number.isFinite(value) && value >= lo && value <= hi;
  });
}

export function robustProfiles(demandRise = 25, performanceLoss = 20, delayRise = 50): ClinicStressProfile[] {
  const base = {
    demand_factor: 1,
    speed_factor: 1,
    runtime_factor: 1,
    cleaning_factor: 1,
    handling_factor: 1,
    lift_traffic_factor: 1,
    door_wait_factor: 1,
    support_factor: 1,
    arrival_spread: 1,
  };
  const performance = 1 - performanceLoss / 100,
    delay = 1 + delayRise / 100;
  const peak = {
    ...base,
    id: "peak",
    name: "Повышенная нагрузка",
    demand_factor: 1 + demandRise / 100,
    arrival_spread: 0.5,
  };
  return [
    peak,
    {
      ...peak,
      id: "adverse",
      name: "Нагрузка и задержки",
      speed_factor: performance,
      runtime_factor: performance,
      cleaning_factor: performance,
      handling_factor: delay,
      lift_traffic_factor: delay,
      door_wait_factor: delay,
      support_factor: delay,
    },
  ];
}

export function profileSummary(p: ClinicStressProfile): string {
  const parts = [
    p.demand_factor !== 1 ? `поток ${Math.round(p.demand_factor * 100)}%` : "",
    p.speed_factor !== 1 ? `скорость ${Math.round(p.speed_factor * 100)}%` : "",
    p.runtime_factor !== 1 ? `автономность ${Math.round(p.runtime_factor * 100)}%` : "",
    p.cleaning_factor !== 1 ? `производительность уборки ${Math.round(p.cleaning_factor * 100)}%` : "",
    p.handling_factor !== 1 ? `загрузка и выдача ${Math.round(p.handling_factor * 100)}% времени` : "",
    p.lift_traffic_factor !== 1 ? `вызовы лифта людьми ${Math.round(p.lift_traffic_factor * 100)}%` : "",
    p.door_wait_factor !== 1 ? `ожидание ручных дверей ${Math.round(p.door_wait_factor * 100)}%` : "",
    p.support_factor !== 1 ? `помощь людей ${Math.round(p.support_factor * 100)}% времени` : "",
    p.arrival_spread !== 1 ? `заявки сгруппированы в первые ${Math.round(p.arrival_spread * 60)} мин каждого часа` : "",
  ].filter(Boolean);
  return parts.join("; ") || "Исходные параметры без дополнительных изменений";
}
