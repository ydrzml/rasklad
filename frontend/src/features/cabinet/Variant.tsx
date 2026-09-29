import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Parameter } from "../../api/client";
import { projects, type Project } from "../../api/projects";
import { Alert, FieldRow, Waiting } from "../../ui";
import { number } from "../../app/format";
import { compareUrl, problem, shown, unitText } from "./format";

// Копию делают с одной целью: посмотреть, что будет, если склад будет работать иначе. Поэтому окно
// сразу спрашивает, что поменять, сервер считает вариант, и мы открываем его рядом с оригиналом.
// Если человек ошибся во вводе, копия не нужна: новая версия того же проекта, старая остается в истории.

type Why = "variant" | "manual";

type State = {
  overrides?: Record<string, number>;
  facilityId?: string;
  taskIds?: string[];
  staff?: { filled?: number }[] | null;
  staffTouched?: boolean;
  // задачи, снятые с расчета галочкой: их поля в копии не предлагаем, они не считаются
  excluded?: string[];
};

// Сколько людей сейчас по строкам штата: занятые ставки, без вакансий
function peopleOf(state: State): number | null {
  if (!Array.isArray(state.staff) || state.staff.length === 0) return null;
  return state.staff.reduce((sum, line) => sum + Number(line.filled ?? 0), 0);
}

