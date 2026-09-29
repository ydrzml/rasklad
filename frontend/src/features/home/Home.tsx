import { useEffect, useState } from "react";
import { call } from "../../api/http";
import { projects, type ProjectSummary } from "../../api/projects";
import type { components } from "../../api/schema";
import { money, term } from "../../app/format";
import { Badge, BlockHead, CatalogStack, Header, Trust } from "../../ui";
import { Pallet07 } from "../../ui/robots";
import { HeatFloor } from "../landing/HeatFloor";
import "../landing/landing.css";
import "../landing-a/landing-a.css";
import "./home.css";
import { PlanSketch, type SketchPlan } from "./PlanSketch";

// Главная вошедшего пользователя. Слева кнопка нового расчета и последний проект с главными числами,
// справа план склада из этого проекта с роботами. Ниже что нового в каталоге роботов, карточками с фото.
// Плана нет, если нет сохраненного проекта: заглушку вошедшему не показываем.

type News = components["schemas"]["CatalogNews"];

const KIND: Record<News["kind"], string> = { new: "новое", spec: "характеристика", price: "цена", task: "в подборе" };
const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
const open = (project: ProjectSummary) => `/calc?project=${project.id}&open=1`;
const saved = (project: ProjectSummary) => new Date(project.updated_at).toLocaleDateString("ru-RU");

export function Home() {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [plan, setPlan] = useState<SketchPlan | null>(null);
  const [news, setNews] = useState<News[] | null>(null);
  const last = list?.[0];

  useEffect(() => {
    projects
      .list()
      .then(setList)
      .catch(() => setList([]));
    call<News[]>("/api/catalog/news")
      .then(setNews)
      .catch(() => setNews([]));
  }, []);

  useEffect(() => {
    if (!last) return;
    projects
      .get(last.id)
      .then((project) => setPlan((project.current?.state as { plan?: SketchPlan } | undefined)?.plan ?? null))
      .catch(() => setPlan(null));
  }, [last]);
  const own = last && plan?.items?.length ? last : null;

  return (
    <div className="l-page la-page">
      <HeatFloor still />
      <div data-floor-busy>
        <Header />
      </div>
      <main className="l-wrap h-scene">
        <section className={own ? "la-hero h-studio" : "la-hero h-studio is-alone"}>
          <div className="h-studio-left" data-floor-busy>
            <h1>
              Продолжим расчет <span>вашего склада</span>
            </h1>
            <p className="la-lead">
              Продолжите последний проект или посчитайте новый склад: план, роботы, смена и окупаемость.
            </p>
            <a className="u-btn u-btn-primary la-go" href="/calc?new=1">
              Новый расчет
              <span className="u-knob">→</span>
            </a>
            {last && <LastProject project={last} />}
          </div>
          {own && plan && (
            <figure className="la-scene h-stretch" data-floor-busy>
              <div className="la-sheet">
                <figcaption className="l-sheet-top">
                  <span className="l-label">ваш план</span>
                  <span className="l-label h-sheet-name">{own.name}</span>
                </figcaption>
                <PlanSketch plan={plan} title={`План склада: ${own.name}`} />
              </div>
              <Pallet07 className="la-07" />
            </figure>
          )}
        </section>

        {news && news.length > 0 && (
          <section className="h-scene-news" data-floor-busy>
            <BlockHead
              title="Новое в каталоге роботов"
              aside={
                <a className="u-btn u-btn-link" href="/method">
                  Как мы считаем
                </a>
              }
            />
            <div className="h-cards">
              {latest(news).map((item) => (
                <article key={`${item.at}${item.title}${item.kind}`} className="h-news-card">
                  <div className="u-card-photo">
                    {item.photo_url ? (
                      <img src={item.photo_url} alt="" loading="lazy" />
                    ) : item.solution_id ? (
                      "фото нет"
                    ) : (
                      <CatalogStack />
                    )}
                  </div>
                  <span className="h-news-meta">
                    <Badge tone={item.kind === "new" ? "blue" : "grey"}>{KIND[item.kind]}</Badge>
                    <span className="mono h-date">{day.format(new Date(item.at))}</span>
                  </span>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </section>
        )}

        <HowWeCount />
      </main>
    </div>
  );
}

function LastProject({ project }: { project: ProjectSummary }) {
  return (
    <div className="h-last">
      <span className="l-label">последний проект · {saved(project)}</span>
      <b className="h-last-name">{project.name}</b>
      <span className="h-last-figures">
        <span>
          <i>роботов</i>
          <b className="mono">{project.figures?.fleet ?? "—"}</b>
        </span>
        <span>
          <i>окупаемость</i>
          <b className="mono">{term(project.figures?.payback_years)}</b>
        </span>
        <span>
          <i>стоимость владения</i>
          <b className="mono">{money(project.figures?.tco_rub)}</b>
        </span>
      </span>
      <span className="h-last-go">
        <a className="u-btn u-btn-ghost" href={open(project)}>
          Продолжить
        </a>
        <a className="u-btn u-btn-link" href="/projects">
          Все проекты
        </a>
      </span>
    </div>
  );
}

/* Как мы считаем: коротко из лендинга, подробности на странице методики. Компактно, под новостями */
const TRUST: [string, string][] = [
  ["S", "эталон"],
  ["A", "проверено"],
  ["B", "подтверждено"],
  ["C", "один источник"],
  ["D", "слабо"],
  ["E", "спорно"],
  ["F", "нет данных"],
];

function HowWeCount() {
  return (
    <section className="h-how" data-floor-busy>
      <BlockHead
        title="Как мы считаем"
        aside={
          <a className="u-btn u-btn-link" href="/method">
            Вся методика
          </a>
        }
      />
      <div className="h-how-grid">
        <a className="h-how-tile" href="/method#path">
          <span className="l-label">пять шагов</span>
          <ol className="h-steps mono">
            <li>объект</li>
            <li>параметры</li>
            <li>план</li>
            <li>решение</li>
            <li>экономика</li>
          </ol>
        </a>
        <a className="h-how-tile is-wide" href="/method#trust">
          <span className="l-label">оценка доверия у каждой цифры</span>
          <span className="h-trust-row">
            {TRUST.map(([level, name]) => (
              <span key={level}>
                <Trust level={level} title={name} />
                <i>{name}</i>
              </span>
            ))}
          </span>
        </a>
        <a className="h-how-tile" href="/method#fleet">
          <span className="l-label">парк роботов</span>
          <b>Прогон смены на вашем плане</b>
          <span className="h-faint">формула стоит рядом проверкой</span>
        </a>
        <a className="h-how-tile" href="/method#scenarios">
          <span className="l-label">экономика</span>
          <b>Три сценария за 5 лет</b>
          <span className="h-faint">без роботов, покупка, аренда</span>
        </a>
        <a className="h-how-tile" href="/method#trust">
          <span className="l-label">откуда данные</span>
          <b>Каталог ФЦ БАС и сайты производителей</b>
          <span className="h-faint">у значения ссылка, цитата и дата</span>
        </a>
      </div>
    </section>
  );
}

/* Одна карточка на решение, свежая: две правки одного робота подряд читаются как повтор. Строка из четырех */
function latest(news: News[]): News[] {
  const seen = new Set<string>();
  return news.filter((item) => !seen.has(item.title) && seen.add(item.title)).slice(0, 4);
}
