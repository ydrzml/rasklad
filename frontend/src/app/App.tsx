import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BudgetFit,
  CalculationResult,
  CustomAnswers,
  Facility,
  FacilitySolutions as FacilityAnswer,
  Parameter,
  Plan,
  PlanMeasures,
  PlanTemplate,
  RackType,
  Role,
  Solution,
  StaffLine,
  StaffReview,
} from "../api/client";
import { api } from "../api/client";
import { account, ApiError, projects } from "../api/projects";
import { autoTemplate, forPlan, planBuilds, troubleOf, withoutPayment, withoutRobot } from "./flow";
import { defaultTemplate, pickingZoneM2, planFitsPicking, zoneShare } from "./steps/peak";
import { ActionBar, ActionMore, ask, Button, choose, Footer, Header, Hero, Tick, type Step } from "../ui";
import { ServerDown } from "../ui/crash";
import "./app.css";
import { mln, overDay } from "./format";
import { plural } from "./steps/economicsNames";
import { ChooseFacility } from "./steps/ChooseFacility";
import { ChooseSolutions } from "./steps/ChooseSolution";
import { Economics } from "./steps/Economics";
import { FacilitySolutions } from "./steps/FacilitySolutions";
import { ImportFile } from "./steps/ImportFile";
import { Parameters } from "./steps/Parameters";
import { PlanObject } from "./steps/PlanObject";
import { Staff } from "./steps/Staff";
import {
  choicesOf,
  DRAFT_KEY,
  draftOf,
  draftTitle,
  draftUrl,
  type Picks,
  picksOf,
  projectFromUrl,
  projectName as nameFor,
  RESULT_KEY,
  SAVE_AFTER_LOGIN,
  saveAfterLogin,
  tasksOf,
} from "./saving";
import { shortName } from "./steps/ChooseSolution";

const STEPS = ["Объект", "Параметры", "План объекта", "Решение", "Экономика"];
const LAST = STEPS.length - 1;
// Путь аэропорта и медучреждения: объект, параметры, решения. Плана и экономики у них нет,
// номера шагов те же, что у склада, чтобы адрес ?step=4 везде значил список решений.
const SHORT = [0, 1, 3];
const FULL = [0, 1, 2, 3, 4];

const TITLES = [
  {
    title: "Объект, задачи и кто их сегодня делает",
    lead: "Выберите объект и отметьте работу, которую заберут роботы. Вводить ничего не нужно: значения уже стоят, а поправить их можно на любом шаге.",
  },
  {
    title: "Параметры объекта",
    lead: "Две вещи: размер объекта с объемом задач и кто эту работу делает сегодня. Остальное уже проставлено по отраслевым данным.",
  },
  {
    title: "План вашего склада",
    lead: "Перенесите свой склад: размеры, ворота, зоны хранения. От плана зависит длина маршрута, а от нее производительность робота и размер парка. Шаг можно пропустить.",
  },
  {
    title: "Решение из каталога",
    lead: "Показываем, что подходит, что требует проверки и почему. У каждого решения видно, каких данных не хватает.",
  },
  {
    title: "Экономика трех сценариев",
    lead: "Как сейчас, покупка и аренда. Видно, из чего сложились затраты и откуда взята каждая цифра.",
  },
];

// Заголовки короткого пути: там нет штата, плана и экономики, и заголовок не должен их обещать
const SHORT_TITLES: Record<number, { title: string; lead: string }> = {
  1: {
    title: "Параметры объекта",
    lead: "Значения из датасета организатора с допустимыми границами. Поправьте то, что знаете про свой объект: от этих чисел зависит проверка решений.",
  },
  3: {
    title: "Решения под ваши задачи",
    lead: "Что подходит, что требует проверки и почему. У каждой характеристики источник, дата и оценка доверия.",
  },
};

// Введенное живет в браузере и переживает перезагрузку (docs/ux-flow.md, «Что сохраняется»).
// Номер в ключе поднимаем, когда меняется форма сохраненного: старое тогда просто не читаем.
const STORE = DRAFT_KEY;
// последний ответ расчета в этой вкладке, с ключом запроса
const RESULT_STORE = RESULT_KEY;

function storedResult(key: string): CalculationResult | null {
  try {
    const raw = window.sessionStorage.getItem(RESULT_STORE);
    const stored = raw ? (JSON.parse(raw) as { key?: string; answer?: CalculationResult }) : null;
    return stored?.key === key && stored.answer ? stored.answer : null;
  } catch {
    return null;
  }
}

type Saved = {
  facilityId: string;
  taskIds: string[];
  // решения на каждую задачу с долей объема: одно или два (смешанный парк)
  picks?: Picks;
  // первое решение каждой задачи: так снимок читали до смешанного парка
  choices?: Record<string, string>;
  // решение первой задачи: так снимок читали до выбора по задачам, старые проекты хранят только его
  robotId: string;
  overrides: Record<string, number>;
  staff: StaffLine[];
  staffTouched: boolean;
  // под какой объем вводили штат руками: путь значения и число. Если объем потом поменяли,
  // шаг параметров предлагает пересчитать штат. У старых снимков поля нет, предложения не будет
  staffBasis?: Record<string, number> | null;
  // задачи, снятые с расчета галочкой на экономике: остаются выбранными, но объект считается без них
  excluded?: string[];
  // бюджет на старте в рублях, если человек его назвал. Пусто: ничего не ограничивает
  budget?: number | null;
  plan: Plan | null;
  answers: CustomAnswers | null;
  planChosen: boolean;
  reached: number;
  calcStarted: boolean;
  // проект, в который сохраняем: у гостя и до первого сохранения его нет
  projectId?: number | null;
  projectName?: string;
  // стоит, только пока введенное совпадает с последним сохранением: тогда это не черновик
  savedAs?: { version: number; key: string } | null;
};

function load(): Partial<Saved> {
  try {
    return (JSON.parse(window.localStorage.getItem(STORE) ?? "{}") as Partial<Saved> | null) ?? {};
  } catch {
    return {};
  }
}

// Шаг в адресе страницы, с единицы: ?step=3 это план. Кнопка «назад» браузера ходит по шагам.
function stepFromUrl(): number | null {
  const raw = Number(new URLSearchParams(window.location.search).get("step"));
  return Number.isInteger(raw) && raw >= 1 && raw <= STEPS.length ? raw - 1 : null;
}

function urlFor(index: number): string {
  const query = new URLSearchParams(window.location.search);
  query.set("step", String(index + 1));
  return `${window.location.pathname}?${query.toString()}${window.location.hash}`;
}

// Мастер из кабинета: /calc?project=12&open=1. Сначала забираем сохраненное введенное с сервера
// и кладем его туда же, откуда мастер читает введенное, а потом открываем мастер. Цифры он
// пересчитывает сам. Тот же проект в адресе без open открываем из браузера: там могут быть
// правки после открытия, и перезагрузка не должна их стирать.
// «Новый расчет» (/calc?new=1). Если в браузере есть незаконченный расчет, спрашиваем, продолжить
// его или начать заново: молча открыть старый так же плохо, как молча его стереть.
export function App() {
  // Начать с чистого листа: стираем незаконченный и убираем new из адреса
  const clean = () => {
    try {
      window.localStorage.removeItem(STORE);
    } catch {
      // без хранилища и так чистый лист
    }
    window.history.replaceState(null, "", "/calc");
  };
  const [fresh, setFresh] = useState(() => {
    if (new URLSearchParams(window.location.search).get("new") !== "1") return "no" as const;
    if (draftOf(window.localStorage.getItem(STORE))) return "ask" as const;
    clean(); // незаконченного нет, спрашивать не о чем
    return "no" as const;
  });

  if (fresh === "ask") {
    const draft = draftOf(window.localStorage.getItem(STORE))!;
    return (
      <div className="u-page">
        <Header />
        <main className="u-main u-wrap">
          <Hero
            title="Новый расчет"
            lead="Продолжить прошлый расчет или начать новый? Несохраненное пропадет"
            compact
          />
          <p>{draftTitle(draft)}</p>
          <span className="u-action-end">
            <Button arrow onClick={() => window.location.replace(draftUrl(draft))}>
              Продолжить
            </Button>
            <Button
              kind="ghost"
              onClick={() => {
                clean();
                setFresh("no");
              }}
            >
              Начать новый
            </Button>
            <Button
              kind="ghost"
              onClick={() => (window.history.length > 1 ? window.history.back() : window.location.assign("/"))}
            >
              Отмена
            </Button>
          </span>
        </main>
      </div>
    );
  }
  return <Opened />;
}

