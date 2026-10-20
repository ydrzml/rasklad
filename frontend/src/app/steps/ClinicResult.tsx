import { useEffect, useState, type KeyboardEvent } from "react";

import {
  api,
  type ClinicFinance,
  type ClinicMoney,
  type ClinicMoneyRequest,
  type ClinicQuotes as Quotes,
  type Parameter,
} from "../../api/client";
import { ClinicQuotes } from "../clinic/ClinicQuotes";
import { ClinicPortfolio } from "../clinic/ClinicPortfolio";
import type { Building } from "../clinic/building";
import { ClinicShift } from "../clinic/ClinicShift";
import { FINANCE_FIELDS } from "../clinic/finance";
import { ClinicOptimizer } from "../clinic/ClinicOptimizer";
import { CLINIC_NAMES, ClinicScenarioDetail, clinicScenario } from "../clinic/ClinicScenarioDetail";
import { candidateSizing, sizingFor, serviceReady, profileSummary, type ClinicSizing } from "../clinic/optimization";
import { Alert, BlockHead, Button, Digest, Digests, FieldRow, SourceList, TextButton } from "../../ui";
import { mln, number, percent, rangeWarning, sourceTitle, term, TRUST_TITLES } from "../format";
import { Card } from "./ChosenResult";
import { checkedWhen, clinicWords } from "./clinic";
import { ScenarioSwitch, type BuyWay, type Shown } from "./ScenarioSwitch";
import "./chosen.css";

// Поля, от которых зависит итог: объем заявок, точки доставки, зарплата санитара и горизонт.
// Остальные поля датасета на итог не влияют и стоят на шаге параметров
const FIELDS = [
  "clinic.drug_orders_per_day",
  "clinic.supply_trips_per_day",
  "clinic.drug_delivery_points",
  "clinic.orderly_salary_rub",
  "clinic.payback_horizon_years",
];
// правку поля считаем не на каждый удар по клавише
const WAIT_MS = 400;
// разделы "Откуда цифры": от объекта к деньгам
const SOURCE_GROUPS = [
  { id: "Объект", name: "Ваш объект" },
  { id: "Роботы", name: "Роботы" },
  { id: "Смена", name: "Смена: лифт, двери, сроки, люди" },
  { id: "Деньги", name: "Деньги" },
] as const;

/* Итог медучреждения устроен как шаг 5 склада: сверху вывод и три карточки одного вида (Card), под ними
   один переключатель сценария (ScenarioSwitch) с покупкой за свои и в кредит, ниже подробности выбранного
   и строки-сводки: требует уточнения, роботы, смена, люди, условия, ваши цифры и откуда цифры. Считает
   сервер на корпусе с шага плана. Готовый итог с запросом уходит наверх (onReady): файлы и сохранение */
