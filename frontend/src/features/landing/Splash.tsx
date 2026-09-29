import { useEffect, useRef, useState } from "react";
import { CARD, CARD_LIGHT, FACE, INK, SIGNAL } from "../../ui/robots";
import "./splash.css";

// Заставка лендинга. Соня (06) влетает на склад, врезается в стопку, верхние коробки падают,
// экран у нее гаснет и включается, она косится вправо, коробки встают обратно, и лицо
// становится знаком рядом с названием. Смысл: робот без расчета упирается в склад,
// сначала расклад, потом роботы.
// Показываем один раз на браузер и быстро, за две секунды: кто открыл сайт впервые, не должен
// восемь секунд смотреть на экран без заголовка и кнопки. ?splash=1 показывает снова и в полную
// длину, как задумано, для питча.

const SEEN = "raskad-splash-seen";

export function shouldShowSplash() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (new URLSearchParams(window.location.search).has("splash")) return true;
  try {
    return !localStorage.getItem(SEEN);
  } catch {
    // хранилище закрыто: заставку все равно показываем, она пропускается щелчком
    return true;
  }
}

/* Время в миллисекундах от начала */
const T = {
  enter: 150,
  hit: 1100,
  rolledBack: 1500,
  screenOff: 1750,
  screenOn: 2100,
  booted: 2400,
  lookStart: 3250,
  lookEnd: 3700,
  leave: 4250,
};
/* Обычный показ идет втрое быстрее и заканчивается, как только встала подпись. Для питча
   (?splash=1) сцена в полную длину, с паузой на названии */
const PITCH = new URLSearchParams(window.location.search).has("splash");
const SPEED = PITCH ? 1 : 3;
const END = PITCH ? T.leave + 1900 : T.leave + 1500;
const FADE_MS = PITCH ? 450 : 300;

const HIT_X = 466;
const BACK_X = 392;
const FLOOR_Y = 232;
const LOGO = { x: 206, y: 170 };

/* Стеллажи: две рамы, на каждом ярусе коробки до края */
const RACKS: [number, number][] = [
  [36, 236],
  [266, 466],
];
const BEAMS = [100, 165, 230];
const LEVELS: [number, number][] = [
  [100, 58],
  [165, 54],
  [230, 54],
  [290, 50],
];
const BOX_W = [44, 30, 52, 36, 40, 28, 48, 34, 56, 38];
const BOX_H = [36, 28, 44, 32, 40, 26, 38, 30, 46, 34];
const BOX_FILL = [CARD, CARD_LIGHT, "#e6d4b6"];

type Box = { x: number; y: number; w: number; h: number; fill: string };

const SHELF_BOXES: Box[] = (() => {
  const boxes: Box[] = [];
  let n = 0;
  for (const [x0, x1] of RACKS) {
    for (const [base, maxH] of LEVELS) {
      let x = x0 + 7;
      for (;;) {
        const w = BOX_W[n % 10];
        const h = Math.min(BOX_H[(n * 3) % 10], maxH);
        if (x + w > x1 - 6) break;
        boxes.push({ x, y: base - h, w, h, fill: BOX_FILL[n % 3] });
        x += w + 3;
        n++;
      }
    }
  }
  return boxes;
})();

/* Две верхние коробки стопки: где стоят, куда падают, когда падают и когда встают обратно */
const FALLING = {
  b3: { from: [593, 193], to: [655, 267], turn: 90, hop: 14, fall: [1230, 1700], back: [3520, 3960] },
  b4: { from: [593, 163], to: [522, 277], turn: -90, hop: 26, fall: [1130, 1600], back: [3700, 4150] },
} as const;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, q: number) => a + (b - a) * q;
const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
const easeIn = (q: number) => q * q;
const easeOut = (q: number) => 1 - (1 - q) * (1 - q);
const easeInOut = (q: number) => (q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2);

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a: string, b: string, q: number) => {
  const p = rgb(a);
  const r = rgb(b);
  return `rgb(${p.map((v, i) => Math.round(lerp(v, r[i], q))).join(",")})`;
};

