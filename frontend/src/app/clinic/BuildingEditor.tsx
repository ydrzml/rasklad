/* Шаг "План корпуса" у медучреждения: этажи, помещения с ролями, двери в мм, шахты лифтов через
   этажи, зарядки и преграды. Экран собран из тех же деталей, что чертеж склада (Board, Tools,
   Window, проверки под листом), инструменты как в редакторе корпуса Аркера. Правки корпуса в
   building.ts, проверка плана на сервере (POST /api/clinic/check), прогон смены на шаге итога.

   Лист в координатах доски: ноль слева сверху, y вниз. Корпус в координатах движка: ноль слева
   снизу, y вверх. Переворачиваем на входе и выходе, как у склада. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, type ClinicCheck } from "../../api/client";
import {
  Badge,
  Button,
  Check,
  FieldPair,
  FieldRow,
  Select,
  ToolCard,
  Tour,
  TourAsk,
  tourSeen,
  tourWanted,
  type TourStep,
} from "../../ui";
import { Board, IconButton, Legend, Modes, Tool, ToolGroup, Tools, Window, type View } from "../../ui/board";
import {
  addBox,
  addDoor,
  addFloor,
  addLift,
  addRoom,
  addSection,
  patchSection,
  removeSection,
  type Box,
  boxOf,
  type Building,
  copyFloor,
  counts,
  floorOf,
  hit,
  type Item,
  type Lift,
  MAX_FLOORS,
  MAX_LIFTS,
  moveItem,
  patchItem,
  removeFloor,
  removeItem,
  resizeFloor,
  resizeItem,
  ROLE_NAMES,
  type Role,
  setDoorWidth,
  snap,
  toggleStop,
  type XY,
} from "./building";
import { FloorDrawing } from "./FloorDrawing";
import { BuildingOverview } from "./BuildingOverview";
import type { Underlay } from "../plan/underlay";
import { rotateClinicImage } from "./upload";
import "./clinic.css";

type ToolName = "select" | "section" | "room" | "door" | "lift" | "charge" | "base" | "blocked";

const TOOLS: { id: ToolName; name: string; note: string }[] = [
  { id: "select", name: "Выбор", note: "Выбрать и передвинуть. Угол справа сверху меняет размер" },
  {
    id: "section",
    name: "Здание и секции",
    note: "Протяните часть пола. Из нескольких секций можно собрать Г- или П-образный этаж",
  },
  { id: "room", name: "Помещение", note: "Протяните прямоугольник. Дверь в коридор встанет сама" },
  { id: "door", name: "Дверь", note: "Щелкните по стене помещения" },
  { id: "lift", name: "Лифт", note: "Шахта встанет на все этажи сразу" },
  { id: "charge", name: "Зарядка", note: "Где заряжаются доставщики" },
  { id: "base", name: "База уборщика", note: "Зарядка уборщика этажа" },
  { id: "blocked", name: "Преграда", note: "Робот здесь не проедет" },
];

const ROLES: { id: Exclude<Role, "" | "cleaning">; name: string }[] = [
  { id: "ward", name: ROLE_NAMES.ward },
  { id: "pharmacy", name: ROLE_NAMES.pharmacy },
  { id: "supplies", name: ROLE_NAMES.supplies },
  { id: "other", name: ROLE_NAMES.other },
];

const HISTORY = 40;

type Gesture =
  | { mode: "draw"; start: XY; box: Box }
  | { mode: "move" | "resize"; start: XY; initial: Building; id: string; section?: boolean; next?: Building };

type Props = {
  building: Building;
  onChange: (next: Building) => void;
  // проверку плана зовет мастер: от нее зависит, пускать ли к решениям и итогу
  check: ClinicCheck | null;
  checkError: string;
  underlays: Record<string, Underlay>;
  onUnderlays: (next: Record<string, Underlay>) => void;
  onUpload: (file: File, floor: number) => void;
  busy: boolean;
  onRestart: () => void;
  onSave: () => void;
  routeControls?: ReactNode;
};

type Snapshot = { building: Building; underlays: Record<string, Underlay> };

export function BuildingEditor({
  building,
  onChange,
  check,
  checkError,
  underlays,
  onUnderlays,
  onUpload,
  busy,
  onRestart,
  onSave,
  routeControls,
}: Props) {
  const [mode, setMode] = useState("furnish");
  const [viewKind, setViewKind] = useState("plan");
  const [legend, setLegend] = useState(false);
  const [full, setFull] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 880px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 880px)");
    const change = () => setNarrow(mq.matches);
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  const [tourOn, setTourOn] = useState<boolean | null>(null);
  const [tourKind, setTourKind] = useState("choice");
  const [tip, setTip] = useState<{ tool: ToolName; top: number } | null>(null);
  const [floorNo, setFloorNo] = useState(building.floors[0]?.number ?? 1);
  const [tool, setTool] = useState<ToolName>("select");
  const [picked, setPicked] = useState("");
  const [preview, setPreview] = useState<Building | null>(null);
  const [draw, setDraw] = useState<Box | null>(null);
  const [history, setHistory] = useState<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const upload = useRef<HTMLInputElement>(null);
  const [showImage, setShowImage] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [hint, setHint] = useState("");
  const [sample, setSample] = useState<Lift | null>(building.lifts[0] ?? null);
  const gesture = useRef<Gesture | null>(null);
  const scale = useRef(1);

  const shown = preview ?? building;
  const floor = floorOf(shown, floorNo) ?? shown.floors[0];
  const number = floor.number;
  const item = floor.items.find((one) => one.id === picked);
  const section = floor.sections.find((one) => `section:${one.id}` === picked);
  const selectedBox = item ?? section;
  const currentTools = TOOLS.filter(
    (one) => one.id === "select" || (mode === "build" ? one.id === "section" : one.id !== "section"),
  );
  const total = counts(building);
  const underlay = underlays[String(number)];

  // образец кабины для нового лифта: первый лифт корпуса или типового
  useEffect(() => {
    if (sample) return;
    void api
      .clinicTemplate()
      .then((template) => setSample(template.lifts[0] ?? null))
      .catch(() => setHint("Не загрузили образец лифта, лифт пока не поставить"));
  }, [sample]);

  const commit = useCallback(
    (next: Building, nextUnderlays = underlays) => {
      if (next === building) return;
      setHistory((now) => ({ past: [...now.past, { building, underlays }].slice(-HISTORY), future: [] }));
      onChange(next);
      if (nextUnderlays !== underlays) onUnderlays(nextUnderlays);
    },
    [building, onChange, underlays, onUnderlays],
  );

  const undo = useCallback(() => {
    const previous = history.past.at(-1);
    if (!previous) return;
    setHistory((now) => ({ past: now.past.slice(0, -1), future: [{ building, underlays }, ...now.future] }));
    onChange(previous.building);
    onUnderlays(previous.underlays);
    setPicked("");
  }, [history.past, building, underlays, onChange, onUnderlays]);

  const redo = useCallback(() => {
    const next = history.future[0];
    if (!next) return;
    setHistory((now) => ({ past: [...now.past, { building, underlays }], future: now.future.slice(1) }));
    onChange(next.building);
    onUnderlays(next.underlays);
    setPicked("");
  }, [history.future, building, underlays, onChange, onUnderlays]);

  const remove = useCallback(() => {
    if (!picked) return;
    commit(
      picked.startsWith("section:")
        ? removeSection(building, number, picked.slice(8))
        : removeItem(building, number, picked),
    );
    setPicked("");
  }, [picked, building, number, commit]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input,textarea,select,[contenteditable='true']")) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        if (!picked) return;
        event.preventDefault();
        remove();
      } else if (event.key === "Escape") {
        setPicked("");
        setTool("select");
      } else if (!mod && !event.altKey && /^[1-7]$/.test(event.key)) {
        const next = currentTools[Number(event.key) - 1];
        if (next) setTool(next.id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [undo, redo, remove, picked, currentTools]);

  // доска дает метры от левого верхнего угла, движку нужны от левого нижнего
  const toEngine = (at: XY): XY => ({
    x: Math.max(0, Math.min(floor.width_m, at.x)),
    y: Math.max(0, Math.min(floor.length_m, floor.length_m - at.y)),
  });
  const screenY = (box: Box) => floor.length_m - box.y - box.h;

  const grip = (one: Box | undefined): XY | null =>
    one && (section || item?.kind === "room" || item?.kind === "blocked")
      ? { x: one.x + one.w, y: one.y + one.h }
      : null;

  function down(raw: XY): boolean {
    const at = toEngine(raw);
    if (tool === "select") {
      const corner = grip(selectedBox);
      if (corner && Math.hypot(at.x - corner.x, at.y - corner.y) < 10 / scale.current) {
        gesture.current = {
          mode: "resize",
          start: at,
          initial: building,
          id: section?.id ?? picked,
          section: !!section,
        };
        return true;
      }
      const found =
        mode === "build"
          ? [...floor.sections]
              .reverse()
              .find((one) => at.x >= one.x && at.x <= one.x + one.w && at.y >= one.y && at.y <= one.y + one.h)
          : hit(floor, at);
      setPicked(found ? `${mode === "build" ? "section:" : ""}${found.id}` : "");
      if (!found) return false;
      gesture.current = { mode: "move", start: at, initial: building, id: found.id, section: mode === "build" };
      return true;
    }
    if (tool === "door") {
      const added = addDoor(building, number, at);
      if (!added) setHint("Щелкните по стене помещения: дверь ставится на его край");
      else {
        commit(added.building);
        setPicked(added.id);
        setHint(
          added.building === building
            ? "Здесь уже есть дверь: выбрана существующая. Для новой выберите свободный участок стены."
            : "",
        );
      }
      return true;
    }
    if (tool === "lift") {
      if (!sample) return true;
      const added = addLift(building, at, sample);
      if (!added) setHint(`Лифтов не больше ${MAX_LIFTS}`);
      else {
        commit(added.building);
        setPicked(`f${number}-${added.id}`);
        setTool("select");
      }
      return true;
    }
    if (tool === "charge" || tool === "base") {
      const next = addBox(building, number, "charge", { x: at.x, y: at.y, w: 0, h: 0 });
      const placed = floorOf(next, number)!.items.at(-1)!;
      commit(tool === "base" ? patchItem(next, number, placed.id, { role: "cleaning" }) : next);
      setPicked(placed.id);
      return true;
    }
    gesture.current = { mode: "draw", start: at, box: boxOf(at, at) };
    setDraw(boxOf(at, at));
    return true;
  }

  function move(raw: XY) {
    const now = gesture.current;
    if (!now) return;
    const at = toEngine(raw);
    if (now.mode === "draw") {
      now.box = boxOf(now.start, at);
      setDraw(now.box);
      return;
    }
    const baseFloor = floorOf(now.initial, number);
    const base = now.section
      ? baseFloor?.sections.find((one) => one.id === now.id)
      : baseFloor?.items.find((one) => one.id === now.id);
    if (!base) return;
    if (now.section) {
      now.next = patchSection(
        now.initial,
        number,
        now.id,
        now.mode === "move"
          ? { ...base, x: snap(base.x + at.x - now.start.x), y: snap(base.y + at.y - now.start.y) }
          : { ...base, w: Math.max(2, snap(at.x - base.x)), h: Math.max(2, snap(at.y - base.y)) },
      );
      setPreview(now.next);
      return;
    }
    if (now.mode === "move") {
      const step = "kind" in base && base.kind === "door" ? 0.5 : 1;
      now.next = moveItem(now.initial, number, now.id, snap(at.x - now.start.x, step), snap(at.y - now.start.y, step));
    } else {
      now.next = resizeItem(now.initial, number, now.id, at.x - base.x, at.y - base.y);
    }
    setHint(
      now.next === now.initial
        ? "На этом месте проемы пересекаются или не помещаются в стене. Выберите свободное место."
        : "",
    );
    setPreview(now.next);
  }

  function up(raw: XY) {
    move(raw);
    const now = gesture.current;
    gesture.current = null;
    if (!now) return;
    if (now.mode !== "draw") {
      const at = toEngine(raw);
      if (now.next && Math.hypot(at.x - now.start.x, at.y - now.start.y) > 0.001) commit(now.next);
      setPreview(null);
      return;
    }
    setDraw(null);
    const box = now.box;
    if (box.w < 1 || box.h < 1) {
      setHint(tool === "room" ? "Протяните прямоугольник помещения" : "Протяните прямоугольник преграды");
      return;
    }
    const next =
      tool === "section"
        ? addSection(building, number, box)
        : tool === "room"
          ? addRoom(building, number, box)
          : addBox(building, number, "blocked", box);
    commit(next);
    setPicked(
      tool === "section"
        ? `section:${floorOf(next, number)!.sections.at(-1)!.id}`
        : floorOf(next, number)!
            .items.filter((one) => one.kind !== "door")
            .at(-1)!.id,
    );
    setHint("");
  }

  const errors = useMemo(
    () => new Set(check?.checks.filter((one) => one.level === "error" && one.target).map((one) => one.target)),
    [check],
  );
  const warnings = useMemo(
    () => new Set(check?.checks.filter((one) => one.level === "warning" && one.target).map((one) => one.target)),
    [check],
  );
  const flagOf = (one: Item) =>
    errors.has(one.id) || errors.has(one.lift)
      ? " is-bad"
      : warnings.has(one.id) || warnings.has(one.lift)
        ? " is-warn"
        : "";

  const pickTarget = (target: string, floorNumber: number | null) => {
    if (floorNumber != null) setFloorNo(floorNumber);
    const where = floorOf(building, floorNumber ?? number);
    const found = where?.items.find((one) => one.id === target || (one.kind === "lift" && one.lift === target));
    if (found) {
      setPicked(found.id);
      setTool("select");
      setMode("furnish");
      setViewKind("plan");
    }
  };

  const floors = [...building.floors].sort((a, b) => a.number - b.number);
  const bad = check?.checks.filter((one) => one.level === "error") ?? [];
  const warn = check?.checks.filter((one) => one.level === "warning") ?? [];
  const corridor = check?.corridor_m2[String(number)];
  const tourKey = "lct.tour.clinic.drawing";
  const touring = !narrow && tourOn === true;
  const switchMode = (next: string) => {
    setMode(next);
    setTool(next === "build" ? "section" : "select");
    setPicked("");
    setViewKind("plan");
    setTip(null);
  };
  const basics: TourStep[] = [
    {
      target: ".c-building .c-floors",
      title: "Каждый этаж: свой план",
      text: "Переключайте этажи, копируйте похожие или добавляйте пустые. Размеры, контур, помещения и подложка у каждого этажа независимы.",
    },
    {
      target: ".c-building .u-tools .u-modes",
      title: "Здание и обстановка",
      text: 'В режиме "Здание" меняют пол и секции этажа. В "Обстановке" ставят помещения, двери, лифты и зарядки. Те же режимы и управление, что в складе.',
    },
    {
      target: ".c-building .u-tools",
      title: "Инструменты",
      text: "Возьмите инструмент и протяните по листу. Для двери щелкните по стене помещения. Клавиши 1-7 выбирают инструмент; Escape возвращает выбор.",
    },
    {
      target: ".c-building .u-board",
      title: "Лист и перемещение",
      text: "Колесо приближает к курсору. Пустое место перетаскивает лист. Выбранную вещь можно двигать, а квадрат в углу меняет ее размер. Ctrl+Z отменяет правку.",
    },
    {
      target: ".c-building .u-side",
      title: "Свойства и назначения",
      text: "Выберите помещение: справа можно задать название, размеры и роль. Аптека и расходники: источники доставки, пост: назначение. Общая аптека может обслуживать все этажи.",
    },
    {
      target: ".c-building .u-draft-views",
      title: "План здания целиком",
      text: '"Здание целиком" показывает все этажи в одинаковом масштабе. Нажатие на этаж открывает его редактор. Легенду можно скрыть, чтобы дать листу больше места.',
    },
    {
      target: ".c-building .u-plan-foot",
      title: "Проверки и расчет",
      text: "После правки сервер проверяет доступность помещений, дверей и лифтов. Нажмите на замечание, чтобы перейти к его месту. Объемы и расписание ниже задаются отдельно от геометрии.",
      next: "Теперь попробуйте",
    },
    {
      target: ".c-building .u-board",
      title: "Выберите помещение",
      text: 'Откройте "Обстановку" и щелкните по помещению. Его свойства появятся справа. Шаг можно пропустить.',
      practice: { done: !!item },
    },
    {
      target: ".c-building .u-board",
      title: "Поправьте план",
      text: "Переместите помещение или измените размер. При необходимости Ctrl+Z вернет его на место. Учебные действия меняют текущий план: сохраняются только ваши правки.",
      practice: { done: history.past.length > 0 },
    },
  ];
  const toolSteps: TourStep[] = TOOLS.map((one) => ({
    target: ".c-building .u-tools",
    title: one.name,
    text: one.note,
  }));
  const tourSteps: TourStep[] =
    tourKind === "choice"
      ? [
          {
            target: ".c-building .u-draft",
            title: "Как пользоваться редактором",
            text: "Выберите короткое знакомство с практикой или обзор медицинских инструментов.",
            choices: [
              {
                label: "Основы и практика",
                note: "Этажи, управление листом, свойства и проверки",
                size: "2-3 минуты",
                run: () => setTourKind("basics"),
              },
              {
                label: "Все инструменты",
                note: "Секции, помещения, двери, лифты и базы",
                size: "1-2 минуты",
                run: () => setTourKind("tools"),
              },
            ],
          },
        ]
      : tourKind === "tools"
        ? toolSteps
        : basics;
  const onTourIndex = useCallback(
    (index: number) => {
      setLegend(true);
      setViewKind("plan");
      if (tourKind === "tools") {
        const next = TOOLS[index];
        if (next) {
          setMode(next.id === "section" ? "build" : "furnish");
          setTool(next.id);
        }
      } else if (tourKind === "basics" && index >= 7) {
        setMode("furnish");
        setTool("select");
      }
    },
    [tourKind],
  );

  return (
    <section className={`u-drawing c-building${underlay && showImage ? " has-underlay" : ""}`}>
      <div className="u-plan-head">
        <h2>Чертеж корпуса</h2>
        <p>
          <span className="mono">
            {total.floors} эт., {total.wards} пост., {total.lifts} лифт.
          </span>
          {check ? (
            check.valid ? (
              <Badge tone="blue">можно считать смену</Badge>
            ) : (
              <Badge>есть ошибки</Badge>
            )
          ) : (
            <Badge>проверяем</Badge>
          )}
        </p>
        <span className="u-spacer" />
        {!narrow && (
          <Button
            kind="light"
            onClick={() => {
              setTourKind("choice");
              setTourOn(true);
              setLegend(true);
              setViewKind("plan");
            }}
          >
            Как пользоваться
          </Button>
        )}
        <Button kind="ghost" onClick={onSave}>
          Сохранить JSON
        </Button>
        <Button kind="ghost" disabled={busy} onClick={onRestart}>
          Начать заново
        </Button>
      </div>

      <div className="c-floors">
        <Modes
          label="Этаж"
          value={String(number)}
          options={floors.map((one) => ({ id: String(one.number), name: one.name || `${one.number} этаж` }))}
          onChange={(next) => {
            setFloorNo(Number(next));
            setPicked("");
          }}
        />
        <Button
          kind="ghost"
          disabled={building.floors.length >= MAX_FLOORS}
          onClick={() => {
            const next = copyFloor(building, number);
            const top = Math.max(...next.floors.map((one) => one.number));
            commit(next, underlay ? { ...underlays, [String(top)]: { ...underlay } } : underlays);
            setFloorNo(Math.max(...next.floors.map((one) => one.number)));
          }}
        >
          Копировать этаж
        </Button>
        <Button
          kind="ghost"
          disabled={building.floors.length >= MAX_FLOORS}
          onClick={() => {
            const next = addFloor(building);
            commit(next);
            setFloorNo(Math.max(...next.floors.map((one) => one.number)));
          }}
        >
          Пустой этаж
        </Button>
        <Button
          kind="ghost"
          disabled={building.floors.length <= 1}
          onClick={() => {
            const remaining = { ...underlays };
            delete remaining[String(number)];
            commit(removeFloor(building, number), remaining);
            setFloorNo(floors.find((one) => one.number !== number)!.number);
            setPicked("");
          }}
        >
          Удалить этаж
        </Button>
      </div>

      <div className="c-underlay-bar">
        <input
          ref={upload}
          type="file"
          hidden
          accept=".png,.jpg,.jpeg,.webp,.dxf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              setShowImage(true);
              onUpload(file, number);
            }
          }}
        />
        <Button kind="ghost" disabled={busy} onClick={() => upload.current?.click()}>
          {underlay ? "Заменить подложку этажа" : "Загрузить план этажа"}
        </Button>
        {underlay && (
          <>
            <Check label="Показывать подложку" checked={showImage} onToggle={() => setShowImage(!showImage)} />
            <span className="muted c-underlay-name" title={underlay.label}>
              {underlay.label}
            </span>
          </>
        )}
      </div>

      <p className="u-plan-todo">
        {bad.length
          ? `Исправьте ошибки плана: ${bad.length}. Нажмите на замечание под листом.`
          : "Проверьте помещения и лифты на каждом этаже. Затем задайте объемы работы ниже."}
      </p>
      <div
        className={`u-draft${full ? " is-full" : ""}${!legend && !item && !section && !touring && !underlay ? " is-calm" : ""}`}
      >
        <Tools>
          <Modes
            label="Режим чертежа"
            value={mode}
            options={[
              { id: "build", name: "Здание", hint: "Пол и контур этажа" },
              { id: "furnish", name: "Обстановка", hint: "Помещения, двери, лифты и базы" },
            ]}
            onChange={switchMode}
          />
          <p className="u-modes-note">
            {mode === "build" ? "Пол, секции и контур этажа" : "Помещения, двери, лифты и зарядки"}
          </p>
          {[
            { title: "", tools: currentTools.slice(0, 1) },
            { title: mode === "build" ? "Здание" : "Корпус", tools: currentTools.slice(1, mode === "build" ? 2 : 4) },
            { title: "На этаже", tools: currentTools.slice(mode === "build" ? 2 : 4) },
          ].map((group) => {
            const buttons = group.tools.map((one) => (
              <Tool
                key={one.id}
                active={tool === one.id}
                onPick={() => {
                  setTool(one.id);
                  if (one.id !== "select") setPicked("");
                  setViewKind("plan");
                  if (!narrow && !touring && one.id !== "select" && tourWanted(`lct.tips.clinic.${one.id}`))
                    setTip({ tool: one.id, top: 60 });
                }}
                glyph={<Glyph kind={one.id} />}
                name={one.name}
                note={one.note}
                hotkey={String(currentTools.indexOf(one) + 1)}
              />
            ));
            return group.title ? (
              <ToolGroup key={group.title} title={group.title}>
                {buttons}
              </ToolGroup>
            ) : (
              buttons
            );
          })}
        </Tools>

        {tip && !touring && (
          <ToolCard
            title={TOOLS.find((one) => one.id === tip.tool)!.name}
            text={TOOLS.find((one) => one.id === tip.tool)!.note}
            edit="Выберите вещь: свойства справа. Ctrl+Z отменяет последнее действие."
            scene={
              <svg className="u-sketch" viewBox="0 0 160 60">
                <rect x="4" y="4" width="152" height="52" />
                <rect x="12" y="12" width="50" height="32" />
                <path d="M62 28h70" strokeDasharray="4 4" />
              </svg>
            }
            top={tip.top}
            onClose={() => setTip(null)}
            onNever={() => {
              tourSeen(`lct.tips.clinic.${tip.tool}`);
              setTip(null);
            }}
          />
        )}
        <div className="u-draft-main" onPointerDownCapture={() => setTip(null)}>
          {viewKind === "building" ? (
            <BuildingOverview
              building={building}
              active={number}
              onPick={(next) => {
                setFloorNo(next);
                setPicked("");
                setViewKind("plan");
              }}
            />
          ) : (
            <Board
              widthM={floor.width_m}
              lengthM={floor.length_m}
              fit={{ x: 0, y: 0, w: floor.width_m, h: floor.length_m }}
              fitKey={`${number}:${floor.width_m}:${floor.length_m}`}
              onDown={down}
              onMove={move}
              onUp={up}
              onView={(view: View) => {
                scale.current = view.s;
              }}
              cursor={tool === "select" ? "default" : "crosshair"}
              label={`План этажа ${number}, ${floor.width_m} на ${floor.length_m} метров`}
              status={TOOLS.find((one) => one.id === tool)?.name.toLowerCase()}
              hint={<span>{hint || TOOLS.find((one) => one.id === tool)?.note}</span>}
              corner={
                <>
                  <IconButton label={full ? "Свернуть чертеж" : "Развернуть чертеж"} onClick={() => setFull(!full)}>
                    <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
                  </IconButton>
                  <IconButton label="Отменить, Ctrl+Z" onClick={undo}>
                    <path d="M5 3.5L2.5 6 5 8.5M2.5 6h6.5a3.5 3.5 0 0 1 0 7H6" />
                  </IconButton>
                  <IconButton label="Повторить, Ctrl+Shift+Z" onClick={redo}>
                    <path d="M10 3.5L12.5 6 10 8.5M12.5 6H6a3.5 3.5 0 0 0 0 7h3" />
                  </IconButton>
                </>
              }
            >
              {(view) => (
                <>
                  {underlay && showImage && (
                    <image
                      href={underlay.src}
                      x={underlay.x}
                      y={floor.length_m - underlay.y - underlay.h}
                      width={underlay.w}
                      height={underlay.h}
                      opacity={underlay.opacity}
                      preserveAspectRatio="none"
                      pointerEvents="none"
                    />
                  )}
                  <FloorDrawing floor={floor} scale={view.s} flagOf={flagOf} />
                  {draw && (
                    <rect
                      x={draw.x}
                      y={floor.length_m - draw.y - draw.h}
                      width={draw.w}
                      height={draw.h}
                      className="u-marquee"
                    />
                  )}
                  {selectedBox && (
                    <rect
                      x={selectedBox.x}
                      y={screenY(selectedBox)}
                      width={selectedBox.w}
                      height={selectedBox.h}
                      className="u-picked"
                      strokeWidth={2 / view.s}
                    />
                  )}
                  {grip(selectedBox) && (
                    <rect
                      x={grip(selectedBox)!.x - 4 / view.s}
                      y={floor.length_m - grip(selectedBox)!.y - 4 / view.s}
                      width={8 / view.s}
                      height={8 / view.s}
                      className="u-handle"
                    />
                  )}
                </>
              )}
            </Board>
          )}
          <div className="u-draft-views">
            <Modes
              small
              label="Вид чертежа"
              value={viewKind}
              options={[
                { id: "plan", name: "План этажа" },
                { id: "building", name: "Здание целиком" },
              ]}
              onChange={setViewKind}
            />
            <button
              type="button"
              className={`u-legend-toggle${legend ? " is-on" : ""}`}
              aria-pressed={legend}
              onClick={() => setLegend(!legend)}
            >
              Легенда
            </button>
          </div>
        </div>

        <div className="u-side">
          {section ? (
            <Window
              title="Секция этажа"
              note="Часть пола; объединение секций задает контур"
              onClose={() => setPicked("")}
              footer={
                <Button kind="ghost" onClick={remove}>
                  Удалить секцию
                </Button>
              }
            >
              <FieldPair
                label="Размер"
                sep="×"
                a={{
                  value: section.w,
                  onChange: (v) =>
                    Number(v) >= 2 && commit(patchSection(building, number, section.id, { ...section, w: Number(v) })),
                }}
                b={{
                  value: section.h,
                  unit: "м",
                  onChange: (v) =>
                    Number(v) >= 2 && commit(patchSection(building, number, section.id, { ...section, h: Number(v) })),
                }}
              />
              <p>Изменение этой секции не меняет остальные этажи. Помещения вне пола будут отмечены проверкой.</p>
            </Window>
          ) : item ? (
            <ItemFields
              item={item}
              building={building}
              number={number}
              floors={floors.map((one) => one.number)}
              onCommit={commit}
              onInvalid={setHint}
              onRemove={remove}
              onClose={() => setPicked("")}
            />
          ) : (
            <>
              <h3>Этаж {number}</h3>
              <label className="u-own-field">
                <span>Название этажа</span>
                <span className="u-field-box">
                  <input
                    aria-label="Название этажа"
                    maxLength={80}
                    value={floor.name}
                    onChange={(event) =>
                      commit({
                        ...building,
                        floors: building.floors.map((one) =>
                          one.number === number ? { ...one, name: event.target.value } : one,
                        ),
                      })
                    }
                  />
                </span>
              </label>
              <MetersField
                label="Ширина"
                value={floor.width_m}
                onChange={(value) => commit(resizeFloor(building, number, value, floor.length_m))}
              />
              <MetersField
                label="Глубина"
                value={floor.length_m}
                onChange={(value) => commit(resizeFloor(building, number, floor.width_m, value))}
              />
              <p className="u-side-cap">Помещения</p>
              <Legend
                rows={[
                  { id: "ward", color: "var(--blue-tint)", name: "Пост отделения", value: "сюда возят" },
                  {
                    id: "pharmacy",
                    color: "color-mix(in srgb, var(--go) 18%, transparent)",
                    name: "Аптека",
                    value: "отсюда возят",
                  },
                  {
                    id: "supplies",
                    color: "color-mix(in srgb, var(--lvl-2) 60%, transparent)",
                    name: "Склад расходников",
                  },
                  { id: "other", color: "var(--paper-cool)", name: "Другое" },
                ]}
              />
              <p>
                Коридор это пол вне помещений, его не рисуют. Стены идут по краю помещения, в коридор ведет дверь.
                {corridor != null && ` Коридоров на этаже ${Math.round(corridor)} м2.`}
              </p>
              {underlay && (
                <div className="c-underlay-controls">
                  <h3>Подложка этажа</h3>
                  <label className="u-own-field">
                    <span>Прозрачность: {Math.round(underlay.opacity * 100)}%</span>
                    <input
                      type="range"
                      aria-label="Прозрачность подложки"
                      min={10}
                      max={100}
                      value={Math.round(underlay.opacity * 100)}
                      onChange={(event) =>
                        onUnderlays({
                          ...underlays,
                          [String(number)]: { ...underlay, opacity: Number(event.target.value) / 100 },
                        })
                      }
                    />
                  </label>
                  {(
                    [
                      ["x", "Сдвиг X, м"],
                      ["y", "Сдвиг Y, м"],
                      ["w", "Ширина подложки, м"],
                      ["h", "Глубина подложки, м"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="u-own-field c-dimension">
                      <span>{label}</span>
                      <span className="u-field-box">
                        <input
                          type="number"
                          aria-label={label}
                          step={0.5}
                          value={underlay[key]}
                          onChange={(event) => {
                            const value = event.target.valueAsNumber;
                            if (
                              Number.isFinite(value) &&
                              Math.abs(value) <= 500 &&
                              (key === "x" || key === "y" || value > 0)
                            )
                              onUnderlays({ ...underlays, [String(number)]: { ...underlay, [key]: value } });
                          }}
                        />
                      </span>
                    </label>
                  ))}
                  <Button
                    kind="ghost"
                    onClick={() =>
                      onUnderlays({
                        ...underlays,
                        [String(number)]: { ...underlay, x: 0, y: 0, w: floor.width_m, h: floor.length_m },
                      })
                    }
                  >
                    Вписать в этаж
                  </Button>
                  <Button
                    kind="ghost"
                    disabled={busy || rotating}
                    onClick={() => {
                      setRotating(true);
                      void rotateClinicImage(underlay)
                        .then((image) => onUnderlays({ ...underlays, [String(number)]: image }))
                        .catch(() => setHint("Не удалось повернуть подложку"))
                        .finally(() => setRotating(false));
                    }}
                  >
                    Повернуть на 90°
                  </Button>
                  <Button
                    kind="danger"
                    onClick={() => {
                      const next = { ...underlays };
                      delete next[String(number)];
                      onUnderlays(next);
                    }}
                  >
                    Удалить подложку
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {touring && (
        <Tour
          key={tourKind}
          steps={tourSteps}
          onIndex={onTourIndex}
          onClose={(why) => {
            if (why !== "later") tourSeen(tourKey);
            setTourOn(false);
          }}
        />
      )}
      {!narrow && tourOn === null && tourWanted(tourKey) && (
        <TourAsk
          target=".c-building .u-board"
          text='Пара минут: этажи, помещения, двери и лифты. Затем можно попробовать самому. Обучение всегда доступно по кнопке "Как пользоваться".'
          onYes={() => {
            setTourKind("choice");
            setTourOn(true);
            setLegend(true);
          }}
          onNo={(never) => {
            if (never) tourSeen(tourKey);
            setTourOn(false);
          }}
        />
      )}

      <div className="u-plan-foot">
        <div className={bad.length ? "u-checks-box is-bad" : "u-checks-box"} aria-live="polite">
          {routeControls}
          <p className="u-checks-head">
            <b>Проверка плана</b>
            <span className="mono">
              {checkError
                ? "сервер не ответил"
                : !check
                  ? "проверяем"
                  : bad.length
                    ? `ошибок ${bad.length}, замечаний ${warn.length}`
                    : warn.length
                      ? `ошибок нет, замечаний ${warn.length}`
                      : "все пройдено"}
            </span>
          </p>
          {checkError && <p className="u-checks-detail">{checkError}</p>}
          {check?.checks
            .filter((one) => one.code === "reach")
            .map((one) => (
              <p className="u-checks-detail" key={one.code}>
                {one.text}
              </p>
            ))}
          <ul className="u-checks">
            {[...bad, ...warn].map((one, index) => (
              <li key={`${one.code}:${one.target}:${index}`} className="is-bad">
                <button type="button" className="c-check" onClick={() => pickTarget(one.target, one.floor)}>
                  <span className="u-checks-name">
                    {one.level === "error" ? "Ошибка" : "Замечание"}
                    {one.floor != null && `, этаж ${one.floor}`}
                  </span>
                  <span className="u-checks-detail">{one.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* Размер этажа в колонке справа: поле как у прозрачности подложки склада, правка уходит по Enter
   или уходу из поля, иначе каждый символ двигал бы вещи за край */
