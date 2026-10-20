import type { ClinicMoney, ClinicQuotes as Quotes } from "../../api/client";
import { FieldRow } from "../../ui";
import { QUOTE_FIELDS } from "./customer";

export function ClinicQuotes({
  fleets,
  value,
  onChange,
}: {
  fleets: ClinicMoney["fleets"];
  value: Quotes;
  onChange: (value: Quotes) => void;
}) {
  return (
    <div className="c-customer">
      {fleets.map((fleet) => (
        <details key={fleet.robot_id}>
          <summary>Предложение поставщика: {fleet.name}</summary>
          <p className="muted">
            Цены на одну машину. Пустое поле использует каталог или допущение, ноль означает явно указанную нулевую
            стоимость. Условия сохраняются для этой модели; при выборе другой не переносятся.
          </p>
          <label className="u-own-field">
            <span>Источник, дата и состав предложения</span>
            <span className="u-field-box">
              <input
                value={value[fleet.robot_id]?.source ?? ""}
                maxLength={1000}
                placeholder="КП №…, дата, НДС и что включено"
                onChange={(e) =>
                  onChange({ ...value, [fleet.robot_id]: { ...value[fleet.robot_id], source: e.target.value } })
                }
              />
            </span>
          </label>
          <div className="c-process-fields">
            {QUOTE_FIELDS.map(([key, label]) => (
              <FieldRow
                key={key}
                label={label}
                unit=""
                value={value[fleet.robot_id]?.[key] ?? ""}
                hint={
                  key === "price_rub"
                    ? `Используется в расчете: ${fleet.price_rub.toLocaleString("ru-RU")} ₽. Измените при наличии КП.`
                    : key === "life_years"
                      ? "От 1 до 30 лет; замена включается в расчет после этого срока."
                      : "Не дублируйте сервис и внедрение в других статьях."
                }
                onChange={(text) => {
                  const quote = { ...value[fleet.robot_id] };
                  if (text === "") delete quote[key];
                  else quote[key] = Number(text);
                  onChange({ ...value, [fleet.robot_id]: quote });
                }}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
