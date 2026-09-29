import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* Обучение поверх экрана: несколько коротких подсказок по шагам, каждая подсвечивает свою часть
   экрана. После объяснения идет практика: шаг ждет, пока человек сделает сам, экран при этом не
   затемнен. Показываем при первом входе, дальше по кнопке. Что человек уже видел, помним в браузере.
   Общий выключатель "lct.tours" поставит настройка в профиле: тогда не показываем ни одного. */

export type TourStep = {
  /* что подсветить: селектор части экрана */
  target: string;
  title: string;
  text: ReactNode;
  /* Шаг практики: экран не затемняем, человек делает сам. done приходит снаружи, по тому, что уже
     стоит на плане: тогда "Дальше" мягко подсвечивается. Идти дальше можно и не сделав */
  practice?: { done: boolean };
  /* подпись главной кнопки вместо "Дальше": на последнем шаге объяснения "Теперь попробуйте" */
  next?: string;
  /* сценка над текстом, как в карточке инструмента */
  scene?: ReactNode;
  /* выбор пути вместо объяснения: крупные строки, каждая начинает свое обучение */
  choices?: { label: string; note: string; size: string; run: () => void }[];
};

const ALL_OFF = "lct.tours";

export function tourWanted(key: string): boolean {
  try {
    return localStorage.getItem(ALL_OFF) !== "off" && !localStorage.getItem(key);
  } catch {
    // без хранилища обучение показать можно, а запомнить нельзя: не навязываем его каждый раз
    return false;
  }
}

export function toursOff(): boolean {
  try {
    return localStorage.getItem(ALL_OFF) === "off";
  } catch {
    return true;
  }
}

export function tourSeen(key: string) {
  try {
    localStorage.setItem(key, "seen");
  } catch {
    // не запомнили: в следующий раз покажем снова
  }
}

type Place = { hole: { x: number; y: number; w: number; h: number }; card: { x: number; y: number } };

// ширина карточки, та же, что у .u-tour-card в board.css
const CARD_W = 400;
const GAP = 14;

// На практике карточка лежит в правом верхнем углу листа, рядом с масштабом: слева табличка
// с числами, а лист остается открытым, на нем работают
function corner(box: DOMRect, height: number) {
  const width = Math.min(CARD_W, window.innerWidth - 32);
  return {
    x: Math.min(Math.max(16, box.right - width - 58), window.innerWidth - width - 16),
    y: Math.min(Math.max(16, box.top + 52), window.innerHeight - height - 16),
  };
}

