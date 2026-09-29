/* Набор компонентов интерфейса. Экраны собираются из них и своих стилей не заводят.
   Оформление лежит в tokens.css и ui.css, правила направления в docs/design.md. */
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { AccountLinks, AccountMenu, homeOf, useMe } from "./account";
import { Modes } from "./board";
import { groupDigits, plainDigits, unitText } from "./digits";
import "./fonts.css";
import "./tokens.css";
import "./ui.css";

/* Знаки. Держим их здесь, чтобы не тащить в проект библиотеку иконок ради четырех штук. */
export function Arrow({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M3 7.5h9M8 3.5l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* Галочка цветом текста на синем (--on-blue) для квадратика на синем; на светлом фоне ее красим цветом текста (color) */
export function Tick({ size = 13, color = "var(--on-blue)" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M2 7l3.2 3L11 3.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Cross({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/* Стопка карточек каталога: на месте фото у новости про весь каталог, например загруженную выгрузку.
   Цвета из токенов, поэтому в темной теме карточки темнеют вместе с плитой */
export function CatalogStack({ size = 72 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.75} viewBox="0 0 64 48" fill="none" aria-hidden="true">
      <rect x="14" y="4" width="36" height="26" rx="5" fill="var(--blue-tint)" stroke="var(--blue-line)" />
      <rect x="9" y="10" width="46" height="30" rx="6" fill="var(--blue-pale)" stroke="var(--blue-line)" />
      <rect x="4" y="16" width="56" height="30" rx="6" fill="var(--paper)" stroke="var(--blue)" strokeWidth="1.5" />
      <rect x="10" y="22" width="14" height="11" rx="3" fill="var(--blue-tint)" />
      <path d="M29 24h24M29 29h17M10 39h28" stroke="var(--blue)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/* Знак сервиса: лицо Сони (робот 06) косится вправо, на название. Тот же рисунок лежит
   в public/favicon.svg, меняем оба вместе. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="var(--ink)" />
      <rect x="10" y="8.5" width="2.6" height="5.4" rx="1.3" fill="var(--on-ink)" />
      <rect x="15.6" y="8.5" width="2.6" height="5.4" rx="1.3" fill="var(--on-ink)" />
    </svg>
  );
}

/* Название. «Ра» синим: внутри слова читается «склад» */
export function Wordmark() {
  return (
    <span className="u-word">
      <span>Ра</span>склад
    </span>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  /* главная кнопка одна на экран и всегда синяя; dark для второстепенного, как "Войти" в шапке;
     danger: ссылка красным для того, что удаляет */
  kind?: "primary" | "dark" | "ghost" | "light" | "link" | "danger";
  arrow?: boolean;
  disabled?: boolean;
  title?: string;
  /* с адресом кнопка становится ссылкой того же вида: переход на другую страницу */
  href?: string;
};

export function Button({ children, onClick, kind = "primary", arrow, disabled, title, href }: ButtonProps) {
  const inside = (
    <>
      {children}
      {arrow && (
        <span className="u-knob">
          <Arrow />
        </span>
      )}
    </>
  );
  if (href)
    return (
      <a className={`u-btn u-btn-${kind}`} href={href} title={title}>
        {inside}
      </a>
    );
  return (
    <button className={`u-btn u-btn-${kind}`} onClick={onClick} disabled={disabled} title={title}>
      {inside}
    </button>
  );
}

/* Действие внутри фразы: выглядит как ссылка, а работает кнопкой, например переключает сценарий.
   «можно взять аренду или кредит», где «аренду» и «кредит» нажимаются */
export function TextButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="u-textbtn" onClick={onClick}>
      {children}
    </button>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return <div className="u-panel">{children}</div>;
}

/* Состояния шага в ленте: пройденный, текущий, открытый следующий и закрытый.
   Следующий нажимается, но полосу не закрашивает: иначе кажется, что ты уже на нем. */
export type Step = { name: string; state: "done" | "now" | "next" | "locked" };

/* Без steps шапка стоит без ленты шагов, так она выглядит в кабинете. nav заменяет ссылки справа. */
export function Header({
  steps = [],
  onPickStep,
  nav,
}: {
  steps?: Step[];
  onPickStep?: (index: number) => void;
  nav?: ReactNode;
}) {
  const me = useMe();
  const signedIn = me !== null && me.role !== "guest";
  // Полосы шагов меняются волной: назад с шага 5 на 1 гаснут по одной справа налево, вперед
  // заполняются слева направо. Для этого помним, с какого шага пришли
  const now = steps.findIndex((step) => step.state === "now");
  const [shown, setShown] = useState(now);
  const [from, setFrom] = useState(now);
  if (now !== shown) {
    setFrom(shown);
    setShown(now);
  }
  const wave = (index: number) => Math.max(0, now < from ? from - index : index - from - 1) * 120;
  return (
    <header className="u-head">
      <div className="u-wrap">
        <Panel>
          <div className={steps.length ? "u-head-row" : "u-head-row is-alone"}>
            {/* знак ведет домой: вошедшего на его главную, админа на главную админки, гостя на лендинг */}
            <a className="u-brand" href={signedIn ? homeOf(me.role) : "/"}>
              <Mark /> <Wordmark />
            </a>
            <nav>
              {nav ?? (
                <>
                  <AccountLinks />
                  <AccountMenu />
                </>
              )}
            </nav>
          </div>

          <div className="u-rail" hidden={!steps.length}>
            {steps.map((step, index) => (
              <button
                key={step.name}
                className={step.state === "locked" ? "" : `is-${step.state}`}
                disabled={step.state === "locked"}
                aria-current={step.state === "now" ? "step" : undefined}
                title={step.name}
                onClick={() => onPickStep?.(index)}
              >
                <span className="u-track">
                  <i style={{ transitionDelay: `${wave(index)}ms` }} />
                </span>
                <span className="u-step-label">
                  <span className="u-idx">{String(index + 1).padStart(2, "0")}</span>
                  <span className="u-step-name">{step.name}</span>
                </span>
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </header>
  );
}

/* Заголовок экрана. compact для шагов после первого: там уже не лендинг, и место нужно содержимому. */
export function Hero({ title, lead, compact }: { title: string; lead: string; compact?: boolean }) {
  return (
    <div className={compact ? "u-hero is-compact" : "u-hero"}>
      <div>
        <h1>{title}</h1>
        <p>{lead}</p>
      </div>
      <div className="u-pattern" aria-hidden="true" />
    </div>
  );
}

export function BlockHead({ title, note, aside }: { title: string; note?: string; aside?: ReactNode }) {
  return (
    <div className="u-block-head">
      <h2>{title}</h2>
      {note && <p>{note}</p>}
      {aside && (
        <>
          <span className="u-spacer" />
          {aside}
        </>
      )}
    </div>
  );
}

type OptionProps = {
  id: string;
  group: string;
  checked: boolean;
  onPick: () => void;
  title: string;
  plan: string;
  stamp: string;
  description: string;
  meta: ReactNode;
};

/* Выбор одного из нескольких: карточки одного вида стоят на своих местах, выбранная подсвечена.
   Раньше выбранная вырастала в крупную ячейку слева, и карточки менялись местами при каждом щелчке */
export function Option(props: OptionProps) {
  return (
    <label className="u-option" htmlFor={props.id}>
      <input type="radio" id={props.id} name={props.group} checked={props.checked} onChange={props.onPick} />
      <span className="u-plan u-grid-bg">
        <span className="u-stamp">{props.stamp}</span>
        <img src={props.plan} alt="" />
      </span>
      <span className="u-option-body">
        <h3>{props.title}</h3>
        <p>{props.description}</p>
        <span className="u-option-foot">{props.meta}</span>
      </span>
    </label>
  );
}

type RowProps = {
  checked: boolean;
  onToggle: () => void;
  title: string;
  description: string;
  who: string;
  value: string;
  unit: string;
  caption: string;
  hint?: string;
  mode?: { label: string; speed?: boolean };
};

/* Строка списка с галочкой: выбор нескольких вариантов. */
export function Row(props: RowProps) {
  return (
    <label className="u-row">
      <input className="u-tick" type="checkbox" checked={props.checked} onChange={props.onToggle} />
      <span className="u-box">
        <Tick />
      </span>
      <span>
        <h3>{props.title}</h3>
        <p>{props.description}</p>
        <span className="u-who">{props.who}</span>
      </span>
      <span className="u-metric">
        <span className="u-cap">{props.caption}</span>
        <span className="u-val">{props.value}</span>{" "}
        <span className="u-unit">{props.unit && unitText(props.unit)}</span>
        {props.hint && (
          <>
            <br />
            <button className="u-hint" title={props.hint} type="button">
              откуда цифра
            </button>
          </>
        )}
      </span>
      {props.mode && (
        <span className={props.mode.speed ? "u-mode u-mode-speed" : "u-mode"}>
          <i /> {props.mode.label}
        </span>
      )}
    </label>
  );
}

/* Сетка карточек и сама карточка решения: место под фото, название, цена, факты и действия.
   Карточка одна на весь проект, поэтому список решений везде выглядит одинаково. */
export function Cards({ children }: { children: ReactNode }) {
  return <div className="u-cards">{children}</div>;
}

type CardProps = {
  title: string;
  subtitle: string;
  photo?: string | null;
  photoNote: string;
  badges?: ReactNode;
  price: ReactNode;
  facts: ReactNode;
  details?: ReactNode;
  picked: boolean;
  pickLabel: string;
  onPick?: () => void;
  /* нажатие на "Выбрано" снимает выбор */
  onUnpick?: () => void;
  /* второе действие под выбором: «взять вторым к этой задаче» при смешанном парке */
  extra?: ReactNode;
  compared: boolean;
  onCompare: () => void;
};

export function Card(props: CardProps) {
  const state = [props.picked ? "is-picked" : "", props.compared ? "is-compared" : ""].join(" ").trim();
  // фото может не найтись на сервере: тогда вместо битой картинки подпись, почему его нет
  const [broken, setBroken] = useState(false);
  return (
    <article className={`u-card ${state}`}>
      <span className="u-card-photo u-grid-bg">
        {props.photo && !broken ? (
          <img src={props.photo} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span>{props.photoNote}</span>
        )}
      </span>
      <h3>{props.title}</h3>
      <span className="u-card-sub">{props.subtitle}</span>
      {props.badges && <span className="u-card-badges">{props.badges}</span>}
      <span className="u-card-price">{props.price}</span>
      <span className="u-card-facts">{props.facts}</span>
      {props.details}
      {/* выбор, под ним сравнение: одно место у всех карточек, выбранной и нет. В углу фото
          "Сравнить" читался как подпись к картинке */}
      <span className="u-card-act">
        {props.picked ? (
          <Picked label={props.pickLabel} onUnpick={props.onUnpick} />
        ) : props.onPick ? (
          <Button kind="ghost" onClick={props.onPick}>
            {props.pickLabel}
          </Button>
        ) : (
          <span className="u-field-src">{props.pickLabel}</span>
        )}
        <CompareToggle checked={props.compared} onToggle={props.onCompare} />
        {props.extra}
      </span>
    </article>
  );
}

/* Выбранное это состояние, а не действие: спокойная метка, а не вторая синяя кнопка на экране.
   Того же размера и на том же месте, что "Выбрать", и нажимается: второе нажатие снимает выбор */
function Picked({ label, onUnpick }: { label: string; onUnpick?: () => void }) {
  if (!onUnpick)
    return (
      <span className="u-picked" role="status">
        <Tick color="currentColor" />
        {label}
      </span>
    );
  return (
    <button
      type="button"
      className="u-btn u-picked"
      aria-pressed="true"
      title="Нажмите, чтобы снять выбор"
      onClick={onUnpick}
    >
      <Tick color="currentColor" />
      {label}
    </button>
  );
}

/* Решение строкой: для тех, что требуют проверки или не подходят. Карточками их было 31
   на странице, и подходящие терялись. В строке маленькое фото, название с компанией, почему
   решение тут одной строкой, цена и те же действия, что у карточки */
export function ListRow(props: CardProps & { why: ReactNode }) {
  const state = [props.picked ? "is-picked" : "", props.compared ? "is-compared" : ""].join(" ").trim();
  const [broken, setBroken] = useState(false);
  return (
    <article className={`u-lrow ${state}`}>
      <span className="u-lrow-photo u-grid-bg" aria-hidden="true">
        {props.photo && !broken && <img src={props.photo} alt="" loading="lazy" onError={() => setBroken(true)} />}
      </span>
      <span className="u-lrow-main">
        <h3>{props.title}</h3>
        <span className="u-card-sub">{props.subtitle}</span>
        <span className="u-lrow-why">{props.why}</span>
      </span>
      <span className="u-lrow-price">{props.price}</span>
      <span className="u-lrow-act">
        {props.picked ? (
          <Picked label={props.pickLabel} onUnpick={props.onUnpick} />
        ) : props.onPick ? (
          <Button kind="ghost" onClick={props.onPick}>
            {props.pickLabel}
          </Button>
        ) : (
          <span className="u-field-src">{props.pickLabel}</span>
        )}
        {props.extra}
        <CompareToggle checked={props.compared} onToggle={props.onCompare} />
      </span>
    </article>
  );
}

/* Очередь выбора: задачи по порядку, у каждой свое решение. Видно, где выбрано, что осталось
   и какая задача открыта сейчас. Плитка нажимается и открывает свою задачу. */
export type QueueItem = { id: string; name: string; picked: string | null };

export function Queue({ items, active, onPick }: { items: QueueItem[]; active: string; onPick: (id: string) => void }) {
  return (
    <div className="u-queue" role="group" aria-label="Задачи по очереди">
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          className={[item.id === active ? "is-now" : "", item.picked ? "is-done" : ""].join(" ").trim()}
          aria-current={item.id === active ? "step" : undefined}
          onClick={() => onPick(item.id)}
        >
          <span className="u-queue-idx">{String(index + 1).padStart(2, "0")}</span>
          <span className="u-queue-name">{item.name}</span>
          <span className="u-queue-pick">
            {item.picked ? (
              <>
                <Tick />
                {item.picked}
              </>
            ) : (
              "выберите решение"
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

/* Доля объема между двумя решениями одной задачи: имена по краям, ползунок посередине,
   проценты моноширинным. Шаг 10%, крайние 10 и 90: решение на ноль процентов это не решение. */
export function Split({
  task,
  left,
  right,
  share,
  onChange,
  onDrop,
}: {
  /* к какой задаче относится доля: подписываем, когда задач несколько */
  task?: string;
  left: string;
  right: string;
  /* доля левого решения, 0..1 */
  share: number;
  onChange: (share: number) => void;
  /* убрать второе решение, задача остается на первом */
  onDrop: () => void;
}) {
  const percent = Math.round(share * 100);
  return (
    <div className="u-split">
      {task && <span className="u-split-task">{task}:</span>}
      <span className="u-split-name">
        {left} <b className="mono">{percent}%</b>
      </span>
      <input
        type="range"
        min={10}
        max={90}
        step={10}
        value={percent}
        aria-label={`Доля объема у решения ${left}`}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
      />
      <span className="u-split-name is-right">
        <b className="mono">{100 - percent}%</b> {right}
      </span>
      <button className="u-hint" type="button" onClick={onDrop}>
        убрать второе
      </button>
      <span className="u-split-note">
        Доля это объем задачи, а не число роботов: сколько роботов нужно каждому решению, посчитает прогон
      </span>
    </div>
  );
}

/* Панель поиска, фильтров и сортировки над списком. */
/* Панель над списком. roomy: как в кабинете, поиск не во всю ширину, фильтры и порядок
   рядом с ним, до списка воздух, чтобы панель не читалась первой строкой списка */
export function Toolbar({ children, roomy }: { children: ReactNode; roomy?: boolean }) {
  return <div className={roomy ? "u-bar is-roomy" : "u-bar"}>{children}</div>;
}

export function Search({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <input
      className="u-search"
      type="search"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/* Кнопка-переключатель: сортировка и подобные наборы, где выбран один из нескольких. */
export function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={active ? "u-pill is-on" : "u-pill"} onClick={onClick}>
      {children}
    </button>
  );
}

/* Долгий расчет: говорим, что именно идет, а не крутим спиннер посреди пустоты. */
export function Waiting({ title, note }: { title: string; note?: string }) {
  return (
    <div className="u-waiting">
      <span className="u-beacon" aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        {note && <span>{note}</span>}
      </span>
    </div>
  );
}

/* Долгий расчет с полосой прогресса и этапами. Сервер отвечает одним ответом, промежуточных
   этапов он не присылает, поэтому полоса идет по времени: быстро в начале и медленнее к концу,
   до ответа не доходит до края. Этап, который сейчас примерно идет, выделен, так и подписано.
   Сколько секунд уже идет, видно рядом: ожидание перестает быть черным ящиком */
export function Progress({
  title,
  note,
  stages,
  seconds,
}: {
  title: string;
  note: string;
  /* этапы по порядку и какую долю ожидания каждый занимает */
  stages: { name: string; share: number }[];
  /* сколько обычно идет расчет, секунд */
  seconds: number;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => setElapsed((performance.now() - start) / 1000), 250);
    return () => window.clearInterval(timer);
  }, []);
  // полоса растет как 1 - e^(-t / T): к обычному времени около двух третей, дальше медленнее
  const done = Math.min(0.95, 1 - Math.exp((-1.1 * elapsed) / seconds));
  // этап идет, пока полоса не перешла его правый край: края это доли этапов нарастающим итогом
  const edges = stages.map((_, index) => stages.slice(0, index + 1).reduce((sum, one) => sum + one.share, 0));
  const now = edges.findIndex((edge) => edge >= done - 1e-6);
  return (
    <div className="u-progress" role="status" aria-live="polite">
      <div className="u-progress-top">
        <strong>{title}</strong>
        <span className="mono">{Math.floor(elapsed)} с</span>
      </div>
      <div className="u-progress-bar" aria-hidden="true">
        <i style={{ width: `${Math.round(done * 100)}%` }} />
      </div>
      <ol className="u-progress-stages">
        {stages.map((stage, index) => (
          <li key={stage.name} className={index < now ? "is-done" : index === now ? "is-now" : undefined}>
            {index < now && <Tick color="currentColor" />}
            {stage.name}
          </li>
        ))}
      </ol>
      <p>{note}</p>
    </div>
  );
}

/* level: уровень заголовка по месту. Под h1 страницы без h2 нужен h2, иначе уровни идут с пропуском */
export function Notice({
  title,
  children,
  level = 3,
  next = [],
}: {
  title: string;
  children: ReactNode;
  level?: 2 | 3;
  next?: string[];
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="u-notice">
      <Heading>{title}</Heading>
      <p>{children}</p>
      {next.length > 0 && (
        <div className="u-notice-next">
          <h4>Что дальше</h4>
          <ul>
            {next.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* Экран, где показывать нечего: гость в кабинете, пустой кабинет, страница 404. Сначала читается
   текст и действия на плашке, робот стоит справа и выглядывает из-за ее края, чтобы не перетягивать
   внимание. Одна раскладка на все такие места. */
export function EmptyState({
  title,
  children,
  actions,
  robot,
  apart,
}: {
  /* без заголовка, когда он уже стоит над плашкой, как на 404 */
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  robot?: ReactNode;
  /* робот стоит отдельно от плашки, с отступом: когда рядом с ним своя картинка, как цифры на 404 */
  apart?: boolean;
}) {
  return (
    <div className={apart ? "u-empty is-apart" : "u-empty"}>
      <div className="u-empty-plate">
        {title && <h2>{title}</h2>}
        <p>{children}</p>
        {actions && <div className="u-empty-actions">{actions}</div>}
      </div>
      {robot && (
        <div className="u-empty-robot" aria-hidden="true">
          {robot}
        </div>
      )}
    </div>
  );
}

/* Полоса действия одна на странице. Шаг может поставить в нее свое, не поднимая состояние
   наверх: ActionExtra переносит содержимое в место рядом с итогом. Так отметки для сравнения
   на шаге решения стоят в той же полосе, а не второй полосой сверху. */
let extraSlot: HTMLElement | null = null;
const extraWatchers = new Set<() => void>();

function setExtraSlot(node: HTMLElement | null) {
  extraSlot = node;
  extraWatchers.forEach((notify) => notify());
}

function watchExtraSlot(notify: () => void) {
  extraWatchers.add(notify);
  return () => {
    extraWatchers.delete(notify);
  };
}

export function ActionBar({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <div className="u-action">
      <span className="u-tally">{summary}</span>
      <span className="u-action-extra" ref={setExtraSlot} />
      {children}
    </div>
  );
}

/* Свое содержимое в полосе действия. Если полосы на странице нет, стоит на месте */
export function ActionExtra({ children }: { children: ReactNode }) {
  const slot = useSyncExternalStore(watchExtraSlot, () => extraSlot);
  return slot ? createPortal(children, slot) : <div className="u-action-extra is-inline">{children}</div>;
}

/* Второстепенные кнопки полосы, например файлы отчета. На широком экране стоят в ряд,
   на телефоне прячутся под одну кнопку с меню: полоса остается в одну строку */
export function ActionMore({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <span className="u-amore" ref={box}>
      <span className="u-amore-row">{children}</span>
      <button
        type="button"
        className="u-btn u-btn-ghost u-amore-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <span className="u-amore-pop" onClick={() => setOpen(false)}>
          {children}
        </span>
      )}
    </span>
  );
}

/* Подвал мастера тонкой строкой. Большой синий блок стоял в конце каждого шага, полосе
   действия было во что упираться, а текст повторял лендинг. "Это оценка, а не коммерческое
   предложение" стоит в итоге шага экономики. Методика на странице /method */
export function Footer() {
  return (
    <footer className="u-foot">
      <div className="u-foot-line">
        <span>Расклад</span>
        <a href="/method">Как мы считаем</a>
        <a href="/method#trust">Откуда цифры</a>
      </div>
    </footer>
  );
}

/* Число в поле пишем так же, как в тексте: 10 000 с пробелами по разрядам и 1,7 с запятой.
   Поле текстовое, а не type="number": в числовом поле браузер пробелы не показывает. Пока в поле
   печатают, стоит то, что напечатано; наверх уходит число без пробелов и с точкой, как раньше.
   Если набранное пока не число (один минус), наверх ничего не уходит. */
function NumberInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: number | string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="mono"
      type="text"
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      placeholder={placeholder}
      value={draft ?? groupDigits(value)}
      onFocus={() => setDraft(groupDigits(value))}
      onBlur={() => setDraft(null)}
      onChange={(event) => {
        setDraft(event.target.value);
        const plain = plainDigits(event.target.value);
        if (plain !== null) onChange(plain);
      }}
    />
  );
}

/* Главное значение шага: подпись сверху, число в поле, под полем подсказка строкой, источник
   под буквой оценки. Поле нарисовано полем: без рамки и фона крупные числа читали как сводку
   и не понимали, что их можно поправить. Подсказка видна сразу, без наведения: на телефоне
   наведения нет. Длинная обрезана до двух строк и раскрывается кнопкой "подробнее".
   Предупреждение встает на место подсказки и красит рамку поля, поэтому высота плитки не прыгает. */
type ValueProps = {
  label: string;
  unit: string;
  value: number | string;
  onChange: (value: string) => void;
  hint?: string;
  trust?: string;
  trustTitle?: string;
  warning?: string;
  step?: string;
  /* что написано в пустом поле: у необязательного значения «не задан» */
  placeholder?: string;
};

// подсказка длиннее этого не помещается в две строки плитки шириной 190 точек
const HINT_FITS = 80;

export function KeyValue(props: ValueProps) {
  const [more, setMore] = useState(false);
  const long = !props.warning && (props.hint?.length ?? 0) > HINT_FITS;
  return (
    <div className={props.warning ? "u-key is-warn" : "u-key"}>
      <label className="u-key-main">
        <span className="u-key-top">
          <span className="u-key-name">{props.label}</span>
          {props.trust && <Trust level={props.trust} title={props.trustTitle} />}
        </span>
        <span className="u-key-box">
          <NumberInput value={props.value} onChange={props.onChange} placeholder={props.placeholder} />
          {props.unit && <span className="u-key-unit">{unitText(props.unit)}</span>}
        </span>
      </label>
      {props.warning ? (
        <span className="u-key-hint is-warn" role="status">
          {props.warning}
        </span>
      ) : (
        props.hint && (
          <span className="u-key-foot">
            <span className={more ? "u-key-hint is-open" : "u-key-hint"}>{props.hint}</span>
            {long && (
              <button type="button" className="u-key-more" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? "свернуть" : "подробнее"}
              </button>
            )}
          </span>
        )
      )}
    </div>
  );
}

/* Необязательное поле одной строкой над содержимым шага, как обычное поле формы: подпись,
   узкое поле с единицей и короткая подсказка рядом. Так стоит бюджет на старте на шаге решения.
   Плиткой с пояснением справа он занимал полэкрана и выглядел пустой карточкой */
export function InlineField({
  label,
  unit,
  value,
  onChange,
  placeholder,
  note,
}: {
  label: string;
  unit: string;
  value: number | string;
  onChange: (value: string) => void;
  placeholder?: string;
  note?: ReactNode;
}) {
  return (
    <label className="u-inline-field">
      <span className="u-frow-name">{label}</span>
      <span className="u-field-box">
        <NumberInput label={label} value={value} onChange={onChange} placeholder={placeholder} />
        <span className="u-field-unit">{unitText(unit)}</span>
      </span>
      {note && <span className="u-frow-hint">{note}</span>}
    </label>
  );
}

/* Остальные параметры: строка на всю ширину, слева название и подсказка, справа поле.
   yesNo: вместо поля кнопки "Да" и "Нет", в данных 1 и 0. Строка тогда не label: щелчок по
   названию нажимал бы первую кнопку */
export function FieldRow(props: ValueProps & { yesNo?: boolean }) {
  const text = (
    <span>
      <span className="u-frow-name">{props.label}</span>
      {props.hint && <span className="u-frow-hint">{props.hint}</span>}
      {props.warning && <Alert tone="warn">{props.warning}</Alert>}
    </span>
  );
  const trust = props.trust && <Trust level={props.trust} title={props.trustTitle} />;
  if (props.yesNo)
    return (
      <div className="u-frow">
        {text}
        <Modes
          label={props.label}
          value={Number(props.value) === 1 ? "1" : "0"}
          options={[
            { id: "1", name: "Да" },
            { id: "0", name: "Нет" },
          ]}
          onChange={props.onChange}
        />
        {trust}
      </div>
    );
  return (
    <label className="u-frow">
      {text}
      <span className={props.warning ? "u-field-box is-warn" : "u-field-box"}>
        <NumberInput value={props.value} onChange={props.onChange} />
        {props.unit && <span className="u-field-unit">{unitText(props.unit)}</span>}
      </span>
      {trust}
    </label>
  );
}

/* Ползунок с числом, как в банковских калькуляторах: подпись, поле с числом, ползунок, края
   диапазона под ним. Правка уходит в расчет, когда ползунок отпустили: сервер пересчитывает всю
   экономику, и на каждый шаг ползунка его не зовем. Число в поле можно вписать руками, в том числе
   за краем ползунка: края это удобный диапазон, а не запрет */
export function Slider(
  props: Omit<ValueProps, "step"> & { min: number; max: number; step: number; ends: [string, string] },
) {
  const { min, max, step } = props;
  const [draft, setDraft] = useState<number | null>(null);
  // Отпущенное значение держим, пока сервер не ответил: иначе число и бегунок на полсекунды
  // возвращались к прежнему и потом прыгали к новому. Держим, пока прежнее значение и
  // предупреждение те же; ответ сервера меняет одно из них, и на экране встает его число
  const [sent, setSent] = useState<{ value: number; from: number; warning?: string } | null>(null);
  const current = Number(props.value);
  const held = sent && sent.from === current && sent.warning === props.warning ? sent.value : null;
  const shown = draft ?? held ?? current;
  const at = Math.min(Math.max(shown, min), max);
  const commit = () => {
    if (draft !== null && draft !== current) {
      setSent({ value: draft, from: current, warning: props.warning });
      props.onChange(String(draft));
    }
    setDraft(null);
  };
  return (
    <div className="u-slider">
      <div className="u-slider-head">
        <span className="u-frow-name">{props.label}</span>
        <span className={props.warning ? "u-field-box is-warn" : "u-field-box"}>
          <NumberInput label={props.label} value={shown} onChange={props.onChange} />
          {props.unit && <span className="u-field-unit">{unitText(props.unit)}</span>}
        </span>
        {props.trust && <Trust level={props.trust} title={props.trustTitle} />}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={at}
        aria-label={props.label}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="u-slider-ends">
        <span>{props.ends[0]}</span>
        <span>{props.ends[1]}</span>
      </span>
      {props.hint && <span className="u-frow-hint">{props.hint}</span>}
      {props.warning && <Alert tone="warn">{props.warning}</Alert>}
    </div>
  );
}

/* Ползунок одной строкой без поля с числом: подпись с числом собирает вызывающий по тому, где
   ползунок сейчас, подсказка под ним. Правка уходит, когда ползунок отпустили, как у Slider */
export function RangeLine(props: {
  label: (value: number) => ReactNode;
  ariaLabel: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? props.value;
  const commit = () => {
    if (draft !== null && draft !== props.value) props.onChange(draft);
    setDraft(null);
  };
  return (
    <div className="u-slider is-line">
      <span className="u-frow-name">{props.label(shown)}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={Math.min(Math.max(shown, props.min), props.max)}
        aria-label={props.ariaLabel}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      {props.hint && <span className="u-frow-hint">{props.hint}</span>}
    </div>
  );
}

/* Два числа в одной строке: размер «76 × 102 м» или ярусы «5 по 1,7 м». В окне свойств
   каждое поле отдельной строкой не помещалось на экран в 768 точек высотой. */
export type PairField = { value: number | string; onChange: (value: string) => void; unit?: string; step?: string };

export function FieldPair({
  label,
  hint,
  sep,
  a,
  b,
}: {
  label: string;
  hint?: ReactNode;
  sep: string;
  a: PairField;
  b: PairField;
}) {
  const field = (one: PairField, name: string) => (
    <span className="u-pair-one">
      <NumberInput label={`${label}, ${name}`} value={one.value} onChange={one.onChange} />
      {one.unit && <span className="u-field-unit">{unitText(one.unit)}</span>}
    </span>
  );
  return (
    <div className="u-frow is-pair">
      <span>
        <span className="u-frow-name">{label}</span>
        {hint && <span className="u-frow-hint">{hint}</span>}
      </span>
      <span className="u-field-box is-pair">
        {field(a, "первое")}
        <span className="u-pair-sep mono">{sep}</span>
        {field(b, "второе")}
      </span>
    </div>
  );
}

/* Блок шага, который сворачивается одной кнопкой у заголовка. Свернутый показывает заголовок и
   строку итога, развернутый как обычно. Внутри обычная секция со своим заголовком: прячем все,
   что после заголовка, сама секция не меняется и не теряет состояние. По умолчанию раскрыт,
   что свернул человек, помним в браузере: вернулся на шаг, и он выглядит так же */
export function Collapse({
  id,
  summary,
  open: initial = true,
  children,
}: {
  id: string;
  summary: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  const key = `raskad-fold-${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? "0" : "1");
    } catch {
      // не запомнили, в следующий раз блок встанет как по умолчанию
    }
  };
  return (
    <div className={open ? "u-collapse" : "u-collapse is-closed"} data-collapse={id}>
      <button type="button" className="u-collapse-btn" aria-expanded={open} onClick={toggle}>
        <span className="u-chev" aria-hidden="true">
          <Arrow />
        </span>
        {open ? "Свернуть" : "Развернуть"}
      </button>
      {children}
      {!open && <p className="u-collapse-sum">{summary}</p>}
    </div>
  );
}

/* Раскрывающийся блок. Сделан на details, поэтому работает с клавиатуры и без скриптов. */
export function Fold({
  title,
  children,
  id,
  open,
  thin,
}: {
  title: string;
  children: ReactNode;
  id?: string;
  /* раскрыт с самого начала, например когда внутри уже выбранное */
  open?: boolean;
  /* тонкая строка-ссылка без плиты: внутри строки таблицы или карточки */
  thin?: boolean;
}) {
  return (
    <details className={thin ? "u-fold is-thin" : "u-fold"} id={id} open={open}>
      <summary>
        <span className="u-chev" aria-hidden="true">
          <Arrow />
        </span>
        {title}
      </summary>
      <div className="u-fold-body">{children}</div>
    </details>
  );
}

/* Оценка доверия к цифре: одна буква, расшифровка при наведении. */
export function Trust({ level, title }: { level: string; title?: string }) {
  return (
    <span className="u-trust" title={title ?? level}>
      {level}
    </span>
  );
}

/* Строка предупреждения или пояснения. Стоит там, где случилась, а не всплывает в углу. */
export function Alert({ tone = "warn", children }: { tone?: "warn" | "note"; children: ReactNode }) {
  return (
    <span className={tone === "note" ? "u-alert u-alert-note" : "u-alert"}>
      <i aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/* Число в ячейке таблицы: без своей подписи, подпись стоит в шапке колонки. */
type NumberBoxProps = {
  value: number | string;
  onChange: (value: string) => void;
  label: string;
  unit?: string;
  warn?: boolean;
  step?: string;
};

export function NumberBox(props: NumberBoxProps) {
  return (
    <span className={props.warn ? "u-num is-warn" : "u-num"}>
      <NumberInput label={props.label} value={props.value} onChange={props.onChange} />
      {props.unit && <span>{unitText(props.unit)}</span>}
    </span>
  );
}

export type Choice = { id: string; name: string; group?: string };

/* Выбор из справочника своим списком, а не системным: открытый системный список на Windows
   выглядел чужим. Кнопка либо как поле с текущим значением, либо действием ("+ Добавить роль").
   Список по группам, Esc и щелчок мимо закрывают, пункты проходятся Tab и стрелками */
export function Picker({
  value,
  onChange,
  options,
  label,
  action,
}: {
  value?: string;
  onChange: (value: string) => void;
  options: Choice[];
  label: string;
  /* подпись кнопки-действия; без нее кнопка выглядит полем с выбранным значением */
  action?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        setOpen(false);
        box.current?.querySelector<HTMLButtonElement>(".u-picker-btn")?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = event.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
        items[next]?.focus();
      }
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", keys);
    (
      box.current?.querySelector<HTMLButtonElement>("[aria-selected=true]") ??
      box.current?.querySelector<HTMLButtonElement>("[role=option]")
    )?.focus();
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", keys);
    };
  }, [open]);
  const current = options.find((option) => option.id === value);
  const groups = [...new Set(options.map((option) => option.group ?? ""))];
  return (
    <div
      className="u-picker"
      ref={box}
      onKeyDown={(event) => {
        // Esc закрывает только список, а не окно свойств, в котором он стоит
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          box.current?.querySelector<HTMLButtonElement>(".u-picker-btn")?.focus();
        }
      }}
    >
      <button
        type="button"
        className={action ? "u-btn u-btn-ghost u-picker-btn is-action" : "u-picker-btn"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={action ? undefined : label}
        onClick={() => setOpen(!open)}
      >
        {action ? (
          <>
            <span aria-hidden="true">+</span> {action}
          </>
        ) : (
          <span className="u-picker-value">{current?.name ?? "выберите"}</span>
        )}
      </button>
      {open && (
        <div className="u-menu u-picker-list" role="listbox" aria-label={label}>
          {groups.map((group) => (
            <div key={group} role="group" aria-label={group || undefined}>
              {group && <span className="u-picker-group">{group}</span>}
              {options
                .filter((option) => (option.group ?? "") === group)
                .map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={option.id === value}
                    onClick={() => {
                      setOpen(false);
                      onChange(option.id);
                    }}
                  >
                    {option.name}
                    {option.id === value && <Tick color="currentColor" />}
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* Поле с подсказками: выбрать из того, что уже есть, или вписать свое. Список встроенный
   (datalist): с клавиатуры и на телефоне работает как у браузера, свое значение не запрещено */
export function Suggest({
  value,
  onChange,
  options,
  id,
  className = "a-input",
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  /* id списка, уникальный на странице */
  id: string;
  className?: string;
  placeholder?: string;
}) {
  return (
    <>
      <input
        className={className}
        list={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={id}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </>
  );
}

/* Выбор из длинного справочника. Группы это optgroup: список ролей иначе не прочитать. */
export function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Choice[];
  label: string;
}) {
  const groups = [...new Set(options.map((option) => option.group ?? ""))];
  return (
    <select className="u-select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {groups.map((group) =>
        group ? (
          <optgroup key={group} label={group}>
            {options.filter((option) => option.group === group).map(toOption)}
          </optgroup>
        ) : (
          options.filter((option) => !option.group).map(toOption)
        ),
      )}
    </select>
  );
}

function toOption(option: Choice) {
  return (
    <option key={option.id} value={option.id}>
      {option.name}
    </option>
  );
}

/* Отдельная галочка: тот же квадрат, что в строке списка, но сама по себе. */
export function Check({
  checked,
  onToggle,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  title?: string;
  /* галочку нельзя переключить: почему, написано в title */
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "u-check is-off" : "u-check"} title={title}>
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} />
      <span className="u-box">
        <Tick />
      </span>
      <span>{label}</span>
    </label>
  );
}

/* Отметка для сравнения на карточке решения. Галочка с подписью "сравнить" читалась как
   "сравнить сейчас"; кнопка говорит, что будет: "+ Сравнить", после нажатия "В сравнении" */
function CompareToggle({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <label className={checked ? "u-compare-tgl is-on" : "u-compare-tgl"}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      {checked ? (
        <>
          <Tick color="currentColor" /> В сравнении
        </>
      ) : (
        <>
          <span aria-hidden="true">+</span> Сравнить
        </>
      )}
    </label>
  );
}

export type Column = { name: string; width?: string; hint?: string };

/* Таблица ввода: шапка колонок, строки и итог. На узком экране строка складывается в карточку. */
export function Sheet({ columns, children, foot }: { columns: Column[]; children: ReactNode; foot?: ReactNode }) {
  const template = columns.map((column) => column.width ?? "minmax(0, 1fr)").join(" ");
  return (
    <div className="u-sheet" style={{ "--cols": template } as CSSProperties}>
      <div className="u-sheet-head">
        {/* Ключ по номеру: заголовков может не быть у нескольких колонок сразу */}
        {columns.map((column, index) => (
          <span key={index} title={column.hint}>
            {column.name}
          </span>
        ))}
      </div>
      {children}
      {foot && <div className="u-sheet-foot">{foot}</div>}
    </div>
  );
}

/* Строка таблицы. Ячейки идут по колонкам шапки, пояснения занимают строку целиком под ними.
   С onDragStart строку тянут целиком, за любое место; ручка слева показывает, что это можно */
export function SheetRow({
  cells,
  notes,
  muted,
  onDragStart,
  dragTitle,
}: {
  cells: ReactNode[];
  notes?: ReactNode;
  muted?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  dragTitle?: string;
}) {
  const className = ["u-sheet-row", muted && "is-muted", onDragStart && "is-drag"].filter(Boolean).join(" ");
  return (
    <div className={className} draggable={onDragStart ? true : undefined} onDragStart={onDragStart} title={dragTitle}>
      {onDragStart && <span className="u-grip" aria-hidden="true" />}
      {cells.map((cell, index) => (
        <span key={index} className="u-cell">
          {cell}
        </span>
      ))}
      {notes && <span className="u-sheet-notes">{notes}</span>}
    </div>
  );
}

/* Чертежная доска, редактор плана и все, что рядом с ним, живут в отдельном файле набора */
export * from "./board";
export * from "./tour";
export { AccountLinks, AccountMenu, useMe } from "./account";
export * from "./player";
export { ask, choose } from "./confirm";
export { Drawer } from "./drawer";
export { Badge } from "./badge";
export * from "./digest";
export * from "./money";
export * from "./checklist";
