import type { CSSProperties, ReactNode } from "react";

import type { Tool } from "./Editor";

/* Карточки инструментов, как в графических редакторах: что это, зачем, как править после установки,
   совет и короткая зацикленная сценка. Сценки нарисованы тем же листом, что чертеж: светлый пол,
   темно-синие стены, ряды гаммой уровней. Двигаются только сдвиг и прозрачность, по одной кривой.
   Цифры в советах из config/layouts.yaml, там же источники. */

export type ToolDemo = { title: string; text: ReactNode; edit: ReactNode; tip: ReactNode; scene: ReactNode };

// Курсор едет из одной точки в другую: концы пути задаем переменными, анимация у всех одна
function Cursor({ from, to }: { from: [number, number]; to: [number, number] }) {
  const style = {
    "--x0": `${from[0]}px`,
    "--y0": `${from[1]}px`,
    "--x1": `${to[0]}px`,
    "--y1": `${to[1]}px`,
  } as CSSProperties;
  return <path d="M0 0l0 13 3.4-3.2 2.4 5.2 2-.9-2.3-5.1 4.6-.2z" className="u-demo-cursor" style={style} />;
}

// Пунктирная рамка протяжки растет от угла за курсором
function Frame({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <rect x={x} y={y} width={w} height={h} className="u-demo-frame" />;
}

// То, что появляется после протяжки; delay раскладывает появление по очереди
// early: появляется, пока курсор еще едет (ворота встают одни за другими по ходу)
function Show({ children, delay = 0, early = false }: { children: ReactNode; delay?: number; early?: boolean }) {
  return (
    <g className={early ? "u-demo-show is-early" : "u-demo-show"} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </g>
  );
}

function Scene({ children, floor = [8, 8, 204, 108] }: { children: ReactNode; floor?: number[] }) {
  const [x, y, w, h] = floor;
  return (
    <svg viewBox="0 0 220 124" className="u-demo" aria-hidden="true">
      <rect x={x} y={y} width={w} height={h} className="u-demo-floor" />
      {children}
      <rect x={x} y={y} width={w} height={h} className="u-demo-wall" />
    </svg>
  );
}

const rack = (x: number, y = 22, h = 80) => (
  <rect key={`${x}:${y}`} x={x} y={y} width="12" height={h} className="u-demo-rack" />
);

const gates = (xs: number[], y = 110) =>
  xs.map((x) => <rect key={x} x={x} y={y} width="18" height="10" className="u-demo-gate-box" />);

export const DEMOS: Partial<Record<Tool, ToolDemo>> = {
  row: {
    title: "Ряд",
    text: "Один ряд стеллажей там, где он стоит у вас: протяните вдоль ряда.",
    edit: "Тяните за конец, чтобы удлинить; длину и тип стеллажа меняют в окне справа.",
    tip: "Рядов много? Быстрее инструмент «Ряды»: он ставит их целой зоной с проездами.",
    scene: (
      <Scene>
        {[30, 58].map((x) => rack(x))}
        <Frame x={100} y={22} w={14} h={80} />
        <Show>
          <rect x="100" y="22" width="14" height="80" className="u-demo-row" />
        </Show>
        <Cursor from={[100, 22]} to={[114, 102]} />
      </Scene>
    ),
  },
  racks: {
    title: "Ряды",
    text: "Зона хранения целиком: протяните прямоугольник по полу, и ряды стеллажей встанут в нем с проездами.",
    edit: "Число рядов, проезд и тип стеллажа в окне справа, R поворачивает ряды, за край добавляются ряды.",
    tip: "Между рядами оставьте проезд, как у вас на складе: погрузчику нужно не меньше 3,5 м. Если проезд уже, план покажет, что погрузчик не проходит.",
    scene: (
      <Scene>
        <Frame x={40} y={26} w={140} h={72} />
        {[48, 70, 92, 114, 136, 158].map((x, index) => (
          <Show key={x} delay={index * 60}>
            <rect x={x} y="30" width="14" height="64" className="u-demo-row" />
          </Show>
        ))}
        <Cursor from={[40, 26]} to={[180, 98]} />
      </Scene>
    ),
  },
  aisle: {
    title: "Проезд",
    text: "Поперечный проезд через зону хранения: протяните полосу поперек рядов, стеллажи под ней уберутся.",
    edit: "Тяните проезд вдоль рядов, за край меняется ширина. Шаг проездов по всей зоне задают в окне зоны.",
    tip: "Ряд длиннее 30 м без поперечного проезда заставляет робота ехать в обход.",
    scene: (
      <Scene>
        {[30, 58, 86, 114, 142, 170].map((x) => (
          <g key={x}>
            <rect x={x} y="18" width="12" height="36" className="u-demo-rack" />
            <rect x={x} y="54" width="12" height="16" className="u-demo-rack u-demo-hide" />
            <rect x={x} y="70" width="12" height="36" className="u-demo-rack" />
          </g>
        ))}
        <Frame x={20} y={54} w={172} h={16} />
        <Cursor from={[20, 54]} to={[192, 70]} />
      </Scene>
    ),
  },
  dock: {
    title: "Ворота",
    text: "Места, где фуры встают под погрузку. Ставьте там, где ворота стоят у вас на складе: ведите вдоль наружной стены, ворота встанут в ряд.",
    edit: "Тяните вдоль стены, за конец ворота шире.",
    tip: "У каждых ворот свое назначение: приемка, отгрузка или и то и другое. Щелкните по воротам и выберите его в окне справа, цвет ворот поменяется.",
    scene: (
      <Scene floor={[8, 8, 204, 92]}>
        {[30, 58, 86, 114, 142, 170].map((x) => rack(x, 20, 44))}
        {[34, 62, 90, 118, 146].map((x, index) => (
          <Show key={x} delay={index * 300} early>
            <rect x={x} y="94" width="20" height="12" className="u-demo-gate-box" />
            <path d={`M${x + 4} 106v8M${x + 16} 106v8`} className="u-demo-line" />
          </Show>
        ))}
        <Cursor from={[40, 102]} to={[158, 102]} />
      </Scene>
    ),
  },
  buffer: {
    title: "Буфер у ворот",
    text: "Площадка у ворот, где груз ждет приемки или отгрузки. От нее считается маршрут робота.",
    edit: "Тяните целиком или за край; назначение буфера в окне справа.",
    tip: "Ставьте вплотную к воротам: буфер в стороне удлиняет каждый рейс.",
    scene: (
      <Scene>
        {[30, 58, 86, 114, 142, 170].map((x) => rack(x, 18, 50))}
        {gates([44, 72, 100, 128])}
        <Frame x={40} y={80} w={112} h={26} />
        <Show>
          <rect x="40" y="80" width="112" height="26" className="u-demo-buffer" />
        </Show>
        <Cursor from={[40, 80]} to={[152, 106]} />
      </Scene>
    ),
  },
  blocked: {
    title: "Перегородка",
    text: "Комната или стена, через которую не проехать: офис, холодильник, техническое помещение.",
    edit: "Тяните целиком или за край, размеры числами в окне справа.",
    tip: "Колонны тоже рисуют перегородкой: маленький квадрат на месте колонны.",
    scene: (
      <Scene>
        {[20, 48, 76, 104].map((x) => rack(x))}
        <Frame x={140} y={16} w={64} h={46} />
        <Show>
          <rect x="140" y="16" width="64" height="46" className="u-demo-room" />
          <path d="M140 38l22-22M140 60l44-44M160 62l44-44M182 62l22-22" className="u-demo-hatch" />
        </Show>
        <Cursor from={[140, 16]} to={[204, 62]} />
      </Scene>
    ),
  },
  nogo: {
    title: "Закрытая зона",
    text: "Пол, которым роботы не пользуются: участок людей, стоянка погрузчиков, зона зарядки техники.",
    edit: "Тяните целиком или за край. В отличие от перегородки, стен у зоны нет.",
    tip: "Закройте проход людей через склад: иначе расчет пустит робота по нему.",
    scene: (
      <Scene>
        {[20, 48, 76, 104].map((x) => rack(x))}
        <Frame x={136} y={60} w={68} h={48} />
        <Show>
          <rect x="136" y="60" width="68" height="48" className="u-demo-nogo" />
          <path d="M146 70l48 28M194 70l-48 28" className="u-demo-nogo-x" />
        </Show>
        <Cursor from={[136, 60]} to={[204, 108]} />
      </Scene>
    ),
  },
  ramp: {
    title: "Пандус",
    text: "Съезд между разными отметками пола. Без пандуса робот на поднятую часть не попадет.",
    edit: "Тяните целиком или за край; можно класть прямо поверх стеллажей.",
    tip: "Протягивайте поперек ступени: половина пандуса на нижнем полу, половина на верхнем.",
    scene: (
      <Scene>
        <rect x="120" y="8" width="92" height="108" className="u-demo-high" />
        <path d="M120 8v108" className="u-demo-step" />
        <Frame x={96} y={50} w={48} h={24} />
        <Show>
          <rect x="96" y="50" width="48" height="24" className="u-demo-ramp" />
          <path d="M104 62h32M130 57l6 5-6 5" className="u-demo-line" />
        </Show>
        <Cursor from={[96, 50]} to={[144, 74]} />
      </Scene>
    ),
  },
  flow: {
    title: "Линия движения",
    text: "Одностороннее движение по проезду: по полосе едут только по стрелке, поперек переезжать можно.",
    edit: "Тяните вдоль проезда, R разворачивает стрелку, Shift+R поворачивает полосу.",
    tip: "Чаще хватает змейки: выберите зону хранения и нажмите S, полосы лягут по всем проездам.",
    scene: (
      <Scene>
        {[30, 58, 86, 114, 142, 170].map((x) => rack(x, 18, 60))}
        <Frame x={24} y={88} w={170} h={14} />
        <Show>
          <rect x="24" y="88" width="170" height="14" className="u-demo-lane" />
          {[50, 90, 130, 170].map((x) => (
            <path key={x} d={`M${x} 91l6 4-6 4`} className="u-demo-line" />
          ))}
        </Show>
        <Cursor from={[24, 88]} to={[194, 102]} />
      </Scene>
    ),
  },
  station: {
    title: "Станция",
    text: "Место, где человек берет товар из стеллажа, который привез робот. Нужна для отбора в робозоне.",
    edit: "Тяните целиком или за край, размеры в окне справа.",
    tip: "Ставьте у края робозоны, ближе к отгрузке: робот ездит к станции на каждый заказ.",
    scene: (
      <Scene>
        {[24, 40, 56, 72, 88, 104, 120, 136, 152, 168, 184].map((x) => (
          <rect key={x} x={x} y="18" width="10" height="56" className="u-demo-rack" />
        ))}
        <Frame x={84} y={86} w={40} h={22} />
        <Show>
          <rect x="84" y="86" width="40" height="22" className="u-demo-station" />
          <circle cx="104" cy="97" r="6" className="u-demo-line" />
        </Show>
        <Cursor from={[84, 86]} to={[124, 108]} />
      </Scene>
    ),
  },
  hall: {
    title: "Здание и секции",
    text: "Пол здания. Щелчок выбирает здание, его углы и стены тянутся. Протяжка поверх зала кладет секцию.",
    edit: "Отметку пола и потолок секции меняют в окне справа: так делают антресоль или рампу.",
    tip: "Поднятую секцию соедините с залом пандусом, иначе робот туда не проедет.",
    scene: (
      <Scene>
        <Frame x={120} y={16} w={84} h={52} />
        <Show>
          <rect x="120" y="16" width="84" height="52" className="u-demo-high" />
          <path d="M120 16h84v52h-84z" className="u-demo-step" />
        </Show>
        <Cursor from={[120, 16]} to={[204, 68]} />
      </Scene>
    ),
  },
  outline: {
    title: "Контур здания",
    text: "Здание не прямоугольником: щелкайте по углам по порядку, углы встают прямыми.",
    edit: "Щелчок в первую точку или Enter замыкает. Del и Ctrl+Z убирают последнюю точку, Esc отменяет.",
    tip: "Угол убирают щелчком и Del, контур целиком убирает Del по зданию.",
    scene: (
      <svg viewBox="0 0 220 124" className="u-demo" aria-hidden="true">
        <Show>
          <path d="M20 16h120v40h60v52h-180z" className="u-demo-floor u-demo-wall" />
        </Show>
        {[
          [20, 16],
          [140, 16],
          [140, 56],
          [200, 56],
          [200, 108],
          [20, 108],
        ].map(([x, y], index) => (
          <Show key={index} delay={index * 220} early>
            <circle cx={x} cy={y} r="4" className="u-demo-dot" />
          </Show>
        ))}
      </svg>
    ),
  },
  hole: {
    title: "Вырез",
    text: "Убирает пол там, где его нет: двор, выступ, угол здания буквой Г.",
    edit: "Тяните целиком или за край, чтобы поменять размер.",
    tip: "Для здания сложной формы удобнее «Контур здания»: обвести углы точками.",
    scene: (
      <Scene>
        <Frame x={140} y={8} w={72} h={48} />
        <Show>
          <rect x="140" y="6" width="74" height="50" className="u-demo-cut" />
          <path d="M146 20l12-12M146 40l32-32M154 52l44-44M174 52l38-38M194 52l18-18" className="u-demo-cut-lines" />
          <path d="M140 8v48h72" className="u-demo-wall" />
        </Show>
        <Cursor from={[140, 8]} to={[212, 56]} />
      </Scene>
    ),
  },
};

/* Отметка пола: часть зала поднимается секцией, у нее своя отметка, на нее ведет пандус */
export const LEVEL_SCENE = (
  <svg viewBox="0 0 220 124" className="u-demo" aria-hidden="true">
    <rect x="8" y="8" width="204" height="108" className="u-demo-floor" />
    <g className="u-demo-show">
      <rect x="120" y="8" width="92" height="108" className="u-demo-high" />
      <path d="M120 8v108" className="u-demo-step" />
      <text x="166" y="66" className="u-demo-label" textAnchor="middle">
        +1,2 м
      </text>
    </g>
    <text x="62" y="66" className="u-demo-label" textAnchor="middle">
      +0 м
    </text>
    <g className="u-demo-show is-late">
      <rect x="100" y="84" width="40" height="20" className="u-demo-ramp" />
      <path d="M106 94h26M127 90l5 4-5 4" className="u-demo-line" />
    </g>
    <rect x="8" y="8" width="204" height="108" className="u-demo-wall" />
  </svg>
);
