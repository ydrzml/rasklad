import { Mover } from "../../ui/robots";

// План склада клиента на главной: легкий чертеж из сохраненного расчета, без редактора.
// Здание, ряды стеллажей, ворота цветом назначения, буфер и зарядка, по проездам ездят роботы 07.
// Метры в плане считаются от левого нижнего угла, на экране y идет вниз, поэтому переворачиваем.
// При "уменьшить анимацию" роботы стоят на своих маршрутах (robots.css).

type Rect = { x: number; y: number; w: number; h: number };
type Item = Rect & { id: string; kind: string; role?: string };
type Section = Rect & { id: string; hole?: boolean };
export type SketchPlan = { sections?: Section[]; items?: Item[] };

const BLUE = "var(--blue)";
const DOCK = { receiving: "var(--dock-in)", shipping: "var(--dock-out)" } as Record<string, string>;
const SIZE = 520;
const PAD = 14;

export function PlanSketch({ plan, title }: { plan: SketchPlan; title: string }) {
  const sections = (plan.sections ?? []).filter((s) => !s.hole);
  const items = plan.items ?? [];
  const all: Rect[] = [...sections, ...items];
  if (!all.length) return null;
  const minX = Math.min(...all.map((r) => r.x));
  const minY = Math.min(...all.map((r) => r.y));
  const maxX = Math.max(...all.map((r) => r.x + r.w));
  const maxY = Math.max(...all.map((r) => r.y + r.h));
  const k = (SIZE - PAD * 2) / Math.max(maxX - minX, maxY - minY);
  const w = (maxX - minX) * k + PAD * 2;
  const h = (maxY - minY) * k + PAD * 2;
  const box = (r: Rect) => ({
    x: PAD + (r.x - minX) * k,
    y: PAD + (maxY - r.y - r.h) * k,
    width: r.w * k,
    height: r.h * k,
  });

  const racks = items.filter((i) => i.kind === "racks").sort((a, b) => a.x - b.x || a.y - b.y);
  const buffer = items.find((i) => i.kind === "buffer");
  const charge = items.find((i) => i.kind === "charge");
  const scale = Math.max(0.8, Math.min(1.4, k / 3.2));

  // Маршруты в координатах экрана: петли по проездам между рядами, вдоль буфера, от зарядки к рядам
  const routes: { kind: "small" | "pallet" | "long"; path: string; length: number }[] = [];
  const ring = (x1: number, y1: number, x2: number, y2: number) => ({
    path: `M${x1.toFixed(1)} ${y1.toFixed(1)}V${y2.toFixed(1)}H${x2.toFixed(1)}V${y1.toFixed(1)}Z`,
    length: 2 * (Math.abs(y2 - y1) + Math.abs(x2 - x1)),
  });
  if (racks.length) {
    const boxes = racks.map(box);
    const top = Math.min(...boxes.map((r) => r.y));
    const bottom = Math.max(...boxes.map((r) => r.y + r.height));
    const shell = sections.map(box);
    const roof = shell.length ? Math.min(...shell.map((r) => r.y)) : top - PAD;
    const floor = buffer ? box(buffer).y : shell.length ? Math.max(...shell.map((r) => r.y + r.height)) : bottom + PAD;
    const above = (roof + top) / 2;
    const below = (bottom + floor) / 2;
    // проезды: середины между соседними рядами одной полосы, по одному на столбец
    const aisles = [
      ...new Set(
        racks.flatMap((r) => {
          const next = racks.filter((o) => Math.abs(o.y - r.y) < 0.5 && o.x > r.x).sort((p, q) => p.x - q.x)[0];
          return next ? [Math.round(PAD + ((r.x + r.w + next.x) / 2 - minX) * k)] : [];
        }),
      ),
    ].sort((p, q) => p - q);
    const pick = (share: number) => aisles[Math.min(aisles.length - 1, Math.floor(aisles.length * share))];
    if (aisles.length >= 4) {
      routes.push({ kind: "pallet", ...ring(pick(0.15), above, pick(0.4), below) });
      routes.push({ kind: "pallet", ...ring(pick(0.85), below, pick(0.6), above) });
    }
    if (charge) {
      const c = box(charge);
      const start = c.x + c.width + 3 * k;
      routes.push({ kind: "small", ...ring(start, c.y + c.height / 2, start + (w - start) * 0.35, below) });
    }
  }
  if (buffer) {
    const b = box(buffer);
    const y = b.y + b.height / 2;
    const from = b.x + b.width * 0.15;
    const to = b.x + b.width * 0.85;
    routes.push({
      kind: "long",
      path: `M${from.toFixed(1)} ${y.toFixed(1)}H${to.toFixed(1)}H${from.toFixed(1)}`,
      length: 2 * (to - from),
    });
  }

  return (
    <svg viewBox={`0 0 ${w.toFixed(0)} ${h.toFixed(0)}`} role="img" aria-label={title}>
      <title>{title}</title>
      {sections.map((s) => (
        <rect key={s.id} {...box(s)} fill="var(--paper)" stroke={BLUE} strokeWidth="1.6" />
      ))}
      {racks.map((r) => (
        <rect key={r.id} {...box(r)} fill="var(--blue-tint)" stroke={BLUE} strokeWidth="0.9" />
      ))}
      {items
        .filter((i) => i.kind === "dock")
        .map((d) => (
          <rect
            key={d.id}
            {...box(d)}
            fill={DOCK[d.role ?? ""] ?? "var(--paper)"}
            stroke="var(--ink)"
            strokeWidth="0.6"
          />
        ))}
      {buffer && <rect {...box(buffer)} fill="none" stroke={BLUE} strokeDasharray="4 3" strokeWidth="0.9" />}
      {charge && (
        <g>
          <rect {...box(charge)} rx="3" fill="var(--paper)" stroke={BLUE} strokeWidth="1.2" />
          <path
            transform={`translate(${box(charge).x + box(charge).width / 2} ${box(charge).y + box(charge).height / 2})`}
            d="M1-6-3 1h3l-1 5 4-7H0z"
            fill={BLUE}
          />
        </g>
      )}
      {routes.map((route, index) => (
        <Mover
          key={index}
          kind={route.kind}
          path={route.path}
          seconds={Math.max(8, route.length / 22)}
          delay={index * 3}
          scale={scale}
        />
      ))}
    </svg>
  );
}
