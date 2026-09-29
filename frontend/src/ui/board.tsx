/* Чертежная доска и все, что рядом с ней: масштаб, меню по правой кнопке, окно свойств,
   панель инструментов, легенда и числа под листом.

   Доска работает как карта в игровом редакторе: колесо приближает к курсору, пустое место
   тянется рукой, кнопки в углу вписывают лист. Координаты внутри в метрах от левого верхнего
   угла участка. Переворот в систему движка, где ноль внизу, делает экран: так подписи
   не встают вверх ногами. */
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import "./board.css";
import { unitText } from "./digits";

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
/* Как лист лежит на экране: точка экрана = метры * s + сдвиг */
export type View = { s: number; tx: number; ty: number };

type BoardProps = {
  widthM: number;
  lengthM: number;
  fit: Box;
  fitKey?: string;
  children: (view: View) => ReactNode;
  overlay?: ReactNode;
  onDown?: (point: Point, event: ReactPointerEvent<SVGSVGElement>) => boolean;
  onMove?: (point: Point, event: ReactPointerEvent<SVGSVGElement>) => void;
  onUp?: (point: Point, event: ReactPointerEvent<SVGSVGElement>) => void;
  onContext?: (point: Point, event: ReactMouseEvent<SVGSVGElement>) => void;
  onDouble?: (point: Point, event: ReactMouseEvent<SVGSVGElement>) => void;
  onKey?: (event: ReactKeyboardEvent<SVGSVGElement>) => void;
  onLeave?: () => void;
  onView?: (view: View, size: { w: number; h: number }) => void;
  cursor?: string;
  label: string;
  status?: ReactNode;
  hint?: ReactNode;
  still?: boolean;
  /* своя кнопка под кнопками масштаба, например «на весь экран» */
  corner?: ReactNode;
};

const MAX_SCALE = 60;

