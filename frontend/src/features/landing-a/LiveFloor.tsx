import { useEffect, useRef } from "react";
import { useDark, withAlpha } from "../../ui/theme";

/* Живой пол лендинга: тепловая карта, как у прогона смены, только едва заметная.
   По сетке все время сами ползут волны из клеток: полоса тускло подсвеченных клеток медленно идет
   с одного из краев, клетки в ней загораются и гаснут по очереди, волны иногда пересекаются.
   Роботы ездят по клетке и оставляют такой же тихий след полосой шире себя, курсор тоже, но след
   почти не отличить от волн. Цвет приглушенный, синий линий чертежа. Возле текста и кнопок
   (data-floor-busy) пол гаснет. Один холст: 30 кадров, пока человек что-то делает, 12 кадров,
   когда он 10 секунд ничего не делает, во вкладке в фоне стоит. Касание на телефоне работает
   как курсор. Меньше движения: один неподвижный кадр */

const CELL = 22;
const FAST = 1000 / 30;
const SLOW = 1000 / 12;
const IDLE_AFTER = 10_000;
// насколько густо может прокраситься клетка: след едва заметен даже там, где роботы ездят часто
const MAX_ALPHA = 0.085;

type Pointer = { x: number; y: number; at: number };
type Bot = { x: number; y: number; tx: number; ty: number; dir: number; angle: number };
type Wave = { angle: number; pos: number; speed: number; width: number; length: number; span: number };
type Colors = { grid: string; heat: string; line: string; body: string; cargo: string; light: string };

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    grid: withAlpha(token("--blue"), 0.07),
    // след темно-синим линий чертежа, а не ярким голубым: на светлом и на темном он тихий
    heat: token("--blue-line"),
    line: withAlpha(token("--blue-line"), 0.6),
    body: withAlpha(token("--paper"), 0.85),
    cargo: withAlpha(token("--blue-pale"), 0.85),
    light: token("--route"),
  };
}

