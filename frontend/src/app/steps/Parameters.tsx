import type { Parameter } from "../../api/client";
import { BlockHead, FieldRow, Fold, KeyValue } from "../../ui";
import { overDay, rangeWarning, sourceTitle } from "../format";

type Props = {
  parameters: Parameter[];
  /* склад, аэропорт, больница: подпись над главными полями говорит про свой объект */
  place?: string;
  /* у аэропорта и больницы поля из датасета, расчета по ним нет */
  dataset?: boolean;
  overrides: Record<string, number>;
  onChange: (path: string, value: number | null) => void;
};

// Шаг 2, поля объекта и выбранных задач. Здесь только то, что вводит клиент: размер объекта,
// режим работы и объем каждой задачи. Наверху главное крупными числами, остальное в списке ниже.
// Значения, которые мы берем на себя (доля работы для роботов, число дежурных, рост зарплат),
// сюда не попадают: клиент их не знает. Он увидит их в экономике списком допущений и там же поправит.
// Границы не запрещают ввод: выход за них это предупреждение, свой объект пользователь знает лучше.
export function Parameters({ parameters, overrides, onChange, place = "свой склад", dataset }: Props) {
  const asked = parameters.filter((field) => !field.ours);
  const main = asked.filter((field) => field.key);
  const rest = asked.filter((field) => !field.key);
  const blocks = [...new Map(rest.map((field) => [field.group, field.group_name])).entries()];
  const tooLong = overDay(parameters, overrides);
  const props = (field: Parameter) => {
    const shown = common(field, overrides, onChange);
    const schedule = field.path.endsWith("schedule.shifts") || field.path.endsWith("schedule.shift_hours");
    // коротко, чтобы строка встала на место подсказки; сколько часов выходит, видно в самих полях
    return tooLong && schedule ? { ...shown, warning: "Смены дают больше 24 ч в сутки, поправьте" } : shown;
  };

  return (
    <section>
      <BlockHead title="Главное про объект" note={`значения отраслевые, поправьте то, что знаете про ${place}`} />

      <div className="u-keys">
        {main.map((field) => (
          <KeyValue key={field.path} {...props(field)} />
        ))}
      </div>

      {rest.length > 0 && (
        <Fold title={`Остальные параметры ${dataset ? "из датасета" : "расчета"}: ${rest.length}`}>
          {blocks.map(([group, name]) => (
            <div key={group}>
              <h3>{name}</h3>
              {rest
                .filter((field) => field.group === group)
                .map((field) => (
                  <FieldRow key={field.path} {...props(field)} yesNo={field.yes_no} />
                ))}
            </div>
          ))}
        </Fold>
      )}
    </section>
  );
}

// Одно и то же поле показывается крупно или строкой, данные для обоих готовим одинаково.
// Источник прячем под букву оценки: иначе он занимает две строки под каждым значением.
function common(
  field: Parameter,
  overrides: Record<string, number>,
  onChange: (path: string, value: number | null) => void,
) {
  const value = overrides[field.path] ?? field.value;
  const out = value < field.min || value > field.max;
  return {
    label: field.label,
    unit: field.unit,
    value,
    hint: field.hint,
    trust: field.trust,
    trustTitle: sourceTitle(field),
    warning: out ? rangeWarning(field) : undefined,
    onChange: (next: string) => onChange(field.path, next === "" ? null : Number(next)),
  };
}
