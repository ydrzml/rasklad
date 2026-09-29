// Быстрая оценка до прогона смены: покроет ли решение пик задачи. По тем данным, что уже есть
// на шаге решения: план и парк по формуле (тот же, что считает бюджет). Прогон смены проверяет
// это точно, но идет полминуты, а сюда человек смотрит, выбирая между карточками

export type PeakFit = { fleet_needed?: number | null };

/* до какого парка прогон гоняет смену: config/model.yaml, engine.max_fleet_simulated */
export const MAX_SIMULATED = 250;

/* проезд уже этого значения: стеллажи стоят плотно, под робота, а не под погрузчик (робозона) */
export const ZONE_AISLE_M = 2.5;

/* Штучный отбор «товар к человеку» считаем по робозоне при любом плане: на рядах под погрузчик до
   станций в разы дальше, и отбор не сходится разумным парком. План человека при этом годится только
   для остальных задач. Признак «план и есть робозона» решает, нужна ли подсказка про робозону.
   То же правило на сервере: fits_picking в backend/app/services/plan.py */
export function planFitsPicking(template: string | undefined): boolean {
  return template === "robot_zone";
}

/* Предупреждение на карточке или null, если оснований нет.
   needsStations: задача «товар к человеку»; planReady: план под нее годится (planFitsPicking);
   fit: парк по формуле, undefined пока не пришел */
export function peakWarning(
  fit: PeakFit | undefined,
  _needsStations: boolean,
  _planReady: boolean,
  maxSimulated: number = MAX_SIMULATED,
): string | null {
  // Отбор на плане под погрузчик сервер считает по робозоне, поэтому план сам пику уже не мешает:
  // needsStations и planReady остаются в подписи для шага решения, но предупреждения не дают
  if (!fit) return null;
  if (fit.fleet_needed === null) {
    return "может не покрыть пик: по формуле спрос задачи не вытянуть и самым большим парком, проверьте прогоном смены";
  }
  if (fit.fleet_needed !== undefined && fit.fleet_needed > maxSimulated) {
    return `может не покрыть пик: по формуле нужно ${fit.fleet_needed} роботов, прогон смены проверяет парк до ${maxSimulated}`;
  }
  return null;
}

/* Типовая планировка по умолчанию: под отбор «товар к человеку» робозона со станциями, иначе ряды
   под погрузчик с одной стороны. На плане под погрузчик отбор не сходился никаким парком, а человек
   видел это только на экономике */
export function defaultTemplate(needsStations: boolean): string {
  return needsStations ? "robot_zone" : "one_side";
}

/* Площадь робозоны под штучный отбор: часть зоны работы роботов (picking_zone_share), по умолчанию
   от плотности рынка, config/model.yaml. Правки с первого шага берем поверх: площадь и доля */
export const ZONE_SHARE_MIN = 0.05;
export const ZONE_SHARE_MAX = 1;

export function zoneShare(
  facility: { id: string; picking_zone_share?: number | null } | undefined,
  overrides: Record<string, number>,
): number | null {
  if (!facility?.picking_zone_share) return null;
  return overrides[`facilities.${facility.id}.picking_zone_share`] ?? facility.picking_zone_share;
}

export function pickingZoneM2(
  facility: { id: string; active_area_m2?: number | null; picking_zone_share?: number | null } | undefined,
  overrides: Record<string, number>,
): number | null {
  const share = zoneShare(facility, overrides);
  const area = facility ? (overrides[`facilities.${facility.id}.active_area_m2`] ?? facility.active_area_m2) : null;
  if (share === null || !area) return null;
  return Math.round(area * Math.min(1, share));
}

/* «2 800 м²»: площадь робозоны в строках шагов плана и экономики */
export function zoneArea(m2: number | null): string {
  return m2 === null ? "" : `${Math.round(m2).toLocaleString("ru-RU")} м²`;
}

/* Строка на шаге 5, когда план человека не робозона: отбор посчитан не по нему */
export function zoneLine(task?: string): string {
  return `${task ? `${task}: о` : "О"}тбор посчитан по компактной робозоне, как ставят такие системы`;
}
