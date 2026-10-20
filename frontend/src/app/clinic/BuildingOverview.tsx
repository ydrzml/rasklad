import { type Building, floorArea } from "./building";
import { FloorDrawing } from "./FloorDrawing";
import { number } from "../format";

export function BuildingOverview({
  building,
  active,
  onPick,
}: {
  building: Building;
  active: number;
  onPick: (floor: number) => void;
}) {
  const width = Math.max(...building.floors.map((one) => one.width_m));
  const depth = Math.max(...building.floors.map((one) => one.length_m));
  return (
    <div className="c-building-overview" aria-label="Все этажи здания">
      <p className="muted">
        Все этажи в одном масштабе. Выберите этаж, чтобы изменить его размеры, контур или помещения.
      </p>
      <div className="u-schemes">
        {[...building.floors]
          .sort((a, b) => b.number - a.number)
          .map((floor) => (
            <button
              type="button"
              key={floor.number}
              className={`u-scheme${floor.number === active ? " is-on" : ""}`}
              onClick={() => onPick(floor.number)}
            >
              <svg viewBox={`-2 -2 ${width + 4} ${depth + 4}`} aria-hidden="true">
                <g transform={`translate(0 ${depth - floor.length_m})`}>
                  <FloorDrawing floor={floor} scale={160 / width} />
                </g>
              </svg>
              <b>{floor.name || `${floor.number} этаж`}</b>
              <span className="mono">
                {floor.width_m} × {floor.length_m} м · {number(floorArea(floor), 0)} м²
              </span>
              <small>
                Постов {floor.items.filter((i) => i.role === "ward").length} · остановок лифта{" "}
                {floor.items.filter((i) => i.kind === "lift").length}
              </small>
            </button>
          ))}
      </div>
    </div>
  );
}
