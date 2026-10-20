import { useEffect, useRef, useState, type AnimationEvent } from "react";

import { mln, term } from "../../app/format";
import { Button } from "../../ui";
import { Pallet07, Scout04 } from "../../ui/robots";
import type { DemoCase } from "./demoCases";
import type { CaseData } from "./load";
import { briefOf } from "./parts";
import { CleanScene, MoneyScene, PeopleScene, PickScene, WorkScene } from "./Scenes";
import { casePoints, refillOf, type CaseNumbers, type PointId } from "./teaser";
import { peopleOf, plural } from "./verdict";
import "./reel.css";

/* Ролик разбора (CaseReel) и первый экран страницы разбора (CaseTop).
   CaseReel ни к какой странице не привязан: на вход разбор и ответ сервера о нем, его можно ставить
   на лендинг. По кругу три сцены: роботы везут, деньги возвращаются, люди сменяются роботами.
   Идет, пока виден; вне экрана стоит. При "уменьшить анимацию" сцены стоят последним кадром и
   меняются только снаружи, через index и onIndex.
   CaseTop: слева ролик, справа три главных пункта. Пункт текущей сцены подсвечен, полоска в нем
   идет вместе со сценой, по пункту можно перейти к сцене */

const SCENE_SECONDS = 8;
const ORDER: PointId[] = ["work", "money", "people"];

function useSeen(target: React.RefObject<HTMLElement | null>): boolean {
  // без IntersectionObserver считаем, что видно всегда
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = target.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(([entry]) => setSeen(entry.isIntersecting), { threshold: 0.2 });
    watch.observe(node);
    return () => watch.disconnect();
  }, [target]);
  return seen;
}

function numbersOf(one: DemoCase, data: CaseData): CaseNumbers | null {
  const brief = briefOf(data.result);
  const sizing = data.result.sizing;
  if (!brief || !sizing) return null;
  const people = peopleOf(sizing);
  // суммы за горизонт те же, что последние точки графика "Три сценария" ниже
  const lastOf = (points: number[] | null | undefined) => (points?.length ? points[points.length - 1] : 0);
  return {
    robotName: one.robotName,
    verb: one.verb,
    average: one.average,
    unit: one.unit,
    fleet: brief.fleet,
    peak: sizing.peak_demand_ops_per_hour ?? 0,
    design: sizing.design_demand_ops_per_hour ?? sizing.peak_demand_ops_per_hour ?? 0,
    horizon: data.result.horizon_years,
    investment: brief.purchase.investment_year0_rub,
    rentStart: brief.raas.investment_year0_rub,
    rentPayback: brief.raas.payback_cumulative_years ?? null,
    rentLater: brief.raas.payback_later_years ?? null,
    payback: brief.purchase.payback_cumulative_years,
    later: brief.purchase.payback_later_years ?? null,
    effect: brief.purchase.annual_effect_year1_rub,
    effectTotal: brief.purchase.effect_total_rub,
    peopleBefore: people.before,
    peopleAfter: people.after,
    baselineTotal: lastOf(brief.baseline.cumulative_cost_rub),
    purchaseTotal: lastOf(brief.purchase.cumulative_cost_rub),
  };
}

/* Пока разбор считается или не посчитался: робот по центру поля */
function Waiting({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <div className="rl-center">
      {failed ? <Scout04 className="rl-robot" /> : <Pallet07 className="rl-robot" idle />}
      <p aria-live="polite">
        {failed
          ? "Сервер не ответил, разбор не посчитался. Обычно помогает повтор через минуту."
          : "Строим план склада и гоняем смену, это несколько секунд"}
      </p>
      {failed && (
        <Button arrow onClick={onRetry}>
          Посчитать еще раз
        </Button>
      )}
    </div>
  );
}

export type ReelProps = {
  one: DemoCase;
  // ответ сервера о разборе; пока его нет, на месте ролика робот и "строим"
  data: CaseData | null;
  failed?: boolean;
  onRetry?: () => void;
  // какая сцена: снаружи, если рядом пункты, по которым переходят к сценам
  index?: number;
  onIndex?: (index: number) => void;
  // время сцены рисует сосед (полоска в пункте), у ролика своя линия не видна
  quietClock?: boolean;
};