const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export function LiveFloor() {
  const ref = useRef<HTMLCanvasElement>(null);
  const dark = useDark();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const colors = readColors();

    let W = 0;
    let H = 0;
    let cols = 0;
    let rows = 0;
    let heat = new Float32Array(0);
    const bots: Bot[] = [];
    const waves: Wave[] = [];
    const pointer: Pointer = { x: -999, y: -999, at: -1e9 };
    let busy: DOMRect[] = [];

    // первый экран: пока он заметно виден, роботов фона нет, там своя сцена с роботами
    let heroShown = true;
    const readBusy = () => {
      busy = [...document.querySelectorAll<HTMLElement>("[data-floor-busy]")]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.bottom > 0 && r.top < H && r.width > 0);
      const hero = document.querySelector(".la-hero")?.getBoundingClientRect();
      heroShown = !!hero && hero.bottom > H * 0.3;
    };

    const blocked = (x: number, y: number) =>
      busy.some((r) => x > r.left - 10 && x < r.right + 10 && y > r.top - 10 && y < r.bottom + 10);

    // роботы стоят на узлах клетки и ездят по ее линиям
    const placeBots = () => {
      bots.length = 0;
      const count = Math.max(2, Math.round(W / 340));
      for (let k = 0; k < count * 20 && bots.length < count; k++) {
        const x = (1 + Math.floor(Math.random() * (cols - 3))) * CELL;
        const y = (1 + Math.floor(Math.random() * (rows - 3))) * CELL;
        if (blocked(x, y)) continue;
        const dir = Math.floor(Math.random() * 4);
        bots.push({ x, y, tx: x, ty: y, dir, angle: (dir * Math.PI) / 2 });
      }
    };

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(H * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      cols = Math.ceil(W / CELL) + 1;
      rows = Math.ceil(H / CELL) + 1;
      heat = new Float32Array(cols * rows);
      readBusy();
      placeBots();
      waves.length = 0;
      for (let i = 0; i < 3; i++) waves.push(newWave(true));
    };

    // прогреть клетки вокруг точки: в центре сильнее, на соседних слабее
    const warm = (x: number, y: number, center: number, side: number, reach = 1) => {
      const c = Math.floor(x / CELL);
      const r = Math.floor(y / CELL);
      for (let dr = -reach; dr <= reach; dr++) {
        for (let dc = -reach; dc <= reach; dc++) {
          const cc = c + dc;
          const rr = r + dr;
          if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
          const n = rr * cols + cc;
          heat[n] = Math.min(1, heat[n] + (dc === 0 && dr === 0 ? center : side));
        }
      }
    };

    // волна заходит с одного из краев окна и ползет поперек него, с небольшим наклоном
    const newWave = (inside = false): Wave => {
      const side = Math.floor(Math.random() * 4);
      const angle = (side * Math.PI) / 2 + (Math.random() - 0.5) * 0.7;
      const span = Math.abs(Math.cos(angle)) * W + Math.abs(Math.sin(angle)) * H;
      const width = 4 * CELL + Math.random() * 3 * CELL;
      return {
        angle,
        span,
        width,
        speed: 26 + Math.random() * 22,
        length: 7 * CELL + Math.random() * 4 * CELL,
        pos: inside ? Math.random() * span - span / 2 : -span / 2 - width * 2.5,
      };
    };

    // сила волн в центре клетки: полоса с огибающей, внутри нее клетки загораются и гаснут по очереди
    const waveAt = (x: number, y: number, t: number) => {
      let v = 0;
      for (const w of waves) {
        const u = (x - W / 2) * Math.cos(w.angle) + (y - H / 2) * Math.sin(w.angle) - w.pos;
        if (u > w.width * 2.5 || u < -w.width * 2.5) continue;
        const env = Math.exp(-(u * u) / (w.width * w.width));
        const pulse = 0.5 + 0.5 * Math.cos((u / w.length) * Math.PI * 2 + t * 0.0012);
        v += env * pulse;
      }
      return Math.min(1, v);
    };

    const now = () => performance.now();

    // ближайший к следу курсора робот его замечает, пока след свежий (4 секунды)
    const chaser = (t: number) => {
      if (t - pointer.at > 4000) return null;
      let best: Bot | null = null;
      let bestD = 380;
      for (const b of bots) {
        const d = Math.hypot(b.x - pointer.x, b.y - pointer.y);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      return best;
    };

    const stepBots = (k: number, t: number) => {
      const lead = chaser(t);
      const step = (32 * k * FAST) / 1000;
      for (const b of bots) {
        const toCursor = b === lead ? Math.hypot(b.x - pointer.x, b.y - pointer.y) : Infinity;
        const dx = b.tx - b.x;
        const dy = b.ty - b.y;
        const left = Math.hypot(dx, dy);
        if (left > 0.5) {
          const move = Math.min(left, step);
          b.x += (dx / left) * move;
          b.y += (dy / left) * move;
        } else if (toCursor > 52) {
          // на узле: к курсору или дальше по линии, изредка поворачивая
          const options = DIRS.map((d, i) => ({ i, x: b.tx + d[0] * CELL, y: b.ty + d[1] * CELL })).filter(
            (o) =>
              o.x >= CELL && o.x <= (cols - 2) * CELL && o.y >= CELL && o.y <= (rows - 2) * CELL && !blocked(o.x, o.y),
          );
          const back = (b.dir + 2) % 4;
          const pool = options.filter((o) => o.i !== back);
          const list = pool.length ? pool : options;
          const straight = list.find((o) => o.i === b.dir);
          const next =
            list.length === 0
              ? undefined
              : b === lead
                ? list.reduce((a, o) =>
                    Math.hypot(o.x - pointer.x, o.y - pointer.y) < Math.hypot(a.x - pointer.x, a.y - pointer.y) ? o : a,
                  )
                : straight && Math.random() < 0.72
                  ? straight
                  : list[Math.floor(Math.random() * list.length)];
          if (next) {
            b.dir = next.i;
            b.tx = next.x;
            b.ty = next.y;
          }
        }
        // поворот плавный; робот у курсора смотрит на курсор
        const target = toCursor <= 52 ? Math.atan2(pointer.y - b.y, pointer.x - b.x) : (b.dir * Math.PI) / 2;
        let turn = target - b.angle;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        b.angle += turn * Math.min(1, (k * FAST) / 220);
        // робот красит полосу шире себя: клетку под собой и соседние, совсем понемногу за кадр
        warm(b.x, b.y, 0.012 * k, 0.008 * k);
      }
    };

    const drawGrid = () => {
      ctx.beginPath();
      for (let x = 0; x <= W; x += CELL) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, H);
      }
      for (let y = 0; y <= H; y += CELL) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(W, y + 0.5);
      }
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    // клетка светится сильнее из двух: от волн или от следа роботов и курсора
    const drawHeat = (t: number) => {
      ctx.fillStyle = colors.heat;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const wave = waveAt(c * CELL + CELL / 2, r * CELL + CELL / 2, t) * 0.75;
          const h = Math.max(heat[r * cols + c], wave) * calm(c * CELL + CELL / 2, r * CELL + CELL / 2);
          if (h < 0.04) continue;
          ctx.globalAlpha = h * MAX_ALPHA;
          ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 1, CELL - 1);
        }
      }
      ctx.globalAlpha = 1;
    };

    // робот сверху в чертежном виде, как на планах: корпус, груз, огонек сзади
    // роботы гаснут у карточек и текста раньше волн: на края карточек они не заезжают
    let botsAlpha = 0;
    const drawBots = () => {
      botsAlpha += ((heroShown ? 0 : 1) - botsAlpha) * 0.12;
      if (botsAlpha < 0.02) return;
      for (const b of bots) {
        const alpha = botsAlpha * Math.max(0, Math.min(1, (nearest(b.x, b.y) - 20) / 60));
        if (alpha < 0.02) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(b.x, b.y);
        ctx.rotate(b.angle);
        ctx.beginPath();
        ctx.roundRect(-11, -8, 22, 16, 4);
        ctx.fillStyle = colors.body;
        ctx.fill();
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = colors.cargo;
        ctx.fillRect(-5, -5, 10, 10);
        ctx.strokeRect(-5, -5, 10, 10);
        ctx.beginPath();
        ctx.arc(-9, 0, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = colors.light;
        ctx.fill();
        ctx.restore();
      }
    };

    // возле текста и кнопок волны гаснут: под текстом их нет, к краю блока они плавно набирают силу.
    // Клетка при этом остается везде одинаковой: стертая под текстом, она читалась как светлая плашка
    const FADE = 56;
    // расстояние до ближайшего блока с текстом или карточки, не дальше 100 px
    const nearest = (x: number, y: number) => {
      let near = 100;
      for (const r of busy) {
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        near = Math.min(near, Math.hypot(dx, dy));
        if (near === 0) return 0;
      }
      return near;
    };
    const calm = (x: number, y: number) => Math.min(1, nearest(x, y) / FADE);

    const draw = (t: number) => {
      ctx.clearRect(0, 0, W, H);
      drawGrid();
      drawHeat(t);
      drawBots();
    };

    resize();

    if (still) {
      // меньше движения: волны замерли на месте, роботы стоят
      draw(0);
      const onResize = () => {
        resize();
        draw(0);
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    let frame = 0;
    let lastInput = now();
    let lastFrame = 0;
    let nextWave = now() + 4000;

    const tick = () => {
      frame = 0;
      if (document.hidden) return;
      const t = now();
      // пока человек что-то делает, 30 кадров; если 10 секунд ничего, 12 кадров: пол живет, но тише
      const gap = t - lastInput > IDLE_AFTER ? SLOW : FAST;
      if (t - lastFrame >= gap) {
        // k: во сколько раз этот кадр длиннее обычного, чтобы скорость не зависела от частоты кадров
        const k = Math.min(4, (t - lastFrame) / FAST);
        lastFrame = t;
        const fade = Math.exp((-k * FAST) / 1500);
        for (let n = 0; n < heat.length; n++) heat[n] *= fade;
        for (const w of waves) w.pos += (w.speed * k * FAST) / 1000;
        // ушедшую волну заменяет новая с другого края; на экране от двух до четырех волн
        for (let i = waves.length - 1; i >= 0; i--) {
          if (waves[i].pos > waves[i].span / 2 + waves[i].width * 2.5) waves.splice(i, 1);
        }
        if (waves.length < 2 || (t > nextWave && waves.length < 4)) {
          waves.push(newWave());
          nextWave = t + 4000 + Math.random() * 4000;
        }
        stepBots(k, t);
        draw(t);
      }
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (frame || document.hidden) return;
      lastFrame = now();
      frame = requestAnimationFrame(tick);
    };

    const onPointer = (x: number, y: number) => {
      const t = now();
      // след ведем по всем клеткам между прошлой и новой точкой, без разрывов при быстром движении
      const fresh = pointer.at > t - 200;
      const steps = fresh ? Math.max(1, Math.ceil(Math.hypot(x - pointer.x, y - pointer.y) / (CELL / 2))) : 1;
      for (let s = 1; s <= steps; s++) {
        const k = s / steps;
        const fx = fresh ? pointer.x + (x - pointer.x) * k : x;
        const fy = fresh ? pointer.y + (y - pointer.y) * k : y;
        warm(fx, fy, 0.14, 0.04);
      }
      pointer.x = x;
      pointer.y = y;
      pointer.at = t;
      lastInput = t;
      start();
    };

    const onMove = (e: PointerEvent) => onPointer(e.clientX, e.clientY);
    const onTouch = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) onPointer(touch.clientX, touch.clientY);
    };
    const onScroll = () => {
      readBusy();
      lastInput = now();
    };
    const onResize = () => resize();
    const onVisible = () => {
      if (!document.hidden) start();
    };
    const busyTimer = window.setInterval(readBusy, 500);

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    window.addEventListener("touchmove", onTouch, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisible);
    start();

    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(busyTimer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [dark]);

  return <canvas ref={ref} className="l-floor" aria-hidden="true" />;
}