function MetersField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => {
    const next = Number((draft ?? "").replace(",", "."));
    if (draft !== null && Number.isFinite(next) && next >= 10 && next <= 200 && next !== value) onChange(next);
    setDraft(null);
  };
  return (
    <label className="u-own-field">
      <span className="u-frow-name">{label}</span>
      <span className="u-field-box">
        <input
          className="mono"
          inputMode="decimal"
          aria-label={`${label} этажа, м`}
          title="от 10 до 200 м"
          value={draft ?? String(value)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={apply}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        />
        <span className="u-field-unit">м</span>
      </span>
    </label>
  );
}

/* Окно свойств выбранной вещи: те же числа, что на листе, плюс то, что мышью не задать */
function ItemFields({
  item,
  building,
  number,
  floors,
  onCommit,
  onInvalid,
  onRemove,
  onClose,
}: {
  item: Item;
  building: Building;
  number: number;
  floors: number[];
  onCommit: (next: Building) => void;
  onInvalid: (message: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const patch = (change: Partial<Item>) => onCommit(patchItem(building, number, item.id, change));
  const resize = (width: number, height: number) => {
    const next = resizeItem(building, number, item.id, width, height);
    onInvalid(next === building ? "В помещении такого размера двери пересекаются или не помещаются в стене." : "");
    onCommit(next);
  };
  const remove = (
    <Button kind="ghost" onClick={onRemove}>
      {item.kind === "lift" ? "Убрать остановку на этаже" : "Удалить"}
    </Button>
  );
  if (item.kind === "room")
    return (
      <Window title="Помещение" note={`${item.w} × ${item.h} м`} onClose={onClose} footer={remove}>
        <label className="u-own-field">
          <span className="u-frow-name">Название</span>
          <span className="u-field-box">
            <input value={item.name} maxLength={80} onChange={(event) => patch({ name: event.target.value })} />
          </span>
        </label>
        <label className="u-own-field">
          <span className="u-frow-name">Что в помещении</span>
          <Select
            label="Что в помещении"
            value={item.role || "other"}
            options={ROLES}
            onChange={(role) => patch({ role: role as Role })}
          />
        </label>
        <FieldPair
          label="Размер"
          hint="ширина × глубина"
          sep="×"
          a={{
            value: item.w,
            step: "1",
            onChange: (next) => Number(next) >= 3 && resize(Number(next), item.h),
          }}
          b={{
            value: item.h,
            step: "1",
            unit: "м",
            onChange: (next) => Number(next) >= 3 && resize(item.w, Number(next)),
          }}
        />
      </Window>
    );
  if (item.kind === "door")
    return (
      <Window title="Дверь" note="Проем в стене помещения" onClose={onClose} footer={remove}>
        <FieldRow
          label="Ширина проема, мм"
          hint="палата 1200, кабинет 900 по СП 158.13330"
          unit=""
          value={item.width_mm}
          onChange={(next) => {
            const value = Number(next);
            if (value >= 600 && value <= 4000) {
              const next = setDoorWidth(building, number, item.id, value);
              onInvalid(
                next === building ? "Проем такой ширины пересекается с другой дверью или не помещается в стене." : "",
              );
              onCommit(next);
            }
          }}
        />
        <Check
          label="Открывается сама"
          checked={item.automatic}
          onToggle={() => patch({ automatic: !item.automatic })}
        />
        {!item.automatic && <p className="u-window-note">Ручную дверь робот ждет, пока ее откроет человек.</p>}
      </Window>
    );
  if (item.kind === "lift") {
    const lift = building.lifts.find((one) => one.id === item.lift);
    const set = (change: Partial<Lift>) =>
      onCommit({
        ...building,
        lifts: building.lifts.map((one) => (one.id === item.lift ? { ...one, ...change } : one)),
      });
    return (
      <Window
        title={lift?.name || `Лифт ${item.lift}`}
        note="Одна шахта на все этажи"
        onClose={onClose}
        footer={remove}
      >
        {lift && (
          <>
            <Check
              label="Робот вызывает лифт сам"
              checked={lift.robots}
              onToggle={() => set({ robots: !lift.robots })}
            />
            {!lift.robots && <p className="u-window-note">Без интеграции робот этим лифтом не ездит.</p>}
            {lift.robots && (
              <p className="u-window-note">
                У выбранной модели робота тоже должна быть подтверждена работа с лифтом. Модель указана в проверке плана
                под чертежом.
              </p>
            )}
            <FieldPair
              label="Кабина"
              hint="ширина × глубина"
              sep="×"
              a={{
                value: lift.cabin_w_mm,
                step: "50",
                onChange: (next) => Number(next) > 0 && set({ cabin_w_mm: Number(next) }),
              }}
              b={{
                value: lift.cabin_d_mm,
                step: "50",
                unit: "мм",
                onChange: (next) => Number(next) > 0 && set({ cabin_d_mm: Number(next) }),
              }}
            />
            <FieldRow
              label="Двери кабины, мм"
              unit=""
              value={lift.door_mm}
              onChange={(next) => Number(next) > 0 && set({ door_mm: Number(next) })}
            />
            <FieldRow
              label="Люди вызывают лифт"
              hint="раз в час, люди едут первыми"
              unit=""
              value={lift.people_calls_per_hour}
              onChange={(next) =>
                Number(next) >= 0 && Number(next) <= 120 && set({ people_calls_per_hour: Number(next) })
              }
            />
          </>
        )}
        <p className="u-side-cap">Остановки</p>
        {floors.map((one) => {
          const stops = building.floors.filter((floor) => floor.items.some((other) => other.lift === item.lift)).length;
          const here = building.floors
            .find((floor) => floor.number === one)
            ?.items.some((other) => other.lift === item.lift);
          return (
            <Check
              key={one}
              label={`${one} этаж`}
              checked={Boolean(here)}
              disabled={Boolean(here) && stops === 1}
              title={here && stops === 1 ? "Последняя остановка: удалите лифт кнопкой ниже" : undefined}
              onToggle={() => onCommit(toggleStop(building, item.lift, one))}
            />
          );
        })}
      </Window>
    );
  }
  return (
    <Window
      title={item.kind === "charge" ? (item.role === "cleaning" ? "База уборщика" : "Зарядка") : "Преграда"}
      note={`${item.w} × ${item.h} м`}
      onClose={onClose}
      footer={remove}
    >
      {item.kind === "charge" ? (
        <Check
          label="Для уборщика этажа"
          checked={item.role === "cleaning"}
          onToggle={() => patch({ role: item.role === "cleaning" ? "" : "cleaning" })}
        />
      ) : (
        <p className="u-window-note">Робот здесь не проедет, путь пойдет в обход.</p>
      )}
    </Window>
  );
}

function Glyph({ kind }: { kind: ToolName }) {
  const paths: Record<ToolName, string> = {
    select: "M4 2.5l8 5.2-3.6.8 2 3.8-1.6.8-2-3.8-2.8 2.4z",
    section: "M2 2h12v12H2zM8 2v12M2 8h12",
    room: "M2.5 3.5h11v9h-11zM2.5 8.5h4",
    door: "M3 13V3h6v10M9 4l3 1v8l-3-1M7.5 8.2v.6",
    lift: "M3.5 2.5h9v11h-9zM3.5 2.5l9 11M12.5 2.5l-9 11",
    charge: "M8.5 2.5L4.5 9h3l-.5 4.5 4.5-7h-3z",
    base: "M3 12.5h10M5 12.5V6l3-3 3 3v6.5M7 12.5v-3h2v3",
    blocked: "M2.5 2.5h11v11h-11zM2.5 8l5.5-5.5M2.5 13.5l11-11M8 13.5l5.5-5.5",
  };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d={paths[kind]} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
