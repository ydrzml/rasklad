import { planFitsPicking, zoneArea } from "./peak";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type CustomAnswers,
  type Direction,
  type Plan,
  type PlanMeasures,
  type PlanTemplate,
  type RackType,
  type Wall,
} from "../../api/client";
import {
  Alert,
  ask,
  Badge,
  BlockHead,
  Button,
  Check,
  Checks,
  FieldPair,
  IconButton,
  Legend,
  Meter,
  Select,
  Modes,
  Tool,
  ToolCard,
  ToolGroup,
  Tools,
  Tour,
  TourOffer,
  type TourStep,
  tourSeen,
  toursOff,
  tourWanted,
} from "../../ui";
import { number } from "../format";
import { type ColorBy, Editor, type Mode, type Tool as ToolName } from "../plan/Editor";
import { Corners } from "../plan/Corners";
import { bounds, cellsOf, floorTone, frameOf, type Point, routeAlpha, signed } from "../plan/geometry";
import { DEMOS, LEVEL_SCENE } from "../plan/demos";
import { MOVES } from "../plan/ItemWindow";
import { turnOf } from "../plan/outline";
import { fitNote as noteOf, fitToBuilding, readFile, straighten, useUnderlay } from "../plan/underlay";
import { View3d } from "../plan/View3d";

type Props = {
  templates: PlanTemplate[];
  rackTypes: RackType[];
  plan: Plan | null;
  measures: PlanMeasures | null;
  /* сервер не принял план при замере: причина его словами. Пусто: принял */
  refused?: string;
  withStations: boolean;
  /* площадь робозоны под отбор, м²: по ней считаем отбор, если план под погрузчик. Пусто: отбора нет */
  zoneM2?: number | null;
  /* площадь зоны работы роботов, м²: из нее размеры здания в анкете, когда стоит робозона */
  areaM2?: number | null;
  /* ответы анкеты «Свой склад», если план строили по ней */
  answers: CustomAnswers | null;
  /* человек уже выбрал, откуда взять план: до этого показываем три пути, а не чертеж */
  chosen: boolean;
  onChosen: (chosen: boolean) => void;
  onPickTemplate: (templateId: string, custom?: CustomAnswers) => void;
  onChangePlan: (plan: Plan) => void;
};

const OWN = "custom";
const ROBOT_ZONE = "robot_zone";
// строка проверок про отбор: она поясняет, а не просит поправить план, поэтому в "Осталось" не идет
const PICKING_CHECK = "План под отбор";
// проезд уже 2,5 м погрузчику не годится (ему нужно от 3 м), значит зона под роботов

// Нарисованное пропадет: спрашиваем окном набора, фокус на отмене
const askErase = (title: string, yes: string) =>
  ask({ title, text: "Все, что вы начертили, пропадет.", yes, danger: true });