export function Board(props: BoardProps) {
  const { widthM, lengthM, fit, fitKey, children, overlay, cursor, label, status, hint, still, corner } = props;
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const space = useRef(false);
  const fitted = useRef("");
  const onView = props.onView;

  useLayoutEffect(() => {
    const node = svg.current;
    if (!node) return;
    // меряем сразу, не дожидаясь наблюдателя: в фоновой вкладке он молчит, и лист не вписывался
    const first = node.getBoundingClientRect();
    setSize({ w: first.width, h: first.height });
    const watch = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  const fitView = useCallback((): View => {
    const pad = 28;
    // сверху и снизу отступ больше: вверху табличка с числами плана, внизу переключатель вида
    const top = 48;
    const bottom = 52;
    const s = Math.min((size.w - pad * 2) / Math.max(fit.w, 1), (size.h - bottom - top) / Math.max(fit.h, 1));
    return {
      s,
      tx: (size.w - fit.w * s) / 2 - fit.x * s,
      ty: top + (size.h - bottom - top - fit.h * s) / 2 - fit.y * s,
    };
  }, [size, fit.x, fit.y, fit.w, fit.h]);

  // Вписываем лист, когда доска впервые получила размер и когда сменился ключ: другой шаблон,
  // другое здание. Обычная правка лист не двигает, иначе он прыгал бы под рукой.
  useEffect(() => {
    if (!size.w || !size.h) return;
    // и ширина, и высота: на весь экран лист становится выше, и его надо вписать заново
    const key = `${fitKey ?? ""}:${Math.round(size.w)}:${Math.round(size.h)}`;
    if (fitted.current === key) return;
    fitted.current = key;
    setView(fitView());
  }, [size, fitKey, fitView]);

  useEffect(() => onView?.(view, size), [view, size, onView]);

  const least = fitView().s / 4;
  const at = (event: { clientX: number; clientY: number }): Point => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return { x: (event.clientX - box.left - view.tx) / view.s, y: (event.clientY - box.top - view.ty) / view.s };
  };

  const zoom = (factor: number, cx = size.w / 2, cy = size.h / 2) =>
    setView((now) => {
      const s = Math.min(MAX_SCALE, Math.max(least, now.s * factor));
      return { s, tx: cx - ((cx - now.tx) * s) / now.s, ty: cy - ((cy - now.ty) * s) / now.s };
    });

  // Колесо слушаем сами и без passive: иначе страница прокручивается вместе с масштабом.
  // Масштаб зависит от силы прокрутки, а не от числа событий: тачпад шлет десятки мелких
  // событий за один жест, и шаг на событие улетал в упор за секунду. Щипок двумя пальцами
  // браузер присылает колесом с ctrl, у него шаги еще мельче. Сдвиг вбок тянет лист.
  useEffect(() => {
    const node = svg.current;
    if (!node || still) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = node.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (Math.abs(dx) > Math.abs(dy) && !event.ctrlKey) {
        setView((now) => ({ ...now, tx: now.tx - dx }));
        return;
      }
      const speed = event.ctrlKey ? 0.01 : 0.0015;
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-dy * speed)));
      zoom(factor, event.clientX - box.left, event.clientY - box.top);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  });

  const down = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button === 2) return;
    svg.current?.focus({ preventScroll: true });
    const point = at(event);
    const byHand = event.button === 1 || space.current;
    if (!byHand && event.button === 0 && props.onDown?.(point, event)) {
      capture(event);
      return;
    }
    if (still) return;
    capture(event);
    pan.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
    setPanning(true);
  };

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const held = pan.current;
    if (held) {
      setView((now) => ({ ...now, tx: held.tx + event.clientX - held.x, ty: held.ty + event.clientY - held.y }));
      return;
    }
    props.onMove?.(at(event), event);
  };

  const up = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (pan.current) {
      pan.current = null;
      setPanning(false);
      return;
    }
    props.onUp?.(at(event), event);
  };

  const key = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.code === "Space") {
      space.current = event.type === "keydown";
      event.preventDefault();
      return;
    }
    if (event.type !== "keydown") return;
    if (event.key === "+" || event.key === "=") zoom(1.3);
    else if (event.key === "-") zoom(1 / 1.3);
    else if (event.code === "KeyF" && !event.ctrlKey && !event.metaKey) setView(fitView());
    else props.onKey?.(event);
  };

  const grid = step(view.s);
  return (
    <div className={still ? "u-board is-still" : "u-board"}>
      <svg
        ref={svg}
        tabIndex={0}
        role="application"
        aria-label={label}
        style={{ cursor: panning ? "grabbing" : cursor }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={() => props.onLeave?.()}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContext?.(at(event), event);
        }}
        onDoubleClick={(event) => props.onDouble?.(at(event), event)}
        onKeyDown={key}
        onKeyUp={key}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
          <rect x={0} y={0} width={widthM} height={lengthM} className="u-lot" />
          <path d={lines(widthM, lengthM, grid)} className="u-lot-grid" strokeWidth={1 / view.s} />
          <path d={lines(widthM, lengthM, grid * 10)} className="u-lot-grid is-major" strokeWidth={1 / view.s} />
          {children(view)}
        </g>
      </svg>

      {!still && (
        <div className="u-board-ctl">
          <IconButton label="Приблизить, клавиша +" onClick={() => zoom(1.3)}>
            <path d="M7.5 3v9M3 7.5h9" />
          </IconButton>
          <IconButton label="Отдалить, клавиша минус" onClick={() => zoom(1 / 1.3)}>
            <path d="M3 7.5h9" />
          </IconButton>
          <IconButton label="Вписать лист, клавиша F" onClick={() => setView(fitView())}>
            <path d="M2.5 5.5v-3h3M9.5 2.5h3v3M12.5 9.5v3h-3M5.5 12.5h-3v-3" />
          </IconButton>
          {corner}
        </div>
      )}

      {(status || hint) && (
        <div className="u-board-status">
          {hint}
          <span className="u-board-where mono">{status}</span>
        </div>
      )}
      {overlay}
    </div>
  );
}

/* Держим мышь за листом, даже если она вышла за его край: иначе объект, который тянут к стене,
   отрывался бы от курсора. Перо и некоторые касания захват не дают, тогда тянем без него. */
function capture(event: ReactPointerEvent<Element>) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // без захвата перетаскивание тоже работает, пока курсор над листом
  }
}

/* Шаг сетки зависит от масштаба, как в игровых редакторах: издалека десять метров, вблизи метр */
export function step(scale: number): number {
  return scale >= 9 ? 1 : scale >= 2.2 ? 5 : 10;
}

function lines(width: number, length: number, gap: number): string {
  let path = "";
  for (let x = gap; x < width; x += gap) path += `M${x} 0V${length}`;
  for (let y = gap; y < length; y += gap) path += `M0 ${y}H${width}`;
  return path;
}

