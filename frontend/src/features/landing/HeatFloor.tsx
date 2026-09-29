import { useEffect, useRef } from "react";
import { CARD, FACE, FLOOR_BOTS, type FloorBotKind, INK, PALLET } from "../../ui/robots";
import { useDark, withAlpha } from "../../ui/theme";

// Фон лендинга: пол склада клетками по всей длине страницы. По свободному полу, по краям и
// между блоками, редко проезжают роботы, клетки под ними нагреваются и медленно остывают.
// Где пути пересекаются, клетки темнее: получается тепловая карта проездов, как в прогоне смены.
// Пол привязан к странице и уезжает вместе с ней при прокрутке.

const CELL = 28;
const KINDS: FloorBotKind[] = ["small", "pallet", "long"];
// Занятые места: сюда роботы не заезжают, чтобы не ездить под текстом
const BUSY = "[data-floor-busy]";
// Шапка прилипает к верху экрана: под ней и над ней роботов не показываем, они гаснут на подъезде
const HEAD = ".l-head";
const FADE = 48;

type Bot = { c: number; r: number; dc: number; dr: number; p: number; v: number; wait: number; kind: FloorBotKind };

// Фон лендинга: роботы медленно ездят по клеткам и оставляют бледный след. Спокойно, без мельтешения:
// роботов мало, едут медленно, чаще стоят, след слабый и гаснет долго.
// still: роботы стоят на местах, пол не двигается. Так фон стоит на главной вошедшего.
// Кто в настройках системы просил меньше движения, всегда видит неподвижный пол
export function HeatFloor({ still: fixed = false }: { still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // холст не понимает var(): цвета пола берем из токенов и перерисовываем пол, когда сменилась тема
  const dark = useDark();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = fixed || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tokens = getComputedStyle(document.documentElement);
    const gridColor = withAlpha(tokens.getPropertyValue("--blue").trim(), 0.06);
    const heatColor = tokens.getPropertyValue("--floor-heat").trim();

    let cols = 0;
    let rows = 0;
    let dpr = 1;
    let heat = new Float32Array(0);
    let blocked = new Uint8Array(0);
    let bots: Bot[] = [];
    let frame = 0;
    let headBottom = 0;

    const open = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows && !blocked[r * cols + c];

    function turn(b: Bot) {
      const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].filter(([dc, dr]) => !(dc === -b.dc && dr === -b.dr) && open(b.c + dc, b.r + dr));
      if (!dirs.length) {
        b.dc = -b.dc;
        b.dr = -b.dr;
        return;
      }
      [b.dc, b.dr] = dirs[Math.floor(Math.random() * dirs.length)];
    }

    function layout() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas!.width = window.innerWidth * dpr;
      canvas!.height = window.innerHeight * dpr;
      const pageHeight = document.documentElement.scrollHeight;
      cols = Math.ceil(window.innerWidth / CELL) + 1;
      rows = Math.ceil(pageHeight / CELL) + 1;
      headBottom = document.querySelector(HEAD)?.getBoundingClientRect().bottom ?? 0;
      heat = new Float32Array(cols * rows);
      blocked = new Uint8Array(cols * rows);
      document.querySelectorAll(BUSY).forEach((el) => {
        const box = el.getBoundingClientRect();
        const top = box.top + window.scrollY;
        const c0 = Math.max(0, Math.floor((box.left - 8) / CELL));
        const c1 = Math.min(cols - 1, Math.floor((box.right + 8) / CELL));
        const r0 = Math.max(0, Math.floor((top - 8) / CELL));
        const r1 = Math.min(rows - 1, Math.floor((top + box.height + 8) / CELL));
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) blocked[r * cols + c] = 1;
      });
      const free: number[] = [];
      blocked.forEach((b, i) => {
        if (!b) free.push(i);
      });
      const count = Math.max(3, Math.round((pageHeight / window.innerHeight) * 1.1));
      bots = [];
      for (let i = 0; i < count && free.length; i++) {
        const at = free[Math.floor(Math.random() * free.length)];
        const bot: Bot = {
          c: at % cols,
          r: Math.floor(at / cols),
          dc: i % 2,
          dr: 1 - (i % 2),
          p: Math.random(),
          v: 0.02 + Math.random() * 0.02,
          wait: 0,
          kind: KINDS[i % KINDS.length],
        };
        turn(bot);
        bots.push(bot);
      }
    }

    function step() {
      for (let k = 0; k < heat.length; k++) heat[k] *= 0.999;
      for (const b of bots) {
        if (b.wait > 0) {
          b.wait--;
          continue;
        }
        b.p += b.v;
        if (b.p < 1) continue;
        b.p = 0;
        if (Math.random() < 0.12) b.wait = 60 + Math.floor(Math.random() * 180);
        if (Math.random() < 0.15) b.v = 0.02 + Math.random() * 0.02;
        if (open(b.c + b.dc, b.r + b.dr) && (b.dc || b.dr)) {
          b.c += b.dc;
          b.r += b.dr;
        }
        if (!open(b.c + b.dc, b.r + b.dr) || Math.random() < 0.2) turn(b);
        const i = b.r * cols + b.c;
        if (i >= 0 && i < heat.length) heat[i] = Math.min(1, heat[i] + 0.16);
      }
    }

    function drawBot(x: number, y: number, b: Bot) {
      const shown = Math.min(1, Math.max(0, (y - headBottom - 12) / FADE));
      if (shown <= 0) return;
      const { w, h, boxes, slats } = FLOOR_BOTS[b.kind];
      ctx!.save();
      ctx!.translate(x, y);
      ctx!.rotate(Math.atan2(b.dr, b.dc));
      ctx!.scale(0.8, 0.8);
      ctx!.globalAlpha = 0.45 * shown;
      ctx!.fillStyle = "#fff";
      ctx!.strokeStyle = INK;
      ctx!.lineWidth = 1.2;
      ctx!.beginPath();
      ctx!.roundRect(-w / 2, -h / 2, w, h, 4);
      ctx!.fill();
      ctx!.stroke();
      ctx!.strokeStyle = PALLET;
      ctx!.lineWidth = 2;
      ctx!.beginPath();
      for (const sx of slats) {
        ctx!.moveTo(sx, -h / 2 + 1);
        ctx!.lineTo(sx, h / 2 - 1);
      }
      ctx!.stroke();
      ctx!.fillStyle = CARD;
      ctx!.strokeStyle = INK;
      ctx!.lineWidth = 0.9;
      for (const [bx, by, bw, bh] of boxes) {
        ctx!.beginPath();
        ctx!.rect(bx, by, bw, bh);
        ctx!.fill();
        ctx!.stroke();
      }
      ctx!.fillStyle = FACE;
      ctx!.fillRect(w / 2 - 2, -3.5, 2, 7);
      ctx!.restore();
    }

    function draw() {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const sy = window.scrollY;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, width, height);
      const r0 = Math.max(0, Math.floor(sy / CELL));
      const r1 = Math.min(rows, r0 + Math.ceil(height / CELL) + 2);
      ctx!.strokeStyle = gridColor;
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      for (let c = 0; c <= cols; c++) {
        ctx!.moveTo(c * CELL + 0.5, 0);
        ctx!.lineTo(c * CELL + 0.5, height);
      }
      for (let r = r0; r <= r1; r++) {
        ctx!.moveTo(0, r * CELL - sy + 0.5);
        ctx!.lineTo(width, r * CELL - sy + 0.5);
      }
      ctx!.stroke();
      for (let r = r0; r < r1; r++) {
        for (let c = 0; c < cols; c++) {
          const value = heat[r * cols + c];
          if (value < 0.04) continue;
          ctx!.fillStyle = withAlpha(heatColor, Number((value * 0.2).toFixed(3)));
          ctx!.fillRect(c * CELL + 2, r * CELL - sy + 2, CELL - 3, CELL - 3);
        }
      }
      for (const b of bots) {
        if (b.r < r0 - 1 || b.r > r1 + 1) continue;
        const go = open(b.c + b.dc, b.r + b.dr) ? b.p : 0;
        drawBot((b.c + b.dc * go) * CELL + CELL / 2, (b.r + b.dr * go) * CELL - sy + CELL / 2, b);
      }
    }

    function loop() {
      step();
      draw();
      frame = requestAnimationFrame(loop);
    }

    layout();
    if (still) {
      for (let n = 0; n < 1500; n++) step();
      draw();
    } else {
      frame = requestAnimationFrame(loop);
    }

    const onResize = () => {
      layout();
      if (still) draw();
    };
    const onScroll = () => {
      if (still) draw();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("load", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    document.fonts?.ready.then(onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("load", onResize);
      window.removeEventListener("scroll", onScroll);
    };
  }, [fixed, dark]);

  return <canvas ref={ref} className="l-floor" aria-hidden="true" />;
}
