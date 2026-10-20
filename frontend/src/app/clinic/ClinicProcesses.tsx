import { useEffect, useState } from "react";
import { api, type ClinicWorkload } from "../../api/client";
import { Alert, BlockHead, Button, Check, Select } from "../../ui";
import { number, percent } from "../format";
import type { Building, ClinicScenario, DeliveryProcess } from "./building";
import { scenarioOf } from "./processes";

const LABELS = { meds: "Лекарства", supplies: "Расходники" } as const;

export function ClinicProcesses({
  building,
  onChange,
  overrides,
  operationIds,
}: {
  building: Building;
  onChange: (building: Building) => void;
  overrides: Record<string, number>;
  operationIds: string[];
}) {
  const scenario = scenarioOf(building);
  const [response, setResponse] = useState<{ key: string; data?: ClinicWorkload; error?: string } | null>(null);
  const mine = Object.fromEntries(Object.entries(overrides).filter(([key]) => key.startsWith("clinic.")));
  const key = JSON.stringify([building, mine, operationIds]);
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .clinicWorkload({ building, overrides: mine, operation_ids: operationIds }, abort.signal)
        .then((data) => setResponse({ key, data }))
        .catch((error: unknown) => {
          if (!abort.signal.aborted) setResponse({ key, error: error instanceof Error ? error.message : "Нет ответа" });
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const data = response?.key === key ? response.data : null;
  const error = response?.key === key ? response.error : "";
  const set = (patch: Partial<ClinicScenario>) => onChange({ ...building, scenario: { ...scenario, ...patch } });
  const rooms = building.floors.flatMap((f) =>
    f.items
      .filter((i) => i.kind === "room")
      .map((i) => ({
        id: i.id,
        name: `${f.number} эт. · ${i.name || i.id}`,
        role: i.role,
      })),
  );
  const wards = rooms.filter((r) => r.role === "ward");
  return (
    <section className="c-processes">
      <BlockHead
        title="Масштаб и процессы"
        note="Эти настройки сохраняются с корпусом и используются в подборе, экономике и прогоне"
      />
      <p className="muted">
        Сначала задайте здание и точки обслуживания, затем объемы и расписание. Увеличение площади удлиняет маршруты и
        увеличивает уборку; нагрузка доставки зависит от выбранного способа задания объема.
      </p>
      <div className="c-process-actions">
        <Button kind="ghost" onClick={() => set({ shift_start_h: 7, shift_hours: 8, cleaning_passes: 1 })}>
          Дневное окно, 8 ч
        </Button>
        <Button
          kind="ghost"
          onClick={() => set({ shift_start_h: 8, shift_hours: 12, cleaning_passes: 2, days_per_year: 247 })}
        >
          Амбулатория 5/2, 08-20
        </Button>
        <Button
          kind="ghost"
          onClick={() => set({ shift_start_h: 7, shift_hours: 24, cleaning_passes: 2, days_per_year: null })}
        >
          Стационар, сутки
        </Button>
      </div>
      <div className="c-process-fields">
        <Numeric
          label="Начало прогона, час суток"
          value={scenario.shift_start_h}
          min={0}
          max={23}
          onChange={(shift_start_h) => set({ shift_start_h })}
        />
        <Numeric
          label="Длительность прогона, ч"
          value={scenario.shift_hours}
          min={1}
          max={24}
          onChange={(shift_hours) => set({ shift_hours })}
        />
        <Numeric
          label="Дней работы в году"
          value={scenario.days_per_year ?? null}
          placeholder="По умолчанию: 365"
          min={1}
          max={366}
          onChange={(days_per_year) => set({ days_per_year })}
          nullable
        />
        <label className="u-own-field">
          <span>Распределение суточных заявок</span>
          <Select
            label="Распределение суточных заявок"
            value={scenario.schedule}
            onChange={(value) => {
              const schedule = value as ClinicScenario["schedule"];
              set({
                schedule,
                hourly_weights:
                  schedule === "custom" && scenario.hourly_weights.length !== 24
                    ? Array(24).fill(1)
                    : scenario.hourly_weights,
              });
            }}
            options={[
              { id: "industry", name: "Отраслевой профиль с пиками" },
              { id: "uniform", name: "Равномерно в течение суток" },
              { id: "custom", name: "Свои веса по часам суток" },
            ]}
          />
        </label>
      </div>
      {scenario.schedule === "custom" && (
        <>
          <p className="muted">
            Веса делят суточный объем между часами. Ноль выключает поступление; сумма нормируется автоматически. Для
            работы только днем задайте ночным часам нули.
          </p>
          <div className="c-hour-weights">
            {scenario.hourly_weights.map((weight, hour) => (
              <Numeric
                key={hour}
                label={`${String(hour).padStart(2, "0")}:00`}
                value={weight}
                min={0}
                max={1000000}
                step={0.1}
                onChange={(value) =>
                  set({ hourly_weights: scenario.hourly_weights.map((old, index) => (index === hour ? value : old)) })
                }
              />
            ))}
          </div>
        </>
      )}
      {operationIds.includes("floor_delivery") && (
        <>
          <div className="c-process-cards">
            {(["meds", "supplies"] as const).map((kind) => (
              <DeliveryEditor
                key={kind}
                kind={kind}
                process={scenario[kind]}
                rooms={rooms}
                onChange={(process) => set({ [kind]: process })}
              />
            ))}
          </div>
          <details>
            <summary>Неравномерная нагрузка постов</summary>
            <p className="muted">
              1: обычный пост, 2: удвоенная нагрузка, 0: исключен. При пересчете по постам веса увеличивают общий объем;
              при фиксированном объеме делят его между получателями. Явные маршруты используют свои объемы.
            </p>
            <div className="c-process-fields">
              {wards.map((ward) => (
                <Numeric
                  key={ward.id}
                  label={`Вес: ${ward.name}`}
                  value={scenario.point_weights[ward.id] ?? 1}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(value) => set({ point_weights: { ...scenario.point_weights, [ward.id]: value } })}
                />
              ))}
            </div>
          </details>
        </>
      )}
      {operationIds.includes("cleaning") && (
        <details open>
          <summary>Уборка по этажам</summary>
          <p className="muted">
            Число полных проходов по коридорам за все окно прогона. Ноль исключает этаж из уборки. Комнаты и санитарная
            обработка поверхностей сюда не входят.
          </p>
          <div className="c-process-fields">
            <Numeric
              label="Проходов по умолчанию"
              value={scenario.cleaning_passes}
              min={0}
              max={12}
              step={0.5}
              onChange={(cleaning_passes) => set({ cleaning_passes })}
            />
            {building.floors.map((f) => (
              <Numeric
                key={f.number}
                label={`Проходов: ${f.name || `${f.number} этаж`}`}
                value={scenario.floor_cleaning_passes[f.number] ?? null}
                placeholder={`По умолчанию: ${scenario.cleaning_passes}`}
                min={0}
                max={12}
                step={0.5}
                onChange={(value) => {
                  const next = { ...scenario.floor_cleaning_passes };
                  if (value === null) delete next[f.number];
                  else next[f.number] = value;
                  set({ floor_cleaning_passes: next });
                }}
                nullable
              />
            ))}
          </div>
        </details>
      )}
      {error && <Alert>Проверьте процессы: {error}</Alert>}
      <div className="u-panel c-workload" aria-live="polite" aria-busy={!data && !error}>
        {data ? (
          <>
            <b>
              {data.floors} эт. · {number(data.area_m2, 0)} м² участков · {data.points} постов
            </b>
            <p>
              В окне {data.shift_hours} ч с {String(data.shift_start_h).padStart(2, "0")}:00 поступает{" "}
              {percent(data.daily_share)} суточных заявок. Взвешенных постов: {number(data.effective_points, 1)},
              исходный объем датасета рассчитан на {data.reference_points}.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Процесс</th>
                  <th>За сутки</th>
                  <th>За прогон</th>
                </tr>
              </thead>
              <tbody>
                {data.processes.map((p) => (
                  <tr key={p.kind}>
                    <td>{LABELS[p.kind as keyof typeof LABELS]}</td>
                    <td>{number(p.per_day, 1)} заявок</td>
                    <td>{number(p.in_window, 1)} заявок</td>
                  </tr>
                ))}
                {Object.keys(data.cleaning_m2).length > 0 && (
                  <tr>
                    <td>Коридоры, с учетом проходов</td>
                    <td>-</td>
                    <td>
                      {number(
                        Object.values(data.cleaning_m2).reduce((a, b) => a + b, 0),
                        0,
                      )}{" "}
                      м²
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="muted">
              Это ожидаемые объемы. Целое число заявок в прогоне округляется с учетом seed; разные seed могут отличаться
              на одну заявку по процессу.
            </p>
            {data.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </>
        ) : (
          !error && <p>Пересчитываем объемы…</p>
        )}
      </div>
      <p className="muted">
        Текущая модель: лекарства, расходники и полы коридоров одного корпуса. Питание, белье, отходы и межкорпусные
        переходы требуют отдельных процессов и характеристик грузов. Доступно до 20 этажей, сторона до 200 м, суммарные
        участки до 200 000 м² и до 5 000 заявок за прогон.
      </p>
    </section>
  );
}

function DeliveryEditor({
  kind,
  process,
  rooms,
  onChange,
}: {
  kind: "meds" | "supplies";
  process: DeliveryProcess;
  rooms: { id: string; name: string; role: string }[];
  onChange: (process: DeliveryProcess) => void;
}) {
  const set = (patch: Partial<DeliveryProcess>) => onChange({ ...process, ...patch });
  const candidates = rooms.filter((r) => r.role === (kind === "meds" ? "pharmacy" : "supplies"));
  const source = candidates[0]?.id ?? rooms[0]?.id ?? "";
  const target =
    rooms.find((r) => r.role === "ward" && r.id !== source)?.id ?? rooms.find((r) => r.id !== source)?.id ?? "";
  return (
    <div className="u-panel c-process-card">
      <h3>{LABELS[kind]}</h3>
      <Check
        label={`Включить: ${LABELS[kind].toLowerCase()}`}
        checked={process.enabled}
        onToggle={() => set({ enabled: !process.enabled })}
      />
      {process.enabled && (
        <>
          <label className="u-own-field">
            <span>Как задавать объем</span>
            <Select
              label={`Объем: ${LABELS[kind]}`}
              value={process.mode}
              onChange={(value) => set({ mode: value as DeliveryProcess["mode"] })}
              options={[
                { id: "per_point", name: "Пересчитать по числу и весам постов" },
                { id: "building", name: "Фиксированный объем на корпус" },
                { id: "routes", name: "Объемы по маршрутам" },
              ]}
            />
          </label>
          {process.mode !== "routes" ? (
            <>
              <Numeric
                label={
                  process.mode === "per_point"
                    ? `Исходный суточный объем: ${LABELS[kind]}`
                    : `Заявок в сутки на корпус: ${LABELS[kind]}`
                }
                value={process.per_day}
                placeholder="Из параметров объекта"
                min={0}
                max={20000}
                step={1}
                nullable
                onChange={(per_day) => set({ per_day })}
              />
              <p className="muted">
                {process.mode === "per_point"
                  ? "Исходный объем × сумма весов постов / исходное число точек датасета. Увеличение корпуса увеличивает поток."
                  : "Изменение размеров и числа постов не меняет общий суточный объем. Каждая заявка: отдельный рейс."}
              </p>
            </>
          ) : (
            <>
              <p className="muted">
                Одна строка: поток заявок от отправителя к получателю. Суточный объем равен сумме строк. При копировании
                этажа добавьте маршруты к новым получателям.
              </p>
              {process.flows.map((flow, index) => (
                <div className="c-process-flow" key={index}>
                  {(["source", "target"] as const).map((field) => (
                    <label key={field} className="u-own-field">
                      <span>{field === "source" ? "Откуда" : "Куда"}</span>
                      <Select
                        label={`${LABELS[kind]}: ${field === "source" ? "откуда" : "куда"} ${index + 1}`}
                        value={flow[field]}
                        onChange={(value) =>
                          set({
                            flows: process.flows.map((f, n) => (n === index ? { ...f, [field]: value } : f)),
                          })
                        }
                        options={[
                          ...(!rooms.some((r) => r.id === flow[field])
                            ? [{ id: flow[field], name: `Помещение удалено: ${flow[field]}` }]
                            : []),
                          ...rooms.map((r) => ({ id: r.id, name: r.name })),
                        ]}
                      />
                    </label>
                  ))}
                  <Numeric
                    label={`${LABELS[kind]}: заявок в сутки, маршрут ${index + 1}`}
                    value={flow.per_day}
                    min={0}
                    max={20000}
                    onChange={(per_day) =>
                      set({ flows: process.flows.map((f, n) => (n === index ? { ...f, per_day } : f)) })
                    }
                  />
                  <Button kind="ghost" onClick={() => set({ flows: process.flows.filter((_, n) => n !== index) })}>
                    Удалить маршрут
                  </Button>
                </div>
              ))}
              <Button
                kind="ghost"
                disabled={!source || !target || process.flows.length >= 400}
                onClick={() => set({ flows: [...process.flows, { source, target, per_day: 1 }] })}
              >
                Добавить маршрут: {LABELS[kind].toLowerCase()}
              </Button>
            </>
          )}
          <details>
            <summary>Срочность и время комплектации</summary>
            <div className="c-process-fields">
              <Numeric
                label={`Срочных заявок, %: ${LABELS[kind]}`}
                value={process.urgent_share === null ? null : process.urgent_share * 100}
                placeholder="Из отраслевых параметров"
                min={0}
                max={100}
                nullable
                onChange={(value) => set({ urgent_share: value === null ? null : value / 100 })}
              />
              <Numeric
                label={`Комплектация, мин: ${LABELS[kind]}`}
                value={process.picking_min}
                placeholder="По модели"
                min={0}
                max={240}
                nullable
                onChange={(picking_min) => set({ picking_min })}
              />
              <Numeric
                label={`Срок плановой заявки, мин: ${LABELS[kind]}`}
                value={process.deadline_min}
                placeholder="По модели"
                min={1}
                max={1440}
                nullable
                onChange={(deadline_min) => set({ deadline_min })}
              />
              <Numeric
                label={`Срок срочной заявки, мин: ${LABELS[kind]}`}
                value={process.urgent_deadline_min}
                placeholder="По модели"
                min={1}
                max={1440}
                nullable
                onChange={(urgent_deadline_min) => set({ urgent_deadline_min })}
              />
            </div>
            <p className="muted">
              Срок доставки отсчитывается после комплектации. Значения: условия сценария, пока нет измерений учреждения.
            </p>
          </details>
        </>
      )}
    </div>
  );
}

type NumericBase = { label: string; min: number; max: number; step?: number; placeholder?: string };
function Numeric(
  props: NumericBase &
    (
      | { nullable: true; value: number | null; onChange: (n: number | null) => void }
      | { nullable?: false; value: number; onChange: (n: number) => void }
    ),
) {
  return (
    <label className="u-own-field">
      <span className="u-frow-name">{props.label}</span>
      <span className="u-field-box">
        <input
          type="number"
          className="mono"
          aria-label={props.label}
          value={props.value ?? ""}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          placeholder={props.placeholder}
          onChange={(e) => {
            if (!e.target.value && props.nullable) {
              props.onChange(null);
              return;
            }
            const value = e.target.valueAsNumber;
            if (
              Number.isFinite(value) &&
              value >= props.min &&
              value <= props.max &&
              (props.step !== undefined || Number.isInteger(value))
            )
              props.onChange(value);
          }}
        />
      </span>
    </label>
  );
}
