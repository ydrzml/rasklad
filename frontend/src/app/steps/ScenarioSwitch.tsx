import "./scenarioSwitch.css";

export type Shown = "baseline" | "purchase" | "raas";
export type BuyWay = "own" | "loan" | "leasing";

const WAYS: { id: BuyWay; name: string }[] = [
  { id: "own", name: "Свои деньги" },
  { id: "loan", name: "Кредит" },
  { id: "leasing", name: "Лизинг" },
];

/* Один переключатель шага 5: по какому сценарию все блоки ниже. Покупка разбита на способы оплаты,
   кредит и лизинг выбираются здесь же. Полоса липнет к верху экрана, пока листаешь шаг: видно, что
   выбрано и что можно переключить. Без onWay (расчет по ссылке) способ оплаты не меняется.
   locked: способы, которых у объекта нет, с причиной (у медучреждения нет лизинга) */
export function ScenarioSwitch({
  shown,
  way,
  onShow,
  onWay,
  locked = {},
}: {
  shown: Shown;
  way: BuyWay;
  onShow: (id: Shown) => void;
  onWay?: (way: BuyWay) => void;
  locked?: Partial<Record<BuyWay, string>>;
}) {
  const option = (id: Exclude<Shown, "purchase">, tone: string, name: string) => (
    <button
      type="button"
      aria-pressed={shown === id}
      className={`u-switch-opt is-${tone}${shown === id ? " is-on" : ""}`}
      onClick={() => onShow(id)}
    >
      <i aria-hidden="true" />
      {name}
    </button>
  );
  return (
    <div className="u-switch" role="group" aria-label="По какому сценарию показать все ниже">
      <span className="u-switch-label">Ниже показано</span>
      {option("baseline", "now", "Без роботов")}
      <span className={`u-switch-group${shown === "purchase" ? " is-on" : ""}`} role="group" aria-label="Покупка">
        <span className="u-switch-name">
          <i aria-hidden="true" />
          Покупка
        </span>
        {WAYS.map((one) => {
          const reason =
            locked[one.id] ?? (!onWay && one.id !== way ? "В расчете по ссылке способ оплаты не меняется" : null);
          return (
            <button
              key={one.id}
              type="button"
              aria-pressed={shown === "purchase" && way === one.id}
              aria-label={`Покупка, ${one.name.toLowerCase()}`}
              className={`u-switch-way${way === one.id ? " is-current" : ""}${shown === "purchase" && way === one.id ? " is-on" : ""}`}
              disabled={reason !== null}
              title={reason ?? undefined}
              onClick={() => {
                onShow("purchase");
                if (one.id !== way) onWay?.(one.id);
              }}
            >
              {one.name}
            </button>
          );
        })}
      </span>
      {option("raas", "rent", "Аренда")}
    </div>
  );
}
