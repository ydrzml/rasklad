/* Этаж корпуса на листе: помещения по ролям с подписью, двери, шахты, зарядки, преграды. Один
   рисунок на редактор и на смену, чтобы план в итоге был тем же, что нарисовали. Внутри доски
   (Board): метры от левого верхнего угла, корпус в метрах от левого нижнего, поэтому y переворачиваем */
import { type Box, type Floor, type Item, ROLE_NAMES } from "./building";
import "./clinic.css";

export function screenY(floor: Floor, box: Box): number {
  return floor.length_m - box.y - box.h;
}

export function FloorDrawing({
  floor,
  scale,
  flagOf = () => "",
}: {
  floor: Floor;
  scale: number;
  // класс отметки проверки плана: is-bad или is-warn
  flagOf?: (item: Item) => string;
}) {
  const y = (box: Box) => screenY(floor, box);
  return (
    <>
      {floor.sections.map((one) => (
        <rect key={one.id} x={one.x} y={y(one)} width={one.w} height={one.h} className="u-section c-floor-section" />
      ))}
      {floor.items
        .filter((one) => one.kind === "room")
        .map((one) => (
          <g key={one.id}>
            <rect
              x={one.x}
              y={y(one)}
              width={one.w}
              height={one.h}
              className={`c-room is-${one.role || "other"}${flagOf(one)}`}
            />
            {one.w * scale > 46 && (
              <text
                x={one.x + one.w / 2}
                y={y(one) + one.h / 2}
                className="c-label"
                style={{ fontSize: Math.min(11, one.w * scale * 0.085) / scale }}
              >
                {one.name || ROLE_NAMES[one.role === "cleaning" ? "other" : one.role]}
              </text>
            )}
          </g>
        ))}
      {floor.items
        .filter((one) => one.kind !== "room")
        .map((one) => (
          <g key={one.id}>
            <rect x={one.x} y={y(one)} width={one.w} height={one.h} className={`${classOf(one)}${flagOf(one)}`} />
            {one.kind === "lift" && (
              <>
                <path
                  d={`M${one.x} ${y(one)}l${one.w} ${one.h}M${one.x + one.w} ${y(one)}l${-one.w} ${one.h}`}
                  className="c-lift-x"
                />
                <text x={one.x + one.w / 2} y={y(one) - 0.6} className="c-tag" style={{ fontSize: 11 / scale }}>
                  {one.lift}
                </text>
              </>
            )}
          </g>
        ))}
    </>
  );
}

function classOf(item: Item): string {
  if (item.kind === "door") return item.automatic ? "c-door" : "c-door is-manual";
  if (item.kind === "lift") return "c-lift";
  if (item.kind === "charge") return item.role === "cleaning" ? "u-charge c-base" : "u-charge";
  return "u-blocked";
}
