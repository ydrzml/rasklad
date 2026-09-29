import { useEffect, useState, type CSSProperties } from "react";
import "./robots.css";

// Роботы-персонажи. Пять характеров сбоку и одна семья сверху для планов.
// 07 трудяга с грузом, 06 спит на зарядке, 12 умный комплектовщик с моноклем,
// 03 ключник в фуражке стережет проекты до входа, 04 разведчик потерял маршрут на странице 404.
// Сверху ездит семья 07: малыш с одной коробкой, сам 07 и длинный с тремя.
// Глаза следят за указателем через переменные --lx и --ly, их ставит страница.

export const INK = "#0d141b";
export const FACE = "#0c2c53";
export const SIGNAL = "#e0512b";
export const CARD = "#efe2cc";
export const CARD_LIGHT = "#f6ecdb";
export const PALLET = "#d9c3a0";
const BLUEPRINT = "#1e4f8e";
const ROUTE = "#4a86cf";

/* Что страница может сказать 07. Без этого он живет сам: глаза идут за указателем через --lx и --ly.
   eyes сдвигает глаза, shut прикрывает их наполовину, lean откидывает корпус (градусы, минус назад),
   mood: радуется или смущается. idle: пока его не трогают, время от времени верхняя коробка съезжает,
   а он подкатывается под нее и возвращает на место. */
export type Pallet07Mood = "calm" | "cheer" | "oops";
// Сколько идет сценка с коробкой: столько же, сколько анимация r-nudge в robots.css
const NUDGE_MS = 3200;
export type Pallet07Eyes = { x: number; y: number; shut?: boolean };