/* Кнопка-значок: у каждой есть подпись для чтения с экрана и подсказка при наведении */
export function IconButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={active ? "u-icon is-on" : "u-icon"}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {children}
        </g>
      </svg>
    </button>
  );
}

/* Размерная линия с засечками, как на чертеже. size это высота подписи в метрах листа:
   ее считают от масштаба, чтобы на экране подпись была одного размера. */
export function Dim({
  x1,
  y1,
  x2,
  y2,
  text,
  size,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  text: string;
  size: number;
}) {
  const tick = size * 0.45;
  const vertical = x1 === x2;
  const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  return (
    <g className="u-dim" pointerEvents="none">
      <path d={`M${x1} ${y1}L${x2} ${y2}`} vectorEffect="non-scaling-stroke" />
      <path
        d={
          vertical
            ? `M${x1 - tick} ${y1}h${tick * 2}M${x2 - tick} ${y2}h${tick * 2}`
            : `M${x1} ${y1 - tick}v${tick * 2}M${x2} ${y2 - tick}v${tick * 2}`
        }
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={mid.x}
        y={mid.y}
        fontSize={size}
        textAnchor="middle"
        dominantBaseline="central"
        transform={vertical ? `rotate(-90 ${mid.x} ${mid.y})` : undefined}
      >
        {text}
      </text>
    </g>
  );
}

