import { useEffect, useRef, useState } from "react";
import { api, type ClinicMoneyRequest, type ClinicPortfolio as Portfolio } from "../../api/client";
import { Alert, Button, Check, FieldRow } from "../../ui";
import { mln, term } from "../format";
import { candidateSizing, robustProfiles, type ClinicSizing } from "./optimization";

const label = (ids: string[]) =>
  ids.length ? ids.map((id) => (id === "cleaning" ? "Уборка" : "Доставка")).join(" + ") : "Нет";

export function ClinicPortfolio({
  request,
  onUse,
}: {
  request: ClinicMoneyRequest;
  onUse: (value: ClinicSizing) => void;
}) {
  const [robust, setRobust] = useState(true);
  const [target, setTarget] = useState(95);
  const [urgent, setUrgent] = useState(100);
  const [budget, setBudget] = useState<number | null>(null);
  const [fleetLimit, setFleetLimit] = useState(12);
  const [result, setResult] = useState<{ key: string; value: Portfolio } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const body = {
    ...request,
    objective: "min_cost" as const,
    time_budget_s: 30,
    max_delivery_fleet: fleetLimit,
    max_cleaners_per_floor: 4,
    on_time_target: target / 100,
    urgent_on_time_target: urgent / 100,
    max_upfront_rub: budget,
    completion_target: 1,
    cleaning_target: 1,
    stress_profiles: robust ? robustProfiles(25, 20, 50) : [],
  };
  const key = JSON.stringify(body);
  useEffect(() => () => abort.current?.abort(), []);
  const fresh = result?.key === key;
  async function compare() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError("");
    try {
      const value = await api.clinicPortfolio(body, controller.signal);
      setResult({ key, value });
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Сравнение не завершено");
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }
  return (
    <div className="c-customer">
      <h3>Что выгодно автоматизировать</h3>
      <p>
        Сравним доставку, уборку и обе задачи вместе. Остальная работа остается ручной. Денежный критерий: худший
        проверенный NPV при ваших ценах и ставке дисконтирования.
      </p>
      <details>
        <summary>Требования и ограничения поиска</summary>
        <div className="c-process-fields">
          {request.operation_ids.includes("floor_delivery") && (
            <>
              <FieldRow
                label="Заявок вовремя не меньше"
                unit="%"
                value={target}
                hint="От 50 до 100%. Требование проекта, не медицинский норматив."
                onChange={(value) => setTarget(Number(value))}
              />
              <FieldRow
                label="Срочных заявок вовремя"
                unit="%"
                value={urgent}
                hint="От 50 до 100%; согласуйте допустимость с учреждением."
                onChange={(value) => setUrgent(Number(value))}
              />
              <FieldRow
                label="Доставщиков не больше"
                unit="шт."
                value={fleetLimit}
                hint="От 1 до 30, перебор в этом диапазоне."
                onChange={(value) => setFleetLimit(Number(value))}
              />
            </>
          )}
          <FieldRow
            label="Денег на старте не больше"
            unit="₽"
            value={budget ?? ""}
            hint="Пусто: ограничение не задано. Бюджет применяется ко всем способам оплаты."
            onChange={(value) => setBudget(value === "" ? null : Number(value))}
          />
        </div>
      </details>
      <Check
        label="Проверять повышение нагрузки и ухудшение условий"
        checked={robust}
        onToggle={() => setRobust(!robust)}
      />
      <p className="muted">
        Проверочные допущения: поток доставки +25%, скорость, автономность и производительность −20%, задержки и помощь
        +50%. Для крупных зданий ограничение времени может оставить часть вариантов непроверенной.
      </p>
      <div className="c-process-actions">
        <Button onClick={() => void compare()} disabled={running}>
          {running ? "Сравниваем процессы…" : "Сравнить способы организации работы"}
        </Button>
        {running && (
          <Button
            kind="ghost"
            onClick={() => {
              abort.current?.abort();
              setRunning(false);
            }}
          >
            Остановить сравнение
          </Button>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      {result && (
        <>
          {!fresh && <Alert>Исходные данные изменились. Для применения варианта повторите сравнение.</Alert>}
          {!result.value.complete && (
            <Alert tone="note">
              Перебор завершен не полностью. Ниже только результаты, которые удалось проверить; глобальный оптимум не
              заявляется.
            </Alert>
          )}
          {result.value.manual_is_cheapest && (
            <Alert tone="note">
              Среди проверенных вариантов роботизация увеличивает приведенные расходы. Финансово выгоднее сохранить
              текущий способ. Выполнение работы текущим штатом в срок нужно проверить отдельно.
            </Alert>
          )}
          <div className="c-process-cards">
            <div className="u-panel c-process-card">
              <h3>Текущий способ работы</h3>
              <p>Дополнительные инвестиции: 0 ₽. Дополнительный денежный эффект: 0 ₽.</p>
              <p className="muted">
                Финансовая база сравнения. Достаточность штата и выполнение сроков не подтверждены симуляцией людей.
              </p>
            </div>
            {result.value.options.map((option) => {
              const candidate = option.candidate;
              return (
                <div className="u-panel c-process-card" key={option.id}>
                  <h3>{label(option.automated)}</h3>
                  <p>Остается вручную: {label(option.manual)}</p>
                  {candidate ? (
                    <>
                      <p>
                        {[
                          candidate.robot_name && `${candidate.fleet} × ${candidate.robot_name}`,
                          candidate.cleaner_name &&
                            `${Object.values(candidate.cleaners).reduce((s, n) => s + n, 0)} × ${candidate.cleaner_name}`,
                        ]
                          .filter(Boolean)
                          .join("; ")}
                      </p>
                      <p>
                        Оплата:{" "}
                        {candidate.payment_id === "purchase"
                          ? "покупка"
                          : candidate.payment_id === "loan"
                            ? "кредит"
                            : "аренда"}
                        . На старте: {mln(candidate.upfront_rub)} млн ₽.
                      </p>
                      <p>
                        NPV: <b>{mln(-(candidate.incremental_npv_cost_rub ?? candidate.incremental_cost_rub))} млн ₽</b>
                        . Простой денежный результат: {mln(-candidate.incremental_cost_rub)} млн ₽.
                      </p>
                      <p>
                        Простой срок: {candidate.payback_years == null ? "не достигнут" : term(candidate.payback_years)}
                        .
                      </p>
                      {result.value.recommended_id === option.id && (
                        <p>
                          <b>Лучший проверенный положительный NPV</b>
                        </p>
                      )}
                      <details>
                        <summary>Условия применения</summary>
                        <ul>
                          {candidate.conditions.map((note, i) => (
                            <li key={i}>{note}</li>
                          ))}
                        </ul>
                      </details>
                      <Button
                        kind="ghost"
                        disabled={!fresh || running || !candidate.validated}
                        onClick={() =>
                          onUse({
                            ...candidateSizing(request, candidate, {
                              payback_horizon_years: request.overrides["clinic.payback_horizon_years"] ?? 7,
                              on_time_share: target / 100,
                              urgent_on_time_share: urgent / 100,
                            }),
                            operation_ids: option.automated,
                          })
                        }
                      >
                        Применить этот вариант
                      </Button>
                    </>
                  ) : (
                    <Alert tone="note">{option.message}</Alert>
                  )}
                </div>
              );
            })}
          </div>
          {result.value.notes.map((note) => (
            <p className="muted" key={note}>
              {note}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