export function Tour({
  steps,
  onClose,
  start = 0,
  onStep,
  onIndex,
}: {
  steps: TourStep[];
  /* done: дошел до конца, never: больше не показывать, later: закрыл на середине */
  onClose: (why: "done" | "never" | "later") => void;
  /* с какого шага начать: "продолжить с практики" начинает сразу с нее */
  start?: number;
  /* ушли с шага вперед: номер шага, с которого ушли */
  onStep?: (index: number) => void;
  /* какой шаг сейчас открыт: экран подсвечивает то, о чем шаг говорит */
  onIndex?: (index: number) => void;
}) {
  const [index, setIndex] = useState(start);
  useEffect(() => onIndex?.(index), [index, onIndex]);
  const [place, setPlace] = useState<Place | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const step = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;
  const practice = step.practice;
  const trying = Boolean(practice);
  // Карточку практики сворачивают в плашку в углу листа: она закрывала четверть экрана и мешала
  // ставить ряды. Свернутая помнит свой шаг; сделал шаг, и она разворачивается сама, чтобы было
  // видно "Дальше"
  const [foldedAt, setFoldedAt] = useState(-1);
  const folded = trying && foldedAt === index && !practice?.done;

  const measure = useCallback(() => {
    const node = document.querySelector(step.target);
    if (!node) return setPlace(null);
    const box = node.getBoundingClientRect();
    const pad = 6;
    const hole = { x: box.left - pad, y: box.top - pad, w: box.width + pad * 2, h: box.height + pad * 2 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const height = card.current?.offsetHeight ?? 220;
    const width = Math.min(CARD_W, vw - 32);
    if (trying) return setPlace({ hole, card: corner(box, height) });
    // справа от подсвеченного, если есть место, иначе слева, иначе под ним или над ним
    let x = hole.x + hole.w + GAP;
    let y = hole.y;
    if (x + width > vw - 16) {
      x = hole.x - GAP - width;
      if (x < 16) {
        x = hole.x + hole.w / 2 - width / 2;
        y = hole.y + hole.h + GAP + height < vh - 16 ? hole.y + hole.h + GAP : hole.y - GAP - height;
      }
    }
    x = Math.min(Math.max(16, x), vw - width - 16);
    y = Math.min(Math.max(16, y), vh - height - 16);
    setPlace({ hole, card: { x, y } });
  }, [step.target, trying]);

  // к подсвеченному прокручиваем, пока он не встанет на экран целиком, и меряем после прокрутки
  useLayoutEffect(() => {
    const node = document.querySelector(step.target);
    node?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    // Практика началась: лист на экране и коротко вспыхивает рамкой, "вот ваш план"
    let flash = 0;
    if (trying && node) {
      node.classList.add("u-flash");
      flash = window.setTimeout(() => node.classList.remove("u-flash"), 1800);
    }
    // на практике фокус не забираем: клавиши инструментов и Del должны доходить до листа
    if (!trying) next.current?.focus({ preventScroll: true });
    // меряем в следующем кадре: карточка уже нарисована, и ее высота известна
    const frame = requestAnimationFrame(measure);
    // Подсвеченное могло еще не появиться: шаг сам переключил режим, и кнопки нужного режима встанут
    // после отрисовки. Меряем еще раз чуть позже
    const again = window.setTimeout(measure, 160);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(again);
      window.clearTimeout(flash);
      node?.classList.remove("u-flash");
    };
  }, [step.target, measure, trying]);

  // свернули или развернули: у карточки другая высота, место считаем заново
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [folded, measure]);

  // На практике начали тянуть по листу: карточка сворачивается сама, лист нужен целиком
  useEffect(() => {
    if (!trying) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".u-board") && !target.closest(".u-tour-card")) setFoldedAt(index);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [trying, index]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  const forward = useCallback(() => {
    onStep?.(index);
    if (last) onClose("done");
    else setIndex(index + 1);
  }, [last, index, onClose, onStep]);

  useEffect(() => {
    // на практике Esc и стрелки нужны листу: снять выбор, подвинуть объект
    if (trying) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose("later");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        forward();
      } else if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        setIndex(index - 1);
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [forward, index, onClose, trying]);

  const foot = practice ? (
    <div className="u-tour-foot">
      <button type="button" className="u-btn u-btn-link" onClick={() => onClose("never")}>
        Закончить
      </button>
      {/* сделал шаг: "Дальше" мягко пульсирует, не сделал: все равно можно идти дальше */}
      <span className="u-tour-go">
        {index > 0 && (
          <button type="button" className="u-btn u-btn-ghost" onClick={() => setIndex(index - 1)}>
            Назад
          </button>
        )}
        <button
          type="button"
          className={practice.done ? "u-btn u-btn-primary is-ready" : "u-btn u-btn-primary"}
          onClick={forward}
        >
          {last ? "Готово" : "Дальше"}
        </button>
      </span>
    </div>
  ) : (
    <div className="u-tour-foot">
      <button type="button" className="u-btn u-btn-link" onClick={() => onClose("never")}>
        Больше не показывать
      </button>
      {/* "Назад" и "Дальше" переносятся вместе и стоят справа, если рядом со ссылкой не встали */}
      <span className="u-tour-go">
        {index > 0 && (
          <button type="button" className="u-btn u-btn-ghost" onClick={() => setIndex(index - 1)}>
            Назад
          </button>
        )}
        <button ref={next} type="button" className="u-btn u-btn-primary" onClick={forward}>
          {step.next ?? (last ? "Понятно" : "Дальше")}
        </button>
      </span>
    </div>
  );

  return createPortal(
    <div
      className={trying ? "u-tour is-practice" : "u-tour"}
      role={trying ? "region" : "dialog"}
      aria-modal={trying ? undefined : true}
      aria-labelledby="u-tour-title"
    >
      {!trying &&
        (place ? (
          <div
            className="u-tour-hole"
            style={{ left: place.hole.x, top: place.hole.y, width: place.hole.w, height: place.hole.h }}
          />
        ) : (
          <div className="u-tour-dim" />
        ))}
      {folded ? (
        <div
          ref={card}
          className="u-tour-pill-at"
          style={
            place
              ? { left: place.card.x + Math.min(CARD_W, window.innerWidth - 32) - 280, top: place.card.y }
              : undefined
          }
        >
          <button
            type="button"
            className="u-tour-pill"
            onClick={() => setFoldedAt(-1)}
            aria-label="Развернуть подсказку"
          >
            <span className="mono">
              {index + 1} из {steps.length}
            </span>
            <b>{step.title}</b>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 7.5L6 4.5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : (
        <div
          ref={card}
          key={index}
          className="u-tour-card"
          style={place ? { left: place.card.x, top: place.card.y } : { left: "50%", top: "30%" }}
        >
          {step.scene && <div className="u-tour-scene">{step.scene}</div>}
          <span className="u-tour-head">
            <span className="u-tour-count mono">
              {steps.length > 1 ? `${index + 1} из ${steps.length}` : "обучение"}
            </span>
            {trying && (
              <button
                type="button"
                className="u-tour-fold"
                onClick={() => setFoldedAt(index)}
                aria-label="Свернуть подсказку"
              >
                Свернуть
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 4.5L6 7.5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </span>
          <h3 id="u-tour-title">{step.title}</h3>
          <p>{step.text}</p>
          {step.choices && (
            <div className="u-tour-choices">
              {step.choices.map((one) => (
                <button key={one.label} type="button" onClick={one.run}>
                  <span>
                    <b>{one.label}</b>
                    <span>{one.note}</span>
                  </span>
                  <span className="mono">{one.size}</span>
                </button>
              ))}
            </div>
          )}
          <div className="u-tour-dots" aria-hidden="true">
            {steps.map((one, at) => (
              <span key={at} className={at === index ? "is-on" : one.practice ? "is-practice" : undefined} />
            ))}
          </div>
          {foot}
        </div>
      )}
    </div>,
    document.body,
  );
}

/* Предложение продолжить с практики: лист пустой, а обучение уже прошли или закрыли. Тот же вид,
   что у обучения, но ничего не затемняет и лежит в углу листа */
export function TourOffer({
  target,
  title,
  text,
  onStart,
  onLater,
  go = "Продолжить с практики",
}: {
  target: string;
  title: string;
  text: ReactNode;
  onStart: () => void;
  onLater: () => void;
  /* подпись главной кнопки */
  go?: string;
}) {
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const measure = useCallback(() => {
    const node = document.querySelector(target);
    setPlace(node ? corner(node.getBoundingClientRect(), card.current?.offsetHeight ?? 200) : null);
  }, [target]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);
  return createPortal(
    <div className="u-tour is-practice" role="region" aria-label={title}>
      <div
        ref={card}
        className="u-tour-card"
        style={place ? { left: place.x, top: place.y } : { left: -9999, top: 0, visibility: "hidden" }}
      >
        <span className="u-tour-count mono">практика</span>
        <h3>{title}</h3>
        <p>{text}</p>
        <div className="u-tour-foot">
          <button type="button" className="u-btn u-btn-link" onClick={onLater}>
            Не сейчас
          </button>
          <span className="u-tour-go">
            <button type="button" className="u-btn u-btn-primary" onClick={onStart}>
              {go}
            </button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
