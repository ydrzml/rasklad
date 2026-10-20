import type { SensitivityAll } from "../../api/client";
import { TRUST_TITLES, mln, term } from "../../app/format";
import { BlockHead, Panel, Tornado, Trust } from "../../ui";
import { type Source, dateText, groupSources, topImpacts, trustCounts, valueText, zeroUnknowns } from "./data";

// Допущения примера с источником, датой и оценкой, что сильнее всего двигает выгоду и чего в расчете нет.
// Значения и источники из ответа сервера (те же, что в "Откуда цифры" на шаге экономики)

const IMPACT_ROWS = 8;

export function Assumptions({ sources, own }: { sources: Source[]; own: Source[] }) {
  const groups = groupSources(sources);
  // счетчики по самому расчету примера, без условий кредита и лизинга: так же, как на шаге экономики
  const counts = trustCounts(own);
  const weak = own.filter((one) => one.trust === "E" || one.trust === "F").length;
  return (
    <section id="assumptions" className="e-section">
      <BlockHead
        title="Допущения"
        note={`главные числа экономики примера. Всего в расчете ${own.length} значений, ${weak} из них с оценкой E или F`}
      />
      <ul className="e-trust" aria-label="Что значат буквы оценки">
        {counts.map((one) => (
          <li key={one.level}>
            <Trust level={one.level} title={TRUST_TITLES[one.level]} />
            <span>{TRUST_TITLES[one.level]}</span>
            <span className="mono e-trust-count">{one.count}</span>
          </li>
        ))}
      </ul>
      <div className="e-groups">
        {groups.map((group) => (
          <Panel key={group.id}>
            <div className="e-group">
              <h3>
                {group.title}
                <span>{group.note}</span>
              </h3>
              <ul className="e-assume">
                {group.items.map((item) => (
                  <li key={item.path}>
                    <Trust level={item.trust} title={TRUST_TITLES[item.trust] ?? item.trust} />
                    <span className="e-assume-name">
                      {item.name}
                      <small title={item.source}>
                        {item.source}. Дата: {dateText(item.date)}
                      </small>
                    </span>
                    <span className="e-assume-value mono">{valueText(item)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        ))}
      </div>
    </section>
  );
}

export function Impacts({ sensitivity }: { sensitivity: SensitivityAll | null }) {
  if (!sensitivity) {
    return (
      <section id="impact" className="e-section">
        <BlockHead title="Что сильнее всего двигает итог" />
        <p className="e-text">Чувствительность для примера не посчиталась: сервер не ответил.</p>
      </section>
    );
  }
  const { base, rows } = topImpacts(sensitivity, "purchase", IMPACT_ROWS);
  const years = sensitivity.horizon_years;
  const staffFirst = rows[0]?.key.includes(".staff.") ?? false;
  return (
    <section id="impact" className="e-section">
      <BlockHead
        title="Что сильнее всего двигает итог"
        note={`каждое число по одному на -20% и +20%, сверху самые сильные из ${sensitivity.params.length}`}
      />
      <Panel>
        <div className="e-body">
          <Tornado
            rows={rows.map((row) => ({
              key: row.key,
              name: row.name,
              note: `сейчас ${row.base}`,
              low: row.low,
              high: row.high,
              lowLabel: "-20",
              highLabel: "+20",
              min: row.min,
              max: row.max,
              size: `${mln(row.swing)} млн ₽`,
            }))}
            base={base}
            color="var(--sc-buy)"
            heads={{
              left: "выгода меньше",
              center: `покупка сейчас: ${mln(base)} млн ₽ за ${term(years)}`,
              right: "больше",
              size: "размах",
            }}
          />
          <p className="e-text">
            Длина полосы это насколько меняется выгода покупки за {term(years)}, если одно число окажется на 20% меньше
            или больше. Сейчас сильнее всего двигает итог: {rows[0]?.name.toLowerCase()}.
            {staffFirst &&
              " Людей в штате и их оклады вы вводите сами на шаге параметров, от них итог зависит больше всего."}{" "}
            Ставку дисконтирования и горизонт так не двигаем: это правила счета, а не данные объекта.
          </p>
        </div>
      </Panel>
    </section>
  );
}

// Чего нет в модели совсем, по docs/calculation.md, раздел 14, и docs/documentation.md, раздел 6.5
const OUTSIDE = [
  "Налог на прибыль и НДС ни в одном сценарии. Цены каталога с НДС. Если добавлять, то во все сценарии одинаково.",
  "Остаточную стоимость роботов в конце горизонта расчета. Без нее покупка выглядит осторожнее, чем на деле.",
  "Выходные пособия и другие разовые затраты при сокращении.",
  "Экономию на ошибках и травмах: пока нечем подтвердить.",
  "Выгоду через выручку, когда людей не сокращают, а объем растет.",
  "Помесячный поток: годы целиком. Выход на режим учтен только в первом году.",
  "Оплату аренды за операцию: только фиксированная плата в месяц.",
];

export function Limits({ sources }: { sources: Source[] }) {
  const zeros = zeroUnknowns(sources);
  return (
    <section id="limits" className="e-section">
      <BlockHead title="Что не учтено" note='"нет в расчете" и "нет данных" это разные вещи' />
      <div className="e-limits">
        <Panel>
          <div className="e-group">
            <h3>
              Нет в расчете
              <span>модель это не считает ни в одном сценарии</span>
            </h3>
            <ul className="e-plain">
              {OUTSIDE.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </Panel>
        <Panel>
          <div className="e-group">
            <h3>
              Есть в расчете, но данных нет
              <span>до уточнения стоит ноль, это не значит "бесплатно"</span>
            </h3>
            <ul className="e-assume">
              {zeros.map((item) => (
                <li key={item.path}>
                  <Trust level={item.trust} title={TRUST_TITLES[item.trust] ?? item.trust} />
                  <span className="e-assume-name">
                    {item.name}
                    <small title={item.source}>{item.source}</small>
                  </span>
                  <span className="e-assume-value mono">{valueText(item)}</span>
                </li>
              ))}
            </ul>
            <p className="e-text">
              Остальные числа без источника стоят не нулем, а нашим допущением с оценкой F: интеграция, инфраструктура,
              пусконаладка, тариф на электроэнергию, выход на режим. Они в списке допущений выше и в блоке "Откуда
              цифры" на шаге экономики.
            </p>
          </div>
        </Panel>
      </div>
    </section>
  );
}
