import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import { number } from "../format";
import type { Point } from "./geometry";
import { turned } from "./outline";
import { loadImage } from "./underlay";

const LEAST = 4; // меньше четырех точек картинку не выпрямить

/* Контур здания на исходной картинке. Точки стоят на наружных углах здания, их сколько угодно:
   склад буквой Г это шесть точек, буквой П восемь. Щелчок по стороне добавляет точку, двойной
   щелчок по точке убирает ее. По этому контуру картинка выпрямляется, а здание на листе
   становится таким же. Стрелка показывает, какая сторона картинки ляжет верхом листа. */
export function Corners({
  source,
  corners,
  sides,
  turn,
  onMove,
}: {
  source: string;
  corners: Point[]; // доли размера картинки, по порядку обхода
  sides: [number, number]; // длина и ширина здания в метрах
  turn: number; // сколько четвертей по часовой повернуть картинку
  onMove: (next: Point[]) => void;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // сколько единиц картинки в одной точке экрана: ручки и линии одной толщины при любом размере
  const [unit, setUnit] = useState(1);
  const [held, setHeld] = useState<number | null>(null);
  const last = useRef({ index: -1, at: 0 });
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let gone = false;
    loadImage(source)
      .then((image) => !gone && setSize({ w: image.naturalWidth, h: image.naturalHeight }))
      .catch(() => null);
    return () => {
      gone = true;
    };
  }, [source]);

  useEffect(() => {
    const node = svg.current;
    if (!node || !size) return;
    const measure = () => {
      const box = node.getBoundingClientRect();
      if (box.width && box.height) setUnit(Math.max(size.w / box.width, size.h / box.height));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => watch.disconnect();
  }, [size]);

  if (!size) return <div className="u-board u-corners" />;

  const toImage = (event: { clientX: number; clientY: number }): Point | null => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: Math.min(1, Math.max(0, at.x / size.w)), y: Math.min(1, Math.max(0, at.y / size.h)) };
  };
  const pad = Math.max(size.w, size.h) * 0.04;
  const px = (one: Point) => ({ x: one.x * size.w, y: one.y * size.h });
  const points = corners.map(px);
  const outline = points.map((one) => `${one.x},${one.y}`).join(" ");

  // щелчок по стороне: новая точка встает на сторону между ее концами, и ее сразу можно тянуть
  const insert = (index: number, event: ReactPointerEvent<SVGElement>) => {
    const at = toImage(event);
    if (!at) return;
    onMove([...corners.slice(0, index + 1), at, ...corners.slice(index + 1)]);
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
    setHeld(index + 1);
  };

  // куда на картинке смотрит верх листа: стрелка из середины контура
  const middle = {
    x: points.reduce((sum, one) => sum + one.x, 0) / points.length,
    y: points.reduce((sum, one) => sum + one.y, 0) / points.length,
  };
  const reach = Math.min(size.w, size.h) * 0.12;
  const up = turned({ x: 0, y: -1 }, (4 - turn) % 4);
  const tip = { x: middle.x + up.x * reach, y: middle.y + up.y * reach };

  return (
    <div className="u-board u-corners">
      <svg
        ref={svg}
        // поля вокруг картинки: точка на самом краю не уходит под строку подсказки
        viewBox={`${-pad} ${-pad} ${size.w + 2 * pad} ${size.h + pad * 3}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Исходная картинка плана и углы здания"
        onPointerMove={(event) => {
          if (held === null) return;
          const at = toImage(event);
          if (at) onMove(corners.map((one, index) => (index === held ? at : one)));
        }}
        onPointerUp={() => setHeld(null)}
        onPointerCancel={() => setHeld(null)}
      >
        <defs>
          <marker
            id="u-corners-arrow"
            viewBox="0 0 10 10"
            refX="5"
            refY="5"
            markerWidth="4"
            markerHeight="4"
            orient="auto"
          >
            <path d="M0 0L10 5L0 10z" className="u-corners-head" />
          </marker>
        </defs>
        <image href={source} width={size.w} height={size.h} />
        <polygon points={outline} className="u-corners-shape" strokeWidth={2 * unit} />
        {points.map((one, index) => {
          const next = points[(index + 1) % points.length];
          return (
            <line
              key={`s${index}`}
              x1={one.x}
              y1={one.y}
              x2={next.x}
              y2={next.y}
              className="u-corners-edge"
              strokeWidth={16 * unit}
              onPointerDown={(event) => insert(index, event)}
            />
          );
        })}
        <path
          d={`M${middle.x} ${middle.y}L${tip.x} ${tip.y}`}
          className="u-corners-up"
          strokeWidth={2 * unit}
          markerEnd="url(#u-corners-arrow)"
        />
        <text x={tip.x} y={tip.y} dy={-10 * unit} fontSize={13 * unit} className="u-corners-side" textAnchor="middle">
          верх листа
        </text>
        {points.map((one, index) => (
          <g
            key={index}
            className={held === index ? "u-corners-dot is-held" : "u-corners-dot"}
            onPointerDown={(event) => {
              const now = Date.now();
              // двойной щелчок по точке убирает ее, если точек останется хотя бы четыре
              if (last.current.index === index && now - last.current.at < 350 && corners.length > LEAST) {
                last.current = { index: -1, at: 0 };
                onMove(corners.filter((_, other) => other !== index));
                return;
              }
              last.current = { index, at: now };
              event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
              setHeld(index);
            }}
          >
            {/* крест точно в углу, кольцо вокруг, чтобы было за что взять */}
            <circle cx={one.x} cy={one.y} r={14 * unit} className="u-corners-ring" strokeWidth={2 * unit} />
            <path
              d={`M${one.x - 7 * unit} ${one.y}h${14 * unit}M${one.x} ${one.y - 7 * unit}v${14 * unit}`}
              strokeWidth={1.5 * unit}
            />
          </g>
        ))}
      </svg>
      <div className="u-board-status">
        <span className="u-board-hint">
          <span>
            <b>Контур здания, точек {corners.length}.</b> Поставьте точки на все наружные углы: щелчок по стороне
            добавляет точку, двойной щелчок по точке убирает. Здание {number(sides[0], 0)} × {number(sides[1], 0)} м
          </span>
        </span>
      </div>
    </div>
  );
}
