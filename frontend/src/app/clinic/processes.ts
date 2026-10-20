import type { Building, ClinicScenario, DeliveryProcess } from "./building.ts";

export const defaultProcess = (): DeliveryProcess => ({
  enabled: true,
  mode: "per_point",
  per_day: null,
  urgent_share: null,
  picking_min: null,
  deadline_min: null,
  urgent_deadline_min: null,
  flows: [],
});

export function scenarioOf(building: Building): ClinicScenario {
  const raw = building.scenario;
  return {
    shift_start_h: 7,
    shift_hours: 24,
    schedule: "industry",
    hourly_weights: [],
    point_weights: {},
    cleaning_passes: 2,
    floor_cleaning_passes: {},
    ...raw,
    meds: { ...defaultProcess(), ...raw?.meds },
    supplies: { ...defaultProcess(), ...raw?.supplies },
  };
}

// После удаления геометрии убираем ее коэффициенты. Явные маршруты сохраняем:
// потерянный получатель должен вызвать проверку, а не незаметно уменьшить объем.
export function reconcileProcesses(building: Building): Building {
  if (!building.scenario) return building;
  const points = new Set(
    building.floors.flatMap((f) => f.items.filter((i) => i.kind === "room" && i.role === "ward").map((i) => i.id)),
  );
  const floors = new Set(building.floors.map((f) => String(f.number)));
  return {
    ...building,
    scenario: {
      ...building.scenario,
      point_weights: Object.fromEntries(
        Object.entries(building.scenario.point_weights).filter(([id]) => points.has(id)),
      ),
      floor_cleaning_passes: Object.fromEntries(
        Object.entries(building.scenario.floor_cleaning_passes).filter(([id]) => floors.has(id)),
      ),
    },
  };
}
