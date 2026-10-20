/* Окно чертежа DXF: какие слои положить под план, в каких единицах чертеж и что лежит на слоях.
   Слои включаются галочками, картинка и размер здания пересчитываются сразу. Роль слоя (стены,
   стеллажи, ворота) нужна, чтобы по чертежу построить сам план. Обе кнопки на месте всегда: если
   чего-то не хватает, причина сказана под ними, а не молчаливым отказом. */
import { useEffect, useMemo, useState } from "react";

import { Button, Check, Select } from "../../ui";
import { plural } from "../steps/economicsNames";
import {
  buildView,
  type DxfChoice,
  type DxfDrawing,
  type DxfLayer,
  hallProblem,
  type LayerRole,
  ROLE_OPTIONS,
  rolesToSend,
  UNITS,
  unitsNote,
} from "./dxf";

export type { DxfChoice } from "./dxf";

const NOISE_NAME = "похоже на размеры или надписи";

/* Что нашли на слое одной строкой: сколько линий и подсказка по имени слоя */
function layerNote(layer: DxfLayer): string {
  if (layer.lines === 0) {
    const marks = layer.texts + layer.fills;
    return `${marks} ${plural(marks, "надпись или штриховка", "надписи и штриховки", "надписей и штриховок")}, не рисуем`;
  }
  const notes = [`${layer.lines} ${plural(layer.lines, "линия", "линии", "линий")}`];
  if (layer.role === "noise") notes.push(NOISE_NAME);
  if (layer.off_in_file) notes.push("в чертеже слой выключен");
  return notes.join(", ");
}

