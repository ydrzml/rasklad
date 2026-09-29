import { useEffect, useState } from "react";
import { AccountLinks, AccountMenu, Arrow, Header } from "../../ui";
import { useMe } from "../../ui/account";
import { FloorBot, Mover, Pallet07, Picker12, Sleeper06 } from "../../ui/robots";
import { HeatFloor } from "../landing/HeatFloor";
import { shouldShowSplash, Splash } from "../landing/Splash";
import "../landing/landing.css";
import "./landing-a.css";

// Второй вариант лендинга, рядом со старым, пока выбираем. Шапка и кнопки из набора, оранжевого нет.
// На первом экране чертеж склада: приемка, стеллажи, зарядка, отгрузка и роботы на маршрутах.
// Роботы ездят только по чертежам, пол фона стоит: движение там, где оно объясняет, как работает план.

const CALC = "/calc";
const LOGIN = "/login";
const MARK = "var(--ink)";
const BLUE = "var(--blue-line)";
const ROUTE = "var(--route)";
// проблемные места на схеме красим цветом «ждет в очереди», как в прогоне смены
const WAIT = "var(--act-wait)";

const STEPS = [
  ["Объект", "Склад, аэропорт, медучреждение или другое, и какие задачи роботизируем."],
  ["Параметры", "Режим работы, площадь, объемы задач и штат. Значения по умолчанию уже проставлены."],
  ["План объекта", "Ворота, стеллажи, проезды и зарядка на чертеже в метрах. От них зависят маршруты и размер парка."],
  ["Решение", "Подбор из каталога: подходят, требуют проверки, не подходят. В каждой карточке видно, почему."],
  ["Экономика", "Три сценария, TCO на 5 лет, окупаемость и прогон смены с выбранным роботом."],
];

const LETTERS = [
  ["S", "эталон: закон, ТЗ или все источники сходятся"],
  ["A", "проверено: производитель и независимая проверка"],
  ["B", "подтверждено: сходятся два типа источников"],
  ["C", "один источник"],
  ["D", "слабо: только организатор или СМИ"],
  ["E", "спорно: берем вариант хуже для окупаемости"],
  ["F", "нет данных: допущение с обоснованием"],
];