/* Меню по правой кнопке. Закрывается кликом мимо и клавишей Esc. */
export type MenuItem = { label: string; hint?: string; onPick: () => void; danger?: boolean } | "line";

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const esc = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc);
    box.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  return (
    <div className="u-menu" ref={box} role="menu" style={{ left: x, top: y }}>
      {items.map((item, index) =>
        item === "line" ? (
          <span key={index} className="u-menu-line" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? "is-danger" : undefined}
            onClick={() => {
              item.onPick();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd className="mono">{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

/* Панелька действий над выбранным объектом, как в редакторах из игр: не надо помнить про
   правую кнопку или двойной щелчок, все, что можно сделать с объектом, лежит у него над головой. */
export function Actions({ x, y, items }: { x: number; y: number; items: MenuItem[] }) {
  return (
    <div className="u-actions" role="toolbar" aria-label="Что сделать с объектом" style={{ left: x, top: y }}>
      {items.map((item, index) =>
        item === "line" ? (
          <span key={index} className="u-actions-line" />
        ) : (
          <button
            key={item.label}
            type="button"
            className={item.danger ? "is-danger" : undefined}
            title={item.hint ? `${item.label}, ${item.hint}` : item.label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={item.onPick}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

/* Подсказка режима в строке под листом: что делать прямо сейчас. На самом листе она закрывала
   ворота у южной стены. Ее можно убрать, выбор помним в этом браузере. */
const HINTS_OFF = "plan-hints-off";

/* Подсказка под листом. Со sticky это следующий шаг плана: его не прячем, он уходит сам,
   когда дело сделано. */
export function Hint({ children, sticky = false }: { children: ReactNode; sticky?: boolean }) {
  const [off, setOff] = useState(() => {
    try {
      return window.localStorage.getItem(HINTS_OFF) === "1";
    } catch {
      return false;
    }
  });
  const toggle = (next: boolean) => {
    setOff(next);
    try {
      window.localStorage.setItem(HINTS_OFF, next ? "1" : "0");
    } catch {
      // без памяти браузера подсказка просто вернется после перезагрузки
    }
  };
  if (sticky) return <span className="u-board-hint is-next">{children}</span>;
  if (off)
    return (
      <button type="button" className="u-board-hint is-off" onClick={() => toggle(false)}>
        показать подсказки
      </button>
    );
  return (
    <span className="u-board-hint">
      <span>{children}</span>
      <button type="button" className="u-board-hint-x" aria-label="Скрыть подсказки" onClick={() => toggle(true)}>
        <svg width="11" height="11" viewBox="0 0 15 15" fill="none" aria-hidden="true">
          <path d="M4 4l7 7M11 4l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

/* Окно свойств: те же размеры числами, потому что в метр мышью не попасть. Без координат
   окно встает в колонку справа от листа, как панель свойств в редакторах: так оно не обрезается
   краем листа и не закрывает сам объект. С координатами висит поверх. */
export function Window({
  x,
  y,
  title,
  about,
  note,
  children,
  footer,
  onClose,
}: {
  x?: number;
  y?: number;
  title: string;
  /* что эта вещь двигает в расчете: видно при наведении на заголовок, места в колонке мало */
  about?: string;
  note?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const docked = x === undefined || y === undefined;
  return (
    <div
      className={docked ? "u-window is-docked" : "u-window"}
      role="dialog"
      aria-label={title}
      style={docked ? undefined : { left: x, top: y }}
      onKeyDown={(event) => event.key === "Escape" && onClose()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="u-window-head">
        <h3 title={about}>{title}</h3>
        <button type="button" className="u-icon" aria-label="Закрыть" title="Закрыть, Esc" onClick={onClose}>
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M4 4l7 7M11 4l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {note && <p className="u-window-note">{note}</p>}
      <div className="u-window-body">{children}</div>
      {footer && <div className="u-window-foot">{footer}</div>}
    </div>
  );
}

/* Проверки плана списком с галочками, как цели в строительной игре: закрытая видна так же,
   как открытая. Одинаковые закрытые проверки показываем одной строкой. */
export function Checks({ items }: { items: { label: string; ok: boolean; detail: string }[] }) {
  const shown = items.filter(
    (item, index) => !item.ok || items.findIndex((other) => other.ok && other.label === item.label) === index,
  );
  const bad = shown.filter((item) => !item.ok).length;
  const passed = items.filter((item) => item.ok).length;
  return (
    <div className={bad ? "u-checks-box is-bad" : "u-checks-box"}>
      <p className="u-checks-head">
        <b>Проверки плана</b>
        <span className="mono">
          {bad ? `не пройдено ${items.length - passed} из ${items.length}` : `все ${items.length} пройдены`}
        </span>
      </p>
      <ul className="u-checks">
        {shown.map((item, index) => (
          <li key={`${item.label}:${index}`} className={item.ok ? "is-ok" : "is-bad"}>
            <span className="u-checks-mark" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                {item.ok ? (
                  <path d="M2.5 6.3l2.3 2.2 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                ) : (
                  <path d="M6 3v3.6M6 8.8v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                )}
              </svg>
            </span>
            <span>
              <span className="u-checks-name">{item.label}</span>
              {!item.ok && item.detail && <span className="u-checks-detail">{item.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Панель объектов слева от доски. Инструменты разложены по группам, как в строительном
   меню игры: сначала само здание, потом то, что на нем стоит. */
/* Переключатель из двух-трех положений одной плашкой: режимы редактора над инструментами,
   план и объем на самом листе. small для листа: там он не должен спорить с чертежом */
export function Modes<T extends string>({
  value,
  options,
  onChange,
  label,
  small = false,
}: {
  value: T;
  options: { id: T; name: string; hint?: string }[];
  onChange: (next: T) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <div className={small ? "u-modes is-small" : "u-modes"} role="radiogroup" aria-label={label}>
      {options.map((one) => (
        <button
          key={one.id}
          type="button"
          role="radio"
          aria-checked={one.id === value}
          className={one.id === value ? "is-on" : undefined}
          title={one.hint}
          onClick={() => onChange(one.id)}
        >
          {one.name}
        </button>
      ))}
    </div>
  );
}

/* Карточка инструмента, как в графических редакторах: встает рядом с колонкой инструментов, когда
   инструмент взяли. Что это, зачем и сценка, как им пользуются. Уходит, как только начали чертить */
export function ToolCard({
  title,
  hotkey,
  text,
  edit,
  tip,
  scene,
  top,
  onClose,
  onNever,
}: {
  title: string;
  hotkey?: string;
  text: ReactNode;
  /* как править то, что поставили */
  edit?: ReactNode;
  /* совет или частая ошибка одной строкой */
  tip?: ReactNode;
  scene: ReactNode;
  top: number;
  onClose: () => void;
  onNever: () => void;
}) {
  // карточка не вылезает ниже чертежа: у нижних инструментов она встает выше своей кнопки
  const fit = useCallback(
    (node: HTMLDivElement | null) => {
      const room = node?.parentElement?.clientHeight;
      if (node && room) node.style.top = `${Math.max(0, Math.min(top, room - node.offsetHeight))}px`;
    },
    [top],
  );
  return (
    <div ref={fit} className="u-toolcard" style={{ top }} role="note" aria-label={`Инструмент ${title}`}>
      <div className="u-toolcard-scene">{scene}</div>
      <div className="u-toolcard-body">
        <div className="u-toolcard-head">
          <h3>{title}</h3>
          {hotkey && <kbd className="u-hotkey mono">{hotkey}</kbd>}
          <span className="u-spacer" />
          <IconButton label="Закрыть" onClick={onClose}>
            <path d="M4 4l7 7M11 4l-7 7" />
          </IconButton>
        </div>
        <p>{text}</p>
        {edit && (
          <p className="u-toolcard-more">
            <b>Править.</b> {edit}
          </p>
        )}
        {tip && (
          <p className="u-toolcard-more">
            <b>Совет.</b> {tip}
          </p>
        )}
        <button type="button" className="u-btn u-btn-link" onClick={onNever}>
          Больше не показывать
        </button>
      </div>
    </div>
  );
}

export function Tools({ children }: { children: ReactNode }) {
  return <div className="u-tools">{children}</div>;
}

export function ToolGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="u-tool-group" role="group" aria-label={title}>
      <span className="u-cap">{title}</span>
      {children}
    </div>
  );
}

export function Tool({
  active,
  onPick,
  glyph,
  name,
  note,
  hotkey,
  suggested = false,
  pulse = false,
}: {
  active: boolean;
  onPick: () => void;
  glyph: ReactNode;
  name: string;
  note?: string;
  hotkey?: string;
  /* о нем говорит подсказка «дальше» под листом */
  suggested?: boolean;
  /* его ждет шаг обучения: рамка мягко пульсирует, видно без чтения */
  pulse?: boolean;
}) {
  const state = active ? "u-tool is-on" : suggested || pulse ? "u-tool is-next" : "u-tool";
  return (
    <button
      className={pulse ? `${state} is-pulse` : state}
      onClick={onPick}
      title={hotkey ? `${note ?? name}. Клавиша ${hotkey}` : note}
      type="button"
      aria-pressed={active}
      aria-keyshortcuts={hotkey}
      data-tool={name}
    >
      {/* клавиша стоит первой и нарисована клавишей: число справа читали как количество */}
      {hotkey && (
        <kbd className="u-hotkey mono" aria-hidden="true">
          {hotkey}
        </kbd>
      )}
      <span className="u-tool-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="u-tool-name">{name}</span>
    </button>
  );
}

/* Легенда цветом: уровни пола или высоты стеллажей. Строка нажимается, если ей есть что выбрать. */
export type LegendRow = {
  id: string;
  color: string;
  name: string;
  value?: ReactNode;
  active?: boolean;
  onPick?: () => void;
};

export function Legend({ rows }: { rows: LegendRow[] }) {
  return (
    <div className="u-legend">
      {rows.map((row) => {
        const body = (
          <>
            <span className="u-swatch" style={{ background: row.color }} aria-hidden="true" />
            <span className="u-legend-text">
              <span className="u-legend-name">{row.name}</span>
              {row.value && <span className="u-legend-value mono">{row.value}</span>}
            </span>
          </>
        );
        return row.onPick ? (
          <button
            key={row.id}
            type="button"
            className={row.active ? "u-legend-row is-on" : "u-legend-row"}
            aria-pressed={row.active}
            onClick={row.onPick}
          >
            {body}
          </button>
        ) : (
          <span key={row.id} className="u-legend-row">
            {body}
          </span>
        );
      })}
    </div>
  );
}

/* Число, которое посчитал сервер: подпись, значение, единица. Поправить его нельзя,
   оно меняется само, когда человек двигает чертеж. Рядом на секунду встает, насколько
   оно изменилось от последней правки: так видно, что двинуло число. */
export function Meter({
  label,
  value,
  unit,
  hint,
  delta,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  delta?: { text: string; tone: "good" | "bad" | "plain"; key: string };
}) {
  return (
    <span className="u-meter" title={hint}>
      <span className="u-cap">{label}</span>
      <span className="u-meter-line">
        <b className="mono">{value}</b>
        {unit && <span className="u-meter-unit">{unitText(unit)}</span>}
        {delta && (
          <span key={delta.key} className={`u-delta is-${delta.tone} mono`}>
            {delta.text}
          </span>
        )}
      </span>
    </span>
  );
}
