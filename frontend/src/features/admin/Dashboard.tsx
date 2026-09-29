import { call } from "../../api/http";
import type { components } from "../../api/schema";
import { useEffect, useState } from "react";
import { catalog, updates, type Change, type Updates } from "../../api/admin";
import { norms, type NormChange } from "../../api/norms";
import { BlockHead, Header, Panel } from "../../ui";
import { Picker12 } from "../../ui/robots";
import { DayBars } from "./DayBars";
import "../landing/landing.css";
import "../landing-a/landing-a.css";
import "../home/home.css";

// Главная администратора: что ждет решения, сколько всего в сервисе, последние правки каталога
// и нормативов, быстрые ссылки. Слева белый блок, справа лист дел той же высоты, на листе 12.

type Stats = components["schemas"]["Stats"];

type Data = {
  total: number;
  toCheck: number;
  updates: Updates | null;
  changes: Change[];
  normChanges: NormChange[];
  stats: Stats | null;
};

const when = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });

export function Dashboard() {
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    Promise.all([
      catalog.list({
        search: "",
        kind: "",
        status: "",
        origin: "",
        with_specs: false,
        facility: "",
        to_check: false,
        incomplete: false,
        sort: "name",
        limit: 1,
      }),
      updates.get().catch(() => null),
      catalog.changes(5),
      norms.changes(3).catch(() => []),
      call<Stats>("/api/admin/stats").catch(() => null),
    ]).then(([page, checks, changes, normChanges, stats]) =>
      setData({ total: page.total, toCheck: page.facets.to_check ?? 0, updates: checks, changes, normChanges, stats }),
    );
  }, []);

  const proposals = data?.updates?.items.filter((i) => i.outcome === "differs" && i.status === "new").length ?? 0;
  const manual = data?.updates?.items.filter((i) => i.outcome === "manual" || i.outcome === "blocked").length ?? 0;

  const todo = [
    {
      title: "Подтвердить объекты и задачи",
      note: "решения из выгрузки, которым правило предложило задачу",
      count: data?.toCheck,
      href: "/admin?to_check=1",
    },
    {
      title: "Правки с сайтов производителей",
      note: "принять с оценкой или отклонить, все в журнал",
      count: proposals,
      href: "/admin",
    },
    { title: "Проверить руками", note: "PDF, переделанные страницы, закрытые сайты", count: manual, href: "/admin" },
  ];

  const days = data?.stats?.days ?? [];
  const series = (key: "saves" | "users" | "edits") => days.map((d) => ({ day: d.day, value: d[key] }));

  const hero = (
    <section className="la-hero h-studio">
      <div className="h-studio-left h-white">
        <h1>Администрирование</h1>
        <p className="la-lead">Что ждет вашего решения, что поменялось и сколько людей считает.</p>
        <a className="u-btn u-btn-primary la-go" href="/admin?to_check=1">
          Разобрать проверки
          <span className="u-knob">→</span>
        </a>
        <div className="h-last is-flat">
          <span className="l-label">сейчас в сервисе</span>
          <span className="h-last-figures h-four">
            <span>
              <i>решений в каталоге</i>
              <b className="mono">{data ? data.total : "…"}</b>
            </span>
            <span>
              <i>ждут подтверждения</i>
              <b className="mono">{data ? data.toCheck : "…"}</b>
            </span>
            <span>
              <i>пользователей</i>
              <b className="mono">{data?.stats?.users ?? "…"}</b>
            </span>
            <span>
              <i>проектов</i>
              <b className="mono">{data?.stats?.projects ?? "…"}</b>
            </span>
          </span>
          <span className="h-faint">
            сохранений расчетов <span className="mono">{data?.stats?.versions ?? "…"}</span>
          </span>
        </div>
      </div>
      <figure className="la-scene h-stretch h-peek">
        {/* лист дел: не чертеж, поэтому в темной теме темнеет вместе со страницей (h-sheet, а не la-sheet) */}
        <div className="h-sheet">
          <figcaption className="l-sheet-top">
            <span className="l-label">ждет вашего решения</span>
            <span className="l-label">{cases(todo.reduce((sum, t) => sum + (t.count ?? 0), 0))}</span>
          </figcaption>
          <ul className="h-list h-todo">
            {todo.map((item) => (
              <li key={item.title}>
                <a className="h-list-main h-todo-link" href={item.href}>
                  <b>{item.title}</b>
                  <span className="h-faint">{item.note}</span>
                </a>
                <span className="mono h-count">{item.count ?? "…"}</span>
              </li>
            ))}
          </ul>
          {/* 12 стоит на листе в правом нижнем углу и разглядывает список: на любой ширине внутри листа */}
          <Picker12 className="h-12" />
        </div>
      </figure>
    </section>
  );
  const charts = (
    <Panel>
      <div className="h-chart-row" data-floor-busy>
        <DayBars title="Сохранения расчетов" days={series("saves")} unit="сохр." />
        <DayBars title="Новые пользователи" days={series("users")} unit="чел." />
        <DayBars title="Правки каталога" days={series("edits")} unit="правок" />
      </div>
    </Panel>
  );
  const journal = (
    <section data-floor-busy>
      <BlockHead
        title="Последние изменения"
        aside={
          <a className="u-btn u-btn-link" href="/api/db">
            Весь журнал
          </a>
        }
      />
      <Panel>
        <ul className="h-news">
          {[
            ...(data?.changes ?? []).map((c) => ({
              id: `c${c.id}`,
              at: c.at,
              who: c.user_email,
              what: c.note || ACTIONS[c.action] || c.action,
              name: c.solution_name,
            })),
            ...(data?.normChanges ?? []).map((c) => ({
              id: `n${c.id}`,
              at: c.at,
              who: c.user_email,
              what: `норматив: ${c.note || c.action}`,
              name: c.name,
            })),
          ]
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 6)
            .map((row) => (
              <li key={row.id}>
                <span className="mono h-date">{when.format(new Date(row.at))}</span>
                <span>
                  <b>{row.name || "каталог"}</b>
                  <span className="h-text">
                    {row.what} · {row.who || "система"}
                  </span>
                </span>
              </li>
            ))}
        </ul>
      </Panel>
    </section>
  );
  // каталог и служебные таблицы уже стоят в шапке админа, здесь только то, чего там нет
  const links = (
    <>
      <a className="u-btn u-btn-ghost" href="/admin?tab=norms">
        Нормативы
      </a>
      <a className="u-btn u-btn-ghost" href="/api/admin/catalog/export">
        Скачать каталог
      </a>
      <a className="u-btn u-btn-ghost" href="/home">
        Главная пользователя
      </a>
    </>
  );

  return (
    <div className="l-page la-page">
      <div data-floor-busy>
        <Header />
      </div>
      {/* первый экран, под ним ссылки узкой полосой, графики и журнал */}
      <main className="l-wrap h-scene">
        {hero}
        <nav className="h-strip-links" aria-label="Разделы админки">
          {links}
        </nav>
        {charts}
        {journal}
      </main>
    </div>
  );
}

function cases(count: number): string {
  const word =
    count % 10 === 1 && count % 100 !== 11
      ? "дело"
      : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)
        ? "дела"
        : "дел";
  return `${count} ${word}`;
}

/* Журнал правок словами, как в каталоге админки: коды действий человеку ничего не говорят */
const ACTIONS: Record<string, string> = {
  create: "добавлено решение",
  update: "поправлены поля",
  delete: "удалено решение",
  spec_add: "добавлена характеристика",
  spec_edit: "поправлена характеристика",
  spec_delete: "удалена характеристика",
  use_set: "поправлены объект и задача",
  photo_set: "загружено фото",
  file_edit: "наши колонки из загруженного файла",
};
