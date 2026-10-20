import { useState } from "react";

import { money } from "../../app/format";
import { Badge, Button, SourceList } from "../../ui";
import { CALC_HREF, type Item, type Use } from "./items";

// Главные цифры на карточке, остальные в панели подробностей
const KEY_FIELDS = ["payload_kg", "max_speed_m_s", "runtime_h", "throughput", "min_aisle_width_mm"];
const KEYS_ON_CARD = 3;

// Карточка решения в том же виде, что на шаге 4 (классы u-card из набора), но для чтения:
// вместо выбора и сравнения подробности и переход к расчету
export function CatalogCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  const keys = KEY_FIELDS.flatMap((field) => item.facts.filter((fact) => fact.field === field && fact.value)).slice(
    0,
    KEYS_ON_CARD,
  );
  return (
    <article className="u-card c-card">
      <span className="u-card-photo u-grid-bg">
        {item.photo && !broken ? (
          <img src={item.photo} alt={item.product} loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span>фото нет</span>
        )}
      </span>
      <h3>{item.product}</h3>
      <span className="u-card-sub">{[item.vendor, origin(item)].filter(Boolean).join(" · ")}</span>
      <span className="u-card-badges">
        {facilityNames(item.uses).map((name) => (
          <Badge key={name} tone="blue">
            {name}
          </Badge>
        ))}
        {item.maturity && <Badge>{item.maturity}</Badge>}
        {item.tested && <Badge>проверено ФЦ БАС</Badge>}
      </span>
      <span className="u-card-price">{item.price ? money(item.price) : "Цена: нет данных"}</span>
      {keys.length > 0 && (
        <span className="u-card-keys">
          {keys.map((fact) => (
            <span key={fact.field} className="c-key">
              <span className="u-card-key-name">{fact.label}</span> <b className="mono">{fact.value}</b>
              <span className="u-trust" title={`${fact.trust}: ${fact.trustTitle}`}>
                {fact.trust}
              </span>
            </span>
          ))}
        </span>
      )}
      <span className="u-card-facts">
        <span>Задачи: {taskNames(item.uses)}</span>
      </span>
      <span className="c-card-act">
        <Button kind="ghost" onClick={onOpen}>
          Подробнее
        </Button>
        <a className="c-calc" href={CALC_HREF}>
          Посчитать свой объект
        </a>
      </span>
    </article>
  );
}

// Все про одно решение: где применяется, почему взяли, что мешает, каждая цифра с источником
export function SolutionDetails({ item }: { item: Item }) {
  const [broken, setBroken] = useState(false);
  const byFacility = groupUses(item.uses);
  return (
    <div className="c-details">
      {item.photo && !broken && (
        <span className="c-details-photo u-grid-bg">
          <img src={item.photo} alt={item.product} onError={() => setBroken(true)} />
        </span>
      )}
      <p className="c-details-sub">
        {[item.vendor, item.type || "тип не указан", origin(item)].filter(Boolean).join(" · ")}
      </p>

      <h3>Где подходит</h3>
      <ul className="c-uses">
        {byFacility.map(([name, tasks]) => (
          <li key={name}>
            <b>{name}:</b>
            <span>{tasks.join(", ")}</span>
          </li>
        ))}
      </ul>

      {item.why.length > 0 && (
        <>
          <h3>Почему это решение</h3>
          {item.why.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </>
      )}
      {item.limits.length > 0 && (
        <>
          <h3>Что мешает и чего не хватает</h3>
          {item.limits.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </>
      )}

      <h3>Цена</h3>
      <p>
        {item.price ? money(item.price) : "Нет данных"}
        {item.priceSource && <small className="c-source"> {item.priceSource}</small>}
      </p>

      <h3>Характеристики и откуда цифры</h3>
      {item.facts.length ? (
        <SourceList
          items={item.facts.map((fact) => ({
            key: fact.field,
            trust: fact.trust,
            trustTitle: fact.trustTitle,
            name: `${fact.label}: ${fact.value || "нет данных"}`,
            source: fact.source,
            value: "",
          }))}
        />
      ) : (
        <p>Характеристик в каталоге нет.</p>
      )}
      <p className="c-legend">
        Буква это оценка надежности: S закон или норматив, A проверено независимо, B сходятся два источника, C один
        источник, D только каталог ФЦ БАС или СМИ, E источники расходятся, F данных нет.
      </p>

      <Button href={CALC_HREF} arrow>
        Посчитать свой объект
      </Button>
    </div>
  );
}

function origin(item: Item): string {
  return item.fromCatalog ? "каталог ФЦ БАС" : "открытые источники";
}

function facilityNames(uses: Use[]): string[] {
  return [...new Set(uses.map((use) => use.facilityName))];
}

function groupUses(uses: Use[]): [string, string[]][] {
  return facilityNames(uses).map((name) => [
    name,
    [...new Set(uses.filter((use) => use.facilityName === name).map((use) => lower(use.taskName)))],
  ]);
}

function taskNames(uses: Use[]): string {
  return [...new Set(uses.map((use) => lower(use.taskName)))].join(", ");
}

function lower(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}
