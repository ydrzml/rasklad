import { useMemo, useState } from "react";
import { Alert, Button, Check, Select } from "../../ui";
import { buildView, initialLayers, placeUnderlay, UNITS, unitOf, type DxfDrawing } from "../plan/dxf";
import type { Underlay } from "../plan/underlay";
import { clinicImage } from "./upload";

export function ClinicDxf({
  drawing,
  name,
  onUse,
  onClose,
}: {
  drawing: DxfDrawing;
  name: string;
  onUse: (underlay: Underlay, size: { width_m: number; length_m: number }) => Promise<void>;
  onClose: () => void;
}) {
  const [layers, setLayers] = useState(() => initialLayers(drawing));
  const [unit, setUnit] = useState(() => unitOf(drawing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const view = useMemo(() => buildView(drawing, layers, unit), [drawing, layers, unit]);
  const problem = !view
    ? "Выберите слои с планом этажа"
    : view.hall.w < 10 || view.hall.h < 10 || view.hall.w > 120 || view.hall.h > 120
      ? "Этаж должен быть от 10 до 120 м по каждой стороне. Проверьте единицы или оставьте в DXF один этаж"
      : "";
  const apply = async () => {
    if (!view || problem) return;
    setBusy(true);
    setError("");
    try {
      const placed = placeUnderlay(view, { x: 0, y: 0, w: view.hall.w, h: view.hall.h }, unit, 0.6, name);
      const image = await clinicImage(placed.src, placed.w, placed.h, name);
      await onUse({ ...image, x: placed.x, y: placed.y }, { width_m: view.hall.w, length_m: view.hall.h });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось прочитать чертеж");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      className="u-dialog c-dxf"
      aria-label="Чертеж корпуса DXF"
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>План этажа из DXF</h2>
      <p>{name}. Оставьте слои с планом нужного этажа.</p>
      <Select
        label="Единицы чертежа"
        value={unit.id}
        options={UNITS}
        onChange={(id) => setUnit(UNITS.find((one) => one.id === id)!)}
      />
      <div className="c-dxf-grid">
        <div className="c-dxf-layers">
          {drawing.layers
            .filter((layer) => layer.lines > 0)
            .map((layer) => (
              <Check
                key={layer.name}
                label={layer.name}
                checked={layers.has(layer.name)}
                onToggle={() =>
                  setLayers((old) => {
                    const next = new Set(old);
                    if (next.has(layer.name)) next.delete(layer.name);
                    else next.add(layer.name);
                    return next;
                  })
                }
              />
            ))}
        </div>
        {view && <img src={view.src} alt="Предпросмотр выбранных слоев этажа" />}
      </div>
      {view && (
        <p className="mono">
          Этаж {view.hall.w} × {view.hall.h} м
        </p>
      )}
      <p className="muted">Чертеж станет подложкой в масштабе. Обведите помещения, поставьте двери, зарядки и лифты.</p>
      {(problem || error) && <Alert>{error || problem}</Alert>}
      <div className="u-form-go">
        <Button kind="ghost" disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <Button disabled={busy || !!problem} onClick={() => void apply()}>
          {busy ? "Готовим план..." : "Использовать чертеж"}
        </Button>
      </div>
    </dialog>
  );
}
