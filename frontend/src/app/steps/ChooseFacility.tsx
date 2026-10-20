import { Fragment } from "react";
import type { Facility, Operation } from "../../api/client";
import { Alert, Badge, BlockHead, Button, Notice, Option, RangeLine, Row } from "../../ui";
import { PLANS, STAMPS } from "../../ui/plans";
import { CasesStrip } from "../../features/cases/Strip";
import { plural } from "./economicsNames";
import { ZONE_SHARE_MAX, ZONE_SHARE_MIN } from "./peak";
import { taskVolume } from "./taskVolume";

type Props = {
  facilities: Facility[];
  facilityId: string;
  taskIds: string[];
  onPickFacility: (facilityId: string) => void;
  onToggleTask: (taskId: string) => void;
  clinicData?: { deliveryStaff?: number; drugOrders?: number; area?: number };
  /* выбран штучный отбор: часть склада под робозону, доля и площадь всего склада. Пусто: отбора нет */
  zone?: { share: number; areaM2: number; onChange: (share: number) => void };
  /* правки человека или разбора: объем задачи на карточке тот же, что на шаге параметров и в расчете */
  overrides?: Record<string, number>;
};

// Шаг 1. Объект и задачи, которые на нем роботизируем. Задач можно выбрать несколько:
// расчет складывает их в один объект с общими дежурными и общими затратами на внедрение.
export function ChooseFacility({
  facilities,
  facilityId,
  taskIds,
  onPickFacility,
  onToggleTask,
  zone,
  clinicData,
  overrides,
}: Props) {
  const facility = facilities.find((item) => item.id === facilityId);
  const tasks = facility?.operations ?? [];
  const picked = tasks.filter((task) => taskIds.includes(task.id));
  // У аэропорта и медучреждения расчетной модели нет: задачи есть, но путь кончается списком решений
  const short = facility?.status === "solutions";

  return (
    <>
      {/* готовые разборы тем, кто не знает, с чего начать: страница /cases, только просмотр */}
      <CasesStrip />
      <section>
        <BlockHead title="Где работают роботы" note="от объекта зависят задачи и список решений" />

        <div className="u-choice">
          {facilities.map((item) => (
            <Option
              key={item.id}
              id={`facility-${item.id}`}
              group="facility"
              checked={item.id === facilityId}
              onPick={() => onPickFacility(item.id)}
              title={item.name}
              description={item.note}
              stamp={STAMPS[item.id] ?? "схема"}
              plan={PLANS[item.id] ?? PLANS.other}
              meta={
                <>
                  <span className="mono">
                    {item.catalog.count}{" "}
                    {item.status === "solutions"
                      ? `${plural(item.catalog.count, "решение", "решения", "решений")} разобрали`
                      : `${plural(item.catalog.count, "решение", "решения", "решений")} в каталоге`}
                  </span>
                  <Badge tone={item.status === "ready" ? "blue" : "grey"}>{statusWord(item)}</Badge>
                </>
              }
            />
          ))}
        </div>
      </section>

      <section>
        <BlockHead
          title="Что заберут роботы"
          note={
            tasks.length > 0
              ? short
                ? "отметьте все, что нужно: покажем решения под каждую задачу"
                : "отметьте все, что нужно: посчитаем как один объект"
              : "по этому объекту доступен только каталог решений"
          }
          aside={
            tasks.length > 0 && (
              <Button kind="link" onClick={() => selectAll(tasks, taskIds, onToggleTask)}>
                {picked.length === tasks.length ? "снять все" : "выбрать все"}
              </Button>
            )
          }
        />

        {short && (
          // отдельной строкой с воздухом сверху и снизу: вплотную к списку задач она терялась
          <p className="u-short-note">
            <Alert tone="note">
              {facility?.id === CLINIC
                ? `Для медучреждения доступны план корпуса по этажам, выбор роботов, прогон смены и экономика доставки и уборки. Остальные задачи пока доступны для ознакомления.`
                : `По объекту "${facility?.name}" путь короче: задачи, параметры объекта и список решений с объяснением. Плана, прогона смены и экономики для него нет, полный расчет сделан для склада.`}
            </Alert>
          </p>
        )}

        {tasks.length === 0 ? (
          <Notice title="Для этого объекта расчета пока нет">
            Задачи, нормативы и экономику мы собрали для склада. По объекту "{facility?.name}" открыт каталог:{" "}
            {facility?.catalog.count}{" "}
            {plural(facility?.catalog.count ?? 0, "решение подходит", "решения подходят", "решений подходят")} по
            процессам, но характеристики по ним не собраны, поэтому считать деньги мы не беремся.
          </Notice>
        ) : (
          <div className="u-rows">
            {tasks.map((task) => {
              const volume = taskVolume(facilityId, task.id, task.volume_per_day, overrides);
              return (
                <Fragment key={task.id}>
                  <Row
                    checked={taskIds.includes(task.id)}
                    onToggle={() => onToggleTask(task.id)}
                    title={task.name}
                    description={task.description || summary(task)}
                    who={
                      facilityId === CLINIC
                        ? task.id === "floor_delivery" && clinicData?.deliveryStaff !== undefined
                          ? `В выбранном окне: ${clinicData.deliveryStaff} сотрудников доставки`
                          : "Сотрудники и текущий способ работы задаются для вашего объекта на шаге параметров"
                        : who(task, short)
                    }
                    caption={task.volume_label || "объем в сутки"}
                    value={
                      facilityId === CLINIC
                        ? ((task.id === "floor_delivery"
                            ? clinicData?.drugOrders
                            : task.id === "cleaning"
                              ? clinicData?.area
                              : undefined
                          )?.toLocaleString("ru-RU") ?? "Укажите данные")
                        : volume.value.toLocaleString("ru-RU")
                    }
                    unit={task.unit}
                    hint={
                      volume.edited
                        ? `Задано вами, у нас было ${task.volume_per_day.toLocaleString("ru-RU")} ${task.unit}`
                        : `${task.volume_source} (оценка ${task.volume_trust})`
                    }
                  />
                  {/* Штучный отбор считаем по робозоне на части склада: сколько ее, решает человек.
                  По умолчанию от плотности рынка, 50 м² на робота (config/model.yaml, picking_m2_per_robot) */}
                  {zone && task.takeover === "speedup" && (
                    <RangeLine
                      ariaLabel="Часть склада под отбор роботами, %"
                      label={(percent) =>
                        `Под отбор роботами: ${percent}% склада, ${Math.round((zone.areaM2 * percent) / 100).toLocaleString("ru-RU")} м²`
                      }
                      hint="Какую часть склада займет робозона: от нее зависит, сколько роботов нужно для отбора"
                      min={ZONE_SHARE_MIN * 100}
                      max={ZONE_SHARE_MAX * 100}
                      step={1}
                      value={Math.round(zone.share * 100)}
                      onChange={(percent) => zone.onChange(percent / 100)}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

// Медучреждение: отдельная модель корпуса с этажами и лифтами.
export const CLINIC = "clinic";

function statusWord(facility: Facility): string {
  if (facility.status === "ready") return "полный расчет";
  if (facility.id === CLINIC) return "план, смена и экономика";
  return facility.status === "solutions" ? "пока без расчета" : "каталог";
}

// У склада роли из нашего справочника, у аэропорта и больницы численность из датасета как есть
function who(task: Operation, short: boolean): string {
  if (!short) return `Сегодня это делают: ${task.performed_by.join(", ").toLowerCase()}`;
  if (task.performed_by.length === 0) return "Кто делает это сейчас, в отраслевом датасете не сказано";
  return `По датасету: ${task.performed_by.join("; ")}`;
}

function summary(task: Operation): string {
  return task.takeover === "speedup"
    ? "Робот подвозит груз к человеку, и тот перестает ходить по объекту"
    : "Робот делает эту работу вместо человека";
}

function selectAll(tasks: Operation[], taskIds: string[], onToggleTask: (id: string) => void) {
  const fill = taskIds.length < tasks.length;
  tasks.forEach((task) => {
    if (taskIds.includes(task.id) !== fill) onToggleTask(task.id);
  });
}
