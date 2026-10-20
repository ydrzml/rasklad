import { useEffect, useRef, useState } from "react";
import { api, type ClinicCheck, type ClinicRobots } from "../../api/client";
import { Alert, ask, BlockHead, Button, Check, Tour, tourSeen, tourWanted } from "../../ui";
import type { DxfDrawing } from "../plan/dxf";
import type { Underlay } from "../plan/underlay";
import { BuildingEditor } from "./BuildingEditor";
import { ClinicDxf } from "./ClinicDxf";
import { ClinicProcesses } from "./ClinicProcesses";
import { ClinicRouteRobot } from "./ClinicRouteRobot";
import { reconcileProcesses, scenarioOf } from "./processes";
import type { Building, ClinicScenario } from "./building";
import {
  CLINIC_TEMPLATES,
  cleanUnderlays,
  clinicDocument,
  dimensionsProblem,
  parseClinicDocument,
  type ClinicDimensions,
  type ClinicPlan as Plan,
} from "./plan";
import { CLINIC_PLAN_ACCEPT, clinicFileProblem, clinicImageFile } from "./upload";
import "./clinic.css";

export function ClinicPlan({
  building,
  plan,
  onChange,
  onPlan,
  check,
  checkError,
  operationIds,
  overrides,
  robots,
  robotId,
  onRobot,
}: {
  building: Building;
  plan: Plan | null;
  onChange: (next: Building) => void;
  onPlan: (next: Plan) => void;
  check: ClinicCheck | null;
  checkError: string;
  operationIds: string[];
  overrides: Record<string, number>;
  robots: ClinicRobots | null;
  robotId: string;
  onRobot: (id: string) => void;
}) {
  const [choosing, setChoosing] = useState(true);
  const [intro, setIntro] = useState(
    () => tourWanted("lct.tour.clinic.start") && !window.matchMedia("(max-width: 880px)").matches,
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState<ClinicDimensions>({
    width_m: 60,
    length_m: 24,
    floors: 2,
    wards_per_floor: 3,
    lifts: 1,
    furnished: true,
    floor_height_m: 3.3,
  });
  const [dxf, setDxf] = useState<{ drawing: DxfDrawing; name: string; floor?: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<symbol | null>(null);
  const latest = useRef({ building, plan });
  useEffect(() => {
    latest.current = { building, plan };
  }, [building, plan]);
  useEffect(
    () => () => {
      operation.current = null;
    },
    [],
  );

  const replace = async (
    next: Building,
    source: Plan["source"],
    title: string,
    underlays: Record<string, Underlay> = {},
    preserveProcesses = true,
  ) => {
    if (
      plan &&
      !(await ask({
        title: "Заменить план корпуса?",
        text: "Текущие помещения, этажи и подложки будут заменены новым корпусом. Сохраните JSON, если хотите вернуться к ним.",
        yes: "Заменить корпус",
        danger: true,
      }))
    )
      return;
    onChange(
      reconcileProcesses({ ...next, scenario: next.scenario ?? (preserveProcesses ? building.scenario : null) }),
    );
    onPlan({ source, title, revision: `${plan?.revision ?? "new"}:next`, underlays });
    setChoosing(false);
    setError("");
  };
  const perform = async (label: string, action: (active: () => boolean) => Promise<void>) => {
    const token = Symbol();
    operation.current = token;
    setBusy(label);
    setError("");
    try {
      await action(() => operation.current === token);
    } catch (failure) {
      if (operation.current === token)
        setError(failure instanceof Error ? failure.message : "Не удалось подготовить корпус");
    } finally {
      if (operation.current === token) {
        setBusy("");
        operation.current = null;
      }
    }
  };
  const generate = (
    params: ClinicDimensions,
    source: Plan["source"],
    title: string,
    schedule?: Partial<ClinicScenario>,
  ) =>
    void perform("Строим корпус...", async (active) => {
      const problem = dimensionsProblem(params);
      if (problem) throw new Error(problem);
      const next = await api.clinicGenerate(params);
      // режим работы приходит с типовым зданием, остальные процессы остаются прежними
      const scenario = schedule ? { ...scenarioOf(building), ...schedule } : next.scenario;
      if (active()) await replace({ ...next, scenario }, source, title);
    });
  const applyImage = async (underlay: Underlay, size: { width_m: number; length_m: number }, target?: number) => {
    const current = latest.current;
    if (target !== undefined && current.plan) {
      if (!current.building.floors.some((floor) => floor.number === target))
        throw new Error("Этот этаж уже удален. Выберите этаж заново");
      onPlan({ ...current.plan, underlays: { ...current.plan.underlays, [String(target)]: underlay } });
    } else {
      const next = await api.clinicGenerate({ ...form, ...size, floors: 1, furnished: false });
      await replace(next, "upload", underlay.label || "Загруженный план", { "1": underlay });
    }
  };
  const upload = (file: File, target?: number) =>
    void perform("Читаем файл...", async (active) => {
      const problem = clinicFileProblem(file);
      if (problem) throw new Error(problem);
      if (/\.json$/i.test(file.name)) {
        if (target !== undefined)
          throw new Error("JSON содержит весь корпус. Откройте его через выбор способа построения");
        const document = parseClinicDocument(await file.text());
        const next = await api.clinicImport(document.building);
        if (active()) await replace(next, "upload", file.name, cleanUnderlays(document.underlays, next), false);
      } else if (/\.dxf$/i.test(file.name)) {
        const drawing = await api.planDxf(file);
        if (active()) setDxf({ drawing, name: file.name, floor: target });
      } else {
        const floor = building.floors.find((one) => one.number === target);
        const size = floor ?? form;
        const params = { ...form, width_m: size.width_m, length_m: size.length_m, floors: 1, furnished: false };
        const invalid = dimensionsProblem(params);
        if (invalid) throw new Error(invalid);
        const image = await clinicImageFile(file, size.width_m, size.length_m);
        if (active()) await applyImage(image, size, target);
      }
    });
  const download = () => {
    if (!plan) return;
    const url = URL.createObjectURL(new Blob([clinicDocument(building, plan)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "clinic-building.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="c-plan">
      {choosing && (
        <BlockHead
          title={choosing ? "Откуда взять план корпуса" : plan?.title || "План корпуса"}
          note={
            choosing
              ? "Любой вариант можно редактировать. Этажи, двери и лифты учитываются в прогоне"
              : "Проверьте помещения, двери, зарядки и остановки лифтов"
          }
          aside={
            <>
              {plan && (
                <Button kind="ghost" disabled={!!busy} onClick={download}>
                  Сохранить JSON
                </Button>
              )}
              {plan && (
                <Button kind="ghost" disabled={!!busy} onClick={() => setChoosing(!choosing)}>
                  Вернуться к корпусу
                </Button>
              )}
            </>
          }
        />
      )}
      {error && <Alert>{error}</Alert>}
      {busy && (
        <p role="status" className="muted">
          {busy}
        </p>
      )}
      {choosing ? (
        <div className="u-start c-plan-start" aria-busy={!!busy}>
          <div className="u-start-card">
            <span className="u-start-tag mono">1 · быстрее всего</span>
            <h3>Типовая планировка</h3>
            <p>Четыре примера здания: помещения, общие точки отправки и разные этажи уже расставлены.</p>
            <div className="u-schemes">
              {CLINIC_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="u-scheme"
                  disabled={!!busy}
                  onClick={() =>
                    generate(
                      { ...template, furnished: true, floor_height_m: 3.3 },
                      "template",
                      template.name,
                      template.schedule,
                    )
                  }
                >
                  <TemplateSketch floors={template.floors} />
                  <span>
                    <b>{template.name}</b>
                    <small>{template.about}</small>
                    <small className="mono">
                      {template.width_m} × {template.length_m} м · {template.floors} эт.
                    </small>
                  </span>
                </button>
              ))}
            </div>
            <p className="u-start-note">
              План задает геометрию. Нагрузку, расписание и реально сокращаемые расходы укажите по своему объекту:
              типовой план сам по себе не обещает окупаемость.
            </p>
          </div>
          <div className="u-start-card">
            <span className="u-start-tag mono">2 · точнее</span>
            <h3>Свой корпус</h3>
            <p>Задайте этажность и размеры. Получите готовую расстановку или пустые этажи для черчения.</p>
            <form
              className="u-form"
              onSubmit={(event) => {
                event.preventDefault();
                generate(form, "custom", "Мой корпус");
              }}
            >
              <Dimension
                label="Ширина этажа, м"
                value={form.width_m}
                min={10}
                max={200}
                onChange={(width_m) => setForm({ ...form, width_m })}
              />
              <Dimension
                label="Глубина этажа, м"
                value={form.length_m}
                min={10}
                max={200}
                onChange={(length_m) => setForm({ ...form, length_m })}
              />
              <Dimension
                label="Количество этажей"
                value={form.floors}
                min={1}
                max={20}
                onChange={(floors) => setForm({ ...form, floors })}
              />
              <Dimension
                label="Высота этажа, м"
                value={form.floor_height_m}
                min={2.1}
                max={8}
                step={0.1}
                onChange={(floor_height_m) => setForm({ ...form, floor_height_m })}
              />
              <Check
                label="Сразу расставить помещения"
                checked={form.furnished}
                onToggle={() => setForm({ ...form, furnished: !form.furnished })}
              />
              {form.furnished && (
                <>
                  {form.floors > 1 && (
                    <Check
                      label="Разные планировки этажей"
                      checked={form.layout === "mixed"}
                      onToggle={() => setForm({ ...form, layout: form.layout === "mixed" ? "linear" : "mixed" })}
                    />
                  )}
                  <Dimension
                    label="Постов на каждом этаже"
                    value={form.wards_per_floor}
                    min={1}
                    max={8}
                    onChange={(wards_per_floor) => setForm({ ...form, wards_per_floor })}
                  />
                  {form.floors > 1 && (
                    <Dimension
                      label="Количество лифтов"
                      value={form.lifts}
                      min={1}
                      max={12}
                      onChange={(lifts) => setForm({ ...form, lifts })}
                    />
                  )}
                </>
              )}
              <p className="u-frow-hint">
                {form.furnished
                  ? "Аптека, расходники и зарядка доставки на первом этаже; база уборщика на каждом."
                  : "Этажи будут пустыми. Помещения, двери и зарядки добавите инструментами редактора."}
              </p>
              <div className="u-form-go">
                <Button disabled={!!busy}>{form.furnished ? "Построить корпус" : "Создать чистый лист"}</Button>
              </div>
            </form>
          </div>
          <div className="u-start-card">
            <span className="u-start-tag mono">3 · точнее всего</span>
            <h3>Загрузить план</h3>
            <p>Фото или схема этажа станут подложкой. JSON откроет сохраненный корпус целиком.</p>
            <div className="u-form">
              <Dimension
                label="Ширина на изображении, м"
                value={form.width_m}
                min={10}
                max={200}
                onChange={(width_m) => setForm({ ...form, width_m })}
              />
              <Dimension
                label="Глубина на изображении, м"
                value={form.length_m}
                min={10}
                max={200}
                onChange={(length_m) => setForm({ ...form, length_m })}
              />
              <p className="u-frow-hint">PNG, JPG, WebP: до 15 МБ. DXF: до 80 МБ, масштаб из чертежа. JSON: до 4 МБ.</p>
              <p className="u-frow-hint">
                Для картинки откроется один пустой этаж. Обведите помещения и двери; остальные этажи добавите в
                редакторе.
              </p>
              <input
                ref={input}
                type="file"
                accept={CLINIC_PLAN_ACCEPT}
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) upload(file);
                }}
              />
              <div className="u-form-go">
                <Button kind="ghost" disabled={!!busy} onClick={() => input.current?.click()}>
                  Выбрать файл плана
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        plan && (
          <BuildingEditor
            key={plan.revision}
            building={building}
            onChange={(next) => onChange(reconcileProcesses(next))}
            check={check}
            checkError={checkError}
            underlays={plan.underlays}
            onUnderlays={(underlays) => onPlan({ ...plan, underlays })}
            onUpload={upload}
            busy={!!busy}
            onRestart={() => setChoosing(true)}
            onSave={download}
            routeControls={
              operationIds.includes("floor_delivery") && (
                <ClinicRouteRobot
                  robots={robots}
                  robotId={robotId}
                  onPick={onRobot}
                  multiFloor={building.floors.length > 1}
                />
              )
            }
          />
        )
      )}
      {!choosing && plan && (
        <ClinicProcesses building={building} onChange={onChange} operationIds={operationIds} overrides={overrides} />
      )}
      {choosing && intro && (
        <Tour
          steps={[
            {
              target: ".c-plan-start",
              title: "Три способа подготовить план корпуса",
              text: (
                <>
                  <span className="u-tour-line">"Типовая планировка": готовое здание, которое можно изменить.</span>
                  <span className="u-tour-line">"Свой корпус": ваши размеры и этажность.</span>
                  <span className="u-tour-line">"Загрузить план": фото, DXF или сохраненный JSON.</span>
                  <span className="u-tour-line">
                    У каждого этажа могут быть свои размеры, контур и помещения. Начать заново можно из редактора.
                  </span>
                </>
              ),
            },
          ]}
          onClose={(why) => {
            if (why !== "later") tourSeen("lct.tour.clinic.start");
            setIntro(false);
          }}
        />
      )}
      {dxf && (
        <ClinicDxf
          drawing={dxf.drawing}
          name={dxf.name}
          onClose={() => setDxf(null)}
          onUse={async (image, size) => {
            await applyImage(image, size, dxf.floor);
            setDxf(null);
          }}
        />
      )}
    </section>
  );
}

function Dimension({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="u-own-field c-dimension">
      <span className="u-frow-name">{label}</span>
      <span className="u-field-box">
        <input
          type="number"
          className="mono"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          required
          value={Number.isFinite(value) ? value : ""}
          onChange={(event) => onChange(event.target.valueAsNumber)}
        />
      </span>
    </label>
  );
}

function TemplateSketch({ floors }: { floors: number }) {
  return (
    <svg className="u-sketch" viewBox="0 0 110 70" fill="none" aria-hidden="true">
      <rect x="5" y="8" width="100" height="54" rx="2" />
      {(floors === 1 ? [8, 30, 52, 74] : floors === 2 ? [8, 34, 60] : [8, 25, 42, 59, 76]).flatMap((x) =>
        [12, floors === 3 ? 46 : 42].map((y) => (
          <rect key={`${x}:${y}`} x={x} y={y} width={floors > 2 ? 14 : 19} height={floors === 3 ? 12 : 16} />
        )),
      )}
      <path d="M10 35h78" strokeDasharray="3 3" />
      <rect x="91" y="29" width="9" height="12" className="c-sketch-lift" />
      {floors > 1 && <path d="M94 32l2-2 2 2m-4 6 2 2 2-2" />}
    </svg>
  );
}