export function CaseReel({ one, data, failed = false, onRetry, index, onIndex, quietClock }: ReelProps) {
  const box = useRef<HTMLDivElement>(null);
  const seen = useSeen(box);
  const [still] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [own, setOwn] = useState(0);
  const [round, setRound] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const numbers = data ? numbersOf(one, data) : null;
  const points = numbers ? casePoints(numbers, { mln, term, plural }) : null;
  const current = (index ?? own) % ORDER.length;
  const id = ORDER[current];
  const running = seen && !leaving;

  const go = (next: number) => {
    const wrapped = next % ORDER.length;
    setLeaving(false);
    setRound(round + 1);
    if (onIndex) onIndex(wrapped);
    else setOwn(wrapped);
  };
  // сцена ушла со сцены: следующая по кругу
  const left = (event: AnimationEvent) => {
    if (event.target === event.currentTarget && leaving) go(current + 1);
  };

  let scene = <Waiting failed={failed} onRetry={onRetry ?? (() => undefined)} />;
  if (numbers && points) {
    const live = { running, still };
    scene =
      id === "work" ? (
        // у каждой задачи своя первая сцена: паллеты везут от ворот, уборка идет полосами, полки едут к станции
        one.operationId === "cleaning" ? (
          <CleanScene fleet={numbers.fleet} peak={numbers.peak} unit={numbers.unit} {...live} />
        ) : one.operationId === "piece_picking" ? (
          <PickScene fleet={numbers.fleet} peak={numbers.peak} unit={numbers.unit} {...live} />
        ) : (
          <WorkScene fleet={numbers.fleet} peak={numbers.peak} unit={numbers.unit} {...live} />
        )
      ) : id === "money" ? (
        <MoneyScene
          investment={numbers.investment}
          refill={refillOf(numbers.investment, numbers.effect, numbers.payback, numbers.horizon, numbers.effectTotal)}
          horizon={numbers.horizon}
          {...live}
        />
      ) : (
        <PeopleScene
          before={numbers.peopleBefore}
          after={numbers.peopleAfter}
          fleet={numbers.fleet}
          baselineTotal={numbers.baselineTotal}
          purchaseTotal={numbers.purchaseTotal}
          horizon={numbers.horizon}
        />
      );
  }

  return (
    <div ref={box} className="rl-reel" data-paused={!seen}>
      <div
        className={!points ? "rl-stage is-wait" : leaving ? "rl-stage is-leaving" : "rl-stage"}
        // номер показа в ключе: переход к той же сцене тоже начинает ее сначала
        key={points ? `${id}-${index ?? ""}-${round}` : "wait"}
        onAnimationEnd={left}
      >
        {points && (
          <p className={toneClass("rl-phrase", points[current].tone)} aria-hidden="true">
            {points[current].phrase}
          </p>
        )}
        {scene}
        {points && !still && (
          <span className={quietClock ? "rl-clock is-hidden" : "rl-clock"} aria-hidden="true">
            <i style={{ animationDuration: `${SCENE_SECONDS}s` }} onAnimationEnd={() => setLeaving(true)} />
          </span>
        )}
      </div>
    </div>
  );
}

type Props = { one: DemoCase; data: CaseData | null; failed: boolean; onRetry: () => void };

export function CaseTop({ one, data, failed, onRetry }: Props) {
  const [still] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0);
  const numbers = data ? numbersOf(one, data) : null;
  const points = numbers ? casePoints(numbers, { mln, term, plural }) : null;
  const pick = (next: number) => {
    setIndex(next);
    setRound(round + 1);
  };

  return (
    <section className="rl" aria-label={`Итог разбора: ${one.title.toLowerCase()}`}>
      <CaseReel
        one={one}
        data={data}
        failed={failed}
        onRetry={onRetry}
        index={index}
        onIndex={(next) => pick(next)}
        quietClock
      />
      {/* пока разбора нет, пустых рамок пунктов не рисуем: они выглядели бы сломанными */}
      {points && (
        <ol className="rl-points">
          {points.map((point, i) => (
            <li key={point.id}>
              <button type="button" className="rl-point" aria-pressed={i === index} onClick={() => pick(i)}>
                <span className="rl-label">{point.label}</span>
                <span className={toneClass("rl-big", point.tone)}>{point.big}</span>
                <span className="rl-note">{point.note}</span>
                <span className="rl-run" aria-hidden="true">
                  {i === index && !still && <i key={round} style={{ animationDuration: `${SCENE_SECONDS}s` }} />}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// выгода цветом выгоды, расход цветом расхода: "экономия" или "дороже" читаются без раздумий
function toneClass(base: string, tone?: "gain" | "loss"): string {
  return tone ? `${base} is-${tone}` : base;
}
