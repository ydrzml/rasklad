/* "Начать с этого разбора": черновик мастера с цифрами разбора. Мастер держит введенное в
   localStorage (app/saving.ts, DRAFT_KEY) и при открытии читает его оттуда, поэтому кладем туда
   тот же вид, что он сохраняет сам, и открываем шаг экономики. Чистая функция: npm test */

export type CaseRequest = {
  facility_id?: string;
  tasks?: { operation_id: string; robot_id: string; share?: number }[];
  overrides?: Record<string, number>;
  // штат реального кейса, если разбор его повторяет; без него мастер берет штат по датасету
  staff?: unknown[] | null;
};

// шаг экономики, пятый из пяти: номер с нуля для черновика и с единицы для адреса
export const ECONOMICS_STEP = 4;
export const WIZARD_URL = `/calc?step=${ECONOMICS_STEP + 1}`;

export function caseDraft(request: CaseRequest, plan: unknown) {
  const tasks = request.tasks ?? [];
  const staff = request.staff ?? [];
  const overrides = request.overrides ?? {};
  return {
    facilityId: request.facility_id ?? "warehouse",
    taskIds: tasks.map((task) => task.operation_id),
    picks: Object.fromEntries(
      tasks.map((task) => [task.operation_id, [{ robotId: task.robot_id, share: task.share ?? 1 }]]),
    ),
    robotId: tasks[0]?.robot_id ?? "",
    overrides: { ...overrides },
    // штат кейса держим как введенный руками: мастер не перекладывает его под объем. Без штата кейса
    // мастер сам возьмет его с сервера по объему, как на значениях по умолчанию
    staff: [...staff],
    staffTouched: staff.length > 0,
    // под какой объем введен штат: объем и дни кейса, иначе мастер сразу предложит пересчитать штат
    staffBasis: staff.length ? basisOf(overrides) : null,
    // план типовой и не правленный: мастер держит его своим и перестроит при правке площади
    plan,
    answers: null,
    planChosen: false,
    reached: ECONOMICS_STEP,
    calcStarted: true,
  };
}

function basisOf(overrides: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([path]) => path.endsWith(".volume_per_day") || path.endsWith("schedule.days_per_year"),
    ),
  );
}