export function Pallet07({
  className,
  eyes,
  lean = 0,
  mood = "calm",
  idle = false,
}: {
  className?: string;
  eyes?: Pallet07Eyes;
  lean?: number;
  mood?: Pallet07Mood;
  idle?: boolean;
}) {
  const [nudging, setNudging] = useState(false);

  // Раз в 7-12 секунд тишины коробка съезжает. Сценка идет NUDGE_MS, потом снова ждем
  useEffect(() => {
    if (!idle || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    const wait = () => {
      timer = window.setTimeout(
        () => {
          setNudging(true);
          timer = window.setTimeout(() => {
            setNudging(false);
            wait();
          }, NUDGE_MS);
        },
        7000 + Math.random() * 5000,
      );
    };
    wait();
    return () => {
      window.clearTimeout(timer);
      setNudging(false);
    };
  }, [idle]);

  const classes = [className, mood === "calm" ? "" : `r-${mood}`, nudging && idle ? "r-nudge" : ""]
    .filter(Boolean)
    .join(" ");
  const gaze = eyes ? { transform: `translate(${eyes.x}px, ${eyes.y}px)` } : undefined;
  return (
    <svg className={classes} viewBox="0 0 170 112" aria-hidden="true">
      <g className="r-roll">
        <g className="r-lean" style={{ transform: `rotate(${lean}deg)` }}>
          <g className="r-bob">
            <rect x="30" y="54" width="100" height="7" rx="1.5" fill={PALLET} stroke={INK} strokeWidth="1.4" />
            <path d="M40 54v7M60 54v7M80 54v7M100 54v7M120 54v7" stroke={INK} strokeWidth="1" />
            {/* Груз чуть запаздывает за корпусом, когда 07 откидывается, и сам понемногу покачивается */}
            <g className="r-cargo" style={{ transform: `translateX(${-lean * 0.6}px)` }}>
              <g className="r-jolt">
                <g className="r-sway">
                  <rect x="34" y="26" width="42" height="28" rx="2" fill={CARD} stroke={INK} strokeWidth="1.4" />
                  <path d="M55 26v10" stroke={INK} strokeWidth="1" />
                </g>
                <g className="r-sway r-sway-late">
                  <rect x="78" y="30" width="46" height="24" rx="2" fill={CARD} stroke={INK} strokeWidth="1.4" />
                  <path d="M101 30v8" stroke={INK} strokeWidth="1" />
                </g>
                <g className="r-slip">
                  <g className="r-wobble">
                    <rect x="50" y="4" width="38" height="22" rx="2" fill={CARD_LIGHT} stroke={INK} strokeWidth="1.4" />
                    <path d="M69 4v8" stroke={INK} strokeWidth="1" />
                  </g>
                </g>
              </g>
            </g>
            <rect x="12" y="61" width="136" height="34" rx="11" fill="#fff" stroke={INK} strokeWidth="1.6" />
            <rect x="20" y="68" width="50" height="20" rx="7" fill={FACE} />
            {mood === "cheer" ? (
              <path
                d="M29 80q5.5-6 11 0M48 80q5.5-6 11 0"
                stroke="#fff"
                strokeWidth="2.2"
                fill="none"
                strokeLinecap="round"
              />
            ) : (
              <g className="r-blink">
                <g className={eyes?.shut ? "r-look r-shut" : "r-look"} style={gaze}>
                  <rect className="r-eye" x="29" y="73" width="11" height="10" rx="3" fill="#fff" />
                  <rect className="r-eye" x="48" y="73" width="11" height="10" rx="3" fill="#fff" />
                </g>
              </g>
            )}
            <text x="116" y="84" className="r-number" fontSize="12">
              07
            </text>
            <path d="M80 88h26" stroke={SIGNAL} strokeWidth="3" strokeLinecap="round" />
            <path d="M140 61L148 12" stroke={INK} strokeWidth="1.4" />
            <path className="r-flag" d="M148 12l16 5-15 6z" fill={SIGNAL} />
          </g>
        </g>
        <rect x="18" y="95" width="124" height="5" rx="2.5" fill={INK} />
        <circle cx="34" cy="103" r="6" fill="#fff" stroke={INK} strokeWidth="1.6" />
        <circle cx="126" cy="103" r="6" fill="#fff" stroke={INK} strokeWidth="1.6" />
      </g>
    </svg>
  );
}

export function Picker12({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 130 190" aria-hidden="true">
      <g className="r-bob">
        <rect x="60" y="60" width="10" height="36" rx="2" fill="#fff" stroke={INK} strokeWidth="1.4" />
        <rect x="56" y="94" width="18" height="58" rx="3" fill="#fff" stroke={INK} strokeWidth="1.5" />
        <path d="M56 108h18M56 122h18M56 136h18" stroke={INK} strokeWidth="1" />
        <g className="r-tilt">
          <rect x="20" y="14" width="88" height="48" rx="16" fill="#fff" stroke={INK} strokeWidth="1.6" />
          <rect x="28" y="22" width="72" height="32" rx="11" fill={FACE} />
          <g className="r-blink">
            <g className="r-look">
              <rect x="40" y="33" width="12" height="11" rx="3" fill="#fff" />
              <rect x="72" y="33" width="12" height="11" rx="3" fill="#fff" />
            </g>
          </g>
          <path className="r-brow" d="M70 27l14-2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          <circle cx="78" cy="38.5" r="10" fill="none" stroke={SIGNAL} strokeWidth="2" />
          <path d="M86 45c6 6 6 14 2 22s-2 14 3 18" fill="none" stroke={SIGNAL} strokeWidth="1" strokeDasharray="2 2" />
        </g>
      </g>
      <rect x="20" y="150" width="90" height="22" rx="10" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <rect x="28" y="159" width="26" height="4" rx="2" fill={SIGNAL} />
      <text x="88" y="165" className="r-number" fontSize="10">
        12
      </text>
      <circle cx="36" cy="176" r="6.5" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <circle cx="94" cy="176" r="6.5" fill="#fff" stroke={INK} strokeWidth="1.6" />
    </svg>
  );
}

export function Sleeper06({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 190 128" aria-hidden="true">
      <text className="r-zz" x="80" y="66" fontSize="12">
        z
      </text>
      <text className="r-zz r-zz2" x="80" y="66" fontSize="14">
        z
      </text>
      <text className="r-zz r-zz3" x="80" y="66" fontSize="17">
        Z
      </text>
      <rect x="146" y="30" width="30" height="86" rx="6" fill="#fff" stroke={INK} strokeWidth="1.5" />
      <rect x="151" y="38" width="20" height="30" rx="3" fill={FACE} />
      <path d="M162 41l-4 6h4l-2 5" fill="none" stroke={SIGNAL} strokeWidth="1.4" strokeLinejoin="round" />
      <rect x="154" y="56" width="12" height="7" rx="1.5" fill="none" stroke="#fff" strokeWidth="1" />
      <rect x="166" y="58" width="1.6" height="3" fill="#fff" />
      <rect x="155.5" y="57.5" width="2.5" height="4" fill={SIGNAL} />
      <text x="161" y="80" textAnchor="middle" className="r-number r-low" fontSize="8">
        7%
      </text>
      <rect x="138" y="114" width="46" height="6" rx="3" fill={INK} />
      <path d="M146 96c-8 0-10 0-18 0" fill="none" stroke={INK} strokeWidth="1.5" />
      <path className="r-spark" d="M141 92l3-5 1 4 3-4" fill="none" stroke={SIGNAL} strokeWidth="1.3" />
      <g className="r-breathe">
        <rect x="58" y="72" width="70" height="32" rx="9" fill="#fff" stroke={INK} strokeWidth="1.6" />
        <rect x="65" y="78" width="36" height="20" rx="6" fill={FACE} />
        <path
          d="M71 88q3.5 3.5 7 0M86 88q3.5 3.5 7 0"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <text x="106" y="92" className="r-number" fontSize="10">
          06
        </text>
      </g>
      <rect x="62" y="104" width="62" height="5" rx="2.5" fill={INK} />
      <circle cx="74" cy="112" r="5" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <circle cx="112" cy="112" r="5" fill="#fff" stroke={INK} strokeWidth="1.6" />
    </svg>
  );
}

/* 03, ключник: стережет проекты до входа. Черта одна: фуражка и связка ключей
   живут от прыжка корпуса. Он подпрыгивает, приземляется, приподнимает другой бок;
   фуражка по инерции взлетает и садится, ключи раскачиваются и затихают. */
export function Keeper03({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="18 26 132 100" aria-hidden="true">
      <defs>
        <radialGradient id="r-shade-03">
          <stop offset="0" stopColor={INK} stopOpacity=".2" />
          <stop offset=".7" stopColor={INK} stopOpacity=".06" />
          <stop offset="1" stopColor={INK} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse className="r-shade" cx="76" cy="119" rx="48" ry="6" fill="url(#r-shade-03)" />
      <g className="r-hop">
        <rect x="30" y="55" width="92" height="48" rx="12" fill="#fff" stroke={INK} strokeWidth="1.6" />
        <rect x="38" y="63" width="48" height="24" rx="8" fill={FACE} />
        <g className="r-glance">
          <rect x="46" y="69" width="10" height="11" rx="3" fill="#fff" />
          <rect x="66" y="69" width="10" height="11" rx="3" fill="#fff" />
        </g>
        <text x="94" y="81" className="r-number" fontSize="10">
          03
        </text>
        <path d="M42 95h22" stroke={SIGNAL} strokeWidth="3" strokeLinecap="round" />
        <g className="r-cap">
          <path
            d="M44 47L37 40.5Q36 37 40 37H82Q86 37 85 40.5L78 47Z"
            fill={FACE}
            stroke={INK}
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <rect x="44" y="47" width="34" height="8" fill={INK} />
          <path d="M44 50.5h34" stroke={SIGNAL} strokeWidth="1.8" />
          <circle cx="52" cy="43" r="2.3" fill={SIGNAL} />
          <path d="M47 49.5H39Q33.5 49.5 32 53.6Q31.7 54.8 33 54.6Q38 53.8 47 53.6Z" fill={INK} />
          <path d="M34.5 53.2Q38 51.6 42 51.3" stroke="#fff" strokeOpacity=".35" strokeWidth=".8" fill="none" />
        </g>
        <g className="r-keys">
          <path d="M122 76h4" stroke={INK} strokeWidth="1.5" />
          <circle cx="130" cy="79" r="4.5" fill="none" stroke={INK} strokeWidth="1.5" />
          <path d="M127 83v14M127 93h3M127 96h2" stroke={BLUEPRINT} strokeWidth="2" fill="none" />
          <circle cx="127" cy="82" r="2.6" fill="#fff" stroke={BLUEPRINT} strokeWidth="1.5" />
          <path d="M133 83v11M133 91h3M133 94h2" stroke={SIGNAL} strokeWidth="2" fill="none" />
          <circle cx="133" cy="82" r="2.6" fill="#fff" stroke={SIGNAL} strokeWidth="1.5" />
        </g>
        <rect x="34" y="103" width="84" height="5" rx="2.5" fill={INK} />
        <circle cx="48" cy="112" r="5.5" fill="#fff" stroke={INK} strokeWidth="1.6" />
        <circle cx="104" cy="112" r="5.5" fill="#fff" stroke={INK} strokeWidth="1.6" />
      </g>
    </svg>
  );
}

/* 04, разведчик: для страницы, которой нет. Пунктир маршрута ведет к нему и обрывается
   прямо перед ним, дальше пустой пол. Он стоит у края разметки, над ним всплывает вопрос. */
export function Scout04({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 130" aria-hidden="true">
      <path d="M0 114h200M0 126h200M30 110v20M60 110v20M90 110v20M120 110v20M150 110v20M180 110v20" stroke="#dce9f8" />
      <path className="r-route" d="M0 118H112" stroke={ROUTE} strokeWidth="2.5" fill="none" />
      <path d="M114 111v14" stroke={SIGNAL} strokeWidth="2.5" strokeLinecap="round" />
      <text className="r-ask" x="100" y="32" fontSize="17" fontWeight="600">
        ?
      </text>
      <g className="r-bob">
        <rect x="18" y="48" width="88" height="48" rx="12" fill="#fff" stroke={INK} strokeWidth="1.6" />
        <rect x="50" y="56" width="48" height="24" rx="8" fill={FACE} />
        <g className="r-blink">
          <g className="r-glance">
            <rect x="60" y="62" width="10" height="11" rx="3" fill="#fff" />
            <rect x="80" y="62" width="10" height="11" rx="3" fill="#fff" />
          </g>
        </g>
        <text x="26" y="74" className="r-number" fontSize="10">
          04
        </text>
        <path d="M26 88h22" stroke={SIGNAL} strokeWidth="3" strokeLinecap="round" />
      </g>
      <rect x="22" y="96" width="80" height="5" rx="2.5" fill={INK} />
      <circle cx="36" cy="105" r="5.5" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <circle cx="88" cy="105" r="5.5" fill="#fff" stroke={INK} strokeWidth="1.6" />
    </svg>
  );
}

// Семья 07 сверху. Размеры в единицах чертежа, спереди у всех +x
export type FloorBotKind = "small" | "pallet" | "long";

type Box = [x: number, y: number, w: number, h: number];
type Shape = { w: number; h: number; boxes: Box[]; slats: number[] };

export const FLOOR_BOTS: Record<FloorBotKind, Shape> = {
  small: { w: 18, h: 14, boxes: [[-6, -4.5, 9, 9]], slats: [] },
  pallet: {
    w: 26,
    h: 16,
    boxes: [
      [-10, -6, 9, 12],
      [0, -5, 8, 10],
    ],
    slats: [-9, -3, 3],
  },
  long: {
    w: 34,
    h: 16,
    boxes: [
      [-14, -6, 8, 12],
      [-5, -6, 8, 12],
      [4, -6, 8, 12],
    ],
    slats: [-13, -7, -1, 5, 11],
  },
};

export function FloorBot({ kind, transform }: { kind: FloorBotKind; transform?: string }) {
  const { w, h, boxes, slats } = FLOOR_BOTS[kind];
  return (
    <g transform={transform}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#fff" stroke={INK} strokeWidth="1.3" />
      {slats.map((x) => (
        <path key={x} d={`M${x} ${-h / 2}v${h}`} stroke={PALLET} strokeWidth="2" />
      ))}
      {boxes.map(([x, y, bw, bh], i) => (
        <rect
          key={i}
          x={x}
          y={y}
          width={bw}
          height={bh}
          rx="1"
          fill={i % 2 ? CARD_LIGHT : CARD}
          stroke={INK}
          strokeWidth="0.9"
          transform={kind === "pallet" && i === 1 ? "rotate(-8 4 0)" : undefined}
        />
      ))}
      <circle cx={-w / 2 + 2} cy={-h / 2 + 2} r="1.7" fill="#4a86cf" />
      <rect x={w / 2 - 2} y="-3.5" width="2" height="7" rx="1" fill={FACE} />
    </g>
  );
}

// Робот, который едет по замкнутому маршруту на плане. Путь в координатах того же SVG
export function Mover({
  kind,
  path,
  seconds,
  delay = 0,
  scale,
}: {
  kind: FloorBotKind;
  path: string;
  seconds: number;
  delay?: number;
  scale?: number;
}) {
  const style: CSSProperties = {
    offsetPath: `path('${path}')`,
    animationDuration: `${seconds}s`,
    animationDelay: `${-delay}s`,
  };
  return (
    <g className="r-mover" style={style}>
      <FloorBot kind={kind} transform={scale ? `scale(${scale.toFixed(2)})` : undefined} />
    </g>
  );
}