// Мастер с проектом из адреса или без него
function Opened() {
  const [link] = useState(() => projectFromUrl(window.location.search));
  const [ready, setReady] = useState(() => !link || (!link.open && load().projectId === link.id));
  const [failure, setFailure] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (ready || !link || started.current) return;
    started.current = true; // окно с вопросом показываем один раз, даже если эффект запустится дважды
    Promise.all([projects.get(link.id), link.version ? projects.version(link.id, link.version) : null])
      .then(async ([project, version]) => {
        const state = (version ?? project.current)?.state as Partial<Saved> | undefined;
        if (!state?.facilityId) throw new ApiError(422, "в проекте нет сохраненного расчета");
        // Проект ляжет на место несохраненного расчета: спрашиваем, как при "Новом расчете"
        const draft = draftOf(window.localStorage.getItem(STORE));
        if (
          draft &&
          draft.projectId !== project.id &&
          !(await ask({
            title: "Открыть проект?",
            text: `В этом браузере есть несохраненный расчет: ${draftTitle(draft)}. Если открыть проект, он пропадет.`,
            yes: "Открыть проект",
            no: "Вернуться в кабинет",
            danger: true,
          }))
        ) {
          window.location.assign("/projects");
          return;
        }
        const opened: Saved = {
          ...(state as Saved),
          reached: LAST,
          calcStarted: true,
          projectId: project.id,
          projectName: project.name,
        };
        window.localStorage.setItem(STORE, JSON.stringify(opened));
        const query = new URLSearchParams(window.location.search);
        query.delete("open");
        query.delete("version");
        query.set("step", String(LAST + 1));
        window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}`);
        setReady(true);
      })
      .catch((error: unknown) => {
        const status = error instanceof ApiError ? error.status : 0;
        setFailure(
          status === 401
            ? "Проект открывается после входа."
            : status === 404
              ? "Проект не нашелся: его удалили или он принадлежит другому пользователю."
              : `Проект не открылся: ${(error as Error).message}.`,
        );
      });
  }, [ready, link]);

  if (failure) {
    const toLogin = link && failure.includes("входа");
    return (
      <div className="u-page">
        <Header />
        <main className="u-main u-wrap">
          <Hero title="Проект не открылся" lead={failure} compact />
          <span className="u-action-end">
            <Button
              arrow
              onClick={() =>
                window.location.assign(
                  toLogin ? `/login?next=${encodeURIComponent(`/calc?project=${link.id}&open=1`)}` : "/projects",
                )
              }
            >
              {toLogin ? "Войти" : "Вернуться в кабинет"}
            </Button>
            <Button kind="link" onClick={() => window.location.assign("/calc?new=1")}>
              Новый расчет
            </Button>
          </span>
        </main>
      </div>
    );
  }
  if (!ready) return null;
  return <Wizard />;
}

// Путь из шагов на одной странице: пройденные свернуты в строку с итогом, текущий раскрыт,
// будущие приглушены и не нажимаются. Расчет целиком на сервере, здесь только показываем.
function Wizard() {
  const [saved] = useState(load);
  // Шаг из адреса пускаем, только если человек там уже был: иначе открываем самый дальний пройденный
  const [step, setStep] = useState(() => {
    const reached = saved.reached ?? 0;
    const wanted = Math.min(stepFromUrl() ?? reached, reached);
    return wanted === LAST && !saved.calcStarted ? LAST - 1 : wanted;
  });
  const [facilities, setFacilities] = useState<Facility[]>([]);
  // Подбор у каждой задачи свой: сервер проверяет решения под ее груз, проезды и ярусы
  const [solutions, setSolutions] = useState<Record<string, Solution[]>>({});
  const [parameters, setParameters] = useState<Parameter[]>([]);
  const [facilityId, setFacilityId] = useState(saved.facilityId ?? "warehouse");
  // Задач можно выбрать несколько, и расчет считает их вместе, объект целиком
  const [taskIds, setTaskIds] = useState<string[]>(saved.taskIds ?? ["pallet_transport"]);
  // Решение на каждую задачу. Старый снимок знает одно решение, это решение первой задачи
  const [picks, setPicks] = useState<Picks>(() => picksOf(saved));
  const choices = useMemo(() => choicesOf({ picks }), [picks]);
  // Какая задача открыта на шаге решения: задачи идут по очереди
  const [activeTask, setActiveTask] = useState<string>("");
  // План объекта. Сначала генерация, потом правка: он приходит готовым по шаблону планировки,
  // и только потом человек его двигает. Числа под чертежом считает сервер, а не браузер.
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [rackTypes, setRackTypes] = useState<RackType[]>([]);
  const [plan, setPlan] = useState<Plan | null>(saved.plan ?? null);
  const [measures, setMeasures] = useState<PlanMeasures | null>(null);
  // сервер не принял план при замере: причина его словами, ее видно в проверках плана
  const [planRefused, setPlanRefused] = useState("");
  const [overrides, setOverrides] = useState<Record<string, number>>(saved.overrides ?? {});
  const [roles, setRoles] = useState<Role[]>([]);
  // роли, которые нужны выбранным задачам: их строки в штате не меняют выбором другой роли
  const [requiredRoles, setRequiredRoles] = useState<string[]>([]);
  const [staff, setStaff] = useState<StaffLine[]>(saved.staff ?? []);
  // Пока пользователь не трогал штат, он следует за выбранными задачами. После первой правки
  // мы его больше не перекладываем: новые роли только добавляем, введенное не теряем.
  const [staffTouched, setStaffTouched] = useState(saved.staffTouched ?? false);
  const [staffBasis, setStaffBasis] = useState<Record<string, number> | null>(saved.staffBasis ?? null);
  const [excluded, setExcluded] = useState<string[]>(saved.excluded ?? []);
  const [budget, setBudget] = useState<number | null>(saved.budget ?? null);
  const [staffReview, setStaffReview] = useState<StaffReview | null>(null);
  const [result, setResult] = useState<CalculationResult | null>(null);
  // На экономику пускаем только после явного «Начать подсчет»: расчет идет до двадцати секунд,
  // и человек должен понимать, что он его запустил, а не провалиться туда случайно.
  const [calcStarted, setCalcStarted] = useState(saved.calcStarted ?? false);
  // Самый дальний шаг, где человек уже был: по пройденному пути ходим без ограничений
  const [reached, setReached] = useState(saved.reached ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // код ответа сервера при ошибке: 422 ведет в параметры, остальное повторить
  const [errorStatus, setErrorStatus] = useState<number>(0);
  // Кто вошел. Гостю сохранение предлагает вход, отчет и таблицы он скачивает и так
  const [role, setRole] = useState<"guest" | "user" | "admin" | null>(null);
  const [askLogin, setAskLogin] = useState(false);
  // Последнее сохранение и вводные, с которыми его сделали: поменял ввод, и «сохранено» уходит
  const [savedAs, setSavedAs] = useState<{ version: number; key: string } | null>(saved.savedAs ?? null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Ссылка на сохраненную версию: по ней расчет виден без входа, только для просмотра
  const [link, setLink] = useState<{ url: string; version: number; copied: boolean } | null>(null);

  useEffect(() => {
    account
      .me()
      .then((me) => setRole(me.role))
      .catch(() => setRole("guest"));
  }, []);
  // Отчет и таблицы доступны и гостю: сохранять для этого ничего не нужно (docs/decisions.md)
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const operationId = taskIds[0] ?? "";
  // Задачи в расчете с решением на каждую, в порядке выбора на первом шаге
  // Считаем только те решения, что есть в подборе и по которым есть данные, как на карточках.
  // Пока подбор задачи не пришел, берем решения как есть: иначе после перезагрузки на экономике
  // нечего было бы считать
  const tasksToCount = useMemo(
    () =>
      tasksOf(
        // задача, снятая галочкой на экономике, в расчет не идет, но остается выбранной
        taskIds.filter((id) => !excluded.includes(id)),
        Object.fromEntries(
          taskIds.map((id) => {
            const list = solutions[id];
            const own = picks[id] ?? [];
            return [
              id,
              list
                ? own.filter((pick) => list.some((item) => item.robot_id === pick.robotId && item.can_calculate))
                : own,
            ];
          }),
        ),
      ),
    [taskIds, picks, solutions, excluded],
  );
  // Склад считается целиком. У аэропорта и больницы только параметры и список решений, поэтому
  // запросы плана, штата и складского подбора для них не уходят: сервер ответил бы "не найдено".
  const kind = facilities.find((item) => item.id === facilityId)?.status;
  const modeled = kind === "ready";
  const short = kind === "solutions";
  const flow = short ? SHORT : FULL;
  const [facilityAnswer, setFacilityAnswer] = useState<FacilityAnswer | null>(null);

  const loadFacilities = useCallback(() => {
    api
      .facilities()
      .then((list) => {
        setFacilities(list);
        setCatalogError(null);
        // У аэропорта нет плана и экономики: если адрес ведет туда, встаем на ближайший шаг его пути.
        // Объект до этой минуты сменить нельзя, список объектов еще не пришел, поэтому берем сохраненный.
        if (list.find((item) => item.id === saved.facilityId)?.status !== "solutions") return;
        setStep((current) => {
          const nearest = SHORT.filter((index) => index <= current).at(-1) ?? 0;
          window.history.replaceState(null, "", urlFor(nearest));
          return nearest;
        });
      })
      .catch(() => setCatalogError("Не удалось получить список объектов."));
  }, [saved.facilityId]);

  useEffect(() => {
    loadFacilities();
  }, [loadFacilities]);

  useEffect(() => {
    api
      .planTemplates()
      .then(setTemplates)
      .catch(() => setCatalogError("Не удалось получить шаблоны планировки."));
    api
      .rackTypes()
      .then(setRackTypes)
      .catch(() => setCatalogError("Не удалось получить типы стеллажей."));
  }, []);

  // Последний план, который пришел с сервера: его не отправляем на пересчет повторно
  const settled = useRef("");

  // Ответы анкеты «Свой склад»: размеры, стена с воротами, ряды. Живут здесь, а не в плане:
  // сервер их не хранит, а план по ним уже построен
  const [answers, setAnswers] = useState<CustomAnswers | null>(saved.answers ?? null);
  // человек выбрал, откуда взять план: до этого шаг показывает три пути, а не готовый чертеж
  const [planChosen, setPlanChosen] = useState(saved.planChosen ?? false);
  // те же ответы в ref: сборка плана читает их без пересоздания, иначе смена ответов перезапускала
  // сборку по старой схеме, и та приходила позже новой
  const answersRef = useRef<CustomAnswers | null>(saved.answers ?? null);
  // Проект берем, только если он и в адресе: «Новый расчет» открывает /calc без проекта,
  // и его сохранение должно стать новым проектом, а не версией прежнего
  const [projectId, setProjectId] = useState<number | null>(() =>
    saved.projectId && projectFromUrl(window.location.search)?.id === saved.projectId ? saved.projectId : null,
  );
  const [projectTitle, setProjectTitle] = useState(projectId ? (saved.projectName ?? "") : "");

  // Все введенное одним снимком: его же кладем в браузер и в версию проекта
  const snapshot: Saved = useMemo(
    () => ({
      facilityId,
      taskIds,
      picks,
      choices,
      robotId: choices[operationId] ?? "",
      overrides,
      staff,
      staffTouched,
      staffBasis,
      excluded,
      budget,
      plan,
      answers,
      planChosen,
      reached,
      calcStarted,
      projectId,
      projectName: projectTitle,
    }),
    [
      facilityId,
      taskIds,
      picks,
      choices,
      operationId,
      overrides,
      staff,
      staffTouched,
      staffBasis,
      excluded,
      budget,
      plan,
      answers,
      planChosen,
      reached,
      calcStarted,
      projectId,
      projectTitle,
    ],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(STORE, JSON.stringify(snapshot));
    } catch {
      // приватное окно или переполненное хранилище: считать это не мешает, просто не запомним
    }
  }, [snapshot]);

  // План строим сам, пока человек его не трогал: поменялась площадь или задачи, поменялся и план.
  // После первой правки чертеж принадлежит человеку, и мы его не перестраиваем.
  const tooLong = overDay(parameters, overrides) !== null;
  // План зависит только от объекта: площадь, смены, задачи. Срок лизинга или цена робота его не
  // меняют, а раньше каждая такая правка строила план заново, и неверный срок ронял и план
  const planKey = JSON.stringify(forPlan(overrides));
  const planOverrides = useMemo(() => JSON.parse(planKey) as Record<string, number>, [planKey]);
  // какую схему просили последней и чей ответ класть: ответ прежней сборки может прийти позже
  const builds = useRef(planBuilds());
  const buildPlan = useCallback(
    (templateId: string, custom?: CustomAnswers) => {
      if (taskIds.length === 0 || tooLong || !modeled) return;
      const own = templateId === "custom" ? (custom ?? answersRef.current) : null;
      const ticket = builds.current.ask(templateId);
      api
        .planGenerate({
          facility_id: facilityId,
          operation_ids: taskIds,
          template_id: templateId,
          overrides: planOverrides,
          ...(own
            ? {
                width_m: own.width_m,
                length_m: own.length_m,
                custom: { docks: own.docks, racks: own.racks },
              }
            : {}),
        })
        .then((built) => {
          if (!builds.current.latest(ticket)) return;
          settled.current = JSON.stringify(built.plan);
          setPlan(built.plan);
          setMeasures(built.measures);
        })
        .catch(() => setCatalogError("Не удалось построить план объекта."));
    },
    [facilityId, taskIds, planOverrides, tooLong, modeled],
  );

  // задача «товар к человеку» без своего плана получает робозону: на рядах под погрузчик отбор не сходится
  const needsStations = facilities
    .find((one) => one.id === facilityId)
    ?.operations.some((operation) => taskIds.includes(operation.id) && operation.takeover === "speedup");
  // Выбор способа на шаге плана и "Начать заново" строят план сами. Если бы и эта пересборка
  // шла от смены выбора, она уходила бы следом со старой схемой и ее ответ ложился поверх
  const chosenRef = useRef(planChosen);
  useEffect(() => {
    chosenRef.current = planChosen;
  }, [planChosen]);
  useEffect(() => {
    if (plan?.edited) return;
    // схему, которую человек выбрал сам, держим; нашу типовую пересобираем под задачи,
    // иначе робозона под отбор терялась, если список задач приходил позже первого плана
    const wanted = defaultTemplate(Boolean(needsStations));
    buildPlan(autoTemplate(builds.current.asked() || plan?.template, chosenRef.current, wanted));
    // перестраиваем только пока чертеж наш, а не человека
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildPlan, needsStations]);

  // Числа плана считает сервер, поэтому каждая правка чертежа уходит запросом, с задержкой
  // и с отменой предыдущего: на каждый сдвиг мышью расчет не гоняем. Ответ несет и план:
  // зарядку ставит программа, и ее место после правки могло измениться. Такой план мы
  // запоминаем в settled, чтобы не отправлять его обратно второй раз.
  useEffect(() => {
    if (!plan) return;
    const sent = JSON.stringify(plan);
    if (sent === settled.current) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      api
        .planMeasure(plan, abort.signal)
        .then((answer) => {
          const back = JSON.stringify(answer.plan);
          settled.current = back;
          setPlanRefused("");
          setMeasures(answer.measures);
          if (back !== sent) setPlan(answer.plan);
        })
        // Отказ по плану (422) показываем на шаге плана. Раньше его глотали, и человек видел
        // "проверки пройдены" прошлого плана, а голый отказ получал только на шаге экономики
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 422) setPlanRefused(error.message);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [plan]);

  // Подбор берет с плана ширину проезда, верхний ярус, пандусы и закрытые стеллажи.
  // Перезапрашиваем, только когда поменялось одно из этих чисел, а не на каждый сдвиг стеллажа.
  const aisle = measures?.aisle_m;
  const rackTop = measures?.rack_top_m;
  const ramps = measures?.ramps;
  const closedRacks = measures?.closed_racks;
  // Масса груза с шага параметров: подбор перезапрашиваем, только когда поменялась она, а не любая правка
  const loadKey = Object.entries(overrides)
    .filter(([path]) => path.endsWith(".load_kg"))
    .sort()
    .join(";");
  const loads = useMemo(
    (): Record<string, number> =>
      Object.fromEntries(
        (loadKey ? loadKey.split(";") : []).map((pair) => {
          const [path, value] = pair.split(",");
          return [path, Number(value)];
        }),
      ),
    [loadKey],
  );
  useEffect(() => {
    if (taskIds.length === 0 || !modeled) return;
    const facts = aisle
      ? { aisle_m: aisle, rack_top_m: rackTop ?? 0, ramps: ramps ?? 0, closed_racks: closedRacks ?? 0 }
      : null;
    let stale = false;
    const loadOf = (id: string) => loads[`facilities.${facilityId}.operations.${id}.load_kg`];
    Promise.all(
      taskIds.map((id) => api.solutions(facilityId, id, facts, loadOf(id)).then((list) => [id, list] as const)),
    )
      .then((lists) => {
        if (!stale) setSolutions(Object.fromEntries(lists));
      })
      .catch(() => setCatalogError("Не удалось подобрать решения."));
    return () => {
      stale = true;
    };
  }, [facilityId, taskIds, aisle, rackTop, ramps, closedRacks, modeled, loads]);

  // Решения аэропорта и больницы проверяются по параметрам второго шага, поэтому правка там
  // пересобирает список. С задержкой и отменой прежнего запроса, как проверка штата.
  useEffect(() => {
    if (!short || taskIds.length === 0) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      api
        .facilitySolutions({ facility_id: facilityId, operation_ids: taskIds, overrides }, abort.signal)
        .then(setFacilityAnswer)
        .catch((failure: Error) => {
          if (failure.name !== "AbortError") setCatalogError("Не удалось подобрать решения.");
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [short, facilityId, taskIds, overrides]);

  useEffect(() => {
    if (taskIds.length === 0) return;
    api
      .parameters(facilityId, taskIds)
      .then(setParameters)
      .catch(() => setCatalogError("Не удалось получить параметры объекта."));
  }, [facilityId, taskIds]);

  // Справочник ролей и штат по умолчанию. Роли в списке зависят от выбранных задач:
  // первыми стоят те, у кого эти задачи забирают работу.
  // Объем задач и рабочие дни с правками: пока штат не трогали, он следует за ними сам
  const volumeOverrides = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(overrides).filter(
          ([path]) => /\.operations\.[^.]+\.volume_per_day$/.test(path) || path.endsWith("schedule.days_per_year"),
        ),
      ),
    [overrides],
  );
  const volumeKey = JSON.stringify(volumeOverrides);
  const [staffNote, setStaffNote] = useState("");
  useEffect(() => {
    if (taskIds.length === 0 || !modeled) return;
    api
      .staffForm(facilityId, taskIds, staffTouched ? {} : volumeOverrides)
      .then((form) => {
        setRoles(form.roles);
        setStaffNote(staffTouched ? "" : form.note);
        setRequiredRoles(form.lines.map((line) => line.role));
        setStaff((current) => (staffTouched ? merge(current, form.lines) : form.lines.map(strip)));
      })
      .catch(() => setCatalogError("Не удалось получить справочник ролей: сервер не ответил."));
    // staffTouched и volumeOverrides читаем, но перезапрашиваем только по ключу объема
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityId, taskIds, modeled, volumeKey]);

  // Проверка штата идет на сервере и с задержкой: на каждый удар по клавише не пересчитываем.
  useEffect(() => {
    if (taskIds.length === 0 || tooLong || !modeled) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      api
        .staffCheck(
          {
            facility_id: facilityId,
            operation_ids: taskIds,
            overrides,
            staff,
            // объем, под который вводили штат: сервер сравнит и предложит пересчитать
            staff_basis: staffTouched && staffBasis ? staffBasis : {},
          },
          abort.signal,
        )
        .then(setStaffReview)
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [facilityId, taskIds, overrides, staff, tooLong, modeled, staffTouched, staffBasis]);

  // Объем задач и рабочие дни сейчас: под них человек вводит штат. Значения из полей шага,
  // с правками; браузер ничего не считает, только запоминает числа
  const basisNow = useCallback(() => {
    const picked = parameters.filter(
      (field) =>
        taskIds.some((id) => field.path.endsWith(`.operations.${id}.volume_per_day`)) ||
        field.path.endsWith("schedule.days_per_year"),
    );
    return Object.fromEntries(picked.map((field) => [field.path, overrides[field.path] ?? field.value]));
  }, [parameters, taskIds, overrides]);

  // Первая правка штата руками запоминает, под какой объем его вводили
  const touchStaff = () => {
    if (!staffTouched) setStaffBasis(basisNow());
    setStaffTouched(true);
  };

  // Правки привязаны к задаче через путь значения, поэтому снять можно только ее правки.
  const dropTaskOverrides = (taskId: string) =>
    setOverrides((current) =>
      Object.fromEntries(Object.entries(current).filter(([path]) => !path.includes(`.operations.${taskId}.`))),
    );

  const toggleTask = async (taskId: string) => {
    if (!taskIds.includes(taskId)) {
      // "выбрать все" отмечает задачи подряд в одном обработчике: берем текущий список, а не снимок
      setTaskIds((current) => (current.includes(taskId) ? current : [...current, taskId]));
      return;
    }
    const edited = Object.keys(overrides).some((path) => path.includes(`.operations.${taskId}.`));
    // Предупреждаем до того, как сбросить правки, а не после
    if (
      edited &&
      !(await ask({
        title: "Снять задачу?",
        text: "Значения, которые вы поправили по этой задаче, сбросятся.",
        yes: "Снять задачу",
        danger: true,
      }))
    )
      return;
    setTaskIds((current) => current.filter((id) => id !== taskId));
    dropTaskOverrides(taskId);
  };

  // Задачи помним по объекту: заглянул в аэропорт и вернулся на склад, отметки склада на месте
  const tasksByFacility = useRef<Record<string, string[]>>({});
  const pickFacility = async (id: string) => {
    if (id === facilityId) return;
    // Предупреждаем до того, как сбросить, а не после (docs/ux-flow.md, «Возврат и правка»)
    if (
      Object.keys(overrides).length > 0 &&
      !(await ask({
        title: "Сменить объект?",
        text: "У другого объекта свои задачи и поля, поправленные значения сбросятся.",
        yes: "Сменить объект",
        danger: true,
      }))
    )
      return;
    setFacilityId(id);
    tasksByFacility.current[facilityId] = taskIds;
    // у другого объекта свои задачи и свои поля. Впервые открытый объект начинается с первой задачи,
    // как склад: иначе кнопка "Дальше" серая, и непонятно, что делать
    const first = facilities.find((item) => item.id === id)?.operations.slice(0, 1) ?? [];
    setTaskIds(tasksByFacility.current[id] ?? first.map((task) => task.id));
    setOverrides({});
    setFacilityAnswer(null);
  };

  const changeParameter = (path: string, next: number | null) =>
    setOverrides((current) => {
      const updated = { ...current };
      if (next === null) delete updated[path];
      else updated[path] = next;
      return updated;
    });

  const editStaff = (id: string, patch: Partial<StaffLine>) => {
    touchStaff();
    setStaff((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const addStaff = (roleId: string) => {
    const role = roles.find((item) => item.id === roleId);
    if (!role) return;
    touchStaff();
    setStaff((current) => [
      ...current,
      {
        id: `line-${Date.now()}`,
        role: role.id,
        headcount: 1,
        filled: 1,
        salary_month: role.salary_month,
        contractor: false,
      },
    ]);
  };

  const removeStaff = (id: string) => {
    touchStaff();
    setStaff((current) => current.filter((line) => line.id !== id));
  };

  const request = useMemo(
    () => ({
      facility_id: facilityId,
      // первая задача и ее решение: так запрос понимали до выбора по задачам
      operation_id: tasksToCount[0]?.operation_id ?? operationId,
      robot_id: tasksToCount[0]?.robot_id ?? "",
      tasks: tasksToCount,
      overrides,
      staff,
      plan,
      raas_buyout: true,
      // парк по прогону смены на плане, формула рядом проверкой (docs/decisions.md)
      use_simulation: true,
      budget_rub: budget,
    }),
    [facilityId, operationId, tasksToCount, overrides, staff, plan, budget],
  );

  // Только что сохраненный расчет не черновик: кабинет не зовет его незаконченным,
  // пока человек не поправит что-то еще. Пишем после снимка выше, поверх него
  useEffect(() => {
    if (!savedAs || savedAs.key !== JSON.stringify(request)) return;
    try {
      window.localStorage.setItem(STORE, JSON.stringify({ ...snapshot, savedAs }));
    } catch {
      // без хранилища черновика и так нет
    }
  }, [savedAs, request, snapshot]);

  // Один расчет за раз: новый отменяет прежний, иначе поздний ответ старого затер бы новый.
  // Что уже посчитано, помним, чтобы возврат на экономику не гонял смену заново.
  const running = useRef<AbortController | null>(null);
  const counted = useRef("");
  // Сохранить можно только посчитанное по текущему вводу: пока идет пересчет или он упал,
  // в result лежит прошлый ответ, и в проект ушли бы новые вводные со старыми цифрами
  const [countedKey, setCountedKey] = useState("");
  const upToDate = result !== null && error === null && !loading && countedKey === JSON.stringify(request);
  const calculate = useCallback(() => {
    running.current?.abort();
    const abort = new AbortController();
    running.current = abort;
    const key = JSON.stringify(request);
    // тот же ввод уже считали в этой вкладке (например, до ухода на вход): берем сохраненный ответ
    const stored = storedResult(key);
    if (stored) {
      counted.current = key;
      setCountedKey(key);
      setResult(stored);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .preview(request, abort.signal)
      .then((answer) => {
        counted.current = key;
        setCountedKey(key);
        setResult(answer);
        // ответ живет в этой вкладке до закрытия: после входа из гостя страница открывается
        // заново, и без этого расчет гонялся бы полминуты повторно при том же вводе
        try {
          window.sessionStorage.setItem(RESULT_STORE, JSON.stringify({ key, answer }));
        } catch {
          // без хранилища просто посчитаем еще раз
        }
      })
      .catch((failure: Error) => {
        if (failure.name === "AbortError") return;
        setError(failure.message);
        setErrorStatus(failure instanceof ApiError ? failure.status : 0);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
  }, [request]);

  // Что мешает показать расчет и куда вести: парк не тянет спрос, невозможный ввод, сервер молчит.
  // Пока идет пересчет, помех нет: на экране ожидание, а не старое сообщение
  const trouble = loading ? null : troubleOf(result, error ? { message: error, status: errorStatus } : null);

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
      .catch((failure: Error) => setExportError(`Файл не собрался: ${failure.message}`))
      .finally(() => setExporting(null));
  };

  // Допущение правится прямо на экране результата, поэтому пересчитываем сами, с задержкой:
  // на каждый удар по клавише расчет не гоняем (docs/ux-flow.md, «Возврат и правка»).
  // Первый подсчет тоже уходит отсюда, кнопка его отдельно не зовет, иначе уходило бы два.
  useEffect(() => {
    if (step !== LAST || counted.current === JSON.stringify(request)) return;
    const timer = setTimeout(calculate, 400);
    return () => clearTimeout(timer);
  }, [step, request, calculate]);

  const facility = facilities.find((item) => item.id === facilityId);
  const tasks = (facility?.operations ?? []).filter((task) => taskIds.includes(task.id));
  // робозона под штучный отбор: на ней считаем штучный отбор при любом плане
  const picking = tasks.some((task) => task.takeover === "speedup");
  const zoneM2 = picking ? pickingZoneM2(facility, overrides) : null;
  const zoneRate = zoneShare(facility, overrides);
  // Выбранное решение каждой задачи. Выбрать можно только то, что считается, поэтому и здесь так же
  // Решения задачи, которые считаются: только те, что есть в подборе и по которым есть данные.
  // На задачу одно решение или два с долей объема
  const picked = taskIds.map((id) => {
    const list = solutions[id] ?? [];
    const own = (picks[id] ?? []).filter((pick) =>
      list.some((item) => item.robot_id === pick.robotId && item.can_calculate),
    );
    return {
      id,
      name: tasks.find((task) => task.id === id)?.name ?? id,
      picks: own,
      solution: own.length ? list.find((item) => item.robot_id === own[0].robotId) : undefined,
    };
  });
  const left = picked.filter((one) => !one.solution);
  // Открытая задача на шаге решения: та, что выбрал человек, иначе первая без решения
  const shownTask = taskIds.includes(activeTask) ? activeTask : (left[0]?.id ?? operationId);
  const nextTask = left.find((one) => one.id !== shownTask);

  // Бюджет на карточках: сколько роботов каждого решения влезает со всеми вложениями на старте.
  // Считает сервер по тем же статьям, что экономика. Ключ: задача и бюджет, чтобы старые числа
  // не показывались под новым бюджетом, пока идет запрос
  const fitKey = `${shownTask}|${budget ?? ""}`;
  const [budgetFits, setBudgetFits] = useState<Record<string, Record<string, BudgetFit>>>({});
  useEffect(() => {
    // парк по формуле спрашиваем всегда: по нему карточка предупреждает про пик, бюджет сверху
    if (step !== 3) return;
    const robotIds = [
      ...new Set(
        (solutions[shownTask] ?? [])
          .filter((solution) => solution.can_calculate && solution.robot_id)
          .map((solution) => solution.robot_id as string),
      ),
    ];
    if (robotIds.length === 0) return;
    const abort = new AbortController();
    api
      .budgetFit(
        {
          facility_id: facilityId,
          operation_id: shownTask,
          robot_ids: robotIds,
          budget_rub: budget ?? null,
          overrides,
          plan,
          share: 1,
        },
        abort.signal,
      )
      .then((rows) =>
        setBudgetFits((current) => ({
          ...current,
          [fitKey]: Object.fromEntries(rows.map((row) => [row.robot_id, row])),
        })),
      )
      .catch(() => {
        // без ответа строки про бюджет на карточках просто нет
      });
    return () => abort.abort();
  }, [step, budget, shownTask, fitKey, solutions, facilityId, overrides, plan]);
  // в подписях только то, что считается: снятые с расчета задачи не называем
  const countedTasks = picked.filter((one) => !excluded.includes(one.id));
  const robotNames = [
    ...new Set(
      countedTasks.flatMap((one) => one.picks.map((pick) => shortName(solutions[one.id] ?? [], pick.robotId))),
    ),
  ];
  const excludedTasks = picked
    .filter((one) => excluded.includes(one.id))
    .map((one) => ({ operationId: one.id, name: one.name }));
  // Правки решений задачи: первое заменить, второе добавить поровну, долю подвинуть, второе убрать
  // Выбор решения держит человека на его задаче: открытая задача иначе первая без решения,
  // и после выбора подбор сам уезжал к следующей. Дальше ведут плитка задачи и кнопка в полосе
  const setFirst = (taskId: string, robotId: string) => {
    setActiveTask(taskId);
    setPicks((current) => ({ ...current, [taskId]: [{ robotId, share: 1 }] }));
  };
  // Снять выбор нажатием на "Выбрано": у задачи с двумя решениями остается второе на весь объем
  const unpick = (taskId: string, robotId: string) => {
    setActiveTask(taskId);
    setPicks((current) => {
      const rest = (current[taskId] ?? []).filter((one) => one.robotId !== robotId);
      return { ...current, [taskId]: rest.map((one) => ({ ...one, share: 1 })) };
    });
  };
  const addSecond = (taskId: string, robotId: string) =>
    setPicks((current) => {
      const first = current[taskId]?.[0];
      if (!first || first.robotId === robotId) return current;
      return {
        ...current,
        [taskId]: [
          { ...first, share: 0.5 },
          { robotId, share: 0.5 },
        ],
      };
    });
  const setShare = (taskId: string, share: number) =>
    setPicks((current) => {
      const [first, second] = current[taskId] ?? [];
      if (!first || !second) return current;
      return {
        ...current,
        [taskId]: [
          { ...first, share },
          { ...second, share: Math.round((1 - share) * 100) / 100 },
        ],
      };
    });
  const dropSecond = (taskId: string) =>
    setPicks((current) => {
      const first = current[taskId]?.[0];
      return first ? { ...current, [taskId]: [{ ...first, share: 1 }] } : current;
    });
  const changed = useMemo(() => Object.keys(overrides).length, [overrides]);

  // Шаг закрыт, когда на нем сделан выбор. Вперед идем по одному шагу и только с закрытого,
  // назад можно всегда: строкой пройденного шага. Прыгнуть с объекта сразу в экономику нельзя.
  // План закрыт всегда: шаг необязательный, и даже нетронутый чертеж это готовый план.
  const closed = [
    facilities.length > 0 && taskIds.length > 0,
    true,
    true,
    taskIds.length > 0 && left.length === 0,
    true,
  ];

  // Куда пускаем. По шагам, где человек уже был, ходим свободно в обе стороны: он там все заполнил.
  // Вперед дальше пройденного идем по одному и только с закрытого шага. Экономика особая:
  // на нее пускает только кнопка «Начать подсчет», зато после этого она открыта всегда.
  const next = flow[flow.indexOf(step) + 1];
  const previous = flow[flow.indexOf(step) - 1];
  const open = (index: number) => {
    if (!flow.includes(index)) return false;
    if (index === LAST) return calcStarted;
    if (index > reached && index !== next) return false;
    return closed.slice(0, index).every(Boolean);
  };

  const goTo = (index: number) => {
    if (index === step || !open(index)) return;
    setReached(Math.max(reached, index));
    setStep(index);
    window.history.pushState(null, "", urlFor(index));
  };

  const startCalculation = () => {
    if (step === LAST) return; // второе нажатие, пока шаг меняется
    setCalcStarted(true);
    setReached(LAST);
    setStep(LAST);
    window.history.pushState(null, "", urlFor(LAST));
    // заглушка ожидания встает сразу, а сам расчет уходит из эффекта выше, один
    if (counted.current !== JSON.stringify(request)) setLoading(true);
  };

  // Адрес совпадает с шагом с первого экрана, чтобы «назад» в браузере было куда вести
  useEffect(() => {
    window.history.replaceState(null, "", urlFor(step));
    // только при открытии страницы
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Новый шаг открывается с начала: заголовок шага наверху экрана, а не середина прошлой страницы.
  // Фокус переходит на заголовок, чтобы с клавиатуры и в чтении с экрана не терялось место.
  const shown = useRef(step);
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    window.scrollTo({ top: 0, behavior: "instant" });
    const title = document.querySelector<HTMLElement>("main h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, [step]);

  // Кнопка «назад» браузера: шаг из адреса, если на нем уже были. Иначе возвращаем адрес текущего.
  const allowed = useRef(open);
  useEffect(() => {
    allowed.current = open;
  });
  useEffect(() => {
    const onPop = () => {
      const wanted = stepFromUrl() ?? 0;
      if (allowed.current(wanted)) setStep(wanted);
      else window.history.replaceState(null, "", urlFor(shown.current));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const value = (suffix: string) => {
    const field = parameters.find((item) => item.path.endsWith(suffix));
    return field ? (overrides[field.path] ?? field.value) : null;
  };
  const area = value("active_area_m2");
  const shifts = value("schedule.shifts");
  const shiftHours = value("schedule.shift_hours");

  // Сохранение в проект. Первый раз создаем проект сразу с версией, дальше добавляем версии.
  // Если проект тем временем удалили в кабинете, заводим новый, а не теряем расчет.
  const save = async () => {
    if (!result || !upToDate || saving) return;
    if (role !== "user" && role !== "admin") {
      void askToLogin();
      return;
    }
    const key = JSON.stringify(request);
    const body = {
      state: snapshot as unknown as Record<string, unknown>,
      result: result as unknown as Record<string, unknown>,
      note: "",
    };
    setSaving(true);
    setSaveError(null);
    try {
      if (projectId) {
        try {
          const version = await projects.saveVersion(projectId, body);
          setSavedAs({ version: version.number, key });
          return;
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
        }
      }
      const created = await projects.create({
        // в названии только то, что посчитано: снятые галочкой задачи не называем
        name: nameFor(
          facility?.name ?? "Объект",
          area,
          countedTasks.map((task) => task.name),
        ),
        facility_type: facilityId,
        ...body,
      });
      setProjectId(created.id);
      setProjectTitle(created.name);
      setSavedAs({ version: created.current?.number ?? 1, key });
      const query = new URLSearchParams(window.location.search);
      query.set("project", String(created.id));
      window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setRole("guest");
        void askToLogin();
      } else setSaveError(`Не сохранилось: ${(failure as Error).message}. Введенное не потерялось, можно повторить`);
    } finally {
      setSaving(false);
    }
  };

  // Поделиться сохраненной версией: сервер дает ссылку, мы кладем ее в буфер обмена.
  // Если браузер буфер не дает, ссылка просто стоит в полосе, ее можно выделить
  const share = async () => {
    if (!projectId || !savedAs) return;
    setSaveError(null);
    try {
      const made = await projects.share(projectId, savedAs.version);
      const url = `${window.location.origin}/share/${made.token}`;
      let copied = true;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        copied = false;
      }
      setLink({ url, version: made.version, copied });
    } catch (failure) {
      setSaveError(`Ссылка не получилась: ${(failure as Error).message}`);
    }
  };

  // Гость нажал "Сохранить в проект": окно поверх страницы, а не подмена кнопки на "Войти".
  // Кнопка, которая сама превращалась во "Войти", выглядела так, будто сохранение сломалось
  const askToLogin = async () => {
    setAskLogin(true);
    const answer = await choose({
      title: "Сохранить расчет в проект",
      text: "Чтобы сохранить расчет, войдите или зарегистрируйтесь, расчет не пропадет: после входа он сразу сохранится в новый проект.",
      no: "Не сейчас",
      options: [
        { id: "register", label: "Зарегистрироваться", kind: "ghost" },
        { id: "login", label: "Войти" },
      ],
    });
    if (answer === "login") login();
    else if (answer === "register") login(true);
    else setAskLogin(false);
  };

  // Вернулись со входа: как только расчет готов, сохраняем его в новый проект один раз
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    if (role !== "user" && role !== "admin") return;
    if (!result || !upToDate || step !== LAST) return;
    try {
      const pressed = window.localStorage.getItem(SAVE_AFTER_LOGIN);
      window.localStorage.removeItem(SAVE_AFTER_LOGIN);
      if (!saveAfterLogin(pressed)) return;
    } catch {
      return;
    }
    void saveRef.current();
  }, [role, result, upToDate, step]);

  const summaries = [
    facility && tasks.length > 0
      ? `${short ? "Выбрано" : "В расчете"} ${tasks.length} из ${facility.operations.length}: ${tasks
          .map((task) => task.name.toLowerCase())
          .join(", ")}`
      : "Выберите хотя бы одну задачу, иначе считать нечего",
    [
      area === null ? null : `${area.toLocaleString("ru-RU")} м²`,
      shifts === null || shiftHours === null ? null : `${shifts} смены по ${shiftHours} ч`,
      staffReview && modeled ? `${staffReview.headcount_total.toLocaleString("ru-RU")} мест в штате` : null,
      changed > 0 ? `правок: ${changed}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    measures
      ? `склад ${measures.width_m} на ${measures.length_m} м · маршрут ${Math.round(measures.route_m)} м · ворот ${measures.docks}` +
        (plan?.edited || plan?.template === "custom" ? "" : " · планировка типовая")
      : "Строим план по шаблону",
    [
      short
        ? `Решений под задачи: ${facilityAnswer?.solutions.length ?? 0}. Дальше этого шага путь для объекта "${facility?.name}" пока не идет`
        : left.length === 0
          ? `${taskIds.length > 1 ? "Решения выбраны для всех задач" : `Выбрано: ${pickedWords(picked[0], solutions)}`} · подсчет гоняет смену на вашем плане, до полуминуты`
          : taskIds.length > 1
            ? `Выбрано ${taskIds.length - left.length} из ${taskIds.length}. Осталось выбрать: ${left.map((one) => one.name.toLowerCase()).join(", ")}`
            : "Решение пока не выбрано",
      budget && !short ? `бюджет на старте ${mln(budget)} млн ₽` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    [
      robotNames.join(", "),
      // парк пишем только по свежему расчету: после смены решения старое число вводило в заблуждение
      upToDate && result?.sizing
        ? `${result.sizing.fleet} ${plural(result.sizing.fleet, "робот", "робота", "роботов")}`
        : loading
          ? "считаем заново"
          : null,
      changed > 0 ? `правок: ${changed}` : "значения по умолчанию",
      excludedTasks.length ? `без учета: ${excludedTasks.map((one) => one.name.toLowerCase()).join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  ];

  const steps: Step[] = flow.map((index) => ({
    name: short && index === 3 ? "Решения" : STEPS[index],
    // Полоса закрашена только до текущего шага: вернулся назад - полоса вернулась вместе с тобой.
    // Шаги, где человек уже был, остаются нажимаемыми, но не выглядят пройденными.
    state: index === step ? "now" : index < step ? "done" : open(index) ? "next" : "locked",
  }));
  const title = (short && SHORT_TITLES[step]) || TITLES[step];

  return (
    <div className="u-page">
      <Header steps={steps} onPickStep={(position) => goTo(flow[position])} />

      <main className="u-main u-wrap is-wizard">
        {/* На шаге экономики заголовок экрана это ответ словами (h1 в сводке). Пока его нет, стоит
            обычный заголовок шага: фокусу при смене шага есть куда встать */}
        {(step !== LAST || !result?.feasible) && <Hero title={title.title} lead={title.lead} compact={step > 0} />}

        {/* На следующих шагах справочник или план не пришли: введенное в браузере, перезагрузка его вернет */}
        {step > 0 && catalogError && <ServerDown what={catalogError} onRetry={() => window.location.reload()} />}

        {step === 0 &&
          (catalogError ? (
            <ServerDown what={catalogError} onRetry={loadFacilities} />
          ) : facilities.length === 0 ? (
            <p className="muted">Получаем список объектов...</p>
          ) : (
            <ChooseFacility
              facilities={facilities}
              facilityId={facilityId}
              taskIds={taskIds}
              onPickFacility={pickFacility}
              onToggleTask={toggleTask}
              zone={
                picking && zoneRate !== null && zoneM2 !== null
                  ? {
                      share: zoneRate,
                      areaM2: overrides[`facilities.${facilityId}.active_area_m2`] ?? facility?.active_area_m2 ?? 0,
                      onChange: (share) => changeParameter(`facilities.${facilityId}.picking_zone_share`, share),
                    }
                  : undefined
              }
            />
          ))}

        {step === 1 && short && (
          <Parameters
            parameters={parameters}
            overrides={overrides}
            onChange={changeParameter}
            place={facilityId === "airport" ? "свой аэропорт" : "свою больницу"}
            dataset
          />
        )}

        {step === 1 && !short && (
          <>
            <ImportFile
              facilityId={facilityId}
              taskIds={taskIds}
              overrides={overrides}
              staff={staff}
              onApply={(fromFile, lines) => {
                setOverrides((current) => ({ ...current, ...fromFile }));
                // пустой штат из файла не стирает введенный: сервер и так не присылает его без строк
                if (lines && lines.length > 0) {
                  touchStaff();
                  setStaff(lines);
                }
              }}
            />
            <Parameters parameters={parameters} overrides={overrides} onChange={changeParameter} />
            <Staff
              roles={roles}
              lines={staff}
              review={staffReview}
              onChange={editStaff}
              onAdd={addStaff}
              onRemove={removeStaff}
              note={staffTouched ? "" : staffNote}
              onRescale={(lines) => {
                setStaff(lines);
                setStaffBasis(basisNow());
              }}
              onKeep={() => setStaffBasis(basisNow())}
              required={requiredRoles}
            />
          </>
        )}

        {step === 2 && (
          <PlanObject
            templates={templates}
            rackTypes={rackTypes}
            plan={plan}
            measures={measures}
            refused={planRefused}
            withStations={tasks.some((task) => task.takeover === "speedup")}
            zoneM2={zoneM2}
            areaM2={overrides[`facilities.${facilityId}.active_area_m2`] ?? facility?.active_area_m2 ?? null}
            answers={answers}
            chosen={planChosen}
            onChosen={setPlanChosen}
            onPickTemplate={(templateId, custom) => {
              if (custom) {
                answersRef.current = custom;
                setAnswers(custom);
              }
              buildPlan(templateId, custom);
            }}
            onChangePlan={setPlan}
          />
        )}

        {step === 3 && !short && (
          <ChooseSolutions
            tasks={picked.map((one) => ({
              id: one.id,
              name: one.name,
              solutions: solutions[one.id] ?? [],
              picks: one.picks,
              needsStations: tasks.find((task) => task.id === one.id)?.takeover === "speedup",
            }))}
            planReady={planFitsPicking(plan?.template)}
            active={shownTask}
            onActive={setActiveTask}
            onPick={setFirst}
            onUnpick={unpick}
            onAdd={addSecond}
            onShare={setShare}
            onDrop={dropSecond}
            budget={budget}
            onBudget={setBudget}
            fits={budgetFits[fitKey]}
          />
        )}

        {step === 3 && short && facility && (
          <FacilitySolutions facility={facility} tasks={tasks} answer={facilityAnswer} />
        )}

        {step === 4 && (
          <Economics
            parameters={parameters}
            overrides={overrides}
            onChangeParameter={changeParameter}
            result={result}
            request={request}
            loading={loading}
            error={error}
            trouble={trouble}
            onFix={goTo}
            onRetry={() =>
              trouble?.kind === "payment"
                ? setOverrides(withoutPayment)
                : trouble?.kind === "robot"
                  ? setOverrides(withoutRobot)
                  : calculate()
            }
            excluded={excludedTasks}
            budget={budget}
            onExclude={(id, off) =>
              setExcluded((current) => (off ? [...new Set([...current, id])] : current.filter((one) => one !== id)))
            }
            facilityId={facilityId}
            tasks={countedTasks.flatMap((one) =>
              // по части на решение задачи; у старого проекта с двумя задачами решение одно
              one.picks.map((pick) => ({
                operationId: one.id,
                name: one.name,
                robotId: pick.robotId,
                robotName: shortName(solutions[one.id] ?? [], pick.robotId),
                share: pick.share,
              })),
            )}
            plan={plan}
            measures={measures}
            rackTypes={rackTypes}
            onEditPlan={() => goTo(2)}
            onRobotZone={() => {
              // та же кнопка, что на шаге плана: начерченный руками план там спросит, стирать ли
              if (!plan?.edited) {
                buildPlan("robot_zone");
                setPlanChosen(true);
              }
              goTo(2);
            }}
            onChangePlan={setPlan}
          />
        )}

        <ActionBar
          summary={
            step === LAST && exportError ? (
              exportError
            ) : step === LAST && exporting ? (
              `Собираем ${exporting === "pdf" ? "отчет" : "таблицы"}: сервер считает заново вместе со сменой, до полуминуты`
            ) : step === LAST && askLogin ? (
              "Сохранить расчет в проект можно после входа. Расчет перенесем в новый проект, введенное не пропадет."
            ) : step === LAST && saveError ? (
              saveError
            ) : step === LAST &&
              savedAs &&
              savedAs.key === JSON.stringify(request) &&
              link?.version === savedAs.version ? (
              <span className="u-saved">
                <Tick />
                <span>
                  {link.copied ? "Ссылка скопирована: " : "Ссылка на расчет: "}
                  <a href={link.url} target="_blank" rel="noreferrer">
                    {link.url.replace(/^https?:\/\//, "")}
                  </a>
                </span>
              </span>
            ) : step === LAST && savedAs && savedAs.key === JSON.stringify(request) ? (
              <span className="u-saved">
                <Tick />
                {/* одним куском: в полосе с гибкой раскладкой иначе каждое слово встает своей колонкой */}
                <span>
                  <span title={`Проект «${projectTitle}»`}>Сохранено, версия</span> <b>{savedAs.version}</b> ·{" "}
                  <a href="/projects">в кабинете</a>
                </span>
              </span>
            ) : step === LAST && role === "guest" && result && !trouble ? (
              // гостю прямо говорим, что доступно без входа: файлы да, проект нет
              "Без входа: отчет PDF и таблицы Excel скачиваются сразу. Сохранить в проект можно после входа"
            ) : step === LAST && projectId ? (
              `Проект «${projectTitle}»: правки сохранятся новой версией`
            ) : (
              // пока сервер молчит, дальше идти не с чем: говорим об этом, а не "выберите задачу"
              (catalogError ? "Сервер не отвечает, ждем его" : summaries[step]) ||
              "Значения по умолчанию: поправьте их под свой объект"
            )
          }
        >
          {step > 0 && (
            <Button kind="ghost" onClick={() => goTo(previous)}>
              Назад
            </Button>
          )}
          {next === undefined && step < LAST ? null : step === LAST - 1 &&
            nextTask &&
            picked.find((one) => one.id === shownTask)?.solution ? (
            // задачи идут по очереди: выбрали для одной, кнопка ведет к следующей без решения
            <Button
              arrow
              onClick={() => {
                setActiveTask(nextTask.id);
                window.scrollTo({ top: 0, behavior: "instant" });
              }}
            >
              Дальше: {nextTask.name.toLowerCase()}
            </Button>
          ) : step === LAST - 1 ? (
            <Button
              arrow
              disabled={!closed[step] || !!catalogError}
              // почему кнопка недоступна, при наведении: то же, что в полосе слева, но у самой кнопки
              title={
                catalogError
                  ? "Сервер не ответил, подбор решений не пришел"
                  : left.length > 0
                    ? taskIds.length > 1
                      ? `Сначала выберите решение: ${left.map((one) => one.name.toLowerCase()).join(", ")}`
                      : "Сначала выберите решение из списка"
                    : undefined
              }
              onClick={startCalculation}
            >
              Начать подсчет
            </Button>
          ) : step < LAST ? (
            <Button arrow disabled={!closed[step] || !!catalogError} onClick={() => goTo(next)}>
              Дальше: {(short && next === 3 ? "решения" : STEPS[next]).toLowerCase()}
            </Button>
          ) : trouble ? (
            // расчета нет: файлы и сохранение выключены, главная кнопка ведет туда, где причина
            <span className="u-action-end">
              <ActionMore label="Файлы">
                <Button kind="light" disabled title="Файлы собираются из готового расчета">
                  <span>
                    <span className="u-wide">Таблицы </span>Excel
                  </span>
                </Button>
                <Button kind="light" disabled title="Отчет собирается из готового расчета">
                  <span>
                    <span className="u-wide">Отчет </span>PDF
                  </span>
                </Button>
              </ActionMore>
              {/* на телефоне выключенную кнопку прячем: полоса не вмещает четыре кнопки */}
              <span className="u-wide-hide">
                <Button kind="light" disabled title="Сохранять пока нечего: расчет не сошелся">
                  Сохранить в проект
                </Button>
              </span>
              <Button
                arrow
                onClick={() =>
                  trouble.kind === "payment"
                    ? setOverrides(withoutPayment)
                    : trouble.kind === "robot"
                      ? setOverrides(withoutRobot)
                      : trouble.step === null
                        ? calculate()
                        : goTo(trouble.step)
                }
              >
                {trouble.action}
              </Button>
            </span>
          ) : (
            <span className="u-action-end">
              <ActionMore label="Файлы">
                <Button
                  kind="light"
                  disabled={exporting !== null || !upToDate}
                  title={role === "guest" ? "Доступно без входа" : undefined}
                  onClick={() => download("xlsx")}
                >
                  <span>
                    <span className="u-wide">Таблицы </span>Excel
                  </span>
                </Button>
                <Button
                  kind="light"
                  disabled={exporting !== null || !upToDate}
                  title={role === "guest" ? "Доступно без входа" : undefined}
                  onClick={() => download("pdf")}
                >
                  <span>
                    <span className="u-wide">Отчет </span>PDF
                  </span>
                </Button>
              </ActionMore>
              {savedAs && savedAs.key === JSON.stringify(request) ? (
                // сохранено и с тех пор не менялось: сохранять то же еще раз незачем, а поделиться можно
                <Button arrow onClick={() => void share()}>
                  Поделиться
                </Button>
              ) : (
                <Button arrow disabled={saving || !upToDate} onClick={() => void save()}>
                  {saving ? "Сохраняем..." : projectId ? "Сохранить новую версию" : "Сохранить в проект"}
                </Button>
              )}
            </span>
          )}
        </ActionBar>
      </main>

      <Footer />
    </div>
  );
}

// На вход или регистрацию и обратно. Введенное лежит в браузере, ответ сервера в хранилище
// вкладки, а метка SAVE_AFTER_LOGIN сохраняет расчет в проект, как только он снова готов
function login(register = false) {
  try {
    window.localStorage.setItem(SAVE_AFTER_LOGIN, String(Date.now()));
  } catch {
    // без хранилища просто не сохраним сами: человек нажмет «Сохранить» еще раз
  }
  const back = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(back)}${register ? "#register" : ""}`);
}

// Решения задачи словами: «Ronavi H1500» или «Ronavi H1500 70% + AMR 800 30%»
function pickedWords(
  one: { id: string; picks: { robotId: string; share: number }[] } | undefined,
  solutions: Record<string, Solution[]>,
): string {
  if (!one || one.picks.length === 0) return "";
  const list = solutions[one.id] ?? [];
  if (one.picks.length === 1) return shortName(list, one.picks[0].robotId);
  return one.picks.map((pick) => `${shortName(list, pick.robotId)} ${Math.round(pick.share * 100)}%`).join(" + ");
}

// Штат по умолчанию приходит с источником: пользователю он нужен, расчету нет.
function strip(line: StaffLine & { role_name?: string; source?: string; trust?: string }): StaffLine {
  const { id, role, headcount, filled, salary_month, contractor } = line;
  return { id, role, headcount, filled, salary_month, contractor };
}

// Задач стало больше: добавляем строки новых ролей и не трогаем то, что человек уже ввел.
function merge(current: StaffLine[], defaults: StaffLine[]): StaffLine[] {
  const added = defaults.filter((line) => !current.some((mine) => mine.role === line.role)).map(strip);
  return [...current, ...added];
}
