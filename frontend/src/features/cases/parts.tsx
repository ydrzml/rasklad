import type { ReactNode } from "react";

import type { CalculationResult, Parameter, ScenarioResult } from "../../api/client";
import { number } from "../../app/format";
import { plural } from "../../app/steps/economicsNames";
import { AccountLinks, AccountMenu, Arrow, Button, Header } from "../../ui";
import { Pallet07 } from "../../ui/robots";
import type { CaseLink } from "./demoCases";

export type Brief = {
  fleet: number;
  chargers: number;
  purchase: ScenarioResult;
  raas: ScenarioResult;
  baseline: ScenarioResult;
};

// Главные числа разбора из ответа сервера. Без любого из трех сценариев разбор не показываем
export function briefOf(result: CalculationResult): Brief | null {
  const find = (id: string) => (result.scenarios ?? []).find((one) => one.id === id);
  const purchase = find("purchase");
  const raas = find("raas");
  const baseline = find("baseline");
  if (!result.feasible || !result.sizing || !purchase || !raas || !baseline) return null;
  return { fleet: result.sizing.fleet, chargers: result.sizing.chargers, purchase, raas, baseline };
}

export function chargersText(count: number): string {
  return `и ${count} ${plural(count, "зарядка", "зарядки", "зарядок")}`;
}

// Значение из датасета так, как его видит человек: доли процентами, метры квадратными
export function valueText(field: Parameter): string {
  const value = field.value ?? 0;
  if (field.unit === "доля") return `${number(value * 100, 0)}%`;
  if (field.unit === "смен") return `${number(value)} ${plural(value, "смена", "смены", "смен")}`;
  const unit = (field.unit ?? "").replace("м2", "м²");
  return unit ? `${number(value)} ${unit}` : number(value);
}

/* Исходные значения разбора: только посмотреть. Поле ввода тут обмануло бы, будто можно поменять.
   Значения кейса приходят правками запроса (overrides), остальное по датасету */
export function Given({
  parameters,
  paths,
  overrides = {},
}: {
  parameters: Parameter[];
  paths: string[];
  overrides?: Record<string, number>;
}) {
  const shown = paths
    .map((path) => parameters.find((field) => field.path === path))
    .filter((field): field is Parameter => field !== undefined)
    .map((field) => (field.path in overrides ? { ...field, value: overrides[field.path] } : field));
  if (!shown.length) return null;
  return (
    <dl className="k-given">
      {shown.map((field) => (
        <div key={field.path}>
          <dt>{field.label}</dt>
          <dd className="mono">{valueText(field)}</dd>
        </div>
      ))}
    </dl>
  );
}

/* Шапка как на лендинге: те же пункты, разборы для гостя продолжают его */
export function CasesHeader() {
  return (
    <Header
      nav={
        <>
          <a className="u-wide-only" href="/#how">
            Как это работает
          </a>
          <a className="u-wide-only" href="/#sources">
            Методика расчета
          </a>
          <AccountLinks />
          <AccountMenu />
        </>
      }
    />
  );
}

/* Источники сверки списком, как "Откуда цифры": что за материал, где опубликован, ссылка наружу */
export function Sources({ links }: { links: CaseLink[] }) {
  return (
    <ul className="k-sources">
      {links.map((link) => (
        <li key={link.href}>
          <a href={link.href} target="_blank" rel="noopener noreferrer">
            <span className="k-sources-name">
              {link.title}
              <small>{link.site}</small>
            </span>
            <span className="k-sources-go" aria-hidden="true">
              <Arrow size={13} />
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/* Внизу каждой страницы разборов: свой объект считается в мастере, без входа. Полоса на всю
   ширину колонки, 07 стоит на ней целиком и везет свои коробки к кнопке */
export function OwnObject({ extra }: { extra?: ReactNode }) {
  return (
    <section className="k-own" aria-labelledby="k-own-title">
      <div className="k-own-text">
        <h2 id="k-own-title">Хотите посчитать свой объект?</h2>
        <p>
          Тот же расчет на ваших цифрах: площадь, объем, смены и ваш план склада. Без регистрации: значения уже стоят,
          поправить их можно на любом шаге.
        </p>
        <div className="k-own-actions">
          <Button arrow href="/calc">
            Посчитать свой объект
          </Button>
          {extra}
        </div>
      </div>
      <div className="k-own-robot" aria-hidden="true">
        <Pallet07 idle />
        <span className="k-own-route" />
      </div>
    </section>
  );
}
