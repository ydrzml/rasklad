import { useEffect, useRef, useState } from "react";
import {
  api,
  type ClinicMoneyRequest,
  type ClinicOptimization,
  type ClinicOptimizationCandidate,
  type ClinicServiceScore,
} from "../../api/client";
import { Alert, Button, Check, FieldRow, Modes } from "../../ui";
import { assessReady, paybackReady, profileSummary, robustProfiles } from "./optimization";
import { mln, number, percent, term } from "../format";

const scoreLine = (score: ClinicServiceScore) =>
  [
    score.on_time_share == null ? "" : `вовремя ${percent(score.on_time_share)}`,
    score.urgent_on_time_share == null ? "" : `срочные вовремя ${percent(score.urgent_on_time_share)}`,
    score.completion_share == null ? "" : `завершено ${percent(score.completion_share)}`,
    score.cleaning_coverage == null ? "" : `уборка ${percent(score.cleaning_coverage)}`,
  ]
    .filter(Boolean)
    .join(" · ");

export function ClinicOptimizer({
  request,
  onUse,
}: {
  request: ClinicMoneyRequest;
  onUse: (candidate: ClinicOptimizationCandidate, targets: Record<string, number>) => void;
}) {
  const [objective, setObjective] = useState<"min_cost" | "max_time">("min_cost");
  const [scope, setScope] = useState("all");
  const [deliveryLimit, setDeliveryLimit] = useState(12);
  const [cleanerLimit, setCleanerLimit] = useState(4);
  const [target, setTarget] = useState(95);
  const [budget, setBudget] = useState<number | null>(null);
  const [timeBudget, setTimeBudget] = useState(30);
  const [robust, setRobust] = useState(true);
  const [demandRise, setDemandRise] = useState(25);
  const [performanceLoss, setPerformanceLoss] = useState(20);
  const [delayRise, setDelayRise] = useState(50);
  const [urgentTarget, setUrgentTarget] = useState(100);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ key: string; answer: ClinicOptimization } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const body = {
    ...request,
    objective,
    max_delivery_fleet: deliveryLimit,
    max_cleaners_per_floor: cleanerLimit,
    on_time_target: target / 100,
    urgent_on_time_target: urgentTarget / 100,
    stress_profiles: robust ? robustProfiles(demandRise, performanceLoss, delayRise) : [],
    completion_target: 1,
    cleaning_target: 1,
    max_upfront_rub: budget,
    time_budget_s: timeBudget,
    ...(scope === "chosen"
      ? {
          delivery_ids: request.robot_id ? [request.robot_id] : undefined,
          cleaner_ids: request.cleaner_id ? [request.cleaner_id] : undefined,
        }
      : {}),
  };
  const key = JSON.stringify(body);
  const fresh = result?.key === key;
  const best = result?.answer.candidates.find((candidate) => candidate.id === result?.answer.recommended_id);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  async function compare() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError("");
    try {
      const answer = await api.clinicOptimize(body, controller.signal);
      setResult({ key, answer });
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Подбор не завершен");
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  return (
    <div className="c-optimize">
      <p>
        Сравниваем модели и состав парка при одинаковом спросе. Сначала: выполнение работы, затем: выбранный критерий.
        Все заявки со сроком внутри смены должны быть завершены, коридоры вымыты полностью. Проверка выполняется на
        новых потоках заявок. Срочные доставки проверяются отдельно.
      </p>
      <Alert tone="note">
        Окупаемость показываем для сравнения. Убыточный вариант тоже можно выбрать и прогнать. В расходах учтены замена
        роботов и помощь персонала; долю сокращения бюджета и исходные цены подбор не меняет.
      </Alert>
      <Modes
        label="Цель подбора"
        value={objective}
        options={[
          { id: "min_cost", name: "Максимум NPV" },
          { id: "max_time", name: "Больше времени персоналу" },
        ]}
        onChange={(id) => setObjective(id as "min_cost" | "max_time")}
      />
      <Modes
        label="Модели для сравнения"
        value={scope}
        options={[
          { id: "all", name: "Весь доступный каталог" },
          { id: "chosen", name: "Только выбранные модели" },
        ]}
        onChange={setScope}
      />
      {request.operation_ids.includes("floor_delivery") && (
        <>
          <FieldRow
            label="Срочных заявок вовремя не меньше"
            value={urgentTarget}
            unit="%"
            hint="По умолчанию 100%. Условие сценария, требует согласования с учреждением."
            onChange={(v) => setUrgentTarget(v === "" ? 100 : Number(v))}
          />
          <FieldRow
            label="Доставщиков не больше"
            value={deliveryLimit}
            unit="шт"
            hint="Перебор от 1 до указанного числа, максимум 30"
            onChange={(v) => setDeliveryLimit(v === "" ? 12 : Number(v))}
          />
          <FieldRow
            label="Заявок вовремя не меньше"
            value={target}
            unit="%"
            hint="Сценарная цель, не медицинский норматив. Знаменатель: заявки со сроком внутри смены."
            onChange={(v) => setTarget(v === "" ? 95 : Number(v))}
          />
        </>
      )}
      {request.operation_ids.includes("cleaning") && (
        <FieldRow
          label="Уборщиков на этаж не больше"
          value={cleanerLimit}
          unit="шт"
          hint="От 1 до 4, число подбирается отдельно для каждого этажа"
          onChange={(v) => setCleanerLimit(v === "" ? 4 : Number(v))}
        />
      )}
      <Check label="Проверять повышенную нагрузку и задержки" checked={robust} onToggle={() => setRobust(!robust)} />
      {robust && (
        <>
          <p className="muted">
            Дополнительно проверяем рост потока и его группирование в первую половину часа; затем тот же пик вместе со
            снижением скорости, автономности и производительности, увеличением времени загрузки, выдачи, помощи и
            ожидания дверей, трафика людей в лифтах. Все условия должен выдержать один парк. Множители ниже: допущения,
            оценка F, измерений учреждения нет.
          </p>
          <FieldRow
            label="Рост потока в проверочных условиях"
            value={demandRise}
            unit="%"
            hint="От 0 до 300%. Проверяются оба процесса доставки, включая явно заданные маршруты."
            onChange={(v) => setDemandRise(v === "" ? 25 : Number(v))}
          />
          <FieldRow
            label="Снижение производительности в неблагоприятных условиях"
            value={performanceLoss}
            unit="%"
            hint="От 0 до 80%. Применяется к скорости, времени работы батареи и производительности уборки."
            onChange={(v) => setPerformanceLoss(v === "" ? 20 : Number(v))}
          />
          <FieldRow
            label="Рост задержек и помощи в неблагоприятных условиях"
            value={delayRise}
            unit="%"
            hint="От 0 до 300%. Это проверочное условие, а не установленный отраслевой норматив."
            onChange={(v) => setDelayRise(v === "" ? 50 : Number(v))}
          />
        </>
      )}
      {!robust && (
        <Alert tone="note">
          Проверяются только случайные потоки при исходных параметрах. Устойчивость к ошибкам предположений не
          проверяется.
        </Alert>
      )}
      <FieldRow
        label="Бюджет на старте"
        value={budget ?? ""}
        unit="₽"
        hint="Пусто: без ограничения. Для аренды учитываются аванс и интеграция."
        onChange={(v) => setBudget(v === "" ? null : Number(v))}
      />
      <FieldRow
        label="Время перебора до"
        value={timeBudget}
        unit="с"
        hint="От 2 до 30 секунд. Неполный перебор отмечается в результате; можно увеличить время и повторить."
        onChange={(v) => setTimeBudget(v === "" ? 30 : Number(v))}
      />
      <Button kind="ghost" disabled={running} onClick={() => void compare()}>
        {running ? "Сравниваем варианты…" : "Сравнить варианты парка"}
      </Button>
      {error && <Alert>{error}</Alert>}
      {result && (
        <>
          {!fresh && <Alert tone="note">Условия изменились. Повторите сравнение перед выбором парка.</Alert>}
          <p>
            Сравнено финансовых вариантов: {result.answer.configurations_checked}; прогонов: {result.answer.simulations}
            . {result.answer.stopped}. Время: {number(result.answer.elapsed_s, 1)} с.
          </p>
          {!result.answer.recommended_id && (
            <Alert>
              В проверенном диапазоне нет парка, подтвердившего выполнение задач во всех условиях. Причины и
              незавершенные проверки показаны у вариантов ниже.
            </Alert>
          )}
          {best && !paybackReady(best, result.answer.horizon_years) && (
            <Alert tone="note">
              Лучший из проверенных по выбранной цели не подтвердил положительный денежный итог и окупаемость во всех
              условиях за {result.answer.horizon_years} лет. Его можно выбрать; затраты и причины показаны ниже.
            </Alert>
          )}
          {best && best.released_hours_year < 0 && (
            <Alert>
              В одном из проверенных прогонов помощь роботам потребовала больше времени, чем они высвободили.
              Отрицательный баланс нельзя считать высвобождением сотрудников.
            </Alert>
          )}
          <div className="c-opt-cards">
            {result.answer.candidates.map((candidate) => (
              <article className="c-opt-card" key={candidate.id}>
                <h3>
                  {[candidate.robot_name, candidate.cleaner_name].filter(Boolean).join(" + ") ||
                    "Задание не требует роботов"}
                </h3>
                <p>
                  {candidate.payment_id === "purchase"
                    ? "Покупка"
                    : candidate.payment_id === "loan"
                      ? "Кредит"
                      : "Аренда"}{" "}
                  · доставщиков {candidate.fleet} · уборщиков{" "}
                  {Object.values(candidate.cleaners).reduce((a, b) => a + b, 0)}
                </p>
                {Object.keys(candidate.cleaners).length > 0 && (
                  <p>
                    По этажам:{" "}
                    {Object.entries(candidate.cleaners)
                      .map(([floor, count]) => `${floor}: ${count}`)
                      .join(", ")}
                  </p>
                )}
                <dl>
                  <div>
                    <dt>Денежный результат за {result.answer.horizon_years} лет, худший прогон</dt>
                    <dd>
                      {candidate.incremental_cost_rub < 0 ? "Экономия " : "Дополнительные расходы "}
                      {mln(Math.abs(candidate.incremental_cost_rub))} млн ₽
                    </dd>
                  </div>
                  <div>
                    <dt>Диапазон денежного результата: плюс: экономия, минус: расходы</dt>
                    <dd>
                      {mln(-candidate.incremental_cost_range_rub[1])}-{mln(-candidate.incremental_cost_range_rub[0])}{" "}
                      млн ₽
                    </dd>
                  </div>
                  <div>
                    <dt>Окупаемость, худший прогон</dt>
                    <dd>
                      {!candidate.validation
                        ? "Проверка не завершена"
                        : candidate.payback_years == null
                          ? `Не достигнута за ${result.answer.horizon_years} лет`
                          : term(candidate.payback_years)}
                    </dd>
                  </div>
                  <div>
                    <dt>Нужно на старте</dt>
                    <dd>{mln(candidate.upfront_rub)} млн ₽</dd>
                  </div>
                  <div>
                    <dt>Худший NPV</dt>
                    <dd>{mln(-(candidate.incremental_npv_cost_rub ?? candidate.incremental_cost_rub))} млн ₽</dd>
                  </div>
                  <div>
                    <dt>Баланс времени персонала, минимум</dt>
                    <dd>{number(candidate.released_hours_year, 0)} ч/год</dd>
                  </div>
                </dl>
                <p>Подбор: {scoreLine(candidate.training)}.</p>
                <details>
                  <summary>Условия проверки: {candidate.assessments.length}</summary>
                  <p>
                    Диапазон отражает заданные условия и случайные потоки. Это не доверительный интервал. После выбора
                    парка экономика и анимация повторяют исходные условия.
                  </p>
                  <ul>
                    {candidate.assessments.map((assessment) => (
                      <li key={assessment.profile.id}>
                        <b>{assessment.profile.name}</b>
                        <p>{profileSummary(assessment.profile)}.</p>
                        <p>Подбор: {scoreLine(assessment.training)}.</p>
                        <p>
                          {assessment.validation
                            ? `Новые потоки: ${scoreLine(assessment.validation)}`
                            : "Проверка на новых потоках не завершена"}
                          . Прогонов: {assessment.runs}.
                        </p>
                        <p>
                          Дополнительные расходы: {mln(assessment.incremental_cost_range_rub[0])}-
                          {mln(assessment.incremental_cost_range_rub[1])} млн ₽; баланс времени:{" "}
                          {number(assessment.labour_balance_range_hours[0], 0)}-
                          {number(assessment.labour_balance_range_hours[1], 0)} ч/год.
                        </p>
                        <p>
                          Окупаемость:{" "}
                          {assessment.payback_years == null ? "не достигнута" : term(assessment.payback_years)}.{" "}
                          {assessment.payback_met
                            ? "Плюс подтвержден во всех прогонах условия."
                            : "Положительный итог не подтвержден."}
                        </p>
                      </li>
                    ))}
                  </ul>
                </details>
                {candidate.validation && (
                  <p>
                    Новые потоки: {scoreLine(candidate.validation)}.
                    {candidate.validation.carryover_jobs > 0 &&
                      ` Перенос за смену заявок с более поздним сроком: ${candidate.validation.carryover_jobs}.`}
                  </p>
                )}
                {candidate.id === result.answer.recommended_id && (
                  <strong>Лучший из проверенных по выбранной цели</strong>
                )}
                {candidate.why_not.map((reason) => (
                  <Alert key={reason}>{reason}</Alert>
                ))}
                {candidate.payback_why_not.map((reason) => (
                  <Alert key={reason}>{reason}</Alert>
                ))}
                {!candidate.validated && !candidate.why_not.length && <p>Проверка на новых потоках не завершена.</p>}
                {candidate.conditions.length > 0 && (
                  <details>
                    <summary>Условия внедрения и полнота сметы</summary>
                    <ul>
                      {candidate.conditions.map((condition) => (
                        <li key={condition}>{condition}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <Button
                  kind="ghost"
                  disabled={
                    !fresh ||
                    running ||
                    !candidate.validated ||
                    !assessReady(candidate.assessments, result.answer.targets) ||
                    candidate.assessments.length !== result.answer.stress_profiles.length + 1
                  }
                  onClick={() => onUse(candidate, result.answer.targets)}
                >
                  Использовать этот парк
                </Button>
              </article>
            ))}
          </div>
          {result.answer.excluded.length > 0 && (
            <details>
              <summary>Почему исключены модели</summary>
              <ul>
                {result.answer.excluded.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </details>
          )}
          <details>
            <summary>Границы сравнения</summary>
            <ul>
              {result.answer.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