export function LandingA() {
  const [splash, setSplash] = useState(shouldShowSplash);
  const me = useMe();
  const signedIn = me !== null && me.role !== "guest";

  // Глаза роботов смотрят в сторону указателя
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      const x = event.clientX / window.innerWidth - 0.5;
      const y = event.clientY / window.innerHeight - 0.5;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty("--lx", `${(x * 4).toFixed(2)}px`);
        root.style.setProperty("--ly", `${(y * 3).toFixed(2)}px`);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <div className="l-page la-page">
      {splash && <Splash onDone={() => setSplash(false)} />}
      <HeatFloor />
      <svg width="0" height="0" className="l-defs" aria-hidden="true">
        <defs>
          <pattern id="l-slots" width="14" height="10" patternUnits="userSpaceOnUse">
            <path d="M14 0V10" stroke={BLUE} strokeWidth="0.9" />
          </pattern>
          <pattern id="la-slots" width="12" height="8" patternUnits="userSpaceOnUse">
            <path d="M0 8H12" stroke={BLUE} strokeWidth="0.7" />
          </pattern>
        </defs>
      </svg>

      {/* роботы на полу объезжают шапку, как любой блок страницы. Шапка прилипает к верху */}
      <div className="la-head" data-floor-busy>
        <Header
          nav={
            <>
              <a className="u-wide-only" href="#how">
                Как это работает
              </a>
              <a className="u-wide-only" href="#sources">
                Методика расчета
              </a>
              <AccountLinks />
              <AccountMenu />
            </>
          }
        />
      </div>

      <main className="l-wrap">
        <section className="la-hero" aria-labelledby="hero-title">
          <div data-floor-busy>
            <h1 id="hero-title">
              Рассчитайте автоматизацию склада <span>до покупки роботов</span>
            </h1>
            <p className="la-lead">
              Задайте параметры и план склада. Сервис подберет роботов, прогонит смену на вашем плане и посчитает
              окупаемость в трех сценариях: без роботов, покупка и аренда.
            </p>
            <a className="u-btn u-btn-primary la-go" href={CALC}>
              Посчитать свой склад
              <span className="u-knob">
                <Arrow />
              </span>
            </a>
            <p className="la-note">Начните с готового примера, свои данные можно поменять на любом шаге.</p>
          </div>

          <figure className="la-scene" data-floor-busy>
            <div className="la-sheet">
              <figcaption className="l-sheet-top">
                <span className="l-label">Пример · типовой склад</span>
                <span className="l-label">перевозка паллет</span>
              </figcaption>
              <HeroPlan />
            </div>
            <Pallet07 className="la-07" />
          </figure>
        </section>
        <div className="l-facts" data-floor-busy>
          <span>
            <b>31</b>решение для склада с характеристиками и источниками
          </span>
          <span>
            <b>3</b>сценария стоимости: без роботов, покупка, аренда
          </span>
          <span>
            <b>5 лет</b>горизонт расчета затрат
          </span>
          <span>
            <b>S-F</b>оценка доверия у каждой цифры
          </span>
        </div>

        <section className="l-block" id="how" aria-labelledby="how-title">
          <BlockHead
            label="Как это работает"
            id="how-title"
            title="Пять шагов на одной странице"
            note="Шаги идут по порядку, пройденный сворачивается в строку с итогом. Вернуться и поправить можно в любой момент, расчет пересчитается."
          />
          <ol className="l-steps" data-floor-busy>
            {STEPS.map(([name, text], i) => (
              <li key={name}>
                <span className="l-n">{String(i + 1).padStart(2, "0")}</span>
                <h3>{name}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="l-block" id="result" aria-labelledby="result-title">
          <BlockHead
            label="Что получите"
            id="result-title"
            title="Роботы едут по вашему плану, а не по рекламе"
            note="Производительность робота мы проверяем прогоном смены: с очередями в проездах и у ворот, с зарядкой. На этой кривой и держится размер парка."
          />
          <div className="l-panel l-shift" data-floor-busy>
            <div className="l-board">
              <ShiftPlan />
              <div className="l-keys">
                <span>
                  <i className="l-pin">1</i>зарядка
                </span>
                <span>
                  <i className="l-pin la-hot">2</i>узкое место в проезде
                </span>
                <span>
                  <i className="l-pin la-hot">3</i>очередь у ворот
                </span>
                <span>
                  <i className="l-sw-route" />
                  маршрут
                </span>
                <span>
                  <i className="l-sw-heat" />
                  где роботы стоят дольше
                </span>
              </div>
            </div>
            <div className="l-side">
              <span className="l-label">Смена на плане</span>
              <h3>Смена целиком, от первой паллеты до зарядки</h3>
              <p>Формула обычно видит робота быстрее, чем он ездит на деле. Прогон это проверяет.</p>
              <ul className="l-gets">
                <li>Маршруты по вашему плану</li>
                <li>Очереди в проездах и у ворот</li>
                <li>Зарядка и простои</li>
                <li>Кривая «роботов → операций в час», по ней считается парк</li>
              </ul>
              <div className="l-sleeper">
                <Sleeper06 />
                <p>06 спит на зарядке, пока остальные работают. Прогон считает и такие простои.</p>
              </div>
            </div>
          </div>

          <div className="l-pair">
            <div className="l-panel l-pick" data-floor-busy>
              <Picker12 className="l-picker" />
              <span className="l-label">Подборка решений</span>
              <h3>Видно, почему решение подошло</h3>
              <p className="l-sub">
                Каждое решение из каталога проходит проверки и получает балл из пяти слагаемых. Из чего он сложился,
                раскрыто в карточке.
              </p>
              <div className="l-card" aria-label="Пример карточки решения">
                <div className="l-card-top">
                  <span className="l-photo" aria-hidden="true" />
                  <div>
                    <b>Ronavi H1500</b>
                    <small>паллетный робот · пример карточки</small>
                  </div>
                  <span className="l-chip">Подходит</span>
                </div>
                <ul className="l-checks">
                  <Check text="Процесс совпадает с задачей" value="перевозка паллет" />
                  <Check text="Грузоподъемности хватает" value="до 1500 кг" />
                  <Check text="Проходит по ширине проезда" value="от 750 мм" />
                  <li>
                    Балл из пяти слагаемых
                    <span className="l-score" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                      <i className="l-lo" />
                    </span>
                  </li>
                </ul>
              </div>
            </div>

            <div className="l-panel l-econ" data-floor-busy>
              <span className="l-label">Окупаемость</span>
              <h3>Три сценария на горизонте пяти лет</h3>
              <p className="l-sub">
                Затраты, окупаемость, ROI и TCO для каждого сценария. Вывод интервалом и с рисками, а не одной красивой
                цифрой.
              </p>
              <CostSketch />
              <div className="l-scen">
                <div>
                  <b>
                    <i className="l-line-grey" />
                    Без роботов
                  </b>
                  как сейчас, с ростом зарплат
                </div>
                <div>
                  <b>
                    <i className="l-line-blue" />
                    Покупка
                  </b>
                  вложения сразу, затем обслуживание
                </div>
                <div>
                  <b>
                    <i className="l-line-dash" />
                    Аренда (RaaS)
                  </b>
                  платеж за робота
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="l-block" id="sources" aria-labelledby="sources-title">
          <BlockHead
            label="Методика расчета"
            id="sources-title"
            title="У каждого значения есть источник"
            note="Мы считаем по открытым данным и отраслевым нормативам. Нажмите на любую цифру в расчете, и увидите, откуда она."
          />
          <div className="l-trust">
            <div className="l-panel l-how-trust" data-floor-busy>
              <span className="l-label">Оценка доверия</span>
              <h3>Одна буква вместо сноски</h3>
              <p>
                Рядом с цифрой стоит буква от S до F. Она говорит, насколько цифре можно верить: сходятся ли несколько
                независимых источников или это слово одного производителя. Под буквой лежат сами источники с цитатами и
                датой.
              </p>
              <div className="l-letters" aria-label="Шкала оценок">
                {LETTERS.map(([letter, meaning]) => (
                  <span
                    key={letter}
                    tabIndex={0}
                    data-t={meaning}
                    className={letter === "B" ? "l-on" : undefined}
                    aria-label={`${letter}, ${meaning}`}
                  >
                    {letter}
                  </span>
                ))}
              </div>
            </div>
            <div className="l-panel l-value" data-floor-busy>
              <div className="l-what">
                <span className="l-label">Грузоподъемность · Ronavi H1500</span>
                <span className="l-label">пример из каталога</span>
              </div>
              <div className="l-num">
                <b>
                  1500<small>кг</small>
                </b>
                <span className="l-grade">
                  <i>B</i>подтверждено: сходятся два источника
                </span>
              </div>
              <ul className="l-srcs">
                <li>
                  <span className="l-t">производитель</span>
                  <span>
                    <a href="https://ronavi-robotics.ru/catalogue/h1500" target="_blank" rel="noopener noreferrer">
                      ronavi-robotics.ru/catalogue/h1500
                    </a>
                    <q>Грузоподъемность до 1500 кг</q>
                  </span>
                </li>
                <li>
                  <span className="l-t">организатор</span>
                  <span>
                    Примеры решений по типам объектов, файл организатора
                    <q>Грузоподъемность: до 1500 кг</q>
                  </span>
                </li>
              </ul>
              <p className="l-date">Данные получены 15.09.2026</p>
            </div>
          </div>
        </section>

        <section className="l-block" id="objects" aria-labelledby="objects-title">
          <BlockHead
            label="Объекты"
            id="objects-title"
            title="Начинаем со склада"
            note="Склад проходит весь путь, от объекта до экономики. Аэропорт и медучреждение пока доведены до выбора, параметров и списка решений."
          />
          <div className="l-objects">
            <article className="l-panel l-wh" data-floor-busy>
              <div className="l-draw" aria-hidden="true">
                <WarehouseMini />
              </div>
              <div>
                <div className="l-obj-t">
                  <h3>Склад</h3>
                  <span className="l-badge l-badge-blue">Полный путь</span>
                </div>
                <p>31 решение, которое мы отобрали и по которым собрали характеристики с источниками.</p>
                <ul>
                  <li>
                    <span>Параметры и план</span>
                    <span>есть</span>
                  </li>
                  <li>
                    <span>Подбор решений</span>
                    <span>есть</span>
                  </li>
                  <li>
                    <span>Прогон смены и экономика</span>
                    <span>есть</span>
                  </li>
                </ul>
              </div>
            </article>
            <div className="l-rows">
              <article className="l-panel l-row" data-floor-busy>
                <svg viewBox="0 0 64 64" aria-hidden="true">
                  <rect x="1" y="1" width="62" height="62" rx="14" fill="var(--blue-tint)" />
                  <path
                    d="M12 34h40c3 0 5-1 5-2s-2-2-5-2H38L28 16h-5l5 14H18l-4-5h-3l2 7-2 7h3l4-5h10l-5 14h5l10-14h14"
                    fill="none"
                    stroke={BLUE}
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
                <div>
                  <h3>
                    Аэропорт <span className="l-badge">Выбор и параметры</span>
                  </h3>
                  <p>Около тридцати позиций каталога по подходящим сценариям. Экономики пока нет.</p>
                </div>
              </article>
              <article className="l-panel l-row" data-floor-busy>
                <svg viewBox="0 0 64 64" aria-hidden="true">
                  <rect x="1" y="1" width="62" height="62" rx="14" fill="var(--blue-tint)" />
                  <rect x="14" y="16" width="36" height="34" fill="none" stroke={BLUE} strokeWidth="1.5" />
                  <path d="M32 22v14M25 29h14" stroke={BLUE} strokeWidth="2.4" strokeLinecap="round" />
                  <path d="M27 50v-7h10v7" fill="none" stroke={BLUE} strokeWidth="1.5" />
                </svg>
                <div>
                  <h3>
                    Медучреждение <span className="l-badge">Выбор и параметры</span>
                  </h3>
                  <p>Около тридцати позиций каталога по подходящим сценариям. Экономики пока нет.</p>
                </div>
              </article>
            </div>
          </div>
        </section>
      </main>

      <footer className="l-foot" data-floor-busy>
        <div className="l-foot-in">
          <div>
            <h2>Это оценка, а не коммерческое предложение</h2>
            <p className="l-foot-sub">
              Расчет идет только на сервере, по открытым данным и отраслевым нормативам. Любое значение можно поправить,
              и расчет вернется уже с вашей цифрой.
            </p>
            <div className="l-foot-btns">
              <a className="l-btn l-btn-light" href={CALC}>
                Посчитать свой склад
                <span className="l-knob">
                  <Arrow size={15} />
                </span>
              </a>
              {/* вошедшему "Войти" не нужен ни здесь, ни в строке ниже */}
              {!signedIn && (
                <a className="l-btn l-btn-line" href={LOGIN}>
                  Войти
                </a>
              )}
            </div>
          </div>
          <dl className="l-specs">
            <Spec
              term="Что считаем"
              value="Парк роботов, затраты, окупаемость, ROI, TCO"
              note="без роботов, покупка, аренда (RaaS)"
            />
            <Spec term="Горизонт" value="5 лет" note="с амортизацией и заменой аккумуляторов" />
            <Spec
              term="Каталог"
              value="31 складское решение с характеристиками"
              note="из 223 позиций каталога организатора"
            />
            <Spec term="Доверие" value="Буква от S до F у каждого значения" note="источник виден под буквой" />
          </dl>
        </div>
        <div className="l-foot-line">
          <span>Расклад · задача хакатона ЛЦТ-2026</span>
          <a href="#how">Как это работает</a>
          <a href="#sources">Откуда цифры</a>
          {!signedIn && <a href={LOGIN}>Войти</a>}
        </div>
      </footer>
    </div>
  );
}

function BlockHead({ label, id, title, note }: { label: string; id: string; title: string; note: string }) {
  return (
    <div className="l-block-head">
      <div>
        <span className="l-label">{label}</span>
        <h2 id={id}>{title}</h2>
      </div>
      <p>{note}</p>
    </div>
  );
}

function Check({ text, value }: { text: string; value: string }) {
  return (
    <li>
      <span className="l-tick" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <path d="M2 7l3.2 3L11 3.5" stroke="var(--on-blue)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      {text}
      <span className="l-v">{value}</span>
    </li>
  );
}

function Spec({ term, value, note }: { term: string; value: string; note: string }) {
  return (
    <div className="l-spec">
      <dt>{term}</dt>
      <dd>
        {value}
        <span>{note}</span>
      </dd>
    </div>
  );
}

function Racks({ x, ys, width, height }: { x: number; ys: number[]; width: number; height: number }) {
  return (
    <g stroke={BLUE} strokeWidth="1.2">
      {ys.map((y) => (
        <rect key={y} x={x} y={y} width={width} height={height} fill="url(#l-slots)" />
      ))}
    </g>
  );
}

function Charger({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const cx = x + w / 2;
  const top = y + h * 0.2;
  const size = h * 0.24;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="4" fill="var(--blue-tint)" stroke={BLUE} strokeWidth="1.2" />
      <path
        d={`M${cx + 2} ${top}l${-size / 2} ${size}h${size / 2}l${-size / 4} ${size}`}
        fill="none"
        stroke="var(--blue)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </g>
  );
}

/* Чертеж первого экрана. Раскладка как у шаблона «Сквозной» из мастера: приемка на одной стене,
   отгрузка на противоположной, между ними ряды стеллажей с поперечным проездом. Маршруты идут по
   проездам между рядами, а не сквозь стеллажи */
const ROWS = Array.from({ length: 14 }, (_, i) => 92 + i * 28);
const aisle = (i: number) => ROWS[i] + 20;

function HeroPlan() {
  const inbound = `M${aisle(3)} 84V178H${aisle(5)}V84Z`;
  const outbound = `M${aisle(1)} 300V200H${aisle(4)}V300Z`;
  const across = `M78 190H${aisle(13)}V190Z`;
  return (
    <svg viewBox="0 0 560 380" role="img" aria-labelledby="la-plan-title">
      <title id="la-plan-title">
        План типового склада: приемка сверху, отгрузка снизу, ряды стеллажей, зарядка и роботы на маршрутах
      </title>
      <g fill="none" stroke={BLUE}>
        <path d="M20 16H540M20 12v8M540 12v8M8 32V352M4 32h8M4 352h8" strokeWidth="0.9" />
        <rect x="20" y="32" width="520" height="320" strokeWidth="1.6" />
      </g>
      <g fontFamily="JetBrains Mono, monospace" fontSize="10" fill="var(--ink-soft)">
        <text x="280" y="11" textAnchor="middle">
          122 м
        </text>
        <text x="0" y="0" transform="translate(3 200) rotate(-90)" textAnchor="middle">
          82 м
        </text>
      </g>

      {/* ворота: приемка и отгрузка разным цветом, как на плане в мастере */}
      <Docks y={28} xs={[160, 212, 264]} color="var(--dock-in)" />
      <Docks y={348} xs={[120, 172, 224]} color="var(--dock-out)" />
      <g fill="none" stroke={BLUE} strokeWidth="0.9" strokeDasharray="4 3">
        <rect x="150" y="44" width="164" height="34" rx="3" />
        <rect x="110" y="306" width="164" height="34" rx="3" />
      </g>

      {/* ряды стеллажей двумя блоками, между ними поперечный проезд */}
      <g stroke={BLUE} strokeWidth="1">
        {ROWS.map((x) => (
          <g key={x}>
            <rect x={x} y="96" width="12" height="80" fill="url(#la-slots)" />
            <rect x={x} y="204" width="12" height="90" fill="url(#la-slots)" />
          </g>
        ))}
      </g>

      <Charger x={34} y={214} w={30} h={46} />

      <g fill="none" stroke={ROUTE} strokeWidth="2" strokeLinejoin="round" opacity="0.45">
        <path d={inbound} />
        <path d={outbound} />
        <path d={`M78 190H${aisle(13)}`} />
      </g>
      <Mover kind="pallet" path={inbound} seconds={16} />
      <Mover kind="long" path={outbound} seconds={18} delay={7} />
      <Mover kind="small" path={across} seconds={20} delay={3} />
      <FloorBot kind="small" transform="translate(49 280) rotate(-90)" />
    </svg>
  );
}

function Docks({ y, xs, color }: { y: number; xs: number[]; color: string }) {
  return (
    <g fill={color}>
      {xs.map((x) => (
        <rect key={x} x={x} y={y} width="40" height="8" rx="1.5" />
      ))}
    </g>
  );
}

function ShiftPlan() {
  // Тепловая карта у ворот и в проезде: чем краснее клетка, тем дольше роботы там стоят
  const hot: [number, number, number][] = [
    [400, 254, 0.55],
    [420, 254, 0.7],
    [440, 254, 0.5],
    [380, 254, 0.3],
    [460, 254, 0.3],
    [420, 234, 0.35],
    [420, 274, 0.4],
    [400, 274, 0.25],
    [440, 274, 0.25],
    [300, 156, 0.45],
    [320, 156, 0.3],
    [280, 156, 0.2],
    [660, 106, 0.18],
    [200, 206, 0.15],
  ];
  return (
    <svg viewBox="0 0 820 360" role="img" aria-labelledby="shift-title">
      <title id="shift-title">Схема прогона смены: маршруты роботов, пробки в проездах, зарядка и ворота</title>
      <g fill="none" stroke={BLUE}>
        <rect x="20" y="20" width="780" height="300" strokeWidth="1.6" />
        <rect x="24" y="24" width="772" height="292" strokeWidth="0.8" />
        <g strokeWidth="1.4">
          <path d="M300 320h60M300 326h60M300 314v18M360 314v18" />
          <path d="M420 320h60M420 326h60M420 314v18M480 314v18" />
          <path d="M540 320h60M540 326h60M540 314v18M600 314v18" />
        </g>
      </g>
      <g fill={WAIT}>
        {hot.map(([x, y, o]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="20" height="20" opacity={o} />
        ))}
      </g>
      <Racks x={140} ys={[58, 128, 178]} width={600} height={18} />
      <Charger x={46} y={200} w={44} h={64} />
      <g fill="none" stroke={ROUTE} strokeWidth="1.6" strokeDasharray="6 5" strokeLinejoin="round">
        <path d="M330 300V100H700V162H310V300" />
        <path d="M450 300V220H120V100H320" />
      </g>
      <Mover kind="pallet" path="M330 300V100H700V162H310V300Z" seconds={14} />
      <Mover kind="small" path="M450 300V220H120V100H320V220H450Z" seconds={18} delay={6} />
      <FloorBot kind="long" transform="translate(302 166) scale(1.2)" />
      <FloorBot kind="small" transform="translate(422 264) rotate(90) scale(1.3)" />
      <FloorBot kind="pallet" transform="translate(450 264) rotate(90) scale(1.3)" />
      <g fontFamily="JetBrains Mono, monospace" fontSize="12" textAnchor="middle">
        <circle cx="68" cy="186" r="11" fill={MARK} />
        <text x="68" y="190" fill="var(--on-ink)">
          1
        </text>
        <circle cx="310" cy="210" r="11" fill={WAIT} />
        <text x="310" y="214" fill="var(--white)">
          2
        </text>
        <circle cx="502" cy="250" r="11" fill={WAIT} />
        <text x="502" y="254" fill="var(--white)">
          3
        </text>
      </g>
    </svg>
  );
}

function CostSketch() {
  return (
    <svg viewBox="0 0 520 200" role="img" aria-labelledby="cost-title">
      <title id="cost-title">Схема накопленных затрат трех сценариев, без чисел</title>
      <g stroke={BLUE} fill="none">
        <path d="M40 166H505M40 14V166" strokeWidth="1.2" />
        <path d="M40 166v5M133 166v5M226 166v5M319 166v5M412 166v5M505 166v5" strokeWidth="1" />
      </g>
      <g fontFamily="JetBrains Mono, monospace" fontSize="11" fill="var(--ink-soft)">
        {[0, 1, 2, 3, 4].map((year) => (
          <text key={year} x={36 + year * 93} y="188">
            {year}
          </text>
        ))}
        <text x="505" y="188" textAnchor="end">
          5 лет
        </text>
        <text x="50" y="24" letterSpacing="1">
          НАКОПЛЕННЫЕ ЗАТРАТЫ
        </text>
      </g>
      <rect x="372" y="10" width="132" height="22" rx="11" fill="var(--sheet)" />
      <text
        x="438"
        y="25"
        textAnchor="middle"
        fontFamily="JetBrains Mono, monospace"
        fontSize="10.5"
        fill="var(--ink-soft)"
      >
        схема, не расчет
      </text>
      <path d="M40 156L505 40" stroke="var(--ink-soft)" strokeWidth="2" fill="none" />
      <path d="M40 98L133 110L505 78" stroke="var(--blue)" strokeWidth="2" fill="none" />
      <path d="M40 156L505 62" stroke={ROUTE} strokeWidth="2" strokeDasharray="6 4" fill="none" />
    </svg>
  );
}

function WarehouseMini() {
  return (
    <svg viewBox="0 0 300 170" aria-hidden="true">
      <g fill="none" stroke={BLUE}>
        <rect x="10" y="10" width="280" height="140" strokeWidth="1.4" />
        <path d="M90 150h34M90 155h34M180 150h34M180 155h34" strokeWidth="1.3" />
      </g>
      <Racks x={40} ys={[32, 66, 100]} width={220} height={12} />
      <path d="M107 148V55H240V89H197V148" fill="none" stroke={ROUTE} strokeWidth="1.3" strokeDasharray="4 3" />
      <FloorBot kind="small" transform="translate(240 55) rotate(90)" />
    </svg>
  );
}
