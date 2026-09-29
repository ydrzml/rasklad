/* Что мешает шагу экономики показать расчет и куда вести человека. Чистые правила, их
   проверяют тесты (npm test): экран только раскладывает ответ по кнопкам.

   При несошедшемся расчете на экране не должно висеть старое сообщение без кнопок, а "Сохранить
   в проект" не должна гореть синим, когда сохранять нечего. Если после смены решения на шаге 4
   старое сообщение остается на месте, пока идет новый расчет, кажется, что он не перезапустился. */

export type Trouble = {
  /* solution: парк не покрывает спрос, менять решение; plan: парк не сходится из-за плана, например
     на нем нет стеллажей, вернуться к плану; input: сервер не принял ввод, менять параметры; payment:
     сервер не принял правку оплаты, вернуть оплату как было; robot: то же с числами робота из
     допущений шага экономики; server: сервер не ответил или упал, повторить */
  kind: "solution" | "plan" | "input" | "payment" | "robot" | "server";
  /* шаг, где причина, с нуля; у server шага нет */
  step: number | null;
  /* подпись кнопки в полосе действия */
  action: string;
  /* что случилось, словами сервера */
  text: string;
};

export const STEP_PARAMETERS = 1;

/* Правки блоков "Как платить", "Господдержка" и "Выход на режим" живут на шаге экономики. Если
   сервер их не принял, вести на шаг параметров бессмысленно: там их нет, а сам шаг экономики
   вместо расчета показывает ошибку, и до поля срока не дойти. Поэтому такие правки снимаем, расчет
   сходится, и блок снова на месте. Тексты отказов в backend/app/services/calculation.py */
const PAYMENT = /кредит|лизинг|оплат|ставка|аванс|мера поддержки|выход на режим|первый месяц/i;
const PAYMENT_PATHS = ["financing.", "subsidies.", "ramp_up."];

/* Правки, от которых зависит план объекта: только сам объект, без штата и внедрения */
export function forPlan(overrides: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([path]) => path.startsWith("facilities.") && !path.includes(".staff.") && !path.includes(".implementation."),
    ),
  );
}

/* Числа робота правятся там же, на шаге экономики, в допущениях: срок службы, зарядки, скорость.
   Тексты отказов начинаются с названия поля (robot_problem в backend/app/services/calculation.py) */
const ROBOT =
  /^(Срок службы|Роботов на одну зарядку|Срок договора аренды|Средняя скорость|Работа от одной зарядки|Готовность робота)/;

/* Отказ по плану сервер начинает словами "План не принят" (_plan_field в backend/app/errors.py) */
const PLAN = /^План не принят/;

export function withoutRobot(overrides: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([path]) => !path.startsWith("robots.") && path !== "engine.simulation.availability",
    ),
  );
}

export function withoutPayment(overrides: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([path]) => !PAYMENT_PATHS.some((root) => path.startsWith(root))),
  );
}
export const STEP_PLAN = 2;
export const STEP_SOLUTION = 3;

export function troubleOf(
  result: { feasible: boolean; message?: string | null; cause?: string | null } | null,
  error: { message: string; status?: number } | null,
): Trouble | null {
  if (error) {
    // сервер не принял план: поле объекта на чертеже вне границ. Поправить его можно только на шаге плана
    if (error.status === 422 && PLAN.test(error.message))
      return { kind: "plan", step: STEP_PLAN, action: "Вернуться к плану", text: error.message };
    // 422: сервер разобрал ввод и отказался считать невозможное, например 30 часов в сутки
    if (error.status === 422 && PAYMENT.test(error.message))
      return { kind: "payment", step: null, action: "Вернуть оплату как было", text: error.message };
    if (error.status === 422 && ROBOT.test(error.message))
      return { kind: "robot", step: null, action: "Вернуть числа робота как было", text: error.message };
    if (error.status === 422)
      return { kind: "input", step: STEP_PARAMETERS, action: "Исправить параметры", text: error.message };
    // 404: решение или задача, которых сервер не знает, такое бывает у старых сохранений
    if (error.status === 404)
      return { kind: "solution", step: STEP_SOLUTION, action: "Поменять решение", text: error.message };
    return { kind: "server", step: null, action: "Повторить", text: error.message };
  }
  // причину называет сервер: план без стеллажей не сходится ни с каким роботом, менять решение бесполезно
  if (result && !result.feasible && result.cause === "plan")
    return { kind: "plan", step: STEP_PLAN, action: "Вернуться к плану", text: result.message ?? "Расчет не сошелся" };
  if (result && !result.feasible)
    return {
      kind: "solution",
      step: STEP_SOLUTION,
      action: "Поменять решение",
      text: result.message ?? "Расчет не сошелся",
    };
  return null;
}

/* Показывать ли ожидание вместо того, что на экране. Прежние цифры при пересчете остаются
   приглушенными, но старую ошибку или старое "не сошлось" держать на экране нельзя: человек
   думает, что новый расчет не запустился */
export function waitingInsteadOfStale(
  loading: boolean,
  result: { feasible: boolean } | null,
  error: { message: string } | null,
): boolean {
  return loading && (error !== null || result === null || !result.feasible);
}

/* Сборки плана идут запросами, и ответ ранней может прийти позже поздней. Тогда на листе
   оставалась прежняя схема: после "Начать заново" и выбора другой схемы снова стояла старая, а
   после фото плана вместо пустого здания приходила заполненная робозона. Поэтому кладем только
   ответ последнего запроса и помним, какую схему просили последней: план на экране может быть
   еще старым */
export type PlanBuilds = {
  ask: (templateId: string) => number;
  latest: (ticket: number) => boolean;
  asked: () => string;
};

export function planBuilds(): PlanBuilds {
  let last = 0;
  let template = "";
  return {
    ask: (templateId) => {
      template = templateId;
      last += 1;
      return last;
    },
    latest: (ticket) => ticket === last,
    asked: () => template,
  };
}

/* Какую схему пересобрать самим, когда поменялись задачи или объект, а план человек еще не
   правил. current: последняя запрошенная схема, а если запросов еще не было, схема плана из
   браузера. Выбранную человеком схему, свой склад и фото держим, нашу типовую меняем на нужную
   задачам */
export function autoTemplate(current: string | undefined, chosen: boolean, wanted: string): string {
  return current && (chosen || current === "custom" || current === wanted) ? current : wanted;
}
