import type { Role, StaffLine, StaffReview } from "../../api/client";
import {
  Alert,
  Badge,
  BlockHead,
  Button,
  Check,
  type Choice,
  type Column,
  Cross,
  NumberBox,
  Picker,
  Sheet,
  SheetRow,
} from "../../ui";
import { money, number } from "../format";

type Props = {
  roles: Role[];
  lines: StaffLine[];
  review: StaffReview | null;
  onChange: (id: string, patch: Partial<StaffLine>) => void;
  onAdd: (roleId: string) => void;
  onRemove: (id: string) => void;
  /* объем ушел от того, под который вводили штат: подставить пересчитанные строки или оставить */
  onRescale: (lines: StaffLine[]) => void;
  onKeep: () => void;
  /* откуда штат по умолчанию: численность склада из данных организатора, пока человек его не трогал */
  note?: string;
  /* роли, которые требуют выбранные задачи: их строки нельзя заменить выбором другой роли */
  required: string[];
};

const COLUMNS: Column[] = [
  { name: "Роль" },
  { name: "Мест в штате", width: "130px", hint: "Сколько ставок этой роли в штатном расписании" },
  {
    name: "Из них работает",
    width: "130px",
    hint: "Сколько ставок закрыто живыми людьми, разница это незакрытые вакансии",
  },
  { name: "Оклад", width: "150px", hint: "До вычета НДФЛ. Взносы модель добавит сама" },
  { name: "Нанят по договору", width: "180px", hint: "Люди подрядчика: оклада и взносов нет, есть цена договора" },
  { name: "", width: "40px" },
];

// Шаг 2, штат объекта. Пользователь набирает роли из справочника и говорит, сколько ставок,
// сколько из них занято людьми и сколько они стоят. Кого заберут роботы, здесь не спрашиваем
// и не показываем: это ответ расчета (docs/decisions.md, «Штат вводит пользователь»).
export function Staff({ roles, lines, review, onChange, onAdd, onRemove, onRescale, onKeep, note, required }: Props) {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const choices: Choice[] = roles.map((role) => ({ id: role.id, name: role.name, group: role.group_name }));
  // пока над таблицей стоит предложение пересчитать штат, расхождение с нормой по роли не повторяем:
  // это одно и то же, сказанное дважды
  const notes = (review?.notes ?? []).filter((note) => !(review?.rescale && note.kind === "norm_gap"));
  const taskNotes = notes.filter((note) => note.operation_id);

  return (
    <section>
      <BlockHead
        title="Кто работает на объекте"
        note="сколько мест в штате, сколько из них закрыто людьми и во что это обходится"
      />

      {review?.rescale && (
        // ничего не меняем молча: штат ввел человек, и растить его за него мы не будем
        <Alert tone="warn">
          <span className="u-rescale">
            <span>{review.rescale.text}</span>
            <span className="u-action-end">
              <Button kind="ghost" onClick={() => review.rescale && onRescale(review.rescale.lines)}>
                Пересчитать
              </Button>
              <Button kind="link" onClick={onKeep}>
                Оставить как есть
              </Button>
            </span>
          </span>
        </Alert>
      )}

      <Sheet columns={COLUMNS} foot={<Totals review={review} />}>
        {lines.map((line, index) => {
          const role = byId.get(line.role);
          // Предупреждение по роли целиком ставим у первой ее строки, чтобы при двух ставках
          // одной роли один и тот же текст не повторялся дважды.
          const first = lines.findIndex((other) => other.role === line.role) === index;
          const mine = notes.filter(
            (note) =>
              note.line_id === line.id || (first && !note.line_id && !note.operation_id && note.role === line.role),
          );
          return (
            <SheetRow
              key={line.id}
              muted={mine.some((note) => note.kind === "idle_line")}
              cells={[
                <>
                  {first && required.includes(line.role) ? (
                    // роль нужна выбранной задаче: заменить ее в списке нельзя, убрать можно крестиком
                    <span className="u-role-fixed">
                      {role?.name ?? line.role}
                      <Badge tone="blue">нужна для задачи</Badge>
                    </span>
                  ) : (
                    <Picker
                      label="Роль"
                      value={line.role}
                      options={choices}
                      // вместе с ролью меняем и оклад: у уборщика он не такой, как у оператора погрузчика
                      onChange={(next) =>
                        onChange(line.id, {
                          role: next,
                          salary_month: byId.get(next)?.salary_month ?? line.salary_month,
                        })
                      }
                    />
                  )}
                  <span className="u-field-src">{about(role)}</span>
                </>,
                <NumberBox
                  label="Мест в штате"
                  unit="мест"
                  step="1"
                  value={line.headcount}
                  onChange={(next) => onChange(line.id, { headcount: Number(next) })}
                  warn={mine.some((note) => note.kind === "norm_gap")}
                />,
                <NumberBox
                  label="Из них работает людей"
                  unit="чел"
                  step="1"
                  value={line.filled}
                  onChange={(next) => onChange(line.id, { filled: Number(next) })}
                  warn={mine.some((note) => note.kind === "overfilled")}
                />,
                <>
                  <NumberBox
                    label="Оклад в месяц"
                    unit="₽/мес"
                    step="1000"
                    value={line.salary_month}
                    onChange={(next) => onChange(line.id, { salary_month: Number(next) })}
                    warn={mine.some((note) => note.kind === "salary_out_of_range")}
                  />
                  <span className="u-field-src">{range(role)}</span>
                </>,
                <Check
                  label="по договору"
                  title="У людей подрядчика нет оклада и взносов: в цене договора уже все есть"
                  checked={line.contractor ?? false}
                  onToggle={() => onChange(line.id, { contractor: !line.contractor })}
                />,
                <Button kind="link" title="Убрать строку" onClick={() => onRemove(line.id)}>
                  <Cross />
                </Button>,
              ]}
              notes={mine.map((note) => (
                <Alert key={note.kind} tone={note.level === "note" ? "note" : "warn"}>
                  {note.text}
                </Alert>
              ))}
            />
          );
        })}
        <div className="u-sheet-add">
          {/* Роль спрашиваем сразу: кнопка, которая сама подставляет первую свободную, обманывает */}
          <Picker label="Добавить роль" action="Добавить роль" options={choices} onChange={onAdd} />
        </div>
      </Sheet>

      {taskNotes.map((note) => (
        <Alert key={note.operation_id} tone={note.level === "note" ? "note" : "warn"}>
          {note.text}
        </Alert>
      ))}

      {note && <p className="u-field-hint">{note}.</p>}
      <p className="u-field-hint">
        Сколько людей заменят роботы, мы считаем сами и покажем в экономике. Разница между местами в штате и людьми это
        незакрытые вакансии: роботы займут их первыми, и экономией это не будет.
      </p>
    </section>
  );
}

function Totals({ review }: { review: StaffReview | null }) {
  if (!review) return <span>Считаем штат...</span>;
  return (
    <>
      <span>Всего по объекту</span>
      <span className="mono">{number(review.headcount_total)} мест</span>
      <span className="mono">{number(review.filled_total)} чел</span>
      <span className="mono">{money(review.payroll_rub_year)}</span>
      <span>в год со взносами</span>
      <span />
    </>
  );
}

function about(role?: Role): string {
  if (!role) return "";
  if (!role.productivity) return "выработки нет, объем в ставки по этой роли не переводится";
  return `выработка ${number(role.productivity)} ${role.productivity_unit}`;
}

function range(role?: Role): string {
  if (!role?.salary_min || !role.salary_max) return "вилки по роли у нас нет";
  return `рынок: ${number(role.salary_min)}-${number(role.salary_max)}`;
}