// Шаг 3. Сначала пусто: человек выбирает, откуда взять план. Типовая схема потока, если
// не хочется заполнять; анкета «Свой склад» с размерами, стенами с воротами и рядами; фото
// своего плана, по которому программа сама находит контур здания и кладет картинку под лист.
//
// Дальше редактор, как строительный режим в игре. «Здание» складывает склад из секций,
// «Обстановка» ставит на пол зоны хранения, ворота, буферы, пандусы и перегородки.
//
// Считает сервер. После каждой правки план уходит на /api/plan/measure, и числа под листом
// приходят оттуда вместе с местом для зарядки: ее ставит программа, а не человек.
export function PlanObject({
  templates,
  rackTypes,
  plan,
  measures: measured,
  refused = "",
  withStations,
  zoneM2 = null,
  areaM2 = null,
  answers,
  chosen,
  onChosen,
  onPickTemplate,
  onChangePlan,
}: Props) {
  // Отказ сервера стоит в проверках красной строкой, как любая другая причина: иначе на листе
  // висели бы проверки прошлого плана, а человек узнавал бы об отказе только на шаге экономики
  // План под погрузчик при выбранном отборе не ошибка, но и "проверки пройдены" тут вводило бы
  // в заблуждение: отдельная строка говорит, что отбор посчитаем по робозоне
  const zone = zoneArea(zoneM2);
  const fitsPicking = planFitsPicking(plan?.template);
  const measures = useMemo(() => {
    if (!measured) return measured;
    const extra = [
      ...(withStations
        ? [
            {
              label: PICKING_CHECK,
              ok: fitsPicking,
              detail: fitsPicking ? "" : `роботу отбора до станций далеко, отбор посчитаем по робозоне ${zone}`.trim(),
            },
          ]
        : []),
      ...(refused ? [{ label: "Сервер принял план", ok: false, detail: refused }] : []),
    ];
    return extra.length ? { ...measured, checks: [...measured.checks, ...extra] } : measured;
  }, [measured, refused, withStations, fitsPicking, zone]);
  const [mode, setMode] = useState<Mode>("furnish");
  // подложка: картинка с планом под листом, живет в браузере
  const underlay = useUnderlay();
  // картинка ждет, пока сервер построит здание по названным размерам: тогда ее подгоняем к нему
  const [pending, setPending] = useState<string | null>(null);
  const [fitNote, setFitNote] = useState("");
  // углы здания на исходной картинке, пока человек их правит; null значит, что не правит
  const [corners, setCorners] = useState<Point[] | null>(null);
  // углы открыла сама программа: она не уверена, какой из двух похожих контуров здание
  const [doubt, setDoubt] = useState(false);
  // какая сторона картинки ляжет верхом листа: четверти поворота по часовой
  const [turn, setTurn] = useState(0);
  const [tool, setTool] = useState<ToolName>("select");
  const [picked, setPicked] = useState("");
  const [colorBy, setColorBy] = useState<ColorBy>("level");
  const [solid, setSolid] = useState(false);
  const [past, setPast] = useState<Plan[]>([]);
  const [future, setFuture] = useState<Plan[]>([]);
  const narrow = useNarrow();
  // лист на весь экран: на ноутбуке он иначе в 410 точек высотой
  const [wantFull, setFull] = useState(false);
  // на телефоне лист только смотрят, там на весь экран не нужно
  const full = wantFull && !narrow;
  useEffect(() => {
    if (!full) return;
    const quit = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setFull(false);
    };
    document.addEventListener("keydown", quit);
    document.body.classList.add("u-no-scroll");
    return () => {
      document.removeEventListener("keydown", quit);
      document.body.classList.remove("u-no-scroll");
    };
  }, [full]);
  const deltas = useDeltas(measures, Boolean(plan?.edited));
  // обучение: при первом входе на чертеж само, потом по кнопке "Как пользоваться"
  const [tourOn, setTourOn] = useState<boolean | null>(null);
  // какое обучение открыто: основы с практикой, выбор пути или все инструменты
  const [tourKind, setTourKind] = useState<"basics" | "choice" | "tools">("basics");
  // шаги "с чего начать": какой картинке человек сказал "все совпало", на каком плане список убрали,
  // и на каком он остается, хотя план уже не пустой
  const [outlineOk, setOutlineOk] = useState("");
  // обучение с какого шага: 0 с начала, после объяснения сразу практика
  const [tourStart, setTourStart] = useState(0);
  // открытый шаг обучения: по нему подсвечиваем нужный инструмент
  const [tourAt, setTourAt] = useState(-1);
  // Практика на готовом плане: что на нем стояло до начала (шаг засчитывается, когда вещей стало
  // больше) и сам план, он вернется после практики
  const [practiceFrom, setPracticeFrom] = useState<{
    plan: Plan;
    count: Record<string, number>;
    restore: boolean;
  } | null>(null);
  // план только что построили любым из трех способов: спрашиваем, хочет ли человек практику
  const [askPractice, setAskPractice] = useState(false);
  // карточка взятого инструмента и ее высота: вровень с кнопкой инструмента слева
  const [tip, setTip] = useState<{ tool: ToolName; top: number } | null>(null);
  // "больше не показывать" у каждого инструмента свое: выключили у Рядов, у Ворот карточка осталась
  const [tipsOff, setTipsOff] = useState<string[]>([]);
  const tipWanted = (name: ToolName) => !tipsOff.includes(name) && tourWanted(`${TIPS_KEY}.${name}`);
  const pickTool = (name: ToolName) => {
    setTool(name);
    if (!DEMOS[name]) return setTip(null);
    // кнопка инструмента подсветится после отрисовки: тогда и меряем, где она стоит
    requestAnimationFrame(() => {
      const on = document.querySelector<HTMLElement>(".u-draft .u-tool.is-on");
      const list = on?.closest<HTMLElement>(".u-tools");
      setTip({ tool: name, top: Math.max(0, (on?.offsetTop ?? 0) - (list?.scrollTop ?? 0) - 8) });
    });
  };
  // после выбора, откуда взять план, чертеж встает на экран целиком
  const scrollHead = useRef(false);
  const headRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || !scrollHead.current) return;
    scrollHead.current = false;
    node.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  // колонка справа от листа: в нее встает окно свойств вместо легенды
  const [side, setSide] = useState<HTMLDivElement | null>(null);
  // что покажут числа, если отпустить объект: сервер считает план, который еще не положили
  const preview = useCallback(
    (next: Plan) =>
      api
        .planMeasure(next)
        .then((answer) => answer.measures)
        .catch(() => null),
    [],
  );

  const put = underlay.put;
  // какую картинку уже взяли в работу: эффект не должен подгонять ее дважды
  const fitting = useRef<string | null>(null);
  useEffect(() => {
    if (!pending || !plan || plan.template !== OWN || plan.edited || fitting.current === pending) return;
    const hall = bounds(cellsOf(plan));
    if (!hall) return;
    const src = pending;
    fitting.current = src;
    fitToBuilding(src, hall)
      .then((fit) => {
        setPending(null);
        put(fit.underlay);
        setFitNote(noteOf(fit));
        // не уверены, какой из двух контуров здание: сразу показываем углы, пусть человек глянет
        if (fit.unsure && !narrow && fit.underlay.corners) {
          setCorners(fit.underlay.corners);
          setTurn(fit.underlay.turn ?? turnOf(fit.underlay.corners));
          setDoubt(true);
        }
      })
      .catch(() => setFitNote("Не удалось прочитать картинку. PDF сначала сохраните как картинку"));
  }, [pending, plan, put, narrow]);

  if (!plan) return <p className="muted">Строим план...</p>;

  const template = templates.find((one) => one.id === plan.template);

  // Другой источник строит план заново, а нарисованное пропадает. Предупреждаем до того,
  // как стереть, а не после.
  const rebuild = async (templateId: string, custom?: CustomAnswers, photo = false): Promise<boolean> => {
    if (plan.edited && !(await askErase("Построить план заново?", "Построить заново"))) return false;
    // старая картинка под новым планом не нужна: у нового плана свои размеры
    if (!photo) {
      put(null);
      setFitNote("");
    }
    setPicked("");
    setPast([]);
    setFuture([]);
    setMode("furnish");
    setTool("select");
    onPickTemplate(templateId, custom);
    scrollHead.current = true;
    setAskPractice(true);
    onChosen(true);
    return true;
  };

  // Анкета начинается с того, что уже есть на плане: размеры и число ворот
  // Робозона под отбор занимает часть склада: здание для анкеты и фото берем со всей площади
  const wholeSide = Math.round(Math.sqrt(areaM2 ?? 0));
  const whole = plan.template === ROBOT_ZONE && wholeSide > 0;
  const start: CustomAnswers = answers ?? {
    width_m: whole ? wholeSide : (measures?.width_m ?? plan.width_m),
    length_m: whole ? wholeSide : (measures?.length_m ?? plan.length_m),
    docks: [{ wall: "west", count: Math.max(1, measures?.docks ?? 4) }],
    racks: "across",
  };

  const fromPhoto = (file: File, size: { width_m: number; length_m: number }) => {
    readFile(file)
      .then(async (src) => {
        if (!(await rebuild(OWN, { ...size, docks: [], racks: "none" }, true))) return;
        put(null);
        setFitNote("");
        // ту же картинку после «начать заново» подгоняем снова: у здания могли стать другие размеры
        fitting.current = null;
        setPending(src);
      })
      .catch(() => window.alert("Не удалось прочитать файл"));
  };

  if (!chosen)
    return (
      <Start
        templates={templates}
        withStations={withStations}
        start={start}
        onTemplate={(id) => void rebuild(id)}
        onOwn={(custom) => void rebuild(OWN, custom)}
        onPhoto={fromPhoto}
      />
    );

  // Инструменты по группам: хранение, ворота, движение. Линия движения в самом конце: она
  // нужна редко, чаще хватает змейки у зоны хранения. Клавиши идут по порядку в списке
  const furnishGroups: { title: string; tools: ToolName[] }[] = [
    { title: "", tools: ["select"] },
    {
      title: "Хранение",
      tools: withStations ? ["row", "racks", "aisle", "station"] : ["row", "racks", "aisle"],
    },
    { title: "Ворота", tools: ["dock", "buffer"] },
    { title: "Движение", tools: ["blocked", "nogo", "ramp", "flow"] },
  ];
  const groups =
    mode === "build" ? [{ title: "Пол и стены", tools: ["hall", "outline", "hole"] as ToolName[] }] : furnishGroups;
  const order: ToolName[] = groups.flatMap((group) => group.tools);

  // Отметки пола и потолки в здании: их показывает легенда, а меняют в свойствах секции
  const levels = cellsOf(plan).levels;
  const heights = levels.map((one) => one.floor_m);
  // границы ступеней слоя «далеко от ворот» считает сервер, здесь только подписи
  const bands = measures?.route_map.bands_m ?? [];

  // следующий шаг плана для строки под листом и подсвеченный инструмент
  const next = mode === "furnish" ? nextStep(plan, measures, Boolean(underlay.value), order) : null;

  const switchMode = (next: Mode) => {
    setMode(next);
    setTool(next === "build" ? "hall" : "select");
    setPicked("");
    setSolid(false);
    setCorners(null);
    setDoubt(false);
  };

  // Режимы здания и обстановки стоят над инструментами, которые они меняют
  const modeSwitch = (
    <>
      <Modes
        label="Режим чертежа"
        value={mode}
        options={[
          { id: "build", name: "Здание", hint: "Пол, стены и контур здания" },
          { id: "furnish", name: "Обстановка", hint: "Стеллажи, ворота, проезды: то, что стоит на полу" },
        ]}
        onChange={switchMode}
      />
      <p className="u-modes-note">
        {mode === "build" ? "Пол, стены и контур здания" : "Стеллажи, ворота и проезды на полу"}
      </p>
    </>
  );

  // Каждая правка кладет прежний план в историю: Ctrl+Z возвращает его целиком.
  // relay: у зоны лежала змейка, а ряды встали иначе. Полосы кладет заново сервер, и это та же
  // правка: отмена вернет план до нее одним шагом
  const commit = (next: Plan, relay?: string) => {
    setPast([...past.slice(-60), plan]);
    setFuture([]);
    onChangePlan(next);
    if (relay) {
      const lanes = next.items.filter((one) => one.kind === "flow" && one.id.startsWith(`${relay}-flow-`));
      const first = lanes.find((one) => one.id === `${relay}-flow-0`)?.direction ?? "";
      api
        .planSerpentine(next, relay, first as Direction | "")
        .then((answer) => onChangePlan(answer.plan))
        .catch(() => undefined);
    }
  };
  // Змейку кладет сервер: полосы по всем проездам зоны, в соседних в разные стороны
  const serpentine = (zone: string, first?: Direction) => {
    api
      .planSerpentine(plan, zone, first ?? "")
      .then((answer) => commit({ ...answer.plan, edited: true }))
      .catch(() => window.alert("Не удалось положить змейку: сервер не ответил"));
  };
  const undo = () => {
    const last = past.at(-1);
    if (!last) return;
    setPast(past.slice(0, -1));
    setFuture([plan, ...future]);
    onChangePlan(last);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture(future.slice(1));
    setPast([...past, plan]);
    onChangePlan(next);
  };

  const hall = bounds(cellsOf(plan));
  const refit = () => {
    if (!underlay.value || !hall) return;
    fitToBuilding(underlay.value.source ?? underlay.value.src, hall).then((fit) => {
      put({ ...fit.underlay, opacity: underlay.value?.opacity ?? fit.underlay.opacity });
      setFitNote(noteOf(fit));
      if (fit.unsure && !narrow && fit.underlay.corners) {
        setCorners(fit.underlay.corners);
        setTurn(fit.underlay.turn ?? turnOf(fit.underlay.corners));
        setDoubt(true);
      }
    });
  };

  // Углы здания на исходной картинке. У подложки, положенной до выпрямления, их нет: тогда
  // считаем, где на картинке стоит здание сейчас
  const editCorners = () => {
    const u = underlay.value;
    if (!u || !hall) return;
    const top = (u.y + u.h - hall.y - hall.h) / u.h;
    const bottom = (u.y + u.h - hall.y) / u.h;
    const left = (hall.x - u.x) / u.w;
    const right = (hall.x + hall.w - u.x) / u.w;
    const found = u.corners ?? [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
    setCorners(found);
    setTurn(u.turn ?? turnOf(found));
    setSolid(false);
    setPicked("");
    setDoubt(false);
  };
  // Контур на фото готов: картинка выпрямляется по нему, а пол здания становится этим контуром.
  // Рамку контура берем по названным размерам, поэтому здание остается того размера, что назвали
  const applyCorners = () => {
    const u = underlay.value;
    if (!u || !hall || !corners) return;
    straighten(u.source ?? u.src, corners, hall, u.opacity, turn).then(({ outline, ...next }) => {
      put({ ...next, found: true });
      setOutlineOk(u.source ?? u.src);
      const main = plan.sections.find((one) => !one.hole);
      if (main && outline.length >= 3)
        commit({
          ...plan,
          sections: plan.sections.map((one) =>
            one.id === main.id ? { ...one, ...frameOf(outline), points: outline } : one,
          ),
        });
      setFitNote(
        corners.length > 4
          ? `Здание обведено по фото: контур из ${corners.length} точек, картинка выпрямлена по нему`
          : "Картинка выпрямлена по углам, которые вы поставили",
      );
      setCorners(null);
      setDoubt(false);
    });
  };

  // Практика после обучения, на любом плане. Шаг засчитывается по тому, что стоит на плане: вещей
  // этого вида стало больше, чем было, когда практика началась. На пустом листе это просто "есть"
  const photoSrc = underlay.value ? (underlay.value.source ?? underlay.value.src) : "";
  const count = (kind: string) => plan.items.filter((item) => item.kind === kind).length;
  const has = (kind: string) => count(kind) > 0;
  const empty = !has("racks") && !has("dock");
  const base = practiceFrom?.count ?? {};
  const grew = (kind: string) => count(kind) > (base[kind] ?? 0);
  // на готовом плане места мало: ставим один ряд, а не зону
  const rowTool: ToolName = practiceFrom?.restore ? "row" : "racks";
  const practiceSteps: TourStep[] = [
    ...(photoSrc
      ? [
          {
            target: ".u-draft-main",
            title: "Сверьте стены",
            text: "Проверьте, что стены здания легли на стены картинки. Не совпали: нажмите «Обвести контур» справа и поставьте точки на углы.",
            practice: { done: outlineOk === photoSrc },
          },
        ]
      : []),
    {
      target: ".u-draft-main",
      title: rowTool === "row" ? "Поставьте ряд" : "Поставьте ряды",
      text:
        rowTool === "row"
          ? "Возьмите «Ряд» в колонке слева и протяните один ряд стеллажей на свободном месте."
          : photoSrc
            ? "Возьмите «Ряды» в колонке слева и протяните прямоугольник поверх рядов на картинке."
            : "Возьмите «Ряды» в колонке слева и протяните прямоугольник по полу там, где у вас стеллажи.",
      practice: { done: grew("racks") },
    },
    {
      target: ".u-draft-main",
      title: "Поставьте ворота",
      text: "Возьмите «Ворота» в колонке слева и ведите вдоль наружной стены там, где ворота стоят у вас.",
      practice: { done: grew("dock") },
    },
    {
      target: ".u-draft-main",
      title: "Поставьте буфер",
      text: "Буфер это площадка у ворот, где груз ждет приемки или отгрузки. Возьмите «Буфер у ворот» слева и протяните вплотную к воротам.",
      practice: { done: grew("buffer") },
    },
    {
      target: ".u-draft-main",
      title: "Посмотрите проверки",
      text: practiceFrom?.restore
        ? "Под листом числа, которые уйдут в подбор роботов, и проверки плана. После «Готово» ваш план вернется таким, каким был до практики."
        : "Под листом числа, которые уйдут в подбор роботов, и проверки плана. Непройденная говорит, что поправить.",
      practice: {
        done:
          Boolean(measures) &&
          has("racks") &&
          has("dock") &&
          measures!.checks.every((check) => check.ok || check.label === PICKING_CHECK),
      },
    },
  ];
  // какой инструмент ждет шаг практики: его рамка в колонке слева пульсирует
  const waits: (ToolName | null)[] = [...(photoSrc ? [null] : []), rowTool, "dock", "buffer", null];
  const tourSteps: TourStep[] = [
    ...TOUR.slice(0, -1),
    { ...TOUR[TOUR.length - 1], next: "Теперь попробуйте" },
    ...practiceSteps,
  ];
  // практика началась: запоминаем, что стояло на плане, и сам план
  const beginPractice = () => {
    if (practiceFrom) return;
    const now: Record<string, number> = {};
    for (const item of plan.items) now[item.kind] = (now[item.kind] ?? 0) + 1;
    // пустой лист человек собирает на практике для себя, его не откатываем
    setPracticeFrom({ plan, count: now, restore: !empty });
  };
  // Практика кончилась. На готовом плане возвращаем его, каким он был: практика не должна портить
  // план человека. Возврат это обычная правка, Ctrl+Z вернет поставленное на практике
  const endPractice = () => {
    if (practiceFrom?.restore && practiceFrom.plan !== plan) commit(practiceFrom.plan);
    setPracticeFrom(null);
  };

  // на телефоне чертеж только смотрят, учить там нечему
  const tourShown = !narrow && (tourOn ?? tourWanted(TOUR_KEY));
  // Все инструменты: шаг на кнопку, подсвечена сама кнопка, в карточке ее сценка. На шагах здания
  // режим переключается сам, чтобы кнопка была на экране
  const toolStep = (name: ToolName, inMode: Mode, title?: string, text?: ReactNode, scene?: ReactNode) => ({
    step: {
      target: `[data-tool="${TOOL_NAMES[name]}"]`,
      title: title ?? TOOL_NAMES[name],
      text: text ?? (
        <>
          {DEMOS[name]?.text} {DEMOS[name]?.edit}
        </>
      ),
      scene: scene ?? DEMOS[name]?.scene,
    },
    mode: inMode,
  });
  const allTools: { step: TourStep; mode: Mode | null }[] = [
    toolStep(
      "hall",
      "build",
      undefined,
      "Пол здания. Щелчок выбирает здание: тяните углы и стены, размеры числами справа. Протяжка поверх зала кладет секцию, это часть пола со своей отметкой.",
    ),
    toolStep(
      "hall",
      "build",
      "Отметка пола",
      "Чтобы поднять часть склада, протяните секцию поверх зала и поставьте ей отметку пола и потолок в окне справа: так делают антресоль или рампу. На поднятую часть робот попадет только по пандусу.",
      LEVEL_SCENE,
    ),
    toolStep("outline", "build"),
    toolStep("hole", "build"),
    toolStep("row", "furnish"),
    toolStep("racks", "furnish"),
    toolStep(
      "racks",
      "furnish",
      "Тип стеллажа",
      "Первый выбор в окне рядов справа. Он решает, кто работает в зоне: в набивной и мобильный блок робот не заезжает, стеллажи для робота он сам возит к станции.",
    ),
    toolStep("aisle", "furnish"),
    ...(withStations ? [toolStep("station", "furnish")] : []),
    toolStep("dock", "furnish"),
    toolStep("buffer", "furnish"),
    toolStep("blocked", "furnish"),
    toolStep("nogo", "furnish"),
    toolStep("ramp", "furnish"),
    toolStep("flow", "furnish"),
    {
      step: {
        target: ".u-draft > .u-side .u-modes",
        title: "Цвет на плане",
        text: "«Высота пола» красит поднятые части склада, «Путь до ворот» каждую клетку по длине пути до буфера у ворот: темнее значит дальше, красные клетки недоступны.",
      },
      mode: null,
    },
    ...(underlay.value
      ? [
          {
            step: {
              target: ".u-draft > .u-side",
              title: "Фото плана",
              text: "Картинка лежит под чертежом. Прозрачность ползунком, «Обвести контур» ставит точки на углы здания и выпрямляет картинку, «Найти заново» ищет стены еще раз, «Убрать» снимает картинку.",
            },
            mode: null,
          },
        ]
      : []),
  ];
  // Выбор пути по кнопке "Как пользоваться": основы с практикой или все инструменты
  const choice: TourStep[] = [
    {
      target: ".u-draft",
      title: "Как хотите разобраться?",
      text: "Чертеж нужен, чтобы посчитать маршрут робота. Выберите, с чего начать, вернуться можно этой же кнопкой.",
      next: "Разберусь сам",
      choices: [
        {
          label: "Основы",
          note: "Режимы, как двигаться по листу, выбрать и отменить, план и объем, числа и проверки, потом практика",
          size: `${TOUR.length} шагов`,
          run: () => {
            setTourKind("basics");
            setTourStart(0);
          },
        },
        {
          label: "Все инструменты",
          note: "По шагу на каждую кнопку: здание, отметка пола, контур, вырез, ряды, ворота, пандус и остальные",
          size: `${allTools.length} шагов`,
          run: () => {
            setTourKind("tools");
            setTourStart(0);
          },
        },
      ],
    },
  ];
  const shownSteps =
    tourKind === "choice" ? choice : tourKind === "tools" ? allTools.map((one) => one.step) : tourSteps;

  // на практике рамку ставит только шаг обучения: обычная подсказка "дальше" обводила бы другой инструмент
  const practicing = tourShown && tourKind === "basics" && tourAt >= TOUR.length;
  // шаг сделан: рамка гаснет, пульсирует уже "Дальше" в карточке
  const waiting = practicing && !tourSteps[tourAt]?.practice?.done ? waits[tourAt - TOUR.length] : null;
  // Обучение уже прошли или закрыли, а план только что построили любым способом: спрашиваем про практику
  const offerShown =
    !narrow &&
    !tourShown &&
    !toursOff() &&
    askPractice &&
    tourWanted(PRACTICE_KEY) &&
    mode === "furnish" &&
    !solid &&
    !corners;

  const origin = underlay.value
    ? "План по вашему фото"
    : plan.template === OWN
      ? "План по вашей анкете"
      : `Типовая схема «${template?.name ?? plan.template}»`;
  const size = measures ? `${number(measures.width_m, 0)} × ${number(measures.length_m, 0)} м` : "";

  const bad = measures ? measures.checks.filter((check) => !check.ok).length : 0;
  // Начать заново значит стереть начерченное сразу, а не только показать три способа: иначе
  // выбор способа снова спрашивал, стирать ли, и после отказа оставался старый план
  const restart = async () => {
    if (plan.edited && !(await askErase("Начать заново?", "Начать заново"))) return;
    put(null);
    setFitNote("");
    setPicked("");
    setPast([]);
    setFuture([]);
    setMode("furnish");
    setTool("select");
    setCorners(null);
    // план строится заново тем же способом, что и был: чистый, еще не тронутый человеком
    onPickTemplate(plan.template, plan.template === OWN ? (answers ?? undefined) : undefined);
    onChosen(false);
  };

  return (
    <section className="u-drawing">
      {/* Над чертежом одной строкой: что за план, откуда он и как начать с нуля. Кнопки крупные и
          стоят рядом с заголовком, а не ссылкой над ним */}
      <div className="u-plan-head" ref={headRef}>
        <h2>Чертеж склада</h2>
        <p title={underlay.value || plan.template === OWN ? undefined : template?.fits}>
          {origin}
          {size && (
            <>
              , <span className="mono">{size}</span>
            </>
          )}
          {plan.edited ? <Badge tone="blue">план поправлен</Badge> : <Badge>как построила программа</Badge>}
        </p>
        <span className="u-spacer" />
        {!narrow && (
          <Button
            kind="light"
            onClick={() => {
              setTourKind("choice");
              setTourStart(0);
              setTourOn(true);
            }}
          >
            Как пользоваться
          </Button>
        )}
        <Button kind="ghost" onClick={() => void restart()}>
          Начать заново
        </Button>
      </div>

      {/* Отбор с роботом, который везет стеллаж к человеку, на плане под погрузчик считаем по
          робозоне: ряды стоят под погрузчик, и до станций в разы дальше. Это не ошибка плана, а
          пояснение, поэтому строка спокойная: паллеты и уборка идут по этому плану */}
      {withStations && !fitsPicking && (
        <div className="u-plan-warn">
          <Alert tone="note">Для отбора нужна робозона: стеллажи вплотную, станции рядом</Alert>
          <Button kind="ghost" onClick={() => void rebuild(ROBOT_ZONE)}>
            Перейти на робозону
          </Button>
        </div>
      )}

      <div className={full ? "u-draft is-full" : "u-draft"}>
        <Tools>
          {!narrow && modeSwitch}
          {groups.map((group) =>
            group.title ? (
              <ToolGroup key={group.title} title={group.title}>
                {group.tools.map((name) => toolButton(name))}
              </ToolGroup>
            ) : (
              group.tools.map((name) => toolButton(name))
            ),
          )}
        </Tools>

        {tip && tip.tool === tool && tipWanted(tip.tool) && !tourShown && DEMOS[tip.tool] && (
          <ToolCard
            key={tip.tool}
            title={DEMOS[tip.tool]!.title}
            hotkey={String(order.indexOf(tip.tool) + 1)}
            text={DEMOS[tip.tool]!.text}
            edit={DEMOS[tip.tool]!.edit}
            tip={DEMOS[tip.tool]!.tip}
            scene={DEMOS[tip.tool]!.scene}
            top={tip.top}
            onClose={() => setTip(null)}
            onNever={() => {
              tourSeen(`${TIPS_KEY}.${tip.tool}`);
              setTipsOff([...tipsOff, tip.tool]);
            }}
          />
        )}

        {/* начали чертить, и карточка инструмента уходит: она нужна до первого движения */}
        <div className="u-draft-main" onPointerDownCapture={() => tip && setTip(null)}>
          {corners && underlay.value && hall ? (
            <Corners
              source={underlay.value.source ?? underlay.value.src}
              corners={corners}
              sides={[hall.w, hall.h]}
              turn={turn}
              onMove={setCorners}
            />
          ) : solid ? (
            <View3d plan={plan} measures={measures} colorBy={colorBy} />
          ) : (
            <Editor
              plan={plan}
              measures={measures}
              mode={mode}
              tool={tool}
              onTool={(next) => {
                pickTool(next);
                if (next !== "select" && next !== "hall") setPicked("");
              }}
              tools={order}
              colorBy={colorBy}
              picked={picked}
              onPick={setPicked}
              onCommit={commit}
              onSerpentine={serpentine}
              onUndo={undo}
              onRedo={redo}
              aisle={template?.aisle_m ?? 3.5}
              fitKey={`${plan.template}:${plan.width_m}:${plan.length_m}`}
              underlay={underlay.value}
              still={narrow}
              rackTypes={rackTypes}
              side={side}
              onPreview={preview}
              next={next?.text}
              hud={
                measures && (
                  <div className="u-hud" aria-live="polite">
                    <HudNumber label="маршрут" value={`${number(measures.route_m, 0)} м`} delta={deltas.route_m} />
                    <HudNumber label="ворот" value={String(measures.docks)} delta={deltas.docks} />
                    <HudNumber label="проездов" value={String(measures.aisles)} delta={deltas.aisles} />
                    {/* проверки видно на самом листе: список под числами на ноутбуке ниже экрана */}
                    <button
                      type="button"
                      className={bad ? "u-hud-check is-bad" : "u-hud-check"}
                      onClick={() =>
                        document.querySelector(".u-plan-foot")?.scrollIntoView({ block: "end", behavior: "smooth" })
                      }
                    >
                      {bad ? `проверок не пройдено: ${bad}` : "проверки пройдены"}
                    </button>
                  </div>
                )
              }
              corner={
                <>
                  {/* отмена и повтор в углу листа, а не отдельной группой: колонка инструментов
                      не должна быть выше листа на экране 768 точек */}
                  <IconButton label="Отменить, Ctrl+Z" onClick={undo}>
                    <path d="M5 3.5L2.5 6 5 8.5M2.5 6h6.5a3.5 3.5 0 0 1 0 7H6" />
                  </IconButton>
                  <IconButton label="Повторить, Ctrl+Shift+Z" onClick={redo}>
                    <path d="M10 3.5L12.5 6 10 8.5M12.5 6H6a3.5 3.5 0 0 0 0 7h3" />
                  </IconButton>
                  <IconButton label={full ? "Свернуть лист, Esc" : "Лист на весь экран"} onClick={() => setFull(!full)}>
                    {full ? (
                      <path d="M5.5 2.5v3h-3M9.5 2.5v3h3M12.5 9.5h-3v3M2.5 9.5h3v3" />
                    ) : (
                      <path d="M2.5 5.5v-3h3M9.5 2.5h3v3M12.5 9.5v3h-3M5.5 12.5h-3v-3M5.5 5.5l-3-3M9.5 5.5l3-3M9.5 9.5l3 3M5.5 9.5l-3 3" />
                    )}
                  </IconButton>
                </>
              }
            />
          )}
          {!corners && (
            <div className="u-draft-views">
              <Modes
                small
                label="Вид чертежа"
                value={solid ? "solid" : "plan"}
                options={[
                  { id: "plan", name: "План", hint: "Вид сверху, здесь чертят" },
                  { id: "solid", name: "Объем", hint: "Тот же склад сверху под углом, только посмотреть" },
                ]}
                onChange={(next) => setSolid(next === "solid")}
              />
            </div>
          )}
        </div>

        <div className="u-side" ref={setSide}>
          {underlay.value && (
            <>
              <h3>Фото плана</h3>
              {corners ? (
                <>
                  <p>
                    {doubt
                      ? "На картинке два похожих контура, например план и таблица под ним. Если точки стоят не на углах здания, перенесите их и нажмите «Готово»."
                      : "Поставьте точки на все наружные углы здания: щелчок по стороне добавляет точку, двойной щелчок по точке убирает. Картинка выпрямится, а здание станет этим контуром. Если план лежит боком, поверните."}
                  </p>
                  <div className="u-bar is-even">
                    <Button onClick={applyCorners}>Готово</Button>
                    <Button kind="ghost" onClick={() => setTurn((turn + 1) % 4)}>
                      Повернуть
                    </Button>
                    <Button
                      kind="ghost"
                      onClick={() => {
                        setCorners(null);
                        setDoubt(false);
                      }}
                    >
                      Отмена
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {fitNote && <p>{fitNote}</p>}
                  <label className="u-own-field">
                    <span className="u-frow-name">Прозрачность</span>
                    <input
                      type="range"
                      min="0.15"
                      max="1"
                      step="0.05"
                      value={underlay.value.opacity}
                      onChange={(event) => underlay.set({ opacity: Number(event.target.value) })}
                    />
                  </label>
                  <div className="u-bar is-even">
                    {/* на телефоне лист только смотрят, контур там не обвести */}
                    {!narrow && (
                      <Button kind="ghost" onClick={editCorners}>
                        Обвести контур
                      </Button>
                    )}
                    <Button kind="ghost" onClick={refit}>
                      Найти заново
                    </Button>
                    <Button
                      kind="ghost"
                      onClick={() => {
                        put(null);
                        setFitNote("");
                      }}
                    >
                      Убрать
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
          {!corners && (
            <>
              {/* Высоту стеллажей цветом больше не показываем: на складе они почти всегда одной высоты,
                  верхний ярус стоит числом под листом, а стеллаж выше потолка ловит проверка */}
              <h3>Цветом на плане</h3>
              <p className="u-side-note">Чем окрашен пол на чертеже</p>
              <Modes
                label="Что показать цветом"
                value={colorBy === "route" ? "route" : "level"}
                options={[
                  { id: "level", name: "Высота пола" },
                  { id: "route", name: "Путь до ворот" },
                ]}
                onChange={setColorBy}
              />

              {colorBy !== "route" ? (
                <>
                  <p className="u-side-cap">Уровни пола в здании и потолок над ними</p>
                  <Legend
                    rows={levels.map((one, index) => ({
                      id: String(index),
                      color: floorTone(heights, one.floor_m),
                      name: `пол ${signed(one.floor_m)} м`,
                      value: `потолок ${number(one.ceiling_m, 1)} м`,
                    }))}
                  />
                  <p>
                    Чтобы поднять часть склада, в режиме «Здание» протяните секцию поверх зала и поставьте ей отметку
                    пола. Между разными отметками робот ездит только по пандусу.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Путь от этой точки до буфера у ворот по проездам, с объездом рядов. Темнее значит дальше. Пока
                    объект тянут, пол красится заранее.
                  </p>
                  {/* шкала одной полосой: семь строк легенды делали колонку выше листа */}
                  <div
                    className="u-scale"
                    role="img"
                    aria-label={`Путь до ворот от 0 до ${number(bands.at(-1) ?? 0, 0)} м`}
                  >
                    <div className="u-scale-bar">
                      {bands.slice(0, -1).map((_, index) => (
                        <span key={index} style={{ opacity: routeAlpha(index, bands.length - 1) }} />
                      ))}
                    </div>
                    <div className="u-scale-ends mono">
                      <span>0 м</span>
                      <span>{number(bands.at(-1) ?? 0, 0)} м</span>
                    </div>
                  </div>
                  <Legend
                    rows={[
                      { id: "lost", color: "color-mix(in srgb, var(--stop) 35%, transparent)", name: "не доехать" },
                    ]}
                  />
                </>
              )}
              <GateLegend plan={plan} />
              <p>Зарядку ставит программа: у стены, рядом с буфером и так, чтобы не мешать проезду.</p>
            </>
          )}
        </div>
      </div>

      <div className="u-plan-foot">
        <div className="u-meters">
          <Meter
            label="средний маршрут"
            value={measures ? number(measures.route_m, 0) : "—"}
            unit="м"
            hint="От места у стеллажа до буфера у ворот, по проездам и с объездом рядов. От него зависит производительность робота"
            delta={deltas.route_m}
          />
          <Meter
            label="мест у ворот"
            value={measures ? String(measures.docks) : "—"}
            hint="Столько роботов разгружаются одновременно, остальные ждут"
            delta={deltas.docks}
          />
          <Meter
            label="проездов"
            value={measures ? String(measures.aisles) : "—"}
            hint="Проездов между рядами: столько роботов едут, не мешая друг другу"
            delta={deltas.aisles}
          />
          <Meter
            label="ширина проезда"
            value={measures ? number(measures.aisle_m, 1) : "—"}
            unit="м"
            hint="Идет в подбор: решения, которым нужен проезд шире, мы не рекомендуем"
            delta={deltas.aisle_m}
          />
          <Meter
            label="верхний ярус"
            value={measures ? number(measures.rack_top_m, 1) : "—"}
            unit="м"
            hint="Идет в подбор: штабелер должен до него доставать"
            delta={deltas.rack_top_m}
          />
          <Meter
            label="площадь пола"
            value={measures ? number(measures.area_m2, 0) : "—"}
            unit="м2"
            hint="Площадь здания по секциям пола"
            delta={deltas.area_m2}
          />
        </div>

        {measures ? (
          <Checks items={measures.checks} />
        ) : (
          refused && <Checks items={[{ label: "Сервер принял план", ok: false, detail: refused }]} />
        )}
      </div>

      {tourShown && (
        <Tour
          key={`${tourKind}:${tourStart}`}
          steps={shownSteps}
          start={Math.min(tourStart, shownSteps.length - 1)}
          onStep={(index) => tourKind === "basics" && index >= TOUR.length - 1 && beginPractice()}
          onIndex={(index) => {
            setTourAt(index);
            // шаг про кнопку другого режима: переключаем режим, чтобы кнопка была на экране
            const want = tourKind === "tools" ? allTools[index]?.mode : null;
            if (want && want !== mode) switchMode(want);
          }}
          onClose={(why) => {
            if (why !== "later") tourSeen(TOUR_KEY);
            if (tourKind === "basics" && tourAt >= TOUR.length) tourSeen(PRACTICE_KEY);
            endPractice();
            setTourKind("basics");
            setAskPractice(false);
            setTourOn(false);
            setTourAt(-1);
          }}
        />
      )}
      {offerShown && (
        <TourOffer
          target=".u-draft-main"
          title={empty ? "План готов. Попробуете на нем?" : "План готов. Хотите короткую практику?"}
          text={
            empty
              ? "Три минуты: поставите ряды, ворота и буфер, каждый шаг засчитается сам."
              : "Три минуты на этом плане: поставите ряд, ворота и буфер, каждый шаг засчитается сам. Ваш план вернется как был."
          }
          go="Попробовать"
          onStart={() => {
            beginPractice();
            setTourStart(TOUR.length);
            setTourOn(true);
          }}
          onLater={() => {
            setAskPractice(false);
            tourSeen(PRACTICE_KEY);
          }}
        />
      )}
    </section>
  );

  function toolButton(name: ToolName) {
    const index = order.indexOf(name) + 1;
    return (
      <Tool
        key={name}
        active={tool === name}
        onPick={() => {
          pickTool(name);
          setSolid(false);
          setCorners(null);
          setDoubt(false);
          if (name !== "select" && name !== "hall") setPicked("");
        }}
        glyph={<Glyph kind={name} />}
        name={TOOL_NAMES[name]}
        note={name in MOVES ? MOVES[name] : TOOL_NOTES[name]}
        hotkey={String(index)}
        suggested={!practicing && next?.tool === name}
        pulse={waiting === name && tool !== name}
      />
    );
  }
}

/* Что сделать дальше: первое незакрытое дело по порядку, в котором план собирают. Сначала
   зоны хранения, потом ворота, потом то, что сказали проверки сервера. Готовый план молчит,
   и в строке остается справка режима. */
function nextStep(
  plan: Plan,
  measures: PlanMeasures | null,
  photo: boolean,
  order: ToolName[],
): { text: ReactNode; tool?: ToolName } | null {
  if (!measures) return null;
  const key = (tool: ToolName) => `клавиша ${order.indexOf(tool) + 1}`;
  const has = (kind: string) => plan.items.some((item) => item.kind === kind);
  if (!has("racks"))
    return {
      tool: "racks",
      text: (
        <>
          <b>Дальше.</b>{" "}
          {photo
            ? "Протяните ряды стеллажей по картинке: инструмент «Ряды»"
            : "Протяните ряды стеллажей по пустому полу: инструмент «Ряды»"}
          , {key("racks")}. Один ряд ставит инструмент «Ряд», {key("row")}
        </>
      ),
    };
  if (!measures.docks)
    return {
      tool: "dock",
      text: (
        <>
          <b>Дальше.</b> Протяните ворота вдоль наружной стены: инструмент «Ворота», {key("dock")}. Щелчок ставит одни
          ворота
        </>
      ),
    };
  const open = measures.checks.find((check) => !check.ok && check.label !== PICKING_CHECK);
  if (open)
    return {
      text: (
        <>
          <b>Осталось.</b> {open.detail || open.label}
        </>
      ),
    };
  return null;
}

/* Стартовый экран шага: три пути к плану, от быстрого к точному. Типовая схема для тех, кто
   не хочет заполнять, анкета для своего склада, фото плана для тех, у кого он есть. */
function Start({
  templates,
  withStations,
  start,
  onTemplate,
  onOwn,
  onPhoto,
}: {
  templates: PlanTemplate[];
  /* выбран штучный отбор: у схем пометка, что пойдет по ним, а что по робозоне */
  withStations: boolean;
  start: CustomAnswers;
  onTemplate: (id: string) => void;
  onOwn: (answers: CustomAnswers) => void;
  onPhoto: (file: File, size: { width_m: number; length_m: number }) => void;
}) {
  // размеры здания общие у анкеты и фото: назвал в одной карточке, во второй они те же
  const [size, setSize] = useState({ width_m: start.width_m, length_m: start.length_m });
  // при первом входе карточка обучения объясняет три способа; на телефоне шаг только смотрят
  const [intro, setIntro] = useState(() => tourWanted(START_KEY) && !window.matchMedia("(max-width: 880px)").matches);
  // Три плиты одного веса и одного устройства: метка пути, название, одна строка о том, что
  // будет, сам выбор и действие внизу. Кнопки стоят на одной линии, какой бы ни была плита
  return (
    <section>
      <BlockHead title="Откуда взять план" note="если пропустить шаг, посчитаем по типовой схеме" />
      <div className="u-start">
        <div className="u-start-card">
          <span className="u-start-tag mono">1 · быстрее всего</span>
          <h3>Типовая планировка</h3>
          <p>Одна из четырех схем потока, размеры из площади объекта.</p>
          <div className="u-schemes">
            {templates.map((one) => (
              <button
                key={one.id}
                type="button"
                className="u-scheme"
                title={`${one.about} ${one.fits}`}
                onClick={() => onTemplate(one.id)}
              >
                <Sketch id={one.id} />
                <span>{one.name}</span>
                {withStations && (
                  <small className="u-scheme-note">
                    {one.id === ROBOT_ZONE ? "под отбор" : "под паллеты; отбор посчитаем по робозоне"}
                  </small>
                )}
              </button>
            ))}
          </div>
          <p className="u-start-note">
            Расчет грубее: где ворота и стеллажи на вашем объекте, мы не знаем, в выводе это будет отдельной строкой
          </p>
        </div>

        <div className="u-start-card">
          <span className="u-start-tag mono">2 · точнее</span>
          <h3>Свой склад</h3>
          <p>Размеры, стены с воротами и ряды. План построится по ответам, дальше его можно править.</p>
          <OwnForm start={start} size={size} onSize={setSize} onBuild={onOwn} />
        </div>

        <div className="u-start-card">
          <span className="u-start-tag mono">3 · точнее всего</span>
          <h3>По фото плана</h3>
          <p>План из БТИ, скриншот из карт или фото схемы. Картинка ляжет под чертеж, по ней обведете зоны.</p>
          <PhotoForm size={size} onSize={setSize} onPhoto={onPhoto} />
        </div>
      </div>
      {intro && (
        <Tour
          steps={[
            {
              target: ".u-start",
              title: "Три способа, от быстрого к точному",
              // каждый способ своей строкой: одним абзацем три пути сливались
              text: (
                <>
                  <span className="u-tour-line">
                    «Типовая планировка»: одна из четырех схем, размеры из площади объекта, расчет грубее.
                  </span>
                  <span className="u-tour-line">«Свой склад»: размеры, стены с воротами и ряды по вашим ответам.</span>
                  <span className="u-tour-line">
                    «По фото плана»: картинка ляжет под чертеж, по ней обведете стены и поставите ряды.
                  </span>
                  <span className="u-tour-line">Любой план потом правится, начать заново можно всегда.</span>
                </>
              ),
            },
          ]}
          onClose={(why) => {
            if (why !== "later") tourSeen(START_KEY);
            setIntro(false);
          }}
        />
      )}
    </section>
  );
}

/* Схема потока картинкой: где ворота и куда идут ряды. Выбирать глазами быстрее, чем читать
   название. Стены здесь те же, что в config/layouts.yaml, длинная сторона вдоль листа. */
function Sketch({ id }: { id: string }) {
  const docks: Record<string, ("s" | "n" | "w" | "e")[]> = {
    through: ["s", "n"],
    corner: ["s", "e"],
    one_side: ["w"],
    robot_zone: ["s"],
  };
  const walls = docks[id] ?? ["w"];
  const gate = (wall: "s" | "n" | "w" | "e", at: number) =>
    wall === "s" || wall === "n" ? (
      <rect key={`${wall}${at}`} x={at} y={wall === "s" ? 55 : 5} width="7" height="6" className="u-sketch-gate" />
    ) : (
      <rect key={`${wall}${at}`} x={wall === "w" ? 5 : 89} y={at} width="6" height="7" className="u-sketch-gate" />
    );
  const gates = walls.flatMap((wall) =>
    (wall === "s" || wall === "n" ? [34, 45, 56] : [22, 33, 44]).map((at) => gate(wall, at)),
  );
  const rows = id === "robot_zone" ? [24, 34, 44, 54, 64, 74] : [22, 32, 42, 52, 62, 72];
  return (
    <svg viewBox="0 0 100 66" aria-hidden="true" className="u-sketch">
      <rect x="8" y="8" width="84" height="50" />
      {rows.map((x) => (
        <rect
          key={x}
          x={x}
          y={id === "robot_zone" ? 20 : 17}
          width={id === "robot_zone" ? 6 : 5}
          height={id === "robot_zone" ? 24 : 32}
          className="u-sketch-row"
        />
      ))}
      {id === "robot_zone" &&
        [30, 48, 66].map((x) => <rect key={x} x={x} y="11" width="6" height="5" className="u-sketch-station" />)}
      {gates}
    </svg>
  );
}

const WALLS: { id: Wall; name: string }[] = [
  { id: "west", name: "слева, на короткой стене" },
  { id: "east", name: "справа, на короткой стене" },
  { id: "south", name: "снизу, на длинной стене" },
  { id: "north", name: "сверху, на длинной стене" },
];

const ROWS = [
  { id: "across", name: "поперек потока от ворот" },
  { id: "along", name: "вдоль потока от ворот" },
  { id: "none", name: "без стеллажей, нарисую сам" },
];

function SizeFields({
  value,
  onChange,
}: {
  value: { width_m: number; length_m: number };
  onChange: (next: { width_m: number; length_m: number }) => void;
}) {
  const size = (key: "width_m" | "length_m") => (next: string) => {
    const parsed = Number(next);
    if (next !== "" && Number.isFinite(parsed) && parsed >= 4) onChange({ ...value, [key]: parsed });
  };
  return (
    <FieldPair
      label="Здание"
      hint="длинная сторона × короткая"
      sep="×"
      a={{ value: value.width_m, onChange: size("width_m"), step: "1" }}
      b={{ value: value.length_m, onChange: size("length_m"), step: "1", unit: "м" }}
    />
  );
}

/* Анкета «Свой склад». Ворота можно поставить на несколько стен сразу, у каждой свое число.
   Кто не похож ни на одну схему, отвечает «без стеллажей» и рисует на пустом здании. */
type Size = { width_m: number; length_m: number };

function OwnForm({
  start,
  size,
  onSize,
  onBuild,
}: {
  start: CustomAnswers;
  size: Size;
  onSize: (size: Size) => void;
  onBuild: (answers: CustomAnswers) => void;
}) {
  const [answers, setForm] = useState(start);
  const form = { ...answers, ...size };
  const at = (wall: Wall) => form.docks.find((one) => one.wall === wall);
  const toggle = (wall: Wall) =>
    setForm({
      ...form,
      docks: at(wall) ? form.docks.filter((one) => one.wall !== wall) : [...form.docks, { wall, count: 4 }],
    });
  const count = (wall: Wall, next: string) => {
    const value = Math.round(Number(next));
    if (!Number.isFinite(value) || value < 1) return;
    setForm({ ...form, docks: form.docks.map((one) => (one.wall === wall ? { ...one, count: value } : one)) });
  };
  return (
    <div className="u-form">
      <SizeFields value={size} onChange={onSize} />
      <div className="u-own-field">
        <span className="u-frow-name">Ворота</span>
        {WALLS.map((wall) => {
          const picked = at(wall.id);
          return (
            <div key={wall.id} className="u-wall-row">
              <Check label={wall.name} checked={Boolean(picked)} onToggle={() => toggle(wall.id)} />
              {picked && (
                <span className="u-field-box u-wall-count">
                  <input
                    className="mono"
                    type="number"
                    step="1"
                    min="1"
                    aria-label={`Сколько ворот ${wall.name}`}
                    value={picked.count}
                    onChange={(event) => count(wall.id, event.target.value)}
                  />
                  <span className="u-field-unit">шт</span>
                </span>
              )}
            </div>
          );
        })}
        {!form.docks.length && <span className="u-frow-hint">без ворот: поставите сами, протянув вдоль стены</span>}
      </div>
      <label className="u-own-field">
        <span className="u-frow-name">Ряды стеллажей</span>
        <Select
          label="Ряды стеллажей"
          value={form.racks}
          options={ROWS}
          onChange={(racks) => setForm({ ...form, racks: racks as CustomAnswers["racks"] })}
        />
      </label>
      <div className="u-form-go">
        <Button onClick={() => onBuild(form)}>Построить план</Button>
      </div>
    </div>
  );
}

/* Фото плана: размеры здания и картинка. Что на картинке должно быть, показываем примером. */
function PhotoForm({
  size,
  onSize,
  onPhoto,
}: {
  size: Size;
  onSize: (size: Size) => void;
  onPhoto: (file: File, size: Size) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className="u-form">
      <SizeFields value={size} onChange={onSize} />
      {/* картинку можно бросить прямо сюда или выбрать кнопкой */}
      <button
        type="button"
        className={over ? "u-drop is-over" : "u-drop"}
        onClick={() => file.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const picked = event.dataTransfer.files?.[0];
          if (picked) onPhoto(picked, size);
        }}
      >
        <svg viewBox="0 0 120 76" aria-hidden="true">
          <rect x="6" y="6" width="108" height="64" />
          {[16, 30, 44, 58, 72, 86].map((x) => (
            <rect key={x} x={x} y="18" width="8" height="40" className="u-example-row" />
          ))}
          <path d="M6 30v16" className="u-example-dock" />
        </svg>
        <span className="u-drop-text">
          <b>Перетащите картинку сюда</b>
          <span>вид сверху, здание целиком, стены темными линиями. PDF сначала сохраните картинкой</span>
        </span>
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (picked) onPhoto(picked, size);
        }}
      />
      <div className="u-form-go">
        <Button kind="ghost" onClick={() => file.current?.click()}>
          Выбрать картинку
        </Button>
      </div>
    </div>
  );
}

/* Ворота окрашены по назначению. Назначение меняют в окне ворот */
function GateLegend({ plan }: { plan: Plan }) {
  const docks = plan.items.filter((item) => item.kind === "dock");
  if (!docks.length) return null;
  const count = (role: string) => docks.filter((item) => (item.role || "both") === role).length;
  return (
    <>
      <p className="u-side-cap">Ворота по назначению и сколько их</p>
      <Legend
        rows={[
          { id: "in", color: "var(--dock-in)", name: "ворота приемки", value: String(count("receiving")) },
          { id: "out", color: "var(--dock-out)", name: "ворота отгрузки", value: String(count("shipping")) },
          { id: "both", color: "var(--paper)", name: "и приемка, и отгрузка", value: String(count("both")) },
        ].filter((row) => row.value !== "0")}
      />
    </>
  );
}

const TOUR_KEY = "lct.tour.drawing";
// карточки инструментов: ключ у каждого свой, lct.tips.tools.racks и так далее
const TIPS_KEY = "lct.tips.tools";

// практика: прошел ее или сказал "не сейчас", и после построения плана больше не спрашиваем
const PRACTICE_KEY = "lct.tour.practice";
// карточка на экране "Откуда взять план"
const START_KEY = "lct.tour.start";

/* Основы: семь коротких подсказок, каждая про свою часть экрана. Последняя ведет в практику */
const TOUR: TourStep[] = [
  {
    target: ".u-draft .u-modes",
    title: "Два режима",
    text: "«Здание» это пол здания: его размеры, контур, вырезы и поднятые части. «Обстановка» это то, что стоит на полу: стеллажи, ворота, проезды, перегородки. Инструменты ниже меняются вместе с режимом.",
  },
  {
    target: ".u-draft > .u-tools",
    title: "Инструменты",
    text: "Возьмите инструмент и протяните по листу. Цифра слева это клавиша, она берет инструмент без мыши. После одной вещи инструмент возвращается к «Выбрать», Shift держит его в руке.",
  },
  {
    target: ".u-draft-main .u-board",
    title: "Как двигаться по листу",
    text: "Колесо или щипок на тачпаде приближают к курсору. Лист двигают пробелом с мышью, средней кнопкой или двумя пальцами на тачпаде. Протяжка по пустому месту рисует рамку выбора.",
  },
  {
    target: ".u-draft-main .u-board-ctl",
    title: "Выбрать и отменить",
    text: "Щелчок выбирает вещь, ее размеры встают справа. Shift+щелчок или рамка выбирают несколько, их тянут, копируют и удаляют вместе. Ctrl+Z отменяет, Ctrl+Shift+Z повторяет, те же кнопки в углу листа.",
  },
  {
    target: ".u-draft-views",
    title: "План и объем",
    text: "«План» это вид сверху, здесь чертят. «Объем» показывает тот же склад под углом с высотой стеллажей и пола, его только смотрят. Кнопка в углу листа разворачивает его на весь экран.",
  },
  {
    target: ".u-draft > .u-side",
    title: "Цвет на плане и легенды",
    text: "«Высота пола» красит поднятые части склада, «Путь до ворот» темнее там, куда роботу дальше ехать. Ниже уровни пола с потолком и ворота по назначению с числом. Зарядку ставит программа, ее можно передвинуть.",
  },
  {
    target: ".u-plan-foot",
    title: "Числа и проверки",
    text: "После каждой правки сервер пересчитывает маршрут, ворота и проезды и проверяет план, числа уходят в подбор роботов. Что сделать дальше, всегда написано в строке под листом.",
  },
];

const TOOL_NAMES: Record<ToolName, string> = {
  outline: "Контур здания",
  hall: "Здание и секции",
  hole: "Вырез",
  select: "Выбрать",
  row: "Ряд",
  racks: "Ряды",
  aisle: "Проезд",
  flow: "Линия движения",
  dock: "Ворота",
  buffer: "Буфер у ворот",
  ramp: "Пандус",
  blocked: "Перегородка",
  nogo: "Закрытая зона",
  station: "Станция",
};

const TOOL_NOTES: Partial<Record<ToolName, string>> = {
  select: "Выбрать и переставить то, что стоит на полу",
  hall: "Щелчок выбирает здание: тяните углы и стены. Протяжка поверх зала поднимает часть пола",
  racks: "Протяните прямоугольник: ряды встанут вдоль длинной стороны, число и проезд поправите справа",
};

function Glyph({ kind }: { kind: ToolName }) {
  const paths: Record<ToolName, ReactNode> = {
    outline: <path d="M2.5 2.5h7v5h4v6h-11zM2.5 2.5v0M9.5 7.5v0" strokeLinejoin="round" />,
    hall: <path d="M2.5 5.5h7v8h-7zM6.5 2.5h7v8h-4" />,
    hole: <path d="M2.5 2.5h11v11h-11zM8 8h5.5v5.5H8z" />,
    select: <path d="M4 3l8 4.5-3.5 1L7 12z" strokeLinejoin="round" />,
    row: <path d="M6.5 2.5h3v11h-3zM6.5 6h3M6.5 9.5h3" />,
    racks: <path d="M2.5 2.5h2.5v11H2.5zM6.75 2.5h2.5v11h-2.5zM11 2.5h2.5v11H11z" />,
    aisle: <path d="M2.5 2.5h11v11h-11zM5.5 4v2.5M8 4v2.5M10.5 4v2.5M5.5 9.5V12M8 9.5V12M10.5 9.5V12M2.5 8h11" />,
    flow: <path d="M2.5 8h11M10 4.5L13.5 8 10 11.5M4 5.5L6.5 8 4 10.5" strokeLinejoin="round" />,
    dock: <path d="M2 13.5h12M4 13.5V6h8v7.5M4 9.5h8" />,
    buffer: <path d="M2.5 2.5h11v11h-11z" strokeDasharray="2 1.6" />,
    ramp: <path d="M2 13l12-7v7zM5 11.3l1.5-1M8.5 9.3l1.5-1" />,
    blocked: <path d="M2.5 2.5h11v11h-11zM2.5 7l4.5-4.5M2.5 12l9.5-9.5M7 13.5l6.5-6.5" />,
    nogo: <path d="M2.5 2.5h11v11h-11zM5 5l6 6M11 5l-6 6" strokeDasharray="2 1.6" />,
    station: <path d="M2.5 2.5h11v11h-11zM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5" />,
  };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      {paths[kind]}
    </svg>
  );
}

