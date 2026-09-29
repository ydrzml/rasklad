import { useMemo, useState } from "react";

import type { Facility, FacilitySolution, FacilitySolutions as Answer, Operation } from "../../api/client";
import {
  ActionExtra,
  Badge,
  BlockHead,
  Button,
  Card,
  Cards,
  Check,
  Drawer,
  Fold,
  Notice,
  SourceList,
  Search,
  Toolbar,
} from "../../ui";
import { money, TRUST_TITLES } from "../format";

type Props = { facility: Facility; tasks: Operation[]; answer: Answer | null };

const STATUS: Record<string, { word: string; tone: "blue" | "grey" }> = {
  recommended: { word: "подходит", tone: "blue" },
  needs_check: { word: "требует проверки", tone: "grey" },
  excluded: { word: "не подходит", tone: "grey" },
};

// Последний шаг пути аэропорта и медучреждения. Расчетной модели у них нет, поэтому здесь нет выбора
// "для расчета": только решения под выбранные задачи, почему каждое подходит, что мешает и откуда
// каждая цифра. Экран прямо говорит, что путь кончается здесь, и почему, а под этим блок "Что дальше"
// из config/facility_types.yaml: что мы делаем для объекта следующим.
export function FacilitySolutions({ facility, tasks, answer }: Props) {
  const [search, setSearch] = useState("");
  const [onlyFits, setOnlyFits] = useState(false);
  const [compared, setCompared] = useState<string[]>([]);

  const all = useMemo(() => answer?.solutions ?? [], [answer]);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return all.filter((item) => {
      if (query && !`${item.product} ${item.vendor} ${item.process}`.toLowerCase().includes(query)) return false;
      return !(onlyFits && item.status === "excluded");
    });
  }, [all, search, onlyFits]);

  const key = (item: FacilitySolution) => `${item.id}-${item.operation}`;
  const toggleCompare = (id: string) =>
    setCompared((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  return (
    <section>
      <Notice title={`Для объекта "${facility.name}" путь заканчивается здесь`} next={facility.next}>
        Плана объекта, прогона смены и экономики по нему нет: полный расчет мы сделали для склада. Здесь решения под
        выбранные задачи, почему каждое подходит, что мешает и откуда каждая цифра. Проверки читают параметры с прошлого
        шага: поправили там, и список пересчитался.
      </Notice>

      <Toolbar>
        <Search value={search} onChange={setSearch} placeholder="Поиск по названию, компании или задаче" />
        <Check label="скрыть неподходящие" checked={onlyFits} onToggle={() => setOnlyFits(!onlyFits)} />
      </Toolbar>

      <CompareBar solutions={all.filter((item) => compared.includes(key(item)))} onDrop={toggleCompare} idOf={key} />

      {answer === null && <p className="muted">Подбираем решения...</p>}

      {tasks.map((task) => {
        const items = visible.filter((item) => item.operation === task.id);
        const counts = Object.entries(STATUS)
          .map(([status, { word }]) => [word, all.filter((i) => i.operation === task.id && i.status === status).length])
          .filter(([, count]) => count)
          .map(([word, count]) => `${word}: ${count}`)
          .join(", ");
        return (
          <div key={task.id}>
            <BlockHead title={`${task.name}: ${items.length}`} note={counts || "решений под эту задачу мы не нашли"} />
            <Cards>
              {items.map((item) => (
                <SolutionCard
                  key={key(item)}
                  item={item}
                  compared={compared.includes(key(item))}
                  onCompare={() => toggleCompare(key(item))}
                />
              ))}
            </Cards>
          </div>
        );
      })}

      {answer && answer.conditions.length > 0 && (
        <Fold title={`Условия объекта словами, по ним решения мы не проверяли: ${answer.conditions.length}`}>
          <SourceList
            items={answer.conditions.map((item) => ({
              key: item.label,
              trust: item.trust,
              trustTitle: TRUST_TITLES[item.trust] ?? item.trust,
              name: item.label,
              source: item.source,
              value: item.value,
            }))}
          />
        </Fold>
      )}
    </section>
  );
}

function SolutionCard({
  item,
  compared,
  onCompare,
}: {
  item: FacilitySolution;
  compared: boolean;
  onCompare: () => void;
}) {
  const fits = item.checks.filter((check) => check.outcome === "fits");
  const unknown = item.checks.filter((check) => check.outcome === "unknown");
  const blocks = item.checks.filter((check) => check.outcome === "blocks");
  const status = STATUS[item.status];

  return (
    <Card
      title={item.product}
      subtitle={[item.vendor, item.from_catalog ? "каталог организатора" : "открытые источники"]
        .filter(Boolean)
        .join(" · ")}
      photo={item.photo_url}
      photoNote={item.from_catalog ? "фото нет: запросим у производителя" : "решение не из каталога, фото не брали"}
      picked={false}
      pickLabel={blocks.length ? `не подходит: ${blocks[0].detail}` : status.word}
      compared={compared}
      onCompare={onCompare}
      badges={
        <>
          <Badge tone={status.tone}>{status.word}</Badge>
          <Badge>{item.availability}</Badge>
        </>
      }
      price={
        <span title={`Источник цены: ${item.price_source}`}>
          {item.price_rub ? money(item.price_rub) : "цену не нашли"}
        </span>
      }
      facts={
        <>
          <span>{item.why}</span>
          {blocks.slice(0, 1).map((check) => (
            <span key={check.label} className="warn">
              мешает: {check.detail}
            </span>
          ))}
          {!blocks.length && unknown.length > 0 && <span className="warn">не проверили: {unknown.length}</span>}
          {!blocks.length && !unknown.length && item.missing.length > 0 && (
            <span className="warn">нет данных: {item.missing.join(", ").toLowerCase()}</span>
          )}
        </>
      }
      details={
        <Fold title="почему подходит и откуда цифры">
          <span className="u-card-facts">
            {fits.map((check) => (
              <span key={check.label}>подходит: {check.detail}</span>
            ))}
            {unknown.map((check) => (
              <span key={check.label} className="warn">
                не проверили: {check.detail}
              </span>
            ))}
            {blocks.map((check) => (
              <span key={check.label} className="warn">
                мешает: {check.detail}
              </span>
            ))}
            <span>ограничения: {item.limits}</span>
            {item.missing.length > 0 && <span>нет ни в одном источнике: {item.missing.join(", ").toLowerCase()}</span>}
            <span>цена: {item.price_source}</span>
          </span>
          <SourceList
            items={item.specs.map((spec) => ({
              key: spec.field,
              trust: spec.trust,
              trustTitle: `${spec.trust_name}. ${spec.note}`,
              // в узкой карточке значение стоит рядом с названием, а не третьей колонкой
              name: `${spec.label}: ${spec.value || "нет данных"}`,
              source: spec.value ? `${spec.sources}, ${day(spec.date)}` : `не нашли, искали ${day(spec.date)}`,
              value: "",
            }))}
          />
        </Fold>
      }
    />
  );
}

// 2026-09-23 -> 23.09.2026
function day(iso: string): string {
  return iso.split("-").reverse().join(".");
}

// Как у склада: отмеченные видны в полосе действия внизу, таблица открывается панелью сбоку.
function CompareBar({
  solutions,
  onDrop,
  idOf,
}: {
  solutions: FacilitySolution[];
  onDrop: (id: string) => void;
  idOf: (item: FacilitySolution) => string;
}) {
  const [open, setOpen] = useState(false);
  if (solutions.length === 0) return null;
  return (
    <>
      <ActionExtra>
        <span className="u-compare-note" title={solutions.map((item) => item.product).join(", ")}>
          В сравнении {solutions.length}
          {solutions.length === 1 && ", отметьте еще одно"}
        </span>
        {solutions.length > 1 && (
          <Button kind="ghost" onClick={() => setOpen(true)}>
            Сравнить
          </Button>
        )}
      </ActionExtra>
      <Drawer
        open={open && solutions.length > 1}
        title={`Сравнение: ${solutions.length}`}
        onClose={() => setOpen(false)}
      >
        <Compare solutions={solutions} onDrop={onDrop} idOf={idOf} />
      </Drawer>
    </>
  );
}

function Compare({
  solutions,
  onDrop,
  idOf,
}: {
  solutions: FacilitySolution[];
  onDrop: (id: string) => void;
  idOf: (item: FacilitySolution) => string;
}) {
  const fields = new Map<string, string>();
  solutions.forEach((item) => item.specs.forEach((spec) => fields.set(spec.field, spec.label)));
  return (
    <table className="compare">
      <thead>
        <tr>
          <th>Характеристика</th>
          {solutions.map((item) => (
            <th key={idOf(item)}>
              {item.product}
              <button className="u-hint" type="button" onClick={() => onDrop(idOf(item))}>
                убрать
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Задача</td>
          {solutions.map((item) => (
            <td key={idOf(item)}>{item.operation_name}</td>
          ))}
        </tr>
        <tr>
          <td>Итог проверок</td>
          {solutions.map((item) => (
            <td key={idOf(item)}>{STATUS[item.status].word}</td>
          ))}
        </tr>
        <tr>
          <td>Цена</td>
          {solutions.map((item) => (
            <td key={idOf(item)}>{item.price_rub ? money(item.price_rub) : "не нашли"}</td>
          ))}
        </tr>
        {[...fields].map(([field, label]) => (
          <tr key={field}>
            <td>{label}</td>
            {solutions.map((item) => {
              const spec = item.specs.find((one) => one.field === field);
              return (
                <td key={idOf(item)}>
                  {spec?.value || "нет данных"}
                  {spec && <span className="trust">{spec.trust}</span>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
