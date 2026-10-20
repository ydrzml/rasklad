import { useEffect, useState } from "react";
import {
  api,
  type ClinicFinance,
  type ClinicMoney,
  type ClinicMoneyRequest,
  type ClinicCheck,
  type ClinicFit,
  type ClinicRobots,
  type FacilitySolution,
  type FacilitySolutions,
  type Operation,
} from "../../api/client";
import {
  ActionExtra,
  Alert,
  Badge,
  BlockHead,
  Button,
  Card,
  Cards,
  Drawer,
  ListRow,
  Queue,
  Search,
  SourceList,
  Toolbar,
} from "../../ui";
import { money, mln, number, percent } from "../format";
import { CLINIC_TASKS, UNFIT, selectionProblem, unfitReason } from "./selection";
import { serviceReady } from "./optimization";
import { ClinicPaymentOptions } from "./ClinicPaymentOptions";
import "./clinic.css";

export function ClinicSolutions({
  tasks,
  answer,
  robots,
  choices,
  check,
  fit,
  onPick,
  onUnpick,
  request,
  finance,
  onFinance,
}: {
  tasks: Operation[];
  answer: FacilitySolutions | null;
  robots: ClinicRobots | null;
  choices: Record<string, string>;
  check: ClinicCheck | null;
  fit: ClinicFit | null;
  onPick: (task: string, robot: string) => void;
  onUnpick: (task: string, robot: string) => void;
  request: ClinicMoneyRequest;
  finance: ClinicFinance;
  onFinance: (next: ClinicFinance) => void;
}) {
  const [active, setActive] = useState("");
  const [query, setQuery] = useState("");
  const [compared, setCompared] = useState<string[]>([]);
  const [details, setDetails] = useState<FacilitySolution | null>(null);
  const [comparison, setComparison] = useState(false);
  const modeled = tasks.filter((task) => CLINIC_TASKS.includes(task.id));
  const skipped = tasks.filter((task) => !CLINIC_TASKS.includes(task.id));
  const current = modeled.find((task) => task.id === active) ?? modeled[0];
  const all = answer?.solutions ?? [];
  const items = all.filter(
    (item) =>
      item.operation === current?.id &&
      `${item.product} ${item.vendor}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const available = items.filter((item) => selectionProblem(item, robots, fit) === null);
  const other = items.filter((item) => selectionProblem(item, robots, fit) !== null);
  const keyOf = (item: FacilitySolution) => `${item.operation}:${item.id}`;
  const comparedItems = all.filter((item) => compared.includes(keyOf(item)));
  const [offers, setOffers] = useState<{
    key: string;
    data?: { offers: Record<string, ClinicMoney>; errors: Record<string, string> };
    error?: string;
  } | null>(null);
  const body = {
    ...request,
    operation_ids: current ? [current.id] : [],
    assumptions: finance,
    robot_ids: all
      .filter((one) => one.operation === current?.id && !selectionProblem(one, robots, fit))
      .map((one) => one.id),
  };
  const offerKey = JSON.stringify(body);
  const offerContext = JSON.stringify([request.building, request.overrides, finance]);
  const [archive, setArchive] = useState<Record<string, ClinicMoney>>({});
  useEffect(() => {
    if (!body.robot_ids.length || !request.building) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () =>
        void api
          .clinicOffers(body, controller.signal)
          .then((data) => {
            setOffers({ key: offerKey, data });
            setArchive((old) =>
              Object.fromEntries(
                Object.entries({
                  ...old,
                  ...Object.fromEntries(
                    Object.entries(data.offers).map(([id, offer]) => [`${offerContext}:${current.id}:${id}`, offer]),
                  ),
                }).slice(-40),
              ),
            );
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted)
              setOffers({ key: offerKey, error: error instanceof Error ? error.message : "Расчет недоступен" });
          }),
      350,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerKey]);
  const currentOffers = offers?.key === offerKey ? offers.data : undefined;
  const offerFor = (item: FacilitySolution) =>
    currentOffers?.offers[item.id] ?? archive[`${offerContext}:${item.operation}:${item.id}`];
  const toggleCompare = (item: FacilitySolution) =>
    setCompared((old) =>
      old.includes(keyOf(item)) ? old.filter((key) => key !== keyOf(item)) : [...old, keyOf(item)],
    );
  const cardProps = (item: FacilitySolution) => {
    const problem = selectionProblem(item, robots, fit);
    const picked = choices[item.operation] === item.id;
    const offer = offerFor(item);
    return {
      title: item.product,
      subtitle: item.vendor,
      photo: item.photo_url,
      photoNote: "Фото производителя пока нет",
      picked,
      pickLabel: picked ? "Выбрано" : (problem ?? "Выбрать"),
      onPick: problem ? undefined : () => onPick(item.operation, item.id),
      onUnpick: () => onUnpick(item.operation, item.id),
      compared: compared.includes(keyOf(item)),
      onCompare: () => toggleCompare(item),
      price: item.price_rub ? money(item.price_rub) : "Цену уточняем",
      facts: (
        <>
          <OfferPrices
            offer={offer}
            loan={finance.loan_enabled === 1}
            error={currentOffers?.errors[item.id] || (offers?.key === offerKey ? offers.error : undefined)}
          />
          <span className="u-card-keys">
            {item.specs
              .filter((spec) => ["max_speed_m_s", "throughput", "runtime_h"].includes(spec.field) && spec.value)
              .map((spec) => (
                <span key={spec.field}>
                  {spec.label}: <b>{spec.value}</b>
                </span>
              ))}
          </span>
          <span>{item.why}</span>
          {offer && (
            <span className="u-frow-hint">
              {offer.shift.service.on_time_share == null
                ? "Уборка"
                : `Вовремя ${percent(offer.shift.service.on_time_share)}`}{" "}
              · {serviceReady(offer.shift.service) ? "объем проверен" : "достаточность парка не подтверждена"}.
              Предварительный прогон при исходных условиях.
            </span>
          )}
        </>
      ),
      badges: (
        <Badge tone={problem ? "grey" : "blue"}>
          {problem === UNFIT ? "не подходит" : problem ? "требует проверки" : "можно рассчитать"}
        </Badge>
      ),
      extra: (
        <button type="button" className="u-hint" onClick={() => setDetails(item)}>
          Характеристики и проверки
        </button>
      ),
    };
  };

  return (
    <>
      <ClinicPaymentOptions finance={finance} onChange={onFinance} />
      {modeled.length > 1 && (
        <Queue
          items={modeled.map((task) => ({
            id: task.id,
            name: task.name,
            picked: all.find((item) => item.operation === task.id && item.id === choices[task.id])?.product ?? null,
          }))}
          active={current?.id ?? ""}
          onPick={setActive}
        />
      )}
      <section className="c-solutions">
        {check?.checks
          .filter((one) => one.code.startsWith("cleaning_"))
          .map((one) => (
            <Alert key={`${one.code}:${one.floor}`} tone="note">
              {one.floor} этаж: {one.text}
            </Alert>
          ))}
        <p className="muted">
          Выберите робота для каждой задачи. Проверка корпуса, смена и экономика используют этот выбор. Парк и платежи
          на карточке относятся к этой задаче; общий итог всех выбранных работ: на следующем шаге.
        </p>
        {skipped.length > 0 && (
          <Alert tone="note">
            Пока без расчета: {skipped.map((task) => task.name.toLowerCase()).join(", ")}. Доступны доставка по этажам и
            уборка.
          </Alert>
        )}
        <Toolbar roomy>
          <Search value={query} onChange={setQuery} placeholder="Название робота или производитель" />
        </Toolbar>
        {comparedItems.length > 0 && (
          <ActionExtra>
            <span className="u-compare-note">
              В сравнении {comparedItems.length}
              {comparedItems.length === 1 && ", отметьте еще одно"}
            </span>
            {comparedItems.length > 1 && (
              <Button kind="ghost" onClick={() => setComparison(true)}>
                Сравнить
              </Button>
            )}
          </ActionExtra>
        )}
        {(!answer || !robots) && <p className="muted">Подбираем решения и проверяем характеристики...</p>}
        {current && (
          <BlockHead
            title={current.name}
            note={
              choices[current.id]
                ? `Выбрано: ${all.find((item) => item.id === choices[current.id] && item.operation === current.id)?.product ?? "робот"}`
                : "Выберите решение для расчета"
            }
          />
        )}
        <Cards>
          {available.map((item) => (
            <Card key={keyOf(item)} {...cardProps(item)} />
          ))}
        </Cards>
        {answer && robots && current && !items.length && (
          <Alert tone="note">По этому запросу решений нет. Измените поиск.</Alert>
        )}
        {other.length > 0 && (
          <>
            <BlockHead title="Требуют проверки" note="Причина ограничения указана у каждого решения" />
            {other.map((item) => (
              <ListRow
                key={keyOf(item)}
                {...cardProps(item)}
                why={unfitReason(item, fit) ?? selectionProblem(item, robots, fit)}
              />
            ))}
          </>
        )}
        <Drawer open={details !== null} title={details?.product ?? "Характеристики"} onClose={() => setDetails(null)}>
          {details && (
            <>
              <p>{details.why}</p>
              <p>{details.limits}</p>
              {unfitReason(details, fit) && <p className="warn">На этом корпусе: {unfitReason(details, fit)}</p>}
              {details.checks.map((check, index) => (
                <p key={index} className={check.outcome === "blocks" ? "warn" : ""}>
                  {check.label}: {check.detail}
                </p>
              ))}
              <SourceList
                items={details.specs.map((spec) => ({
                  key: spec.field,
                  name: spec.label,
                  value: spec.value || "нет данных",
                  source: `${spec.sources} · ${spec.date}`,
                  trust: spec.trust,
                  trustTitle: `${spec.trust_name}. ${spec.note}`,
                }))}
              />
              <p className="muted">Цена: {details.price_source}</p>
            </>
          )}
        </Drawer>
        <Drawer
          open={comparison && comparedItems.length > 1}
          title="Сравнение решений"
          onClose={() => setComparison(false)}
        >
          <div className="c-compare">
            <table className="compare">
              <thead>
                <tr>
                  <th>Характеристика</th>
                  {comparedItems.map((item) => (
                    <th key={keyOf(item)}>
                      {item.product}
                      <button type="button" className="u-hint" onClick={() => toggleCompare(item)}>
                        убрать
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["Задача", (one: ClinicMoney) => one.tasks.join(", ")],
                  [
                    "Выполнение задачи",
                    (one: ClinicMoney) =>
                      serviceReady(one.shift.service) ? "Цель достигнута" : "Достаточность парка не подтверждена",
                  ],
                  [
                    "Заявок вовремя",
                    (one: ClinicMoney) =>
                      one.shift.service.on_time_share == null
                        ? "Нет доставки"
                        : percent(one.shift.service.on_time_share),
                  ],
                  [
                    "Покрытие уборки",
                    (one: ClinicMoney) =>
                      one.shift.service.cleaning_coverage == null
                        ? "Нет уборки"
                        : percent(one.shift.service.cleaning_coverage),
                  ],
                  [
                    "Парк на эту задачу, шт.",
                    (one: ClinicMoney) => String(one.fleets.reduce((sum, f) => sum + f.count, 0)),
                  ],
                  [
                    "Покупка: нужно на старте",
                    (one: ClinicMoney) => money(one.scenarios.find((s) => s.id === "purchase")!.start_rub),
                  ],
                  [
                    "Аренда: тариф за месяц",
                    (one: ClinicMoney) => {
                      const s = one.scenarios.find((s) => s.id === "raas")!;
                      return s.available ? money(s.month_rub ?? 0) : "Тариф не опубликован";
                    },
                  ],
                  [
                    "Кредит: нужно на старте",
                    (one: ClinicMoney) => {
                      const s = one.scenarios.find((s) => s.id === "loan")!;
                      return s.available ? money(s.start_rub) : "Не добавлен";
                    },
                  ],
                  ["Высвобождено за год", (one: ClinicMoney) => `${number(one.people.hours_per_year, 0)} ч`],
                ].map(([label, value]) => (
                  <tr key={String(label)}>
                    <td>{String(label)}</td>
                    {comparedItems.map((item) => (
                      <td key={keyOf(item)}>
                        {offerFor(item)
                          ? (value as (one: ClinicMoney) => string)(offerFor(item)!)
                          : "Нет предварительного расчета"}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td>Цена</td>
                  {comparedItems.map((item) => (
                    <td key={keyOf(item)}>{item.price_rub ? money(item.price_rub) : "нет данных"}</td>
                  ))}
                </tr>
                {[
                  ...new Map(
                    comparedItems.flatMap((item) => item.specs.map((spec) => [spec.field, spec.label] as const)),
                  ),
                ].map(([field, label]) => (
                  <tr key={field}>
                    <td>{label}</td>
                    {comparedItems.map((item) => (
                      <td key={keyOf(item)}>
                        {item.specs.find((spec) => spec.field === field)?.value || "нет данных"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Drawer>
      </section>
    </>
  );
}

function OfferPrices({ offer, loan, error }: { offer?: ClinicMoney; loan: boolean; error?: string }) {
  if (!offer) return <span className="u-frow-hint">{error || "Считаем парк и способы оплаты на вашем плане…"}</span>;
  const buy = offer.scenarios.find((s) => s.id === "purchase")!;
  const rent = offer.scenarios.find((s) => s.id === "raas")!;
  const credit = offer.scenarios.find((s) => s.id === "loan");
  return (
    <span className="u-card-ways">
      <span className="u-card-ways-head">
        парк для задачи {offer.fleets.reduce((sum, f) => sum + f.count, 0)} шт., суммы как в источнике цены
      </span>
      <span className="u-card-way is-own">
        <i />
        <span className="u-card-way-name">Свои деньги</span>
        <span className="u-card-way-sum">
          <b className="mono">{mln(buy.start_rub)}</b> млн ₽
        </span>
      </span>
      <span className="u-card-way is-raas">
        <i />
        <span className="u-card-way-name">Аренда</span>
        <span className="u-card-way-sum">
          {rent.available ? (
            <>
              <b className="mono">{mln(rent.month_rub ?? 0)}</b> млн ₽ в месяц
            </>
          ) : (
            "тариф уточняется"
          )}
        </span>
      </span>
      {rent.available && (
        <span className="u-frow-hint">
          {rent.rent_period === "year" ? "Годовой тариф в пересчете на месяц" : "Помесячный тариф"}; на старте{" "}
          {mln(rent.start_rub)} млн ₽
        </span>
      )}
      {loan && credit?.available && (
        <span className="u-card-way is-loan">
          <i />
          <span className="u-card-way-name">Кредит, на старте</span>
          <span className="u-card-way-sum">
            <b className="mono">{mln(credit.start_rub)}</b> млн ₽
          </span>
        </span>
      )}
      {loan && credit?.financing && (
        <span className="u-frow-hint">
          Платежи {number(credit.financing.first_month_rub, 0)} → {number(credit.financing.last_month_rub, 0)} ₽/мес.,{" "}
          {credit.financing.term_months} мес.
        </span>
      )}
    </span>
  );
}