/* На узком экране чертеж только смотрят: двигать прямоугольники пальцем по листу в триста
   точек не выйдет, а палец на листе должен прокручивать страницу */
function useNarrow(): boolean {
  const query = "(max-width: 880px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const watch = () => setNarrow(media.matches);
    media.addEventListener("change", watch);
    return () => media.removeEventListener("change", watch);
  }, []);
  return narrow;
}

type Delta = { text: string; tone: "good" | "bad" | "plain"; key: string };

/* Число в табличке на листе: подпись, значение и на пару секунд сдвиг после правки */
function HudNumber({ label, value, delta }: { label: string; value: string; delta?: Delta }) {
  return (
    <span className="u-hud-num">
      <span>{label}</span>
      <b className="mono">{value}</b>
      {delta && (
        <span key={delta.key} className={`u-delta is-${delta.tone} mono`}>
          {delta.text}
        </span>
      )}
    </span>
  );
}

/* На сколько сдвинулись числа после правки. Разность двух ответов сервера, ничего своего
   здесь не считаем. Маршрут короче это хорошо, ворот и проездов больше тоже. */
function useDeltas(measures: PlanMeasures | null, edited: boolean): Partial<Record<string, Delta>> {
  const last = useRef<PlanMeasures | null>(null);
  const [deltas, setDeltas] = useState<Partial<Record<string, Delta>>>({});
  useEffect(() => {
    const before = last.current;
    last.current = measures;
    if (!before || !measures) return;
    // с пустого плана сдвиг не показываем: «+39 м» к нулю ничего не говорит. План, который программа
    // построила заново, тоже не правка: "-66 м" к прошлому плану ничего не говорит
    if (!before.route_m || !edited) {
      setDeltas({});
      return;
    }
    const better: Record<string, 1 | -1 | 0> = {
      route_m: -1,
      docks: 1,
      aisles: 1,
      aisle_m: 0,
      rack_top_m: 0,
      area_m2: 0,
    };
    const next: Partial<Record<string, Delta>> = {};
    for (const key of Object.keys(better) as (keyof PlanMeasures)[]) {
      const change = Number(measures[key]) - Number(before[key]);
      const fine = key === "aisle_m" || key === "rack_top_m";
      if (Math.abs(change) < (fine ? 0.05 : 0.5)) continue;
      const way = better[key];
      next[key] = {
        text: signed(change, fine ? 1 : 0),
        tone: way === 0 ? "plain" : Math.sign(change) === way ? "good" : "bad",
        key: `${key}:${Date.now()}`,
      };
    }
    setDeltas(next);
  }, [measures, edited]);
  return deltas;
}