export function ClinicResult({
  building,
  robotId,
  cleanerId,
  operationIds: requestedTasks,
  parameters,
  overrides,
  onChange,
  finance,
  onFinanceChange,
  sizing,
  onUseSizing,
  quotes,
  onQuotesChange,
  onReady,
}: {
  // корпус с шага плана; нет: сервер считает на типовом
  building: Building | null;
  robotId: string;
  cleanerId: string;
  operationIds: string[];
  parameters: Parameter[];
  overrides: Record<string, number>;
  onChange: (path: string, value: number | null) => void;
  finance: ClinicFinance;
  onFinanceChange: (next: ClinicFinance) => void;
  sizing: ClinicSizing | null;
  onUseSizing: (next: ClinicSizing) => void;
  quotes: Quotes;
  onQuotesChange: (next: Quotes) => void;
  /* готовый итог и запрос, по которому он посчитан; null, пока считаем или ошибка */
  onReady?: (ready: { request: ClinicMoneyRequest; answer: ClinicMoney } | null) => void;
}) {
  const [answer, setAnswer] = useState<ClinicMoney | null>(null);
  const [sent, setSent] = useState<ClinicMoneyRequest | null>(null);
  const [picked, setPicked] = useState<Shown | null>(null);
  const [answerKey, setAnswerKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({
    shift: true,
    finance: false,
    optimize: false,
    insight: true,
    basis: true,
  });
  const [attempt, setAttempt] = useState(0);
  const mine = Object.fromEntries(Object.entries(overrides).filter(([path]) => path.startsWith("clinic.")));
  const request = {
    operation_ids: requestedTasks,
    quotes,
    overrides: mine,
    building,
    robot_id: robotId,
    cleaner_id: cleanerId,
    assumptions: finance,
  };
  const selectedSizing = sizingFor(request, sizing);
  const operationIds = selectedSizing?.operation_ids ?? requestedTasks;
  const key = JSON.stringify([
    operationIds,
    mine,
    building,
    robotId,
    cleanerId,
    finance,
    quotes,
    selectedSizing,
    attempt,
  ]);
  const pending = loading || answerKey !== key;

  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const body: ClinicMoneyRequest = {
        operation_ids: operationIds,
        overrides: mine,
        building,
        robot_id: robotId,
        cleaner_id: cleanerId,
        assumptions: finance,
        quotes,
        ...(selectedSizing ? { fleet: selectedSizing.fleet, cleaners: selectedSizing.cleaners } : {}),
      };
      api
        .clinicMoney(body, abort.signal)
        .then((next) => {
          setAnswer(next);
          setSent(body);
          setAnswerKey(key);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (abort.signal.aborted) return;
          setError(reason instanceof Error ? reason.message : "Сервер не ответил");
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, WAIT_MS);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
    // запрос зависит только от ключа: задачи, правки медучреждения и корпус
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // наверх только итог, посчитанный по текущему вводу: файлы и сохранение берут его как есть
  const ready = !pending && answer && sent ? { request: sent, answer } : null;
  useEffect(() => {
    onReady?.(ready);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready?.answer, ready?.request]);

  if (error && !answer)
    return (
      <>
        <Alert>Итог не посчитался: {error}</Alert>
        <Button kind="ghost" onClick={() => setAttempt(attempt + 1)}>
          Повторить
        </Button>
      </>
    );
  if (!answer) return <p className="muted">Гоняем смену на вашем корпусе и считаем деньги...</p>;

  const horizon = answer.horizon_years;
  const serviceConfirmed =
    answer.shift.search?.needed !== null &&
    serviceReady(
      answer.shift.service,
      selectedSizing?.assessment?.onTimeTarget ?? 0.95,
      selectedSizing?.assessment?.urgentTarget ?? 1,
    );
  const baseWords = clinicWords(horizon, answer.scenarios, answer.assumptions.cash_realization_share, serviceConfirmed);
  const hasPositiveNpv = answer.scenarios.some((s) => s.id !== "baseline" && s.available && s.npv_rub > 0);
  const words =
    baseWords && !hasPositiveNpv && baseWords.best
      ? {
          ...baseWords,
          head: "При заданной стоимости капитала выгодность не подтверждена",
          sub: "Простой денежный поток может быть положительным, но NPV не превышает ноль. Сравните способы организации работы и полную смету.",
          best: null,
        }
      : baseWords;
  const baseline = answer.scenarios.find((one) => one.id === "baseline");
  const buy = answer.scenarios.find((one) => one.id === "purchase");
  const rent = answer.scenarios.find((one) => one.id === "raas");
  const loan = answer.scenarios.find((one) => one.id === "loan");
  if (!words || !baseline || !buy || !rent) return null;
  const fleetLine = answer.fleets.map((one) => `${one.count} ${one.name}`).join(" и ");
  const toggle = (id: string) => setOpen((current) => ({ ...current, [id]: !current[id] }));
  const fields = FIELDS.flatMap((path) => parameters.filter((one) => one.path === path));
  const weak = answer.sources.filter((one) => one.trust === "F").length;
  const shift = answer.shift;
  const delivering = operationIds.includes("floor_delivery");

  const shown: Shown = picked ?? (words.best === "rent" ? "raas" : "purchase");
  const way: BuyWay = finance.loan_enabled === 1 ? "loan" : "own";
  const onWay = (next: BuyWay) => onFinanceChange({ ...finance, loan_enabled: next === "loan" ? 1 : 0 });
  const buyShown = way === "loan" && loan?.available && loan.financing ? loan : buy;
  // стрелки влево и вправо ходят по карточкам, как по вкладкам, как у склада
  const ids: Shown[] = ["baseline", "purchase", "raas"];
  const tab = (id: Shown) => ({
    id: `card-${id}`,
    selected: shown === id,
    onSelect: () => setPicked(id),
    onKeyDown: (event: KeyboardEvent) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = ids[(ids.indexOf(id) + step + ids.length) % ids.length];
      setPicked(next);
      document.getElementById(`card-${next}`)?.focus();
    },
  });
  const payback = (one: typeof buy) => ({
    label: one.id === "loan" ? "окупится с учетом долга" : "окупится",
    value: one.payback_years == null ? `не за ${horizon} лет` : term(one.payback_years),
    plain: true,
  });
  // платеж меньше 0,1 млн в тысячах, иначе на карточке "0,0 млн", как у склада
  const month = (value: number, label = "платеж в месяц") =>
    value < 100_000
      ? { label, value: `${Math.round(value / 1_000).toLocaleString("ru-RU")} тыс. ₽`, plain: true }
      : { label, value: mln(value) };

  return (
    <div className={`${pending ? "u-econ u-stale" : "u-econ"} c-medical-economics`}>
      <section id="chosen" className="u-chosen">
        <h1 className="u-chosen-head">{words.head}</h1>
        <p className="u-chosen-sub">{words.sub}</p>
        {error && <Alert>Последняя правка не посчиталась: {error}. На экране прошлый итог.</Alert>}
        {requestedTasks.some((id) => !operationIds.includes(id)) && (
          <Alert tone="note">
            Автоматизируется {operationIds.map((id) => (id === "cleaning" ? "уборка" : "доставка")).join(" и ")}.
            Остальные выбранные процессы остаются ручными, ниже расходы только автоматизируемой части.
          </Alert>
        )}
        {(shift.done < shift.jobs || (shift.cleaning_coverage != null && shift.cleaning_coverage < 0.999)) && (
          <Alert>
            Объем выполнен не полностью. Денежный эффект посчитан только для выполненных работ, оставшиеся требуют
            персонала.
          </Alert>
        )}
        {shift.search && shift.search.needed === null && (
          <Alert>
            Парк не достиг цели {percent(shift.search.target)} заявок вовремя: {shift.search.stopped}. Экономика
            рассчитана для проверенного парка; перед внедрением исправьте ограничения корпуса.
          </Alert>
        )}
        {answer.skipped.length > 0 && (
          <Alert tone="note">
            Не считаем: {answer.skipped.join(", ").toLowerCase()}. Деньги есть только для доставки по этажам и уборки
            коридоров.
          </Alert>
        )}
        {selectedSizing && (
          <Alert tone="note">
            Используется выбранный состав парка. Экономика и проигрыватель повторяют его без нового подбора численности.
          </Alert>
        )}
        {sizing && !selectedSizing && (
          <Alert tone="note">
            После выбора парка изменились исходные данные. Итог рассчитан обычным подбором; повторите сравнение
            вариантов.
          </Alert>
        )}
        {selectedSizing?.assessment && (
          <details>
            <summary>
              Проверка выбранного парка: {selectedSizing.assessment.cases} условий, {selectedSizing.assessment.runs}{" "}
              прогонов, денежный результат от {mln(-selectedSizing.assessment.incrementalCostRangeRub[1])} до{" "}
              {mln(-selectedSizing.assessment.incrementalCostRangeRub[0])} млн ₽ за горизонт
            </summary>
            <p>
              Деньги и анимация относятся к исходному сценарию. Дополнительные условия использовались при выборе
              численности; они не подтверждены измерениями учреждения. Минимальный баланс времени:{" "}
              {number(selectedSizing.assessment.minimumLabourHours, 0)} ч/год.
            </p>
            <ul>
              {selectedSizing.assessment.profiles.map((profile) => (
                <li key={profile.id}>
                  {profile.name}: {profileSummary(profile)}.
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="u-chosen-cards" data-count={3} role="tablist" aria-label="Что показать подробно">
          <Card
            {...tab("baseline")}
            tone="now"
            name="Без роботов"
            note={
              !delivering
                ? "Коридоры моют уборщицы: это база для сравнения"
                : shift.cleaned_m2 > 0
                  ? "Рейсы делают санитары, коридоры моют уборщицы: это база для сравнения"
                  : "Рейсы из аптеки делают санитары, это база для сравнения"
            }
            total={baseline.tco_rub}
            horizon={horizon}
            rows={[
              { label: "вложить на старте", value: "не нужно", plain: true },
              { label: "люди на этой работе в год", value: mln(baseline.years_rub[0] ?? 0) },
              { label: "часов людей в смену", value: number(answer.people.manual_hours_per_shift, 1), plain: true },
            ]}
          />
          <Card
            {...tab("purchase")}
            tone="buy"
            name={buyShown.id === "loan" ? "Покупка в кредит" : "Покупка"}
            note={
              buyShown.id === "loan"
                ? "Роботы ваши, оборудование в кредит: на старте свои деньги, дальше платежи банку"
                : "Роботы ваши: парк и внедрение на старте, дальше обслуживание"
            }
            best={words.best === "buy"}
            rows={
              buyShown.id === "loan" && buyShown.financing
                ? [
                    { label: "своих денег на старте", value: mln(buyShown.start_rub) },
                    month(buyShown.financing.first_month_rub, "первый платеж в месяц"),
                    payback(buyShown),
                  ]
                : [
                    { label: "вложить на старте", value: mln(buy.start_rub) },
                    buy.effect_year1_rub < 0
                      ? { label: "экономии нет, расходы выше в год", value: mln(-buy.effect_year1_rub) }
                      : { label: "эффект бюджета в 1-й год", value: mln(buy.effect_year1_rub) },
                    payback(buy),
                  ]
            }
            total={buyShown.tco_rub}
            gain={baseline.tco_rub - buyShown.tco_rub}
            horizon={horizon}
          />
          <Card
            {...tab("raas")}
            tone="rent"
            name="Аренда"
            note={
              !rent.available
                ? "Для всего выбранного парка нужен тариф поставщика"
                : rent.rent_period === "year"
                  ? "Годовая оплата дешевле помесячной на этом горизонте, роботы не ваши"
                  : "Платеж в месяц, ремонт на поставщике, роботы не ваши"
            }
            best={words.best === "rent"}
            rows={
              rent.available
                ? [
                    { label: "внедрение и аванс на старте", value: mln(rent.start_rub) },
                    rent.rent_period === "year"
                      ? { label: "платеж в год", value: mln((rent.month_rub ?? 0) * 12) }
                      : month(rent.month_rub ?? 0),
                    payback(rent),
                  ]
                : [{ label: "почему нет суммы", value: rent.why_not, plain: true }]
            }
            total={rent.tco_rub}
            totalText={rent.available ? undefined : "уточняется"}
            gain={baseline.tco_rub - rent.tco_rub}
            horizon={horizon}
          />
        </div>
        <p className="u-chosen-under">
          <span>
            Крупно все расходы за {horizon} лет вместе с людьми: чем меньше, тем выгоднее. Смену прогнали на{" "}
            {building ? "вашем" : "типовом"} корпусе: этажей {shift.floors}, постов {shift.wards}, лифтов {shift.lifts},
            окно {shift.hours} ч с {String(shift.shift_start_h).padStart(2, "0")}:00.
          </span>
        </p>
        <aside className="u-chosen-other is-rent">
          <h3>{words.rent.title}</h3>
          <p>{words.rent.text}</p>
        </aside>
      </section>
      <ScenarioSwitch
        shown={shown}
        way={way}
        onShow={setPicked}
        onWay={onWay}
        locked={{ leasing: "Лизинг для медучреждения пока не считаем: есть покупка за свои и в кредит" }}
      />
      <div
        className={`u-chosen-detail is-${shown === "baseline" ? "now" : shown === "raas" ? "rent" : "buy"}`}
        id="step5-detail"
        role="tabpanel"
        aria-labelledby={`card-${shown}`}
      >
        <ClinicScenarioDetail
          answer={answer}
          shown={shown}
          way={way}
          finance={finance}
          onFinanceChange={onFinanceChange}
        />
      </div>

      <div className="u-econ-more">
        <BlockHead
          title="Как посчитано"
          note={`Деньги выше по выбранному: ${CLINIC_NAMES[clinicScenario(answer, shown, way)?.id ?? "purchase"].toLowerCase()}. Откройте строку, под ней все цифры и откуда они`}
        />
        <Digests>
          <Digest
            id="clinic-basis"
            title="Что требует уточнения"
            open={!!open.basis}
            onToggle={() => toggle("basis")}
            facts={[{ label: "пунктов", value: String((answer.readiness ?? []).length) }]}
            line="Предварительный результат становится обоснованием решения после проверки исходных данных и пилота"
          >
            {(answer.readiness ?? []).length ? (
              <ul>
                {answer.readiness.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : (
              <p>
                Основные данные и коммерческие условия введены. Проверка на эксплуатации и санитарная применимость
                подтверждаются отдельно.
              </p>
            )}
          </Digest>
          <Digest
            id="clinic-insight"
            title="Что влияет на окупаемость"
            open={!!open.insight}
            onToggle={() => toggle("insight")}
            line="Стоимость парка, реально сокращаемые расходы и порог безубыточности"
          >
            <p>
              Типовой план задает пути и площадь, а не экономию. В расчете {shift.hours} ч работы в день,{" "}
              {answer.assumptions.days_per_year} дней в год; стоимость высвобождения{" "}
              {mln(answer.people.released_value_year_rub)} млн ₽/год, в сокращение расходов превращается{" "}
              {percent(answer.assumptions.cash_realization_share)}
              {answer.people.positions_released ? `: ${answer.people.positions_released} целых ставок` : ""}.
              {(buy.residual_rub ?? 0) > 0 &&
                ` Остаток срока службы парка на конец горизонта ${mln(buy.residual_rub ?? 0)} млн ₽ вычтен из итога покупки: это не деньги, а оплаченные годы работы второго парка. В срок окупаемости он не входит.`}
            </p>
            {answer.assumptions.cash_realization_share === 0 && (
              <Alert tone="note">
                Зарплатный бюджет сохраняется полностью. У роботов появляются затраты, а денежной экономии от
                высвобождения часов нет. Меняйте эту долю только при реальном сокращении сверхурочных, вакансий или
                подрядных расходов.
              </Alert>
            )}
            {answer.people.released_value_year_rub <= 0 && (
              <Alert tone="note">
                Чистого высвобождения времени на этих входах нет: проверьте фактические расстояния, объем работы,
                загрузку и помощь роботам. Рост числа роботов сам по себе это не исправляет.
              </Alert>
            )}
            <ul className="u-sources">
              {answer.scenarios
                .filter((s) => s.id !== "baseline" && s.available)
                .map((s) => (
                  <li key={s.id}>
                    <span aria-hidden="true" />
                    <span className="u-sources-name">
                      {s.id === "purchase" ? "Покупка" : s.id === "loan" ? "Кредит" : "Аренда"}
                      <small>
                        {s.cash_share_for_break_even == null
                          ? "Порог недостижим без положительного высвобождения."
                          : s.cash_share_for_break_even > 1
                            ? "Даже реализация 100% высвобождения не покрывает затраты на этих входах."
                            : `Для безубыточности в реальные деньги должно превращаться ${percent(s.cash_share_for_break_even)} высвобождения.`}
                      </small>
                    </span>
                    <span className="u-sources-value mono">
                      {s.annual_gap_rub > 0 ? `Не хватает ${number(s.annual_gap_rub, 0)} ₽/год` : "Порог пройден"}
                    </span>
                  </li>
                ))}
            </ul>
            <p className="muted">
              Это порог простого денежного результата без дисконтирования, приведенный к ценам первого года. Введенный
              предел сокращения расходов может сделать его недостижимым. Для инвестиционного сравнения используйте NPV.
              Варианты можно выбирать при любом результате. Для поиска меньших расходов сравните весь каталог и состав
              парка; объемы, ставки и длительность помощи задавайте по объекту.
            </p>
          </Digest>
          <Digest
            id="clinic-optimize"
            title="Найти эффективный состав парка"
            open={!!open.optimize}
            onToggle={() => toggle("optimize")}
            line="Перебор моделей, численности, распределения по этажам, покупки, аренды и добавленного кредита"
          >
            <ClinicPortfolio request={request} onUse={onUseSizing} />
            <details>
              <summary>Подробный подбор парка для всех выбранных задач</summary>
              <ClinicOptimizer
                request={request}
                onUse={(candidate, targets) => onUseSizing(candidateSizing(request, candidate, targets))}
              />
            </details>
          </Digest>
          <Digest
            id="clinic-fleet"
            title="Сколько роботов"
            open={!!open.fleet}
            onToggle={() => toggle("fleet")}
            facts={answer.fleets.map((one) => ({ label: one.task.toLowerCase(), value: String(one.count) }))}
            line={`${fleetLine}. ${selectedSizing ? "Состав выбран после сравнения; ниже фактический прогон этого состава" : shift.search ? (shift.search.needed === null ? "Цель доставки не достигнута" : `Парк доставки подтвержден на трех прогонах: вовремя не менее ${percent(shift.search.target)}`) : "Уборщики работают на своих этажах"}`}
          >
            <ul className="u-sources">
              <li>
                <span aria-hidden="true" />
                <span className="u-sources-name">
                  Заявок за окно прогона
                  <small>лекарства и расходники из аптеки на посты, по объему датасета на {shift.wards} постов</small>
                </span>
                <span className="u-sources-value mono">
                  {shift.done} / {shift.jobs} выполнено
                </span>
              </li>
              <li>
                <span aria-hidden="true" />
                <span className="u-sources-name">
                  Вовремя
                  <small>час на плановую заявку, 20 минут на срочную от готовности заказа</small>
                </span>
                <span className="u-sources-value mono">
                  {shift.on_time_share == null ? "нет заявок" : percent(shift.on_time_share)}
                </span>
              </li>
              <li>
                <span aria-hidden="true" />
                <span className="u-sources-name">
                  В среднем от заявки до поста
                  <small>вместе со сборкой заказа в аптеке, ожиданием лифта и дверей</small>
                </span>
                <span className="u-sources-value mono">
                  {shift.avg_delivery_min == null ? "нет" : `${number(shift.avg_delivery_min, 0)} мин`}
                </span>
              </li>
              {shift.lift_busy_share != null && (
                <li>
                  <span aria-hidden="true" />
                  <span className="u-sources-name">
                    Самый занятый лифт
                    <small>лифт общий с людьми, они едут первыми</small>
                  </span>
                  <span className="u-sources-value mono">{percent(shift.lift_busy_share)} смены</span>
                </li>
              )}
              {shift.cleaned_m2 > 0 && (
                <li>
                  <span aria-hidden="true" />
                  <span className="u-sources-name">
                    Вымыто коридоров за смену
                    <small>уборщик на каждом этаже: на лифте уборщики не ездят</small>
                  </span>
                  <span className="u-sources-value mono">
                    {number(shift.cleaned_m2, 0)} / {number(shift.cleaning_required_m2, 0)} м²
                  </span>
                </li>
              )}
              {answer.fleets.map((one) => (
                <li key={one.name}>
                  <span className="u-trust" title={TRUST_TITLES.C}>
                    C
                  </span>
                  <span className="u-sources-name">
                    Цена {one.name}
                    <small>{one.price_source}</small>
                  </span>
                  <span className="u-sources-value mono">{mln(one.price_rub)} млн ₽</span>
                </li>
              ))}
            </ul>
            <p className="u-shift-note">Узкое место: {shift.bottleneck}.</p>
          </Digest>

          {building && (
            <Digest
              id="clinic-shift"
              title="Смена на плане корпуса"
              open={!!open.shift}
              onToggle={() => toggle("shift")}
              facts={[
                { label: "этажей", value: String(shift.floors) },
                { label: "заявок", value: String(shift.jobs) },
              ]}
              line="Выбранные роботы на вашем корпусе: двери, очередь к лифту, зарядка"
            >
              {open.shift && !pending && (
                <ClinicShift
                  building={building}
                  fleet={shift.fleet}
                  cleaners={shift.cleaners}
                  robotId={robotId}
                  cleanerId={operationIds.includes("cleaning") ? cleanerId : null}
                  operationIds={operationIds}
                  overrides={mine}
                />
              )}
            </Digest>
          )}

          <Digest
            id="clinic-people"
            title="Что с людьми"
            open={!!open.people}
            onToggle={() => toggle("people")}
            facts={[
              { label: "часов в смену", value: number(answer.people.hours_per_shift, 1) },
              { label: "эквивалент ставок", value: number(answer.people.fte, 1) },
            ]}
            line={`Чистое высвобождение: ${number(answer.people.hours_per_year, 0)} ч/год после помощи роботам. Эквивалент ставок: мера времени, а не число увольнений.`}
          >
            <p>
              Ручной эквивалент выполненного объема: {number(answer.people.manual_hours_per_shift, 2)} ч/смену. С
              роботами остается {number(answer.people.remaining_hours_per_shift, 2)} ч, включая помощь{" "}
              {number(answer.people.support_hours_per_shift, 2)} ч. Чистое высвобождение доставки:{" "}
              {number(answer.people.delivery_hours_per_shift, 2)} ч, уборки:{" "}
              {number(answer.people.cleaning_hours_per_shift, 2)} ч.
            </p>
            <p>
              Стоимость чистого времени: {mln(answer.people.released_value_year_rub)} млн ₽/год. Подтвержденный
              сценарием эффект фонда оплаты труда: {mln(answer.people.cash_saving_year_rub)} млн ₽/год до расходов на
              роботов. Час доставки: {number(answer.people.hour_rub, 0)} ₽, уборки:{" "}
              {number(answer.people.cleaner_hour_rub, 0)} ₽ с начислениями.
            </p>
            {answer.people.extra_hours_per_shift > 0 && (
              <Alert>
                Дополнительная нагрузка персонала: {number(answer.people.extra_hours_per_shift, 2)} ч/смену, она
                включена в расходы.
              </Alert>
            )}
          </Digest>

          <Digest
            id="clinic-finance"
            title="Условия расчета"
            open={!!open.finance}
            onToggle={() => toggle("finance")}
            facts={[{ label: "реализация в бюджете", value: percent(answer.assumptions.cash_realization_share) }]}
            line="Хронометраж помощи, доля сокращения расходов и полная смета внедрения"
          >
            {answer.warnings.map((warning) => (
              <Alert key={warning} tone="note">
                {warning}
              </Alert>
            ))}
            {FINANCE_FIELDS.filter(
              ({ id }) =>
                !id.startsWith("loan_") &&
                (operationIds.includes("cleaning") ||
                  ![
                    "cleaning_time_saving_share",
                    "cleaner_support_min_per_shift",
                    "cleaner_hour_rub",
                    "rent_service_included",
                  ].includes(id)),
            ).map((field) => {
              const value = finance[field.id] ?? answer.assumptions[field.id];
              const missingEstimate =
                ["integration_rub", "extra_annual_rub"].includes(field.id) && finance[field.id] === undefined;
              return (
                <FieldRow
                  key={field.id}
                  label={field.label}
                  unit={field.unit}
                  value={missingEstimate || value == null ? "" : Math.round(value * field.scale * 100) / 100}
                  hint={field.hint}
                  yesNo={field.id === "rent_service_included"}
                  trust="F"
                  trustTitle="Сценарное условие, подтвердите данными объекта"
                  warning={
                    value != null && (value < field.min || value > field.max)
                      ? `Диапазон: ${field.min * field.scale}-${field.max * field.scale}`
                      : undefined
                  }
                  onChange={(next) => {
                    const changed = { ...finance };
                    if (next === "") delete changed[field.id];
                    else changed[field.id] = Number(next) / field.scale;
                    onFinanceChange(changed);
                  }}
                />
              );
            })}
            {Object.keys(finance).length > 0 && (
              <TextButton onClick={() => onFinanceChange({})}>Вернуть сценарные условия</TextButton>
            )}
            <ClinicQuotes fleets={answer.fleets} value={quotes} onChange={onQuotesChange} />
            {Object.keys(rent.rental_options_rub).length > 1 && (
              <p>
                Расходы на аренду и внедрение за {horizon} лет, без зарплаты: помесячно{" "}
                {mln(rent.rental_options_rub.month)} млн ₽; с годовой оплатой {mln(rent.rental_options_rub.year)} млн ₽.
                Выбран меньший итог; договор и возможность годового аванса нужно подтвердить.
              </p>
            )}
          </Digest>

          <Digest
            id="clinic-inputs"
            title="Ваши цифры"
            open={!!open.inputs}
            onToggle={() => toggle("inputs")}
            facts={[{ label: "вы поправили", value: String(Object.keys(mine).length) }]}
            line="Сейчас стоит пример по отраслевому датасету: поправьте то, что знаете про свою больницу"
          >
            {fields.map((field) => {
              const value = overrides[field.path] ?? field.value;
              return (
                <FieldRow
                  key={field.path}
                  label={field.label.replaceAll("е", "е")}
                  unit={field.unit}
                  value={value}
                  hint={field.hint}
                  trust={field.trust}
                  trustTitle={sourceTitle(field)}
                  warning={value < field.min || value > field.max ? rangeWarning(field) : undefined}
                  onChange={(next) => onChange(field.path, next === "" ? null : Number(next))}
                />
              );
            })}
            {Object.keys(mine).length > 0 && (
              <TextButton onClick={() => Object.keys(mine).forEach((path) => onChange(path, null))}>
                Вернуть пример
              </TextButton>
            )}
          </Digest>

          <Digest
            id="clinic-sources"
            title="Откуда цифры"
            open={!!open.sources}
            onToggle={() => toggle("sources")}
            facts={[
              { label: "значений", value: String(answer.sources.length) },
              { label: "без источника", value: String(weak) },
            ]}
            line="Что приняли за вас, источник каждой цифры и чего в деньгах нет"
          >
            <h3>Чего нет в деньгах</h3>
            <ul>
              {answer.not_counted.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {SOURCE_GROUPS.map((group) => {
              const rows = answer.sources.filter((one) => one.group === group.id);
              if (!rows.length) return null;
              return (
                <div key={group.id}>
                  <h3>{group.name}</h3>
                  <SourceList
                    items={rows.map((one) => ({
                      key: one.name,
                      name: one.name,
                      value: one.value,
                      source: `${one.source} · ${checkedWhen(one.date)}`,
                      trust: one.trust,
                      trustTitle: TRUST_TITLES[one.trust] ?? one.trust,
                    }))}
                  />
                </div>
              );
            })}
          </Digest>

          <Digest
            id="clinic-evidence"
            title="Сверка с реальными внедрениями"
            open={!!open.evidence}
            onToggle={() => toggle("evidence")}
            facts={[{ label: "кейса", value: "4" }]}
            line="Первичные публикации: что робот выполняет, сколько помогает человек и есть ли сокращение бюджета"
          >
            <p>
              <a
                href="https://www.linkedin.com/pulse/celebrating-moxis-10000th-delivery-rochester-general-sm8wc/"
                target="_blank"
                rel="noreferrer"
              >
                Rochester Regional Health, 27.03.2024
              </a>
              : примерно 100 доставок и более 50 часов времени сотрудников в день. Существующие штатные роли не
              заменяли. Это более 30 минут заявленного высвобождения на доставку, методика хронометража не опубликована.
            </p>
            {shift.done > 0 && (
              <p>
                На вашем плане ручной эквивалент одной выполненной доставки:{" "}
                {number((answer.people.manual_delivery_hours_per_shift * 60) / shift.done, 1)} мин; чистое высвобождение
                после помощи: {number((answer.people.delivery_hours_per_shift * 60) / shift.done, 1)} мин. Сходство с
                Rochester не подтверждено: отличаются расстояния, потоки, роботы и длительность работы.
              </p>
            )}
            <p>
              <a href="https://djph.org/wp-content/uploads/2024/12/djph-105-05.pdf" target="_blank" rel="noreferrer">
                Исследование ChristianaCare, 2024
              </a>
              : 89 доставок за 33 часа наблюдений, 107 вмешательств помощника, из них 72 у лифтов. Это число событий
              помощи, а не процент неудачных доставок; длительность помощи в статье не дана.
            </p>
            <p>
              <a
                href="https://www.bartshealth.nhs.uk/news/how-cobots-are-creating-a-cleaner-future-at-barts-health-18557/"
                target="_blank"
                rel="noreferrer"
              >
                Barts Health, 29.04.2026
              </a>
              : время уборки полов сократилось на 25%, время сотрудников перенаправлено на ручные задачи. Наши 25%:
              сценарий по аналогу с другими машинами, а не доказанный коэффициент для выбранного робота.
            </p>
            <p>
              <a
                href="https://www.waybotrobot.ru/waybot-robotics-na-cleaning-focus-club"
                target="_blank"
                rel="noreferrer"
              >
                Пилот Cleanbotics 600 в Москве, 2023-2024
              </a>
              : по сообщению производителя два робота активно работают в НИИ Склифосовского, а в центре Вересаева
              используются редко. Обучение и организация работы влияют на эффект. Подтвержденных сокращений штата и
              денежной экономии публикация не дает.
            </p>
          </Digest>
        </Digests>
      </div>
    </div>
  );
}