export function DxfDialog({
  drawing,
  label,
  choice,
  onUnderlay,
  onBuild,
  onCancel,
  wait = "",
}: {
  drawing: DxfDrawing;
  label: string;
  choice: DxfChoice;
  onUnderlay: (choice: DxfChoice) => void;
  /* Строит план по слоям; вернуть текст ошибки или пустую строку, если план построен */
  onBuild: (choice: DxfChoice) => Promise<string>;
  onCancel: () => void;
  /* Что сказать, пока сервер строит план по большому чертежу: он разбирает файл заново, это минуты */
  wait?: string;
}) {
  const [on, setOn] = useState(choice.on);
  const [unit, setUnit] = useState(choice.unit);
  const [roles, setRoles] = useState(choice.roles);
  const [tried, setTried] = useState<"" | "underlay" | "build">("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const view = useMemo(() => buildView(drawing, on, unit, roles), [drawing, on, unit, roles]);
  const problem = hallProblem(view?.hall ?? null);
  const picked = { on, unit, roles };
  const sent = rolesToSend(drawing, picked);
  const hasWalls = Object.values(sent).includes("walls");

  // Esc закрывает окно и тогда, когда браузер своего "cancel" не прислал (фокус не успел попасть внутрь)
  useEffect(() => {
    const esc = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busy) onCancel();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onCancel]);

  const toggle = (name: string) =>
    setOn((now) => {
      const next = new Set(now);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // роль слою назначили руками: слой сразу и показываем, иначе роль молча не сработала бы
  const setRole = (name: string, role: LayerRole) => {
    setRoles((now) => ({ ...now, [name]: role }));
    if (role) setOn((now) => new Set(now).add(name));
    setFailure("");
  };

  const underlay = () => {
    setTried("underlay");
    if (!problem) onUnderlay(picked);
  };

  const build = async () => {
    setTried("build");
    setFailure("");
    if (!hasWalls || problem) return;
    setBusy(true);
    const answer = await onBuild(picked);
    setBusy(false);
    setFailure(answer);
  };

  const shown =
    tried === "build" && !hasWalls
      ? "Укажите, какой слой это стены: по нему строится здание. Отметьте его галочкой и выберите роль"
      : tried && problem
        ? problem
        : failure;

  return (
    <dialog
      className="u-dialog u-dxf"
      aria-labelledby="u-dxf-title"
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="u-dialog-body u-dxf-body">
        <h2 id="u-dxf-title">Чертеж {label}</h2>
        <p className="u-dxf-lead">
          Отметьте слои, которые нужны. Размеры и надписи лучше убрать: стены и стеллажи видны лучше. Чтобы построить по
          чертежу сам план, скажите, что лежит на слое.
        </p>

        <div className="u-dxf-main">
          <div className="u-dxf-view">
            {view ? <img src={view.src} alt="Чертеж из включенных слоев" /> : <span>Включите слой с линиями</span>}
          </div>

          <div className="u-dxf-side">
            <div className="u-dxf-units">
              <span className="u-frow-name" id="u-dxf-units">
                Единицы чертежа
              </span>
              <Select
                label="Единицы чертежа"
                value={unit.id}
                onChange={(id) => setUnit(UNITS.find((one) => one.id === id) ?? unit)}
                options={UNITS.map((one) => ({ id: one.id, name: one.name }))}
              />
            </div>
            <p className="u-dxf-note">{unitsNote(drawing, unit)}</p>

            <table className="u-dxf-table" aria-label="Слои чертежа">
              <thead>
                <tr>
                  <th scope="col">Слой</th>
                  <th scope="col">Что на нем нашли</th>
                  <th scope="col">Что на слое</th>
                </tr>
              </thead>
              <tbody>
                {drawing.layers.map((layer) => (
                  <tr key={layer.name}>
                    <td className="u-dxf-name">
                      <Check
                        checked={on.has(layer.name)}
                        onToggle={() => toggle(layer.name)}
                        label={layer.name}
                        disabled={layer.lines === 0}
                        title={layer.lines === 0 ? "На этом слое нет линий, только надписи или штриховка" : undefined}
                      />
                    </td>
                    <td className="u-dxf-meta">{layerNote(layer)}</td>
                    <td className="u-dxf-role">
                      {layer.lines > 0 ? (
                        <Select
                          label={`Что на слое ${layer.name}`}
                          value={roles[layer.name] ?? ""}
                          onChange={(role) => setRole(layer.name, role as LayerRole)}
                          options={ROLE_OPTIONS.map((one) => ({ id: one.id, name: one.name }))}
                        />
                      ) : (
                        <span className="u-dxf-meta">без линий</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <details className="u-dxf-limits">
              <summary>Что программа берет из чертежа</summary>
              <ul>
                <li>
                  Здание: самый большой замкнутый контур на слое со стенами. Не замкнут, берем рамку вокруг линий.
                </li>
                <li>Стеллажи: замкнутые фигуры и блоки на слоях со стеллажами. Секции вплотную склеиваем в ряд.</li>
                <li>Ворота: значок у ближайшей стены. Буфер за воротами ставим, если хватает места.</li>
                <li>Все края встают на сетку в метр, как на плане. Стена под углом ложится ступеньками.</li>
                <li>
                  Чертеж, повернутый целиком, разворачиваем по стенам. Стеллаж под другим углом заменяем
                  прямоугольником.
                </li>
                <li>Не читаем штриховки, надписи и вложенные чертежи. Что пропущено, скажем после построения.</li>
              </ul>
            </details>
          </div>
        </div>

        {/* итог и ошибка стоят над кнопками, а не в листаемой колонке: их видно всегда */}
        <div className="u-dxf-status">
          {view && !problem && (
            <p className="u-dxf-size">
              Здание на плане: {view.hall.w} × {view.hall.h} м
            </p>
          )}
          <p role="alert" className="u-dxf-error">
            {shown}
          </p>
          {busy && wait && (
            <p role="status" className="u-dxf-wait">
              {wait}
            </p>
          )}
        </div>

        <div className="u-dialog-actions">
          <Button kind="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button kind="ghost" onClick={underlay}>
            Только под план
          </Button>
          <Button onClick={() => void build()}>{busy ? "Строим план..." : "Построить план"}</Button>
        </div>
      </div>
    </dialog>
  );
}