export function VariantDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const state = (project.current?.state ?? {}) as State;
  const [why, setWhy] = useState<Why>("variant");
  const [fields, setFields] = useState<Parameter[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState<string | null>(null);
  const [peopleRaw, setPeopleRaw] = useState<string | null>(null);
  const peopleBefore = peopleOf(state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    box.current?.showModal();
  }, []);

  useEffect(() => {
    let live = true;
    api
      .parameters(state.facilityId ?? project.facility_type, state.taskIds ?? [])
      .then(
        (found) =>
          live && setFields(found.filter((field) => field.key && !(state.excluded ?? []).includes(field.group))),
      )
      .catch(() => live && setFields([]));
    return () => {
      live = false;
    };
  }, [project.facility_type, state.facilityId, state.taskIds, state.excluded]);

  const current = (field: Parameter) => state.overrides?.[field.path] ?? field.value;

  // Что поменяли: только поля, где число другое, чем в оригинале
  const changes = useMemo(() => {
    const out: Record<string, number> = {};
    for (const field of fields ?? []) {
      const raw = values[field.path];
      if (raw === undefined || raw.trim() === "") continue;
      const value = Number(raw.replace(",", "."));
      if (Number.isFinite(value) && value !== current(field)) out[field.path] = value;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, values]);

  // Штат в проекте введен строками и под новый объем сам не растет. Когда меняют объем или смены,
  // спрашиваем, сколько людей нужно: иначе сценарий без роботов останется прежним, и вариант обманет
  const askPeople =
    peopleBefore !== null && Object.keys(changes).some((path) => /volume_per_day|schedule\./.test(path));
  const peopleValue = peopleRaw === null ? null : Number(peopleRaw.replace(",", "."));
  const people =
    askPeople &&
    peopleValue !== null &&
    Number.isFinite(peopleValue) &&
    peopleValue >= 0 &&
    peopleValue !== peopleBefore
      ? peopleValue
      : null;

  // Имя копии собирается само из правки, пока человек не написал свое
  const suggested = useMemo(() => {
    const parts = (fields ?? [])
      .filter((field) => field.path in changes)
      .map((field) => shown(changes[field.path], field.unit));
    if (people !== null) parts.push(`${number(people)} чел в штате`);
    return parts.length ? `${project.name}: ${parts.join(", ")}` : `${project.name} (копия)`;
  }, [changes, fields, people, project.name]);

  const finalName = (name ?? suggested).trim().slice(0, 200) || suggested;
  const changed = Object.keys(changes).length > 0;

  async function make() {
    setBusy(true);
    setError(null);
    try {
      if (why === "variant") {
        const made = await projects.copy(project.id, { name: finalName, changes, people });
        window.location.assign(compareUrl([{ project_id: project.id }, { project_id: made.id }]));
      } else {
        const made = await projects.copy(project.id, { name: finalName });
        window.location.assign(`/calc?project=${made.id}&open=1`);
      }
    } catch (reason) {
      setError(problem(reason));
      setBusy(false);
    }
  }

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <dialog
      ref={box}
      className="u-dialog c-variant"
      aria-labelledby="c-variant-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="u-dialog-body">
        <h2 id="c-variant-title">Копия «{project.name}»</h2>
        <p>Копия ляжет в ту же папку, рядом с оригиналом. Оригинал не меняется.</p>

        <div className="c-why" role="radiogroup" aria-label="Зачем копия">
          <label className="c-why-one">
            <input type="radio" name="why" checked={why === "variant"} onChange={() => setWhy("variant")} />
            <span>
              <strong>Посмотреть, что будет, если...</strong>
              <span>Поменяйте число, мы посчитаем вариант и покажем его рядом с оригиналом</span>
            </span>
          </label>
          <label className="c-why-one">
            <input type="radio" name="why" checked={why === "manual"} onChange={() => setWhy("manual")} />
            <span>
              <strong>Поменять в расчете самому</strong>
              <span>Копия откроется в мастере: план, штат, решение, все шаги</span>
            </span>
          </label>
        </div>

        {why === "variant" &&
          (fields === null ? (
            <Waiting title="Загружаем параметры проекта" />
          ) : (
            <div className="c-variant-fields">
              {fields.map((field) => (
                <FieldRow
                  key={field.path}
                  label={field.label}
                  hint={field.path in changes ? `было ${number(current(field))}` : `сейчас ${number(current(field))}`}
                  unit={unitText(field.unit)}
                  value={values[field.path] ?? current(field)}
                  onChange={(value) => setValues({ ...values, [field.path]: value })}
                />
              ))}
              {askPeople && (
                <div className="c-variant-staff">
                  <Alert tone="note">
                    {state.staffTouched
                      ? `Штат вы вводили сами: ${number(peopleBefore)} чел.`
                      : `В расчете штат ${number(peopleBefore)} чел., его подставили под прежний объем.`}{" "}
                    При новом объеме людей нужно больше? Без правки сценарий "без роботов" останется прежним.
                  </Alert>
                  <FieldRow
                    label="Людей в штате"
                    hint={people !== null ? `было ${number(peopleBefore)}` : `сейчас ${number(peopleBefore)}`}
                    unit="чел"
                    value={peopleRaw ?? peopleBefore ?? 0}
                    onChange={setPeopleRaw}
                  />
                </div>
              )}
            </div>
          ))}

        <label className="c-variant-name">
          <span>Название копии</span>
          <input
            className="u-search"
            maxLength={200}
            value={name ?? suggested}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <p className="c-variant-note">
          Ошиблись во вводе? Копия не нужна:{" "}
          <a href={`/calc?project=${project.id}&open=1`}>откройте проект в расчете</a> и сохраните новую версию, прежняя
          останется в истории.
        </p>

        {error && <Alert>{error}</Alert>}
        {busy && why === "variant" && (
          <Waiting title="Считаем вариант" note="Гоняем смену и считаем деньги, до двадцати секунд" />
        )}

        <div className="u-dialog-actions">
          <button className="u-btn u-btn-ghost" type="button" onClick={close} disabled={busy}>
            Отмена
          </button>
          {why === "variant" ? (
            <button className="u-btn u-btn-primary" type="button" onClick={make} disabled={busy || !changed}>
              {changed ? "Посчитать и сравнить" : "Поменяйте хотя бы одно число"}
            </button>
          ) : (
            <button className="u-btn u-btn-primary" type="button" onClick={make} disabled={busy}>
              Сделать копию и открыть
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
