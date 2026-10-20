/* Строка над листом чертежа: что сделать сейчас. Одна фраза, первое незакрытое дело по порядку,
   в котором план собирают: сначала стеллажи, потом ворота, потом то, что сказали проверки
   сервера. Готовый план просит только проверить ворота и ряды и идти дальше.

   Это не расчет: проверки считает сервер, здесь только выбор фразы. */
import type { Plan, PlanMeasures } from "../../api/client";

// проверка про отбор не ошибка плана, а пояснение: о ней говорит отдельная строка над листом
export const PICKING_CHECK = "План под отбор";

export type Todo = {
  text: string;
  /* инструмент, который подсветить в колонке слева */
  tool?: "racks" | "dock";
  /* чего-то на плане не хватает: строка заметнее */
  next: boolean;
};

export function planTodo(
  plan: Pick<Plan, "items">,
  measures: Pick<PlanMeasures, "docks" | "checks"> | null,
  options: { photo: boolean; narrow: boolean },
): Todo | null {
  if (!measures) return null;
  if (!plan.items.some((item) => item.kind === "racks"))
    return {
      tool: "racks",
      next: true,
      text: options.photo
        ? 'Стеллажей пока нет. Возьмите "Ряды" слева и протяните по картинке там, где стоят стеллажи.'
        : 'Стеллажей пока нет. Возьмите "Ряды" слева и протяните по полу там, где стоят стеллажи.',
    };
  if (!measures.docks)
    return {
      tool: "dock",
      next: true,
      text: 'Ворот пока нет. Возьмите "Ворота" слева и щелкните у наружной стены там, где они у вас.',
    };
  const open = measures.checks.find((check) => !check.ok && check.label !== PICKING_CHECK);
  if (open) return { next: true, text: `Поправьте план: ${open.detail || open.label}` };
  return {
    next: false,
    // на телефоне инструментов нет: править план можно только на компьютере
    text: options.narrow
      ? "Проверьте ворота и ряды. Если похоже на ваш склад, дальше можно сразу к решению."
      : 'Проверьте ворота и ряды. Если похоже на ваш склад, жмите "Дальше: решение". Поправить можно инструментами слева.',
  };
}

/* Правая колонка нужна, когда в ней есть дело: открыта легенда, идет обучение, лежит фото
   плана или ставят его углы. Окно свойств выбранного ложится поверх листа само, это делает CSS. */
export function sideHidden(state: { legend: boolean; tour: boolean; photo: boolean; corners: boolean }): boolean {
  return !state.legend && !state.tour && !state.photo && !state.corners;
}

/* Предложение попрактиковаться после "Построить план". Одно окно за вход: если человека уже
   спросили "Пройти обучение?" (answered) или карточка сейчас на экране (busy), второе не показываем. */
export function practiceOffered(state: {
  narrow: boolean;
  answered: boolean;
  busy: boolean;
  off: boolean;
  built: boolean;
  wanted: boolean;
  onSheet: boolean;
}): boolean {
  return !state.narrow && !state.answered && !state.busy && !state.off && state.built && state.wanted && state.onSheet;
}
