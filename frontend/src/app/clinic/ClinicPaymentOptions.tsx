import type { ClinicFinance } from "../../api/client";
import { FieldRow } from "../../ui";
import { FINANCE_FIELDS } from "./finance";
import "../steps/payways.css";

const defaults = { loan_enabled: 0, loan_rate: 0.2, loan_months: 36, loan_own_share: 0.2, loan_insurance_share: 0.01 };

export function ClinicPaymentOptions({
  finance,
  onChange,
}: {
  finance: ClinicFinance;
  onChange: (next: ClinicFinance) => void;
}) {
  const loan = finance.loan_enabled === 1;
  return (
    <section className="u-panel u-money-block" aria-label="Способы оплаты медицинских роботов">
      <div className="u-money-block-head">
        <h2>Как хотите получить роботов</h2>
        <p>Покупку и доступную аренду сравниваем рядом. Кредит можно добавить отдельно.</p>
      </div>
      <div className="u-money-block-row">
        <div className="u-ways is-two">
          <div className="u-way is-on is-own">
            <span className="u-way-text">
              <b>Покупка</b>
              <span>Роботы ваши; парк и внедрение на старте</span>
            </span>
          </div>
          <div className="u-way is-on is-raas">
            <span className="u-way-text">
              <b>Аренда</b>
              <span>Тариф поставщика; аванс и сервис учитываются отдельно</span>
            </span>
          </div>
        </div>
      </div>
      <div className="u-money-buy">
        <label className="u-money-credit">
          <input type="checkbox" checked={loan} onChange={() => onChange({ ...finance, loan_enabled: loan ? 0 : 1 })} />
          Своих денег нет или не хватает: добавить кредит
        </label>
      </div>
      {loan && <LoanFields finance={finance} onChange={onChange} />}
    </section>
  );
}

/* Условия кредита: шаг решений и итог (под переключателем, когда выбрана покупка в кредит) */
export function LoanFields({ finance, onChange }: { finance: ClinicFinance; onChange: (next: ClinicFinance) => void }) {
  return (
    <div className="c-loan-fields">
      <p className="muted">
        Условия ниже: допущения F, не банковское предложение. Кредит снижает аванс, но добавляет проценты и страховку;
        окупаемость считается с непогашенным долгом.
      </p>
      {FINANCE_FIELDS.filter((f) => f.id.startsWith("loan_") && f.id !== "loan_enabled").map((f) => (
        <FieldRow
          key={f.id}
          label={f.label}
          unit={f.unit}
          value={(finance[f.id] ?? defaults[f.id as keyof typeof defaults]) * f.scale}
          hint={f.hint}
          trust="F"
          onChange={(v) => {
            const next = { ...finance };
            if (v === "") delete next[f.id];
            else next[f.id] = Number(v) / f.scale;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}
