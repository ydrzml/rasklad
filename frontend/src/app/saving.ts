/* Правила сохранения расчета в проект, отдельно от экрана: их проверяют тесты (npm test).

   Проект живет в адресе мастера: /calc?project=12. Кабинет открывает его с &open=1, тогда мастер
   берет введенное из сохранения, а не из браузера. После этого open из адреса убираем, чтобы
   перезагрузка не стирала правки, которые человек сделал после открытия. */

export type ProjectLink = { id: number; version: number | null; open: boolean };

export function projectFromUrl(search: string): ProjectLink | null {
  const query = new URLSearchParams(search);
  const id = Number(query.get("project"));
  if (!Number.isInteger(id) || id <= 0) return null;
  const version = Number(query.get("version"));
  return {
    id,
    version: Number.isInteger(version) && version > 0 ? version : null,
    open: query.get("open") === "1",
  };
}

// Куда вернуть человека после входа. Только путь на нашем сайте: адрес вида //чужой.сайт
// или https://... увел бы его со страницы, которую он не выбирал.
export function safeNext(raw: string | null, fallback = "/projects"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}

// Название нового проекта по тому, что посчитано. Поменять его можно в кабинете.
export function projectName(facility: string, area: number | null, tasks: string[]): string {
  const size = area ? ` ${area.toLocaleString("ru-RU")} м²` : "";
  const what = tasks.length ? `, ${tasks.map((task) => task.toLowerCase()).join(", ")}` : "";
  return `${facility}${size}${what}`.slice(0, 200);
}

// Запрос расчета из сохраненного ввода: по нему кабинет и страница по ссылке собирают отчет PDF и Excel
// без мастера. Тот же вид, что уходит из мастера (App.tsx, request)
/* Решение на задаче с долей объема. Смешанный парк это два решения на задачу, доли в сумме 1 */
export type Pick = { robotId: string; share: number };
export type Picks = Record<string, Pick[]>;

export type SavedInput = {
  facilityId: string;
  taskIds: string[];
  // решения по задачам с долями; снимки до смешанного парка хранят choices (одно решение на задачу),
  // а еще более старые одно robotId на весь расчет
  picks?: Picks;
  choices?: Record<string, string>;
  robotId?: string;
  overrides?: Record<string, number>;
  staff?: unknown[];
  plan?: unknown;
  // бюджет на старте в рублях, если называли
  budget?: number | null;
  // задачи, снятые с расчета галочкой на шаге экономики: выбраны, но не считаются
  excluded?: string[];
};

// Решения по задачам из снимка. У старого снимка одно решение, оно принадлежит первой задаче.
// Совсем новому расчету решение не ставим, даже эталонный Ronavi H1500: иначе на шаге решения
// кажется, что выбор уже сделан без человека
export function picksOf(state: Partial<SavedInput>): Picks {
  if (state.picks) return state.picks;
  if (state.choices)
    return Object.fromEntries(Object.entries(state.choices).map(([id, robotId]) => [id, [{ robotId, share: 1 }]]));
  const first = state.taskIds?.[0];
  if (first && state.robotId) return { [first]: [{ robotId: state.robotId, share: 1 }] };
  return {};
}

// Первое решение каждой задачи: так снимок читали до смешанного парка
export function choicesOf(state: Partial<SavedInput>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(picksOf(state))
      .filter(([, list]) => list.length > 0)
      .map(([id, list]) => [id, list[0].robotId]),
  );
}

// Что считаем: задачи, у которых есть решение, по части на решение с его долей. Старый проект
// с двумя задачами и одним решением считался по первой задаче, так он и откроется
export function tasksOf(taskIds: string[], picks: Picks, excluded: string[] = []) {
  return taskIds
    .filter((id) => !excluded.includes(id))
    .flatMap((id) =>
      (picks[id] ?? []).map((pick) => ({ operation_id: id, robot_id: pick.robotId, share: pick.share })),
    );
}

