import { Mini } from "../../ui/plans";
import { FloorBot, Mover, type FloorBotKind } from "../../ui/robots";

/* Части лендинга "/": склад, который собирается по прокрутке, и пять шагов с картинками. Все рисуется
   кодом в цветах tokens.css,
   поэтому светлая и темная тема работают сами. Кто просил меньше движения, видит все неподвижным:
   роботы стоят (robots.css), прокрутка ничего не собирает, все уже на месте (variants.css) */

const LINE = "var(--blue-line)";
const ROUTE = "var(--route)";

/* ---------- Чертеж склада для блока сборки ---------- */

/* Склад сверху: ряды стеллажей, ворота, зарядка, роботы едут по проездам */
const RACK_XS = Array.from({ length: 24 }, (_, i) => 150 + i * 48);
const aisle = (i: number) => RACK_XS[i] + 32;

type Run = { kind: FloorBotKind; path: string; seconds: number; delay: number };

// Маршруты идут по проездам между рядами, по поперечному проезду и вдоль стен, сквозь стеллажи не едут
const RUNS: Run[] = [
  { kind: "pallet", path: `M${aisle(1)} 775V440H${aisle(6)}V120H${aisle(1)}Z`, seconds: 34, delay: 0 },
  { kind: "long", path: `M${aisle(3)} 120V440H${aisle(9)}V775H${aisle(3)}Z`, seconds: 38, delay: 9 },
  { kind: "small", path: `M${aisle(16)} 775V440H${aisle(21)}V120H${aisle(16)}Z`, seconds: 30, delay: 4 },
  { kind: "pallet", path: `M${aisle(19)} 120V440H${aisle(14)}V775H${aisle(19)}Z`, seconds: 36, delay: 15 },
  { kind: "small", path: `M${aisle(10)} 120V775H${aisle(12)}V120Z`, seconds: 28, delay: 11 },
  { kind: "long", path: `M${aisle(22)} 775V120H${aisle(17)}V440H${aisle(22)}Z`, seconds: 40, delay: 22 },
];

function WarehouseFloor() {
  return (
    <>
      <defs>
        <pattern id="v-slots" width="16" height="10" patternUnits="userSpaceOnUse">
          <path d="M0 10H16" stroke={LINE} strokeWidth="0.8" />
        </pattern>
      </defs>
      <g className="v-walls" fill="none" stroke={LINE}>
        <rect x="80" y="90" width="1280" height="720" strokeWidth="1.8" pathLength={1} />
      </g>
      <g className="v-docks">
        {[360, 430, 500, 570, 640].map((x) => (
          <rect key={`in${x}`} x={x} y="85" width="50" height="9" rx="2" fill="var(--dock-in)" />
        ))}
        {[800, 870, 940, 1010, 1080].map((x) => (
          <rect key={`out${x}`} x={x} y="806" width="50" height="9" rx="2" fill="var(--dock-out)" />
        ))}
      </g>
      <g className="v-racks v-racks-a" stroke={LINE} strokeWidth="1">
        {RACK_XS.map((x) => (
          <rect key={x} x={x} y="150" width="16" height="250" fill="url(#v-slots)" />
        ))}
      </g>
      <g className="v-racks v-racks-b" stroke={LINE} strokeWidth="1">
        {RACK_XS.map((x) => (
          <rect key={x} x={x} y="480" width="16" height="260" fill="url(#v-slots)" />
        ))}
      </g>
      <g className="v-charge">
        <rect x="96" y="470" width="34" height="60" rx="5" fill="var(--blue-tint)" stroke={LINE} strokeWidth="1.2" />
        <path d="M115 482l-7 14h7l-4 14" fill="none" stroke="var(--blue)" strokeWidth="1.8" strokeLinejoin="round" />
      </g>
      <g className="v-routes" fill="none" stroke={ROUTE} strokeWidth="1.4" strokeDasharray="7 6" opacity="0.6">
        <path d="M100 440H1340" />
        {RUNS.slice(0, 4).map((run) => (
          <path key={run.path} d={run.path} />
        ))}
      </g>
      <g className="v-bots">
        {RUNS.map((run) => (
          <Mover key={run.path} kind={run.kind} path={run.path} seconds={run.seconds} delay={run.delay} scale={1.7} />
        ))}
      </g>
    </>
  );
}

/* ---------- Склад собирается по прокрутке ---------- */

const BUILD: [string, string][] = [
  ["Контур и ворота", "Стены в метрах, приемка и отгрузка на своих сторонах."],
  ["Стеллажи и проезды", "Ряды стеллажей, проезды между ними и поперечный проезд."],
  ["Зарядка", "Место зарядки: от него зависят простои и запас роботов."],
  ["Роботы на маршрутах", "Парк выезжает на план, и смена прогоняется с очередями."],
];

