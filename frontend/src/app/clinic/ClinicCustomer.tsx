import { useRef, useState } from "react";
import type { ClinicFinance, ClinicQuotes, Parameter } from "../../api/client";
import { Alert, BlockHead, Button, FieldRow } from "../../ui";
import type { Building } from "./building";
import { FINANCE_FIELDS, restoreClinicFinance } from "./finance";
import { downloadClinic, restoreClinicQuotes } from "./customer";

const INPUTS = [
  "clinic.drug_orders_per_day",
  "clinic.supply_trips_per_day",
  "clinic.drug_delivery_points",
  "clinic.drug_picking_min",
  "clinic.stat_share_pct",
  "clinic.payback_horizon_years",
];
const STAFF = [
  "delivery_staff_per_shift",
  "cleaning_staff_per_shift",
  "manual_delivery_min_per_job",
  "manual_cleaning_m2_per_hour",
  "delivery_hour_rub",
  "cleaner_hour_rub",
  "days_per_year",
  "cash_saving_cap_rub_year",
];

export function ClinicCustomer({
  parameters,
  overrides,
  onChange,
  finance,
  onFinance,
  quotes,
  onQuotes,
  building,
  tasks,
  name,
  onName,
  volumeModes,
  onVolumeMode,
}: {
  parameters: Parameter[];
  overrides: Record<string, number>;
  onChange: (key: string, value: number | null) => void;
  finance: ClinicFinance;
  onFinance: (value: ClinicFinance) => void;
  quotes: ClinicQuotes;
  onQuotes: (value: ClinicQuotes) => void;
  building: Building | null;
  tasks: string[];
  name: string;
  onName: (value: string) => void;
  volumeModes: { meds: string; supplies: string };
  onVolumeMode: (kind: "meds" | "supplies", mode: "per_point" | "building") => void;
}) {
  const upload = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const delivery = tasks.includes("floor_delivery"),
    cleaning = tasks.includes("cleaning");
  const fields = parameters.filter(
    (p) => INPUTS.includes(p.path) && (delivery || p.path.endsWith("payback_horizon_years")),
  );
  const inputOverrides = Object.fromEntries(Object.entries(overrides).filter(([key]) => key.startsWith("clinic.")));
  for (const [kind, path] of [
    ["meds", "clinic.drug_orders_per_day"],
    ["supplies", "clinic.supply_trips_per_day"],
  ] as const) {
    const value = building?.scenario?.[kind]?.per_day;
    if (value != null && volumeModes[kind] !== "routes") inputOverrides[path] = value;
  }
  return (
    <section className="c-customer">
      <BlockHead
        title="Данные вашего медучреждения"
        note="Пустое поле означает, что данных пока нет. При предварительном расчете допущения будут перечислены отдельно."
      />
      <label className="u-own-field">
        <span>Название объекта</span>
        <span className="u-field-box">
          <input
            value={name}
            maxLength={160}
            placeholder="Например, диагностический корпус"
            onChange={(e) => onName(e.target.value)}
          />
        </span>
      </label>
      <div className="c-process-actions">
        <Button kind="ghost" href="/calc?new=1">
          Новый объект
        </Button>
        <Button
          kind="ghost"
          onClick={() => {
            fields.forEach((p) => onChange(p.path, p.value));
            onVolumeMode("meds", "per_point");
            onVolumeMode("supplies", "per_point");
            onFinance({ ...finance, days_per_year: 365 });
          }}
        >
          Заполнить отраслевой пример
        </Button>
        <Button
          kind="ghost"
          onClick={() =>
            downloadClinic(
              "medical-inputs.json",
              JSON.stringify(
                {
                  format: "clinic-inputs-v1",
                  name,
                  overrides: inputOverrides,
                  finance,
                  quotes,
                  volume_modes: volumeModes,
                },
                null,
                2,
              ),
              "application/json",
            )
          }
        >
          Сохранить исходные данные
        </Button>
        <Button kind="ghost" onClick={() => upload.current?.click()}>
          Загрузить исходные данные
        </Button>
        <input
          ref={upload}
          hidden
          type="file"
          accept=".json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              if (file.size > 2e6) throw Error("Файл исходных данных: до 2 МБ");
              const doc = JSON.parse(await file.text());
              if (
                doc.format !== "clinic-inputs-v1" ||
                !doc.overrides ||
                typeof doc.overrides !== "object" ||
                Array.isArray(doc.overrides)
              )
                throw Error("Ожидается JSON исходных данных медучреждения");
              const known = new Set(parameters.map((p) => p.path));
              if (doc.finance && (typeof doc.finance !== "object" || Array.isArray(doc.finance)))
                throw Error("Некорректные финансовые условия");
              const importedFinance = restoreClinicFinance(doc.finance);
              if (
                Object.keys(doc.finance ?? {}).some(
                  (key) => importedFinance[key as keyof ClinicFinance] !== doc.finance[key],
                )
              )
                throw Error("Финансовые условия содержат неизвестные или недопустимые значения");
              if (doc.quotes && (typeof doc.quotes !== "object" || Array.isArray(doc.quotes)))
                throw Error("Некорректные предложения поставщиков");
              const importedQuotes = restoreClinicQuotes(doc.quotes);
              for (const [id, value] of Object.entries(doc.quotes ?? {})) {
                if (!value || typeof value !== "object" || Array.isArray(value) || !importedQuotes[id])
                  throw Error("Некорректное предложение поставщика");
                if (
                  Object.entries(value).some(
                    ([key, amount]) => importedQuotes[id][key as keyof (typeof importedQuotes)[string]] !== amount,
                  )
                )
                  throw Error("Предложение содержит неизвестные или недопустимые условия");
              }
              for (const [key, value] of Object.entries(doc.overrides))
                if (!known.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0)
                  throw Error("Некорректный параметр: " + key);
              for (const kind of ["meds", "supplies"] as const) {
                const mode = doc.volume_modes?.[kind] ?? "building";
                if (!["per_point", "building", "routes"].includes(mode))
                  throw Error("Неизвестный способ задания объема");
                if (mode === "routes" && volumeModes[kind] !== "routes")
                  throw Error("Для профиля с маршрутами сначала загрузите сохраненный корпус JSON");
              }
              for (const key of Object.keys(overrides).filter((key) => key.startsWith("clinic."))) onChange(key, null);
              for (const [key, value] of Object.entries(doc.overrides)) onChange(key, value as number);
              onFinance(importedFinance);
              onQuotes(importedQuotes);
              for (const kind of ["meds", "supplies"] as const) {
                const mode = doc.volume_modes?.[kind] ?? "building";
                if (mode !== "routes") onVolumeMode(kind, mode);
              }
              if (typeof doc.name === "string") onName(doc.name.slice(0, 160));
              setError("");
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : "Не удалось прочитать файл");
            }
          }}
        />
      </div>
      {error && <Alert>{error}</Alert>}
      <Alert tone="note">
        Площадь, этажи и помещения берутся из плана корпуса.{" "}
        {building
          ? `В вашем плане ${building.floors.length} эт., ${Math.round(building.floors.reduce((s, f) => s + f.width_m * f.length_m, 0)).toLocaleString("ru-RU")} м² участков.`
          : "На следующем шаге выберите или создайте здание."}{" "}
        Укажите сотрудников, участвующих в выбранных процессах и окне работы этого корпуса.
      </Alert>
      <div className="c-process-fields">
        {fields
          .filter(
            (field) =>
              !field.path.endsWith("drug_delivery_points") ||
              volumeModes.meds === "per_point" ||
              volumeModes.supplies === "per_point",
          )
          .map((field) => (
            <FieldRow
              key={field.path}
              label={
                field.path.endsWith("drug_orders_per_day")
                  ? "Заявок лекарств в сутки"
                  : field.path.endsWith("supply_trips_per_day")
                    ? "Рейсов расходников в сутки"
                    : field.label
              }
              unit={field.unit}
              value={inputOverrides[field.path] ?? ""}
              hint={`Отраслевой пример: ${field.value.toLocaleString("ru-RU")} ${field.unit}. ${field.path.endsWith("drug_delivery_points") ? "Число постов исходного примера для пересчета объема; фактические посты задаются планом." : "За диапазоном примера можно вводить свои физически допустимые значения."}`}
              onChange={(value) => {
                onChange(field.path, value === "" ? null : Number(value));
                if (field.path.endsWith("drug_orders_per_day")) onVolumeMode("meds", "building");
                if (field.path.endsWith("supply_trips_per_day")) onVolumeMode("supplies", "building");
              }}
            />
          ))}
      </div>
      {delivery && (
        <p className="muted">
          При вводе собственных суточных объемов они относятся ко всему корпусу и не умножаются на число постов. Текущий
          способ: лекарства:{" "}
          {volumeModes.meds === "per_point"
            ? "пересчет отраслевого примера по постам"
            : volumeModes.meds === "routes"
              ? "явные маршруты"
              : "объем на корпус"}
          ; расходники:{" "}
          {volumeModes.supplies === "per_point"
            ? "пересчет отраслевого примера по постам"
            : volumeModes.supplies === "routes"
              ? "явные маршруты"
              : "объем на корпус"}
          . Подробные потоки и маршруты задаются на плане.
        </p>
      )}
      <BlockHead
        title="Как выполняется работа сейчас"
        note="Хронометраж и сотрудники относятся только к выбранному корпусу, процессам и окну прогона"
      />
      <div className="c-process-fields">
        {FINANCE_FIELDS.filter(
          (f) =>
            STAFF.includes(f.id) &&
            (delivery ||
              !["delivery_staff_per_shift", "manual_delivery_min_per_job", "delivery_hour_rub"].includes(f.id)) &&
            (cleaning ||
              !["cleaning_staff_per_shift", "manual_cleaning_m2_per_hour", "cleaner_hour_rub"].includes(f.id)),
        ).map((field) => (
          <FieldRow
            key={field.id}
            label={field.label}
            unit={field.unit}
            value={finance[field.id] ?? ""}
            hint={field.hint}
            onChange={(value) => {
              const next = { ...finance };
              if (value === "") delete next[field.id];
              else next[field.id] = Number(value) / field.scale;
              onFinance(next);
            }}
          />
        ))}
      </div>
      <p className="muted">
        Без измерений доступен предварительный сценарий по отраслевым данным. Уменьшение зарплаты, сверхурочных и
        подрядных расходов подтверждается отдельно; высвобожденное время не означает автоматически сокращение ставок.
      </p>
    </section>
  );
}