export function Splash({ onDone }: { onDone: () => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const [leaving, setLeaving] = useState(false);

  // Кадр рисуем сами через setAttribute: шестьдесят раз в секунду без перерисовки React
  useEffect(() => {
    const root = svg.current;
    if (!root) return;
    const el: Record<string, Element> = {};
    root.querySelectorAll("[data-k]").forEach((node) => (el[(node as SVGElement).dataset.k!] = node));
    const set = (k: string, attr: string, value: string | number) => el[k].setAttribute(attr, String(value));

    function box(k: "b3" | "b4", t: number, shake: number) {
      const b = FALLING[k];
      let x: number;
      let y: number;
      let r: number;
      if (t < b.fall[0]) {
        x = b.from[0] + shake * 5;
        y = b.from[1];
        r = t > T.hit ? shake * 8 : 0;
      } else if (t < b.back[0]) {
        const q = span(t, b.fall[0], b.fall[1]);
        x = lerp(b.from[0], b.to[0], q);
        y = lerp(b.from[1], b.to[1], easeIn(q)) - (q < 0.62 ? b.hop * Math.sin(Math.PI * Math.min(q * 1.6, 1)) : 0);
        r = b.turn * easeIn(q);
        if (t > b.fall[1] && t < b.fall[1] + 220) y -= 6 * Math.sin(Math.PI * span(t, b.fall[1], b.fall[1] + 220));
      } else {
        const q = span(t, b.back[0], b.back[1]);
        const e = easeInOut(q);
        x = lerp(b.to[0], b.from[0], e);
        y = lerp(b.to[1], b.from[1], e) - 70 * Math.sin(Math.PI * q);
        r = lerp(b.turn, 0, e);
        if (t > b.back[1] && t < b.back[1] + 160) y += 3 * Math.sin(Math.PI * span(t, b.back[1], b.back[1] + 160));
      }
      set(k, "transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${r.toFixed(1)})`);
    }

    function frame(t: number) {
      set("scene", "opacity", (1 - span(t, T.leave, T.leave + 500)).toFixed(3));

      // Соня: разгон, удар со сплющиванием, откат, потом уезжает на место знака
      let x: number;
      let y = FLOOR_Y;
      let rot = 0;
      let sx = 1;
      let sy = 1;
      if (t < T.hit) {
        const q = span(t, T.enter, T.hit);
        x = lerp(-160, HIT_X, q * (0.55 + 0.45 * q));
        y += Math.sin(t / 38) * 2;
        rot = 4;
      } else if (t < T.leave) {
        x = lerp(HIT_X, BACK_X, easeOut(span(t, T.hit, T.rolledBack)));
        if (t < T.hit + 160) {
          const q = easeOut(span(t, T.hit, T.hit + 160));
          sx = lerp(0.8, 1, q);
          sy = lerp(1.15, 1, q);
        }
        rot = t < T.rolledBack ? lerp(-9, 0, easeOut(span(t, T.hit, T.rolledBack))) : 0;
        if (t > T.rolledBack && t < T.rolledBack + 200)
          y += 3 * Math.sin(Math.PI * span(t, T.rolledBack, T.rolledBack + 200));
      } else {
        const q = easeInOut(span(t, T.leave, T.leave + 800));
        x = lerp(BACK_X, LOGO.x, q);
        y = lerp(FLOOR_Y, LOGO.y, q);
      }
      set(
        "rob",
        "transform",
        `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})`,
      );
      const wheel = (x * 5.7).toFixed(1);
      set("w1", "transform", `translate(-18 48) rotate(${wheel})`);
      set("w2", "transform", `translate(58 48) rotate(${wheel})`);

      const gone = span(t, T.leave, T.leave + 450);
      set("body", "transform", `translate(0 ${(gone * 24).toFixed(1)})`);
      set("body", "opacity", (1 - gone).toFixed(3));

      set("speed", "transform", `translate(${(x - 62).toFixed(1)} ${y.toFixed(1)})`);
      set("speed", "opacity", t < T.hit ? span(t, 300, 450) : 0);
      const burst = span(t, T.hit, T.hit + 280);
      set("burst", "transform", `translate(556 232) scale(${lerp(0.6, 1.5, burst).toFixed(2)})`);
      set("burst", "opacity", t >= T.hit ? (1 - burst).toFixed(2) : 0);

      const shake = t >= T.hit ? Math.sin((t - T.hit) / 55) * (1 - span(t, T.hit, T.hit + 600)) : 0;
      set("stack", "transform", `translate(${(shake * 5).toFixed(2)} 0)`);
      box("b3", t, shake);
      box("b4", t, shake);

      // Лицо: гаснет после удара, в конце из широкого экрана становится квадратным знаком
      const toMark = easeInOut(span(t, T.leave + 100, T.leave + 700));
      const dark =
        t < T.screenOff ? span(t, 1550, T.screenOff) : t < T.screenOn ? 1 : 1 - span(t, T.screenOn, T.screenOn + 100);
      set("face", "x", lerp(-36, -32, toMark));
      set("face", "y", lerp(-20, -32, toMark));
      set("face", "width", lerp(72, 64, toMark));
      set("face", "height", lerp(40, 64, toMark));
      set("face", "rx", lerp(12, 20, toMark));
      set("face", "fill", toMark > 0 ? mix(FACE, INK, toMark) : mix(FACE, "#151b22", dark));

      // Глаза: округляются перед ударом, гаснут полоской, мигают при включении, моргают, косятся
      let scaleY = 1;
      let scaleX = 1;
      let shown = 1;
      if (t >= T.hit && t < T.hit + 200) scaleY = 1.3;
      if (t >= 1550 && t < T.screenOff) {
        const q = span(t, 1550, T.screenOff);
        scaleY = q < 0.5 ? lerp(1, 0.08, q * 2) : 0.08;
        scaleX = q < 0.5 ? 1 : lerp(1, 0, (q - 0.5) * 2);
      }
      if (t >= T.screenOff && t < T.screenOn) shown = 0;
      if (t >= T.screenOn && t < T.booted) {
        const q = span(t, T.screenOn, T.booted);
        shown = q < 0.15 || (q > 0.3 && q < 0.42) || q >= 0.55 ? 1 : 0;
        scaleY = q < 0.55 ? 0.08 : lerp(0.08, 1, easeOut(span(q, 0.55, 1)));
      }
      for (const [a, b] of [
        [2750, 2930],
        [3050, 3200],
      ])
        if (t > a && t < b) scaleY = 1 - 0.9 * Math.sin(Math.PI * span(t, a, b));
      const look = easeInOut(span(t, T.lookStart, T.lookEnd));
      const eyeY = lerp(-1, -2.4, toMark);
      const eyes = [
        [lerp(-13, lerp(-5, -2.1, toMark), look), eyeY],
        [lerp(13, lerp(19, 15, toMark), look), eyeY],
      ];
      ["e1", "e2"].forEach((k, i) => {
        set(k, "opacity", shown);
        set(
          k,
          "transform",
          `translate(${eyes[i][0].toFixed(2)} ${eyes[i][1].toFixed(2)}) scale(${scaleX.toFixed(3)} ${scaleY.toFixed(3)})`,
        );
      });

      const title = easeOut(span(t, T.leave + 450, T.leave + 950));
      set("title", "opacity", title.toFixed(3));
      set("title", "transform", `translate(${lerp(-14, 0, title).toFixed(1)} 0)`);
      set("cap", "opacity", span(t, T.leave + 1050, T.leave + 1500).toFixed(3));
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) * SPEED;
      frame(Math.min(t, END));
      if (t < END) raf = requestAnimationFrame(tick);
      else setLeaving(true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Пропуск: щелчок, Esc или кнопка. Страница под заставкой не прокручивается
  useEffect(() => {
    try {
      localStorage.setItem(SEEN, "1");
    } catch {
      // не запомнили, покажем еще раз
    }
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setLeaving(true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDone, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone]);

  return (
    <div className={leaving ? "s-splash is-leaving" : "s-splash"} onClick={() => setLeaving(true)}>
      <button type="button" className="s-skip" onClick={() => setLeaving(true)}>
        Пропустить
      </button>
      <svg
        ref={svg}
        className="s-stage"
        viewBox="0 0 680 340"
        aria-label="Расклад. Сначала расклад, потом роботы"
        role="img"
      >
        <g data-k="scene">
          {SHELF_BOXES.map((b, i) => (
            <g key={i}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="2" fill={b.fill} stroke={INK} strokeWidth="1.3" />
              <path d={`M${b.x + b.w / 2} ${b.y}v7`} stroke={INK} />
            </g>
          ))}
          {RACKS.map(([x0, x1]) => (
            <g key={x0}>
              {[x0, x1].map((u) => (
                <rect
                  key={u}
                  x={u - 4}
                  y="36"
                  width="8"
                  height="254"
                  rx="1.5"
                  fill="#fff"
                  stroke={INK}
                  strokeWidth="1.4"
                />
              ))}
              {BEAMS.map((b) => (
                <rect key={b} x={x0} y={b} width={x1 - x0} height="6" rx="1" fill={INK} />
              ))}
              <rect x={x0 - 8} y="287" width="16" height="4" fill={INK} />
              <rect x={x1 - 8} y="287" width="16" height="4" fill={INK} />
            </g>
          ))}
          <path d="M0 290H680" stroke={INK} strokeWidth="1.6" />
          <g data-k="speed" stroke="var(--ink-faint)" strokeWidth="3" strokeLinecap="round" opacity="0">
            <path d="M0 -14H-40M8 8H-30M0 30H-46" />
          </g>
          <g data-k="stack">
            <rect x="556" y="248" width="74" height="42" rx="2" fill={CARD} stroke={INK} strokeWidth="1.5" />
            <path d="M593 248v9" stroke={INK} />
            <rect x="563" y="210" width="60" height="38" rx="2" fill={CARD_LIGHT} stroke={INK} strokeWidth="1.5" />
            <path d="M593 210v8" stroke={INK} />
          </g>
          <g data-k="b3" transform="translate(593 193)">
            <rect x="-23" y="-17" width="46" height="34" rx="2" fill={CARD} stroke={INK} strokeWidth="1.5" />
            <path d="M0 -17v8" stroke={INK} />
          </g>
          <g data-k="b4" transform="translate(593 163)">
            <rect x="-15" y="-13" width="30" height="26" rx="2" fill={CARD_LIGHT} stroke={INK} strokeWidth="1.5" />
            <path d="M0 -13v7" stroke={INK} />
          </g>
          <g data-k="burst" opacity="0" stroke={SIGNAL} strokeWidth="3" strokeLinecap="round">
            <path d="M-14 -34L-8 -20M14 -34L8 -20M-30 -6H-18M-26 24L-14 16" />
          </g>
        </g>

        <g data-k="rob" transform="translate(-200 232)">
          <g data-k="body">
            <rect x="-50" y="-32" width="140" height="64" rx="18" fill="#fff" stroke={INK} strokeWidth="2.4" />
            <text x="46" y="9" className="s-number">
              06
            </text>
            <rect x="-42" y="32" width="124" height="10" rx="5" fill={INK} />
            {["w1", "w2"].map((k) => (
              <g key={k} data-k={k}>
                <circle r="10" fill="#fff" stroke={INK} strokeWidth="2.4" />
                <path d="M0 0V-6" stroke={INK} strokeWidth="2" strokeLinecap="round" />
              </g>
            ))}
          </g>
          <rect data-k="face" x="-36" y="-20" width="72" height="40" rx="12" fill={FACE} />
          {["e1", "e2"].map((k) => (
            <g key={k} data-k={k}>
              <rect x="-4" y="-8.25" width="8" height="16.5" rx="4" fill="#fff" />
            </g>
          ))}
        </g>

        <text data-k="title" x="256" y="192" className="s-title" opacity="0">
          <tspan fill="var(--blue)">Ра</tspan>
          <tspan fill={INK}>склад</tspan>
        </text>
        <text data-k="cap" x="258" y="226" className="s-cap" opacity="0">
          Сначала расклад, потом роботы
        </text>
      </svg>
    </div>
  );
}
