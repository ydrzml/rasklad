import { useEffect, useState } from "react";

import { api, type Parameter } from "../../api/client";
import { FieldRow, Fold } from "../../ui";
import { groupDigits } from "../../ui/digits";
import { rangeWarning, sourceTitle } from "../format";

type Props = {
  parameters: Parameter[];
  /* роботы, выбранные на шаге решений: у каждого своя цена, обслуживание и срок службы */
  robots: string[];
  overrides: Record<string, number>;
  onChange: (path: string, value: number | null) => void;
};

// Значения, которые мы взяли на себя: доля работы, посильная роботам, число дежурных
// в робозоне, рост зарплат, потери рабочего времени, а по роботу цена, обслуживание и срок службы.
// Клиент их обычно не знает, поэтому на шаге параметров мы их не спрашиваем. Но в результате он
// обязан их увидеть и поправить (ТЗ, п. 3.5.3): на них стоят все цифры.
export function Assumptions({ parameters, robots, overrides, onChange }: Props) {
  const [robotFields, setRobotFields] = useState<Parameter[]>([]);
  const wanted = robots.join(",");
  useEffect(() => {
    if (!wanted) return;
    let stale = false;
    api
      .robotParameters(wanted.split(","))
      .then((list) => {
        if (!stale) setRobotFields(list);
      })
      // без полей робота список допущений все равно полезен: показываем то, что есть
      .catch(() => {
        if (!stale) setRobotFields([]);
      });
    return () => {
      stale = true;
    };
  }, [wanted]);

  const ours = [...parameters.filter((field) => field.ours), ...(wanted ? robotFields : [])];
  if (ours.length === 0) return null;
  const blocks = [...new Map(ours.map((field) => [field.group, field.group_name])).entries()];
  const edited = ours.filter((field) => field.path in overrides).length;

  return (
    <Fold title={`Что мы приняли за вас: ${ours.length}${edited ? `, поправлено вами ${edited}` : ""}`}>
      <p className="u-frow-hint">
        Этих цифр обычно нет ни у кого на объекте, поэтому мы взяли их из отраслевых данных, каталога и нормативов.
        Поправьте любую, если у вас иначе: расчет пересчитается. Чтобы вернуть наше значение, сотрите поле.
      </p>
      {blocks.map(([group, name]) => (
        <div key={group}>
          <h3>{name}</h3>
          {ours
            .filter((field) => field.group === group)
            .map((field) => {
              const value = overrides[field.path] ?? field.value;
              const out = value < field.min || value > field.max;
              return (
                <FieldRow
                  key={field.path}
                  label={field.label}
                  unit={field.unit}
                  value={value}
                  hint={hintOf(field, ours, overrides)}
                  trust={field.trust}
                  trustTitle={sourceTitle(field)}
                  warning={out ? rangeWarning(field) : undefined}
                  onChange={(next) => onChange(field.path, next === "" ? null : Number(next))}
                />
              );
            })}
        </div>
      ))}
    </Fold>
  );
}

// Под своей цифрой человек видит, что было у нас. Обслуживание переводим в рубли по цене
// этого же робота, с его правкой: долю от цены в уме никто не считает
function hintOf(field: Parameter, all: Parameter[], overrides: Record<string, number>): string {
  const parts = [field.hint];
  if (field.path.endsWith(".maintenance_share_year")) {
    const price = all.find((one) => one.path === field.path.replace(/maintenance_share_year$/, "price_rub"));
    if (price) {
      const rub = (overrides[price.path] ?? price.value) * (overrides[field.path] ?? field.value);
      parts.push(`Сейчас это ${groupDigits(Math.round(rub))} руб в год за робота`);
    }
  }
  if (field.path in overrides) {
    parts.push(`Задано вами, у нас было ${groupDigits(field.value)}${field.unit ? ` ${field.unit}` : ""}`);
  }
  return parts.join(". ");
}