export function requestFrom(state: SavedInput) {
  // снятые галочкой задачи не считаем: кабинет и ссылка собирают тот же запрос, что экран
  const tasks = tasksOf(state.taskIds, picksOf(state), state.excluded ?? []);
  return {
    facility_id: state.facilityId,
    operation_id: tasks[0]?.operation_id ?? state.taskIds[0] ?? "",
    robot_id: tasks[0]?.robot_id ?? state.robotId ?? "",
    tasks,
    overrides: state.overrides ?? {},
    staff: state.staff ?? null,
    plan: state.plan ?? null,
    raas_buyout: true,
    use_simulation: true,
    budget_rub: state.budget ?? null,
  };
}

// Скачать файл, который отдал сервер
export function saveBlob(blob: Blob, name: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Незаконченный расчет в этом браузере: мастер держит введенное в localStorage под этим ключом
export const DRAFT_KEY = "lct-calc-v1";
// Гость нажал "Сохранить" и ушел на вход: время нажатия, после входа сохраняем сами (docs/ux-flow.md)
export const SAVE_AFTER_LOGIN = "lct-save-after-login";
const SAVE_AFTER_LOGIN_MS = 30 * 60 * 1000;
// Последний ответ расчета в этой вкладке и подложка плана: картинка с планом склада клиента
export const RESULT_KEY = "lct-calc-result-v1";
export const UNDERLAY_KEY = "plan-underlay";

// Сохранять ли сами после входа: только если "Сохранить" нажали недавно, а не когда-то давно
export function saveAfterLogin(raw: string | null, now = Date.now()): boolean {
  const pressed = Number(raw);
  return Number.isFinite(pressed) && pressed > 0 && now - pressed < SAVE_AFTER_LOGIN_MS;
}

// Выход и удаление аккаунта: черновик, обещание сохранить, ответ расчета и подложка плана
// принадлежат этому человеку, следующий на том же компьютере их видеть не должен.
// Гость не выходит, поэтому его черновик здесь не стирается
export function forgetBrowser() {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
    window.localStorage.removeItem(SAVE_AFTER_LOGIN);
    window.localStorage.removeItem(UNDERLAY_KEY);
    window.sessionStorage.removeItem(RESULT_KEY);
  } catch {
    // без хранилища забывать нечего
  }
}

export type Draft = { step: number; projectId: number | null; projectName: string; area: number | null };

const STEP_NAMES = ["объект", "параметры", "план объекта", "решение", "экономика"];

export function draftOf(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as {
      reached?: number;
      overrides?: Record<string, number>;
      plan?: { edited?: boolean } | null;
      projectId?: number | null;
      projectName?: string;
      savedAs?: unknown;
    };
    if (saved.savedAs) return null; // все введенное уже в проекте
    const touched = (saved.reached ?? 0) > 0 || Object.keys(saved.overrides ?? {}).length > 0 || !!saved.plan?.edited;
    if (!touched) return null;
    const areaPath = Object.keys(saved.overrides ?? {}).find((path) => path.endsWith("active_area_m2"));
    return {
      step: saved.reached ?? 0,
      projectId: saved.projectId ?? null,
      projectName: saved.projectName ?? "",
      area: areaPath ? (saved.overrides ?? {})[areaPath] : null,
    };
  } catch {
    return null;
  }
}

// Строка про черновик: «Склад 12 000 м2, дошли до шага «решение»» или про проект
export function draftTitle(draft: Draft): string {
  const where = `дошли до шага «${STEP_NAMES[Math.min(draft.step, STEP_NAMES.length - 1)]}»`;
  if (draft.projectId && draft.projectName) return `Правки к проекту «${draft.projectName}», ${where}`;
  const size = draft.area ? ` ${draft.area.toLocaleString("ru-RU")} м²` : "";
  return `Расчет${size}, ${where}`;
}

// Куда вести «Продолжить»: к проекту, если черновик его
export function draftUrl(draft: Draft): string {
  return draft.projectId ? `/calc?project=${draft.projectId}` : "/calc";
}
