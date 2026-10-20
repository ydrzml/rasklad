import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { Facility } from "../../api/client";
import { Button, Cards, Drawer, EmptyState, Footer, Header, Hero, Search, Select, Waiting } from "../../ui";
import { CatalogCard, SolutionDetails } from "./CatalogCard";
import { loadCatalog } from "./data";
import { CALC_HREF, type Catalog as Data, type Item } from "./items";
import { applyFilters, EMPTY, type Filters, readFilters, SORTS, writeFilters } from "./filters";
import "./catalog.css";

// Каталог роботов для гостя, без входа и только чтение: что есть по каждому объекту, с фото,
// характеристиками, оценкой надежности и источником. Шаблон страницы: список с поиском и фильтрами,
// подробности решения в панели сбоку, чтобы не терять место в списке.

const NO_TYPE = "none";

export function Catalog() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [open, setOpen] = useState<Item | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    loadCatalog(abort.signal)
      .then(setData)
      .catch(() => !abort.signal.aborted && setFailed(true));
    return () => abort.abort();
  }, []);

  useEffect(() => writeFilters(filters), [filters]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const visible = useMemo(() => applyFilters(items, filters), [items, filters]);
  const shown = (data?.facilities ?? []).filter((one) => one.status !== "catalog_only");
  const other = data?.facilities.find((one) => one.status === "catalog_only");
  const change = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <div className="u-page">
      <Header />
      <main className="u-main u-wrap c-page">
        <div className="c-top">
          <Hero
            compact
            title="Каталог роботов"
            lead="Что есть для склада, аэропорта и медучреждения: решения каталога ФЦ БАС и открытых источников. У каждой цифры источник и оценка надежности."
          />
          <Button href={CALC_HREF} arrow>
            Посчитать свой объект
          </Button>
        </div>

        <Objects
          facilities={shown}
          active={filters.facility}
          onPick={(id) => change({ facility: filters.facility === id ? "all" : id, task: "all" })}
        />
        {other && (
          <p className="c-other">
            Еще {other.catalog.count} позиций каталога ФЦ БАС относятся к другим сценариям. Под них мы не разбирали
            решения и не считаем.
          </p>
        )}

        <div className="c-filters" role="search">
          <label className="c-filter c-filter-search">
            <span>Поиск</span>
            <Search
              value={filters.query}
              onChange={(query) => change({ query })}
              placeholder="Название или производитель"
            />
          </label>
          <Filter label="Объект">
            <Select
              label="Объект"
              value={filters.facility}
              onChange={(facility) => change({ facility, task: "all" })}
              options={[{ id: "all", name: "Все объекты" }, ...shown.map((one) => ({ id: one.id, name: one.name }))]}
            />
          </Filter>
          <Filter label="Задача">
            <Select
              label="Задача"
              value={filters.task}
              onChange={(task) => change({ task })}
              options={taskOptions(shown, filters.facility)}
            />
          </Filter>
          <Filter label="Тип робота">
            <Select
              label="Тип робота"
              value={filters.type}
              onChange={(type) => change({ type })}
              options={typeOptions(items)}
            />
          </Filter>
          <Filter label="Порядок">
            <Select label="Порядок" value={filters.sort} onChange={(sort) => change({ sort })} options={SORTS} />
          </Filter>
        </div>

        <section className="c-list" aria-live="polite">
          {!data && !failed && <Waiting title="Загружаем каталог" note="Решения склада, аэропорта и медучреждения" />}
          {failed && (
            <EmptyState
              title="Каталог не загрузился"
              actions={<Button onClick={() => window.location.reload()}>Обновить страницу</Button>}
            >
              Сервер не ответил. Обновите страницу через минуту.
            </EmptyState>
          )}
          {data && (
            <p className="c-count">
              Показано {visible.length} из {items.length}
              {!sameAs(filters, EMPTY) && (
                <button type="button" className="u-textbtn" onClick={() => setFilters(EMPTY)}>
                  сбросить фильтры
                </button>
              )}
            </p>
          )}
          {data && visible.length === 0 && (
            <EmptyState
              title="Под эти фильтры решений нет"
              actions={
                <Button kind="ghost" onClick={() => setFilters(EMPTY)}>
                  Сбросить фильтры
                </Button>
              }
            >
              Уберите часть условий или поищите по другому названию.
            </EmptyState>
          )}
          <Cards>
            {visible.map((item) => (
              <CatalogCard key={item.id} item={item} onOpen={() => setOpen(item)} />
            ))}
          </Cards>
        </section>
      </main>
      <Footer />

      <Drawer open={open !== null} title={open?.product ?? ""} onClose={() => setOpen(null)}>
        {open && <SolutionDetails item={open} />}
      </Drawer>
    </div>
  );
}

// Сколько решений у каждого объекта и что по нему можно сделать: плитка нажимается и оставляет
// в списке только этот объект
function Objects({
  facilities,
  active,
  onPick,
}: {
  facilities: Facility[];
  active: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="c-objects">
      {facilities.map((one) => (
        <button
          key={one.id}
          type="button"
          className={active === one.id ? "c-object is-on" : "c-object"}
          aria-pressed={active === one.id}
          onClick={() => onPick(one.id)}
        >
          <span className="c-object-name">{one.name}</span>
          <span className="c-object-count mono">{one.catalog.count}</span>
          <span className="c-object-unit">{plural(one.catalog.count)}</span>
          <span className={one.status === "ready" || one.id === "clinic" ? "c-object-mode is-full" : "c-object-mode"}>
            {one.status === "ready"
              ? "Подбор и полный расчет"
              : one.id === "clinic"
                ? "Подбор, план, смена и экономика"
                : "Подбор, расчета пока нет"}
          </span>
          <span className="c-object-note">{one.note}</span>
        </button>
      ))}
    </div>
  );
}

// Подпись над полем видна всегда: в выпадающем списке выбранное значение закрывает его название
function Filter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="c-filter">
      <span aria-hidden="true">{label}</span>
      {children}
    </div>
  );
}

function taskOptions(facilities: Facility[], facility: string) {
  const picked = facilities.filter((one) => facility === "all" || one.id === facility);
  return [
    { id: "all", name: "Все задачи" },
    ...picked.flatMap((one) =>
      one.operations.map((task) => ({
        id: `${one.id}:${task.id}`,
        name: task.name,
        group: facility === "all" ? one.name : undefined,
      })),
    ),
  ];
}

function typeOptions(items: Item[]) {
  const types = [...new Set(items.map((item) => item.type).filter(Boolean))].sort();
  const unknown = items.some((item) => !item.type);
  return [
    { id: "all", name: "Любой тип" },
    ...types.map((type) => ({ id: type, name: type })),
    ...(unknown ? [{ id: NO_TYPE, name: "Тип не указан" }] : []),
  ];
}

function sameAs(left: Filters, right: Filters): boolean {
  return (Object.keys(right) as (keyof Filters)[]).every((key) => left[key] === right[key]);
}

function plural(count: number): string {
  const tail = count % 100;
  if (tail > 10 && tail < 20) return "решений";
  if (count % 10 === 1) return "решение";
  if ([2, 3, 4].includes(count % 10)) return "решения";
  return "решений";
}