export function Assemble() {
  return (
    <section className="l-block v2-build" id="build" aria-labelledby="build-title">
      <div className="l-block-head">
        <div>
          <span className="l-label">План склада</span>
          <h2 id="build-title">Склад собирается из вашего плана</h2>
        </div>
        <p>По этому чертежу сервис считает пробеги, очереди у ворот и в проездах и сколько роботов нужно.</p>
      </div>
      <div className="v2-track">
        <div className="v2-stage" data-floor-busy>
          <div className="v2-side">
            <ol className="v2-steps">
              {BUILD.map(([title, text], i) => (
                <li key={title} className={`v2-step v2-step-${i + 1}`}>
                  <span className="l-n">{String(i + 1).padStart(2, "0")}</span>
                  <b>{title}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
            <p className="v2-hint">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2v11M3.5 8.5L8 13l4.5-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Листайте ниже: склад соберется по шагам
            </p>
          </div>
          <div className="v2-sheet l-panel">
            <svg viewBox="60 60 1320 790" role="img" aria-labelledby="build-plan">
              <title id="build-plan">План склада: стены, ворота, ряды стеллажей, зарядка и роботы на маршрутах</title>
              <WarehouseFloor />
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- Пять шагов на маршруте ---------- */

/* Робот едет вдоль шагов и останавливается у каждого; шаг, у которого он стоит, подсвечен */
export function StepRoute() {
  return (
    <div className="v1-route" aria-hidden="true">
      <i className="v1-route-line" />
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className="v1-stop" style={{ left: `${i * 20}%` }} />
      ))}
      <span className="v1-car">
        <svg viewBox="-24 -16 48 32" width="48" height="32">
          <FloorBot kind="pallet" transform="rotate(90)" />
        </svg>
      </span>
    </div>
  );
}

const PIC = { width: 56, height: 38, viewBox: "0 0 56 38", fill: "none", "aria-hidden": true } as const;

/* Маленькие картинки к шагам в том же чертежном виде, что и пиктограммы объектов */
export function StepPic({ step }: { step: number }) {
  if (step === 0)
    return (
      <span className="v1-pic">
        <Mini id="warehouse" />
      </span>
    );
  if (step === 1)
    return (
      <svg className="v1-pic" {...PIC}>
        {[9, 19, 29].map((y, i) => (
          <g key={y}>
            <path d={`M6 ${y}H50`} stroke={LINE} strokeWidth="1" />
            <circle cx={[34, 18, 42][i]} cy={y} r="3.2" fill="var(--paper)" stroke="var(--blue)" strokeWidth="1.4" />
          </g>
        ))}
      </svg>
    );
  if (step === 2)
    return (
      <svg className="v1-pic" {...PIC}>
        <rect x="4" y="4" width="48" height="30" stroke={LINE} strokeWidth="1.2" />
        {[12, 20, 28, 36].map((x) => (
          <rect key={x} x={x} y="9" width="4" height="9" fill="var(--blue-pale)" stroke={LINE} strokeWidth="0.7" />
        ))}
        <path d="M14 30V22H42" stroke={ROUTE} strokeWidth="1" strokeDasharray="2.5 2" />
      </svg>
    );
  if (step === 3)
    return (
      <svg className="v1-pic" {...PIC}>
        <rect x="4" y="5" width="48" height="28" rx="4" stroke={LINE} strokeWidth="1.2" />
        <rect x="9" y="11" width="12" height="9" rx="1.5" fill="var(--blue-tint)" stroke={LINE} strokeWidth="0.7" />
        <path d="M26 13H44M26 18H38" stroke={LINE} strokeWidth="1" />
        <rect x="9" y="24" width="7" height="5" rx="1.2" fill="var(--blue)" />
        <path d="M10.5 26.5l1.4 1.3 2.4-2.6" stroke="var(--on-blue)" strokeWidth="1" />
        <path d="M20 26.5H40" stroke={LINE} strokeWidth="1" />
      </svg>
    );
  return (
    <svg className="v1-pic" {...PIC}>
      <path d="M4 34H52" stroke={LINE} strokeWidth="1.2" />
      <rect x="9" y="8" width="10" height="26" fill="var(--blue-pale)" stroke={LINE} strokeWidth="0.8" />
      <rect x="23" y="20" width="10" height="14" fill="var(--blue)" />
      <rect x="37" y="19" width="10" height="15" fill="var(--blue-pale)" stroke={LINE} strokeWidth="0.8" />
    </svg>
  );
}
