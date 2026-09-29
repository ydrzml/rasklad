import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import {
  catalog,
  type Change,
  type FieldInfo,
  type ImportResult,
  type ListQuery,
  type OperationInfo,
  type PhotoMeta,
  type SolutionCard,
  type SolutionRow,
  type SolutionCreate,
  type SolutionUpdate,
  type Spec,
  type SpecUpdate,
  type UseInfo,
} from "../../api/admin";
import { ApiError } from "../../api/http";
import { account, type Me } from "../../api/projects";
import {
  AccountLinks,
  AccountMenu,
  Alert,
  Badge,
  BlockHead,
  Button,
  Check,
  EmptyState,
  Header,
  Hero,
  Notice,
  Pill,
  Search,
  Select,
  Suggest,
  Sheet,
  SheetRow,
  Toolbar,
  Waiting,
  type Choice,
} from "../../ui";
import { Keeper03 } from "../../ui/robots";
import { NormsPanel } from "./Norms";
import { CatalogTree } from "./Tree";
import { UpdatesPanel } from "./Updates";
import "./admin.css";

// Админка: каталог решений. Список с поиском и фильтрами, загрузка выгрузки организатора,
// карточка решения с полями, характеристиками (значение, источник, дата, оценка) и историей правок.
// Каждая правка уходит на сервер отдельным запросом и попадает в журнал. Пользователи и журнал
// целиком живут в служебных таблицах на /api/db.

const KINDS: Choice[] = [
  { id: "", name: "не указан" },
  { id: "brs", name: "робот" },
  { id: "bas", name: "беспилотник" },
  { id: "software", name: "программа" },
];
const STATUSES: Choice[] = [
  { id: "", name: "не указан" },
  { id: "operation", name: "в эксплуатации" },
  { id: "piloting", name: "пилот" },
  { id: "rnd", name: "разработка" },
];
const RATINGS = ["S", "A", "B", "C", "D", "E", "F"];
const RATING_NAMES: Record<string, string> = {
  S: "эталон: закон, ТЗ или все источники сходятся",
  A: "проверено: производитель и независимая проверка",
  B: "подтверждено: сходятся два типа источников",
  C: "один источник",
  D: "слабо: косвенный источник",
  E: "спорно: источники расходятся",
  F: "нет данных",
};
const ACTIONS: Record<string, string> = {
  seed: "первый запуск",
  import: "загрузка выгрузки",
  create: "добавлено",
  update: "поправлено",
  reset: "возвращено значение организатора",
  delete: "удалено",
  spec_add: "добавлена характеристика",
  spec_edit: "поправлена характеристика",
  spec_delete: "удалена характеристика",
  photo_set: "загружено фото",
  photo_edit: "поправлен источник фото",
  photo_delete: "удалено фото",
  photo_seed: "фото из папки данных",
  uses_seed: "объекты и операции из папки данных",
  use_set: "поправлены объект и операция",
  updates_check: "проверка страниц производителей",
  file_edit: "наши колонки из загруженного файла",
  update_accept: "принято обновление с сайта производителя",
  update_reject: "отклонено обновление с сайта производителя",
};
const USE_STATUS: Record<string, string> = {
  confirmed: "подтверждено",
  suggested: "предложено",
  rejected: "отклонено",
};
const LABELS: Record<string, string> = {
  name: "название",
  company: "компания",
  kind: "тип",
  status: "статус",
  description: "описание",
  type: "тип решения",
  subtype: "подтип",
  process: "процесс склада",
  price_rub: "цена",
  trl: "УГТ",
  region: "регион",
  industry: "отрасль",
  tested_fcbas: "протестировано ФЦ БАС",
  registry_719: "реестр 719",
};
const PAGE = 50;

const FACILITY_FILTERS: [string, string][] = [
  ["", "Все объекты"],
  ["warehouse", "Склад"],
  ["airport", "Аэропорт"],
  ["clinic", "Медучреждение"],
  ["none", "Не привязано"],
];

const nameOf = (choices: Choice[], id: string) => choices.find((c) => c.id === id)?.name ?? id;
const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const when = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

function problem(error: unknown): string {
  return error instanceof Error ? error.message : "Что-то пошло не так, попробуйте еще раз";
}

type Access = { state: "loading" } | { state: "guest" } | { state: "user"; me: Me } | { state: "admin"; me: Me };

type Tab = "catalog" | "norms";
const TABS: { id: Tab; name: string; title: string; lead: string }[] = [
  {
    id: "catalog",
    name: "Каталог решений",
    title: "Каталог решений",
    lead: "Решения, из которых идет подбор. У каждой характеристики источник, дата и оценка доверия, каждая правка попадает в журнал.",
  },
  {
    id: "norms",
    name: "Нормативы",
    title: "Нормативы",
    lead: "Взносы, рабочие часы, резервы, цены и значения по умолчанию, по которым считается экономика. У каждого источник, дата и оценка, каждая правка попадает в журнал.",
  },
];

function tabFromAddress(): Tab {
  return new URLSearchParams(window.location.search).get("tab") === "norms" ? "norms" : "catalog";
}

export function Admin() {
  const [access, setAccess] = useState<Access>({ state: "loading" });
  // Раздел помним в адресе: ссылку на нормативы можно отправить, и после обновления страницы он тот же
  const [tab, setTab] = useState<Tab>(tabFromAddress);
  const current = TABS.find((item) => item.id === tab) ?? TABS[0];

  function open(next: Tab) {
    setTab(next);
    window.history.replaceState(null, "", next === "catalog" ? "/admin" : `/admin?tab=${next}`);
  }

  useEffect(() => {
    account
      .me()
      .then((me) =>
        setAccess(
          me.role === "admin"
            ? { state: "admin", me }
            : me.role === "user"
              ? { state: "user", me }
              : { state: "guest" },
        ),
      )
      .catch(() => setAccess({ state: "guest" }));
  }, []);

  return (
    <div className="u-page">
      <Header
        nav={
          <>
            <AccountLinks />
            <AccountMenu />
          </>
        }
      />
      <main className="u-main u-wrap">
        <Hero compact title={current.title} lead={current.lead} />
        {access.state === "loading" && <Waiting title="Проверяем, кто вошел" />}
        {access.state === "guest" && (
          <EmptyState
            apart
            title="Админка открывается после входа"
            robot={<Keeper03 />}
            actions={
              <a className="u-btn u-btn-dark" href="/login">
                Войти
              </a>
            }
          >
            Каталог правит администратор. Для проверки есть демо-аккаунт администратора, пароль не нужен.
          </EmptyState>
        )}
        {access.state === "user" && (
          <EmptyState
            apart
            title="Сюда только администратору"
            robot={<Keeper03 />}
            actions={
              <a className="u-btn u-btn-dark" href="/projects">
                В мои проекты
              </a>
            }
          >
            Вы вошли как {access.me.email}. Каталог правит администратор, а подборку решений вы увидите в расчете.
          </EmptyState>
        )}
        {access.state === "admin" && (
          <>
            <Toolbar>
              {TABS.map((item) => (
                <Pill key={item.id} active={tab === item.id} onClick={() => open(item.id)}>
                  {item.name}
                </Pill>
              ))}
            </Toolbar>
            {tab === "catalog" ? <Catalog /> : <NormsPanel />}
          </>
        )}
      </main>
    </div>
  );
}

function Catalog() {
  const [query, setQuery] = useState<ListQuery>({
    search: "",
    kind: "",
    status: "",
    origin: "",
    with_specs: false,
    facility: "",
    to_check: false,
    incomplete: false,
    sort: "name",
    limit: PAGE,
  });
  const [typed, setTyped] = useState("");
  const [items, setItems] = useState<SolutionRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "import" | "create" | "updates">("none");
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldInfo[]>([]);
  const [operations, setOperations] = useState<OperationInfo[]>([]);
  const [recent, setRecent] = useState<Change[]>([]);
  // На телефоне фильтры прячутся под кнопку, иначе занимают весь первый экран
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setView] = useState<"list" | "tree">("list");
  const active = [
    query.kind,
    query.status,
    query.origin,
    query.with_specs,
    query.facility,
    query.to_check,
    query.incomplete,
  ].filter(Boolean).length;

  const load = useCallback(async () => {
    try {
      const page = await catalog.list(query);
      setItems(page.items);
      setTotal(page.total);
      setFacets(page.facets);
      setError(null);
      setRecent(await catalog.changes(8));
    } catch (reason) {
      setError(problem(reason));
    }
  }, [query]);

  useEffect(() => {
    // Список грузится с сервера при каждом изменении фильтров
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    catalog
      .fields()
      .then(setFields)
      .catch(() => setFields([]));
    catalog
      .operations()
      .then(setOperations)
      .catch(() => setOperations([]));
  }, []);

  // Поиск уходит на сервер, когда перестали печатать
  useEffect(() => {
    const timer = window.setTimeout(
      () => setQuery((q) => (q.search === typed ? q : { ...q, search: typed, limit: PAGE })),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [typed]);

  const set = (patch: Partial<ListQuery>) => setQuery((q) => ({ ...q, ...patch, limit: PAGE }));

  async function changed(message: string | null, nextOpen?: string | null) {
    setNotice(message);
    if (nextOpen !== undefined) setOpenId(nextOpen);
    await load();
  }

  return (
    <section>
      <BlockHead
        title="Решения"
        note={items ? `${total} ${query.search || active ? "найдено" : "в каталоге"}` : undefined}
        aside={
          <span className="a-row">
            <Button kind="ghost" onClick={() => setPanel(panel === "updates" ? "none" : "updates")}>
              Проверить обновления
            </Button>
            <a className="u-btn u-btn-ghost" href={catalog.exportUrl} download>
              Скачать каталог
            </a>
            <Button kind="ghost" onClick={() => setPanel(panel === "import" ? "none" : "import")}>
              Загрузить выгрузку
            </Button>
            <Button arrow onClick={() => setPanel(panel === "create" ? "none" : "create")}>
              Добавить решение
            </Button>
          </span>
        }
      />

      {panel === "import" && (
        <ImportPanel
          onDone={(message) => {
            changed(message);
          }}
          onClose={() => setPanel("none")}
        />
      )}
      {panel === "updates" && (
        <UpdatesPanel onChanged={(message) => changed(message)} onClose={() => setPanel("none")} />
      )}
      {panel === "create" && (
        <CreatePanel
          onCreated={(card) => {
            setPanel("none");
            changed(`Решение «${card.name}» добавлено, заполните характеристики`, card.id);
          }}
          onClose={() => setPanel("none")}
        />
      )}

      <Toolbar>
        <Pill active={view === "list"} onClick={() => setView("list")}>
          Списком
        </Pill>
        <Pill active={view === "tree"} onClick={() => setView("tree")}>
          Деревом
        </Pill>
      </Toolbar>
      {view === "tree" && (
        <CatalogTree
          onOpen={(id, name) => {
            setView("list");
            setTyped(name);
            setOpenId(id);
          }}
        />
      )}
      {view === "list" && (
        <>
          <Toolbar>
            <Search value={typed} onChange={setTyped} placeholder="Название или компания" />
            <span className="a-filter-toggle">
              <Pill active={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
                Фильтры{active > 0 && <span className="a-count">{active}</span>}
              </Pill>
            </span>
            <div className={`a-filters${filtersOpen ? " is-open" : ""}`}>
              {[
                ["", "Все"],
                ["brs", "Роботы"],
                ["bas", "Беспилотники"],
                ["software", "Программы"],
              ].map(([id, name]) => (
                <Pill key={id} active={query.kind === id} onClick={() => set({ kind: id })}>
                  {name}
                </Pill>
              ))}
              <Select
                label="Статус"
                value={query.status}
                onChange={(status) => set({ status })}
                options={[{ id: "", name: "любой статус" }, ...STATUSES.slice(1)]}
              />
              <Select
                label="Откуда"
                value={query.origin}
                onChange={(origin) => set({ origin })}
                options={[
                  { id: "", name: "из выгрузки и наши" },
                  { id: "organizer", name: "из выгрузки организатора" },
                  { id: "team", name: "добавила команда" },
                ]}
              />
              <Select
                label="Порядок"
                value={query.sort}
                onChange={(sort) => set({ sort })}
                options={[
                  { id: "name", name: "по названию" },
                  { id: "updated", name: "свежие правки сверху" },
                  { id: "price", name: "дорогие сверху" },
                ]}
              />
              <Check
                label="с характеристиками"
                checked={query.with_specs}
                onToggle={() => set({ with_specs: !query.with_specs })}
              />
            </div>
          </Toolbar>
          <div className={`a-filters${filtersOpen ? " is-open" : ""}`}>
            <Toolbar>
              {FACILITY_FILTERS.map(([id, name]) => (
                <Pill key={id} active={query.facility === id} onClick={() => set({ facility: id })}>
                  {name}
                  {id && facets[id] !== undefined && <span className="a-count">{facets[id]}</span>}
                </Pill>
              ))}
              <Check
                label={`ждут проверки${facets.to_check ? ` (${facets.to_check})` : ""}`}
                checked={query.to_check}
                onToggle={() => set({ to_check: !query.to_check })}
              />
              <Check
                label={`неполные${facets.incomplete ? ` (${facets.incomplete})` : ""}`}
                checked={query.incomplete}
                onToggle={() => set({ incomplete: !query.incomplete })}
              />
            </Toolbar>
          </div>

          {notice && (
            <p className="a-said" role="status">
              <Alert tone="note">{notice}</Alert>
            </p>
          )}
          {error && <Notice title="Не получилось загрузить каталог">{error}</Notice>}
          {!items && !error && <Waiting title="Загружаем каталог" />}
          {items && items.length === 0 && (
            <Notice title="Ничего не нашлось">Поменяйте фильтры или поищите часть названия.</Notice>
          )}

          {items && items.length > 0 && (
            <Sheet
              columns={[
                { name: "", width: "76px" },
                { name: "Решение" },
                { name: "Вид", width: "150px" },
                {
                  name: "Где и что делает",
                  width: "230px",
                  hint: "Подтвержденные объекты и задачи: с ними решение идет в подбор",
                },
                { name: "Статус", width: "130px" },
                { name: "Цена", width: "120px" },
                {
                  name: "Заполнено",
                  width: "110px",
                  hint: "Сколько характеристик заполнено из тех, что нужны решению для его операций",
                },
                { name: "", width: "110px" },
              ]}
            >
              {items.map((row) => {
                const open = openId === row.id;
                return (
                  <SheetRow
                    key={row.id}
                    cells={[
                      <Thumb url={row.photo_url} name={row.name} />,
                      <button className="a-name" aria-expanded={open} onClick={() => setOpenId(open ? null : row.id)}>
                        <b>{row.name}</b>
                        <span>
                          {row.company || "компания не указана"}
                          {row.origin === "team" && " · добавила команда"}
                          {row.manual_fields.length > 0 && ` · правки вручную: ${row.manual_fields.length}`}
                        </span>
                      </button>,
                      <span>
                        {nameOf(KINDS, row.kind)}
                        {row.subtype && <span className="a-faint"> · {row.subtype}</span>}
                      </span>,
                      <span>
                        {row.tasks.length > 0
                          ? row.tasks.join(", ")
                          : !row.to_check && <span className="a-faint">не привязано</span>}
                        {row.to_check > 0 && (
                          <>
                            {row.tasks.length > 0 && " "}
                            <Badge>проверить {row.to_check}</Badge>
                          </>
                        )}
                      </span>,
                      row.status ? (
                        <Badge tone={row.status === "operation" ? "blue" : "grey"}>
                          {nameOf(STATUSES, row.status)}
                        </Badge>
                      ) : (
                        ""
                      ),
                      <span className="mono">{row.price_rub ? `${money.format(Number(row.price_rub))} ₽` : "—"}</span>,
                      row.needs_total ? (
                        <span className={row.needs_filled < row.needs_total ? "mono a-short" : "mono"}>
                          {row.needs_filled} из {row.needs_total}
                        </span>
                      ) : (
                        <span className="a-faint">не нужно</span>
                      ),
                      <Button kind="link" onClick={() => setOpenId(open ? null : row.id)}>
                        {open ? "Свернуть" : "Открыть"}
                      </Button>,
                    ]}
                    notes={
                      open ? (
                        <Editor id={row.id} fields={fields} operations={operations} onChanged={changed} />
                      ) : undefined
                    }
                  />
                );
              })}
            </Sheet>
          )}
          {items && items.length < total && (
            <div className="a-more">
              <Button kind="ghost" onClick={() => setQuery((q) => ({ ...q, limit: q.limit + PAGE }))}>
                Показать еще {Math.min(PAGE, total - items.length)} из {total - items.length}
              </Button>
            </div>
          )}
        </>
      )}

      {recent.length > 0 && (
        <div className="a-recent">
          <BlockHead title="Последние правки" note="весь журнал в служебных таблицах" />
          <History changes={recent} withName />
        </div>
      )}
    </section>
  );
}

function ImportPanel({ onDone, onClose }: { onDone: (message: string) => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const report = await catalog.importFile(file, dryRun);
      setResult(report);
      if (!dryRun) onDone(`Выгрузка загружена. ${report.note}`);
    } catch (reason) {
      setError(problem(reason));
    } finally {
      setBusy(false);
    }
  }

  function pick(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setResult(null);
    setError(null);
  }

  return (
    <div className="a-plate">
      <h3>Загрузить выгрузку каталога</h3>
      <p className="a-faint">
        Файл CSV в UTF-8 с разделителем ";": выгрузка организатора catalog_export как есть или наш файл из кнопки
        "Скачать каталог", дополненный в Excel. Сначала можно только проверить: в базу ничего не запишется. В выгрузке
        организатора характеристик нет, их загрузка не трогает; в нашем файле пустая ячейка ничего не меняет,
        заполненная пишется в карточку и журнал. Объекты и задачи из нашего списка подтверждаются сразу, остальные
        решения получают предложения по сценарию, их подтверждает администратор.
      </p>
      <div className="a-row">
        <label className="u-btn u-btn-ghost a-file">
          <input type="file" accept=".csv" onChange={pick} disabled={busy} />
          {file ? file.name : "Выбрать файл"}
        </label>
        <Button kind="ghost" onClick={() => run(true)} disabled={!file || busy}>
          Только проверить
        </Button>
        <Button onClick={() => run(false)} disabled={!file || busy}>
          Загрузить в каталог
        </Button>
        <span className="a-gap" />
        <Button kind="link" onClick={onClose}>
          Закрыть
        </Button>
      </div>
      {busy && <Waiting title="Проверяем строки" />}
      {error && <Alert>{error}</Alert>}
      {result && (
        <div className="a-report">
          <p>
            <b>{result.dry_run ? "Проверка без записи." : "Загружено."}</b> Строк в файле{" "}
            <span className="mono">{result.rows}</span>: добавится <span className="mono">{result.added}</span>,
            обновится <span className="mono">{result.updated}</span>, без изменений{" "}
            <span className="mono">{result.unchanged}</span>, склеено дублей{" "}
            <span className="mono">{result.merged}</span>, с ошибками{" "}
            <span className="mono">{result.errors.length}</span>.
          </p>
          {result.kept > 0 && (
            <Alert tone="note">
              Ручные правки есть в <span className="mono">{result.kept}</span>{" "}
              {result.kept % 10 === 1 && result.kept % 100 !== 11 ? "решении" : "решениях"}: загрузка их не трогает, они
              помечены «вручную» в карточках.
            </Alert>
          )}
          {result.errors.slice(0, 20).map((problem) => (
            <Alert key={problem.row}>
              Строка {problem.row}: {problem.message}
            </Alert>
          ))}
          {result.errors.length > 20 && <p className="a-faint">и еще {result.errors.length - 20}</p>}
        </div>
      )}
    </div>
  );
}

function CreatePanel({ onCreated, onClose }: { onCreated: (card: SolutionCard) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [kind, setKind] = useState("brs");
  const [industry, setIndustry] = useState("");
  const [error, setError] = useState<string | null>(null);
  // отрасли, которые уже есть в каталоге: из них выбирают, новую можно вписать
  const [industries, setIndustries] = useState<string[]>([]);
  useEffect(() => {
    catalog
      .list({
        search: "",
        kind: "",
        status: "",
        origin: "",
        with_specs: false,
        facility: "",
        to_check: false,
        incomplete: false,
        sort: "name",
        limit: 300,
      })
      .then((page) =>
        setIndustries(
          [...new Set(page.items.map((item) => item.industry.trim()).filter(Boolean))].sort((a, b) =>
            a.localeCompare(b, "ru"),
          ),
        ),
      )
      .catch(() => setIndustries([]));
  }, []);

  async function create() {
    try {
      onCreated(await catalog.create({ name: name.trim(), company, kind: kind as SolutionCreate["kind"], industry }));
    } catch (reason) {
      setError(problem(reason));
    }
  }

  return (
    <div className="a-plate">
      <h3>Новое решение</h3>
      <p className="a-faint">
        Например, решение для медучреждения, которого нет в выгрузке организатора. Характеристики с источниками добавите
        в карточке после создания.
      </p>
      <div className="a-form">
        <Field label="Название">
          <input className="a-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Компания">
          <input className="a-input" value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label="Вид">
          <Select label="Вид" value={kind} onChange={setKind} options={KINDS.slice(1)} />
        </Field>
        <Field label="Отрасль">
          <Suggest
            id="new-industry"
            value={industry}
            onChange={setIndustry}
            options={industries}
            placeholder="выберите или впишите"
          />
        </Field>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="a-row">
        <Button onClick={create} disabled={!name.trim()}>
          Добавить
        </Button>
        <Button kind="link" onClick={onClose}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  wide,
  mark,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  mark?: ReactNode;
}) {
  return (
    <label className={wide ? "a-field is-wide" : "a-field"}>
      <span className="a-field-top">
        {label}
        {mark}
      </span>
      {children}
    </label>
  );
}

type Draft = Required<{ [K in keyof SolutionUpdate]: NonNullable<SolutionUpdate[K]> | "" }>;

function draftOf(card: SolutionCard): Draft {
  return {
    name: card.name,
    company: card.company,
    kind: card.kind as Draft["kind"],
    status: card.status as Draft["status"],
    description: card.description,
    type: card.type,
    subtype: card.subtype,
    scenario: card.scenario,
    cases: card.cases,
    trl: card.trl ?? "",
    market_potential: card.market_potential,
    region: card.region,
    industry: card.industry,
    price_rub: card.price_rub ?? "",
    process: card.process,
    tested_fcbas: card.tested_fcbas,
    registry_719: card.registry_719,
  };
}

function Editor({
  id,
  fields,
  operations,
  onChanged,
}: {
  id: string;
  fields: FieldInfo[];
  operations: OperationInfo[];
  onChanged: (message: string | null, nextOpen?: string | null) => Promise<void>;
}) {
  const [card, setCard] = useState<SolutionCard | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    catalog
      .get(id)
      .then((loaded) => {
        setCard(loaded);
        setDraft(draftOf(loaded));
      })
      .catch((reason) => setError(problem(reason)));
  }, [id]);

  const dirty = useMemo(() => {
    if (!card || !draft) return {};
    const base = draftOf(card);
    const out: Partial<SolutionUpdate> = {};
    for (const key of Object.keys(draft) as (keyof Draft)[]) {
      // Цену сравниваем числом: «2850000» и «2850000.00» это одна и та же цена
      const same =
        key === "price_rub"
          ? Number(draft[key] || NaN) === Number(base[key] || NaN) || draft[key] === base[key]
          : String(draft[key]) === String(base[key]);
      if (!same) {
        const value = draft[key];
        (out as Record<string, unknown>)[key] =
          key === "trl"
            ? value === ""
              ? null
              : Number(value)
            : key === "price_rub"
              ? value === ""
                ? null
                : String(value)
              : value;
      }
    }
    return out;
  }, [card, draft]);

  if (!card || !draft) return error ? <Alert>{error}</Alert> : <Waiting title="Открываем решение" />;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const changedCount = Object.keys(dirty).length;

  async function act(action: () => Promise<SolutionCard | void>, message: string, nextOpen?: string | null) {
    setBusy(true);
    setError(null);
    try {
      const updated = await action();
      if (updated) {
        setCard(updated);
        setDraft(draftOf(updated));
      }
      await onChanged(message, nextOpen);
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 409 ? reason.message : problem(reason));
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    const sure = window.confirm(
      `Удалить «${card!.name}» вместе с ${card!.specs.length} характеристиками? В журнале останется запись, но вернуть решение придется вручную.`,
    );
    if (sure) act(() => catalog.remove(id), `Решение «${card!.name}» удалено`, null);
  }

  const missing = fields.filter((f) => !card.specs.some((s) => s.field === f.id));

  // Поле организатора, поправленное руками: метка, значение организатора при наведении и возврат к нему
  const mark = (key: string) => {
    if (!card.manual_fields.includes(key)) return undefined;
    const known = key in card.organizer_values;
    const theirs = show(card.organizer_values[key]);
    return (
      <span className="a-manual">
        <span title={known ? `У организатора: ${theirs}` : "Выгрузку организатора еще не загружали"}>
          <Badge tone="blue">вручную</Badge>
        </span>
        {known && (
          <button
            type="button"
            className="a-reset"
            title={`Вернуть как у организатора: ${theirs}`}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              act(() => catalog.reset(id, key), `«${LABELS[key] ?? key}» вернули к значению организатора`);
            }}
          >
            вернуть
          </button>
        )}
      </span>
    );
  };

  return (
    <div className="a-editor">
      <PhotoBlock
        card={card}
        busy={busy}
        onUpload={(file, meta) => act(() => catalog.putPhoto(id, file, meta), "Фото загружено")}
        onMeta={(meta) => act(() => catalog.updatePhoto(id, meta), "Источник фото сохранен")}
        onRemove={() => {
          if (window.confirm("Удалить фото? В журнале останется запись, откуда оно было.")) {
            act(() => catalog.removePhoto(id), "Фото удалено");
          }
        }}
      />
      <div className="a-form">
        <Field label="Название" mark={mark("name")}>
          <input className="a-input" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Компания" mark={mark("company")}>
          <input className="a-input" value={draft.company} onChange={(e) => set({ company: e.target.value })} />
        </Field>
        <Field label="Вид" mark={mark("kind")}>
          <Select
            label="Вид"
            value={draft.kind}
            onChange={(kind) => set({ kind: kind as Draft["kind"] })}
            options={KINDS}
          />
        </Field>
        <Field label="Статус" mark={mark("status")}>
          <Select
            label="Статус"
            value={draft.status}
            onChange={(status) => set({ status: status as Draft["status"] })}
            options={STATUSES}
          />
        </Field>
        <Field label="Тип решения" mark={mark("type")}>
          <input className="a-input" value={draft.type} onChange={(e) => set({ type: e.target.value })} />
        </Field>
        <Field label="Подтип" mark={mark("subtype")}>
          <input className="a-input" value={draft.subtype} onChange={(e) => set({ subtype: e.target.value })} />
        </Field>
        <Field label="Процесс склада">
          <input className="a-input" value={draft.process} onChange={(e) => set({ process: e.target.value })} />
        </Field>
        <Field label="Цена, ₽" mark={mark("price_rub")}>
          <input
            className="a-input mono"
            type="number"
            min="0"
            value={draft.price_rub}
            onChange={(e) => set({ price_rub: e.target.value })}
          />
        </Field>
        <Field label="УГТ, 1–9" mark={mark("trl")}>
          <input
            className="a-input mono"
            type="number"
            min="1"
            max="9"
            value={draft.trl}
            onChange={(e) => set({ trl: e.target.value === "" ? "" : Number(e.target.value) })}
          />
        </Field>
        <Field label="Регион" mark={mark("region")}>
          <input className="a-input" value={draft.region} onChange={(e) => set({ region: e.target.value })} />
        </Field>
        <Field label="Отрасль" wide mark={mark("industry")}>
          <input className="a-input" value={draft.industry} onChange={(e) => set({ industry: e.target.value })} />
        </Field>
        <Field label="Описание" wide mark={mark("description")}>
          <textarea
            className="a-input"
            rows={3}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        <span className="a-checks">
          <Check
            label="протестировано ФЦ БАС"
            checked={Boolean(draft.tested_fcbas)}
            onToggle={() => set({ tested_fcbas: !draft.tested_fcbas })}
          />
          <Check
            label="в реестре 719"
            checked={Boolean(draft.registry_719)}
            onToggle={() => set({ registry_719: !draft.registry_719 })}
          />
        </span>
      </div>

      <div className="a-row">
        <Button
          onClick={() => act(() => catalog.update(id, dirty), `Решение «${draft.name}» сохранено`)}
          disabled={busy || !changedCount}
        >
          {changedCount ? `Сохранить ${changedCount === 1 ? "правку" : `правки (${changedCount})`}` : "Правок нет"}
        </Button>
        {changedCount > 0 && (
          <Button kind="link" onClick={() => setDraft(draftOf(card))}>
            Вернуть как было
          </Button>
        )}
        <span className="a-gap" />
        <Button kind="link" onClick={remove} disabled={busy}>
          Удалить решение
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}

      <h3 className="a-sub">Где работает и что делает</h3>
      <Uses
        card={card}
        operations={operations}
        busy={busy}
        onSet={(use, status, message) => act(() => catalog.setUse(id, use.facility, use.operation, status), message)}
      />

      <h3 className="a-sub">Характеристики</h3>
      {card.missing.length > 0 && (
        <p className="a-short">
          Для операций решения не хватает:{" "}
          {card.missing.map((f) => fields.find((x) => x.id === f)?.label ?? f).join(", ")}
        </p>
      )}
      <Sheet
        columns={[
          { name: "Характеристика", width: "190px" },
          { name: "Значение" },
          { name: "Ед.", width: "110px" },
          { name: "Оценка", width: "70px", hint: "S, A–F: насколько можно верить значению. Расшифровка при наведении" },
          { name: "Источник" },
          { name: "Найдено", width: "150px" },
          { name: "", width: "130px" },
        ]}
      >
        {card.specs.map((spec) => (
          <SpecRow
            key={`${spec.id}-${spec.value}-${spec.rating}-${spec.source}-${spec.retrieved}-${spec.unit}`}
            spec={spec}
            busy={busy}
            onSave={(body) => act(() => catalog.updateSpec(id, spec.id, body), `«${spec.label}» сохранено`)}
            onRemove={() => {
              if (window.confirm(`Удалить характеристику «${spec.label}»?`)) {
                act(() => catalog.removeSpec(id, spec.id), `«${spec.label}» удалено`);
              }
            }}
          />
        ))}
      </Sheet>
      {card.specs.length === 0 && <p className="a-faint">Характеристик пока нет.</p>}
      {missing.length > 0 && (
        <div className="a-row a-add">
          <span className="a-faint">Добавить:</span>
          {missing.map((f) => (
            <Button
              key={f.id}
              kind="ghost"
              disabled={busy}
              onClick={() =>
                act(
                  () => catalog.addSpec(id, { field: f.id, unit: f.unit, rating: "F" }),
                  `Характеристика «${f.label}» добавлена, заполните значение и источник`,
                )
              }
            >
              + {f.label}
            </Button>
          ))}
        </div>
      )}

      <h3 className="a-sub">История правок</h3>
      {card.history.length ? (
        <History changes={card.history} operations={operations} />
      ) : (
        <p className="a-faint">Правок еще не было.</p>
      )}
    </div>
  );
}

/* Объекты и операции решения. Подтвержденные идут в подбор объекта, предложения правила ждут решения
   администратора, отклоненные видно блеклыми: правило их больше не предложит, но вернуть можно. */
function Uses({
  card,
  operations,
  busy,
  onSet,
}: {
  card: SolutionCard;
  operations: OperationInfo[];
  busy: boolean;
  onSet: (use: { facility: string; operation: string }, status: "confirmed" | "rejected", message: string) => void;
}) {
  const [adding, setAdding] = useState("");
  const taken = new Set(card.uses.map((u) => `${u.facility}/${u.operation}`));
  const free = operations.filter((op) => !taken.has(`${op.facility}/${op.id}`));
  const sourceName: Record<string, string> = { team: "разобрали мы", rule: "правило", admin: "вручную" };

  const line = (use: UseInfo) => (
    <li key={`${use.facility}/${use.operation}`} className={`a-use a-use-${use.status}`}>
      <span>{use.facility_label}</span>
      <span>
        <b>{use.label}</b>
        <span className="a-faint">
          {" "}
          · {sourceName[use.source] ?? use.source}
          {use.note && `: ${use.note}`}
        </span>
      </span>
      <span>
        {use.status === "confirmed" && <Badge tone="blue">в подборе</Badge>}
        {use.status === "suggested" && <Badge>проверить</Badge>}
        {use.status === "rejected" && <span className="a-faint">отклонено</span>}
      </span>
      <span className="a-row">
        {use.status !== "confirmed" && (
          <Button
            kind="link"
            disabled={busy}
            onClick={() => onSet(use, "confirmed", `${use.facility_label}: «${use.label}» подтверждено`)}
          >
            Подтвердить
          </Button>
        )}
        {use.status !== "rejected" && (
          <Button
            kind="link"
            disabled={busy}
            onClick={() => onSet(use, "rejected", `${use.facility_label}: «${use.label}» отклонено`)}
          >
            Отклонить
          </Button>
        )}
      </span>
    </li>
  );

  return (
    <div className="a-uses">
      {card.uses.length > 0 ? (
        <ul>{card.uses.map(line)}</ul>
      ) : (
        <p className="a-faint">Не привязано ни к одному объекту, в подбор не попадает.</p>
      )}
      {free.length > 0 && (
        <div className="a-row a-add">
          <Select
            label="Добавить объект и операцию"
            value={adding}
            onChange={setAdding}
            options={[
              { id: "", name: "добавить объект и операцию" },
              ...free.map((op) => ({ id: `${op.facility}/${op.id}`, name: `${op.facility_label}: ${op.label}` })),
            ]}
          />
          <Button
            kind="ghost"
            disabled={busy || !adding}
            onClick={() => {
              const [facility, operation] = adding.split("/");
              const op = free.find((o) => o.facility === facility && o.id === operation);
              setAdding("");
              onSet({ facility, operation }, "confirmed", `${op?.facility_label}: «${op?.label}» добавлено`);
            }}
          >
            Добавить
          </Button>
        </div>
      )}
    </div>
  );
}

/* Миниатюра в списке. Без фото стоит чертежная сетка: сразу видно, у кого снимка еще нет */
function Thumb({ url, name }: { url?: string | null; name: string }) {
  return url ? (
    <img className="a-thumb" src={url} alt={name} loading="lazy" />
  ) : (
    <span className="a-thumb u-grid-bg" title="Фото пока нет" />
  );
}

/* Фото решения в карточке: сам снимок, откуда он и можно ли его использовать */
function PhotoBlock({
  card,
  busy,
  onUpload,
  onMeta,
  onRemove,
}: {
  card: SolutionCard;
  busy: boolean;
  onUpload: (file: File, meta: PhotoMeta) => void;
  onMeta: (meta: PhotoMeta) => void;
  onRemove: () => void;
}) {
  const photo = card.photo;
  const [meta, setMeta] = useState<PhotoMeta>({
    source_url: photo?.source_url ?? "",
    owner: photo?.owner ?? "",
    license: photo?.license ?? "",
  });
  const dirty =
    Boolean(photo) &&
    (meta.source_url !== photo?.source_url || meta.owner !== photo?.owner || meta.license !== photo?.license);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onUpload(file, meta);
  }

  return (
    <div className="a-photo">
      {photo ? (
        <a
          className="a-photo-frame u-grid-bg"
          href={photo.url}
          target="_blank"
          rel="noreferrer"
          title="Открыть фото целиком"
        >
          <img src={photo.url} alt={card.name} />
        </a>
      ) : (
        <span className="a-photo-frame u-grid-bg a-photo-empty">
          Фото пока нет. Нужно: робот целиком, светлый фон, горизонтальное, от 1200 точек
        </span>
      )}
      <div className="a-photo-meta">
        <Field label="Откуда фото">
          <input
            className="a-input"
            value={meta.source_url}
            placeholder="ссылка на страницу или пресс-кит"
            onChange={(e) => setMeta({ ...meta, source_url: e.target.value })}
          />
        </Field>
        <Field label="Чье фото">
          <input
            className="a-input"
            value={meta.owner}
            placeholder="производитель или автор"
            onChange={(e) => setMeta({ ...meta, owner: e.target.value })}
          />
        </Field>
        {/* "Можно ли использовать" (license) в данных остается и уходит на сервер как было, на экране не
            показываем: для администратора это служебная пометка про права, и строка про закрытый
            репозиторий в каждой карточке только сбивала */}
        <div className="a-row">
          <label className={busy ? "u-btn u-btn-ghost a-file is-busy" : "u-btn u-btn-ghost a-file"}>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} disabled={busy} />
            {photo ? "Заменить фото" : "Загрузить фото"}
          </label>
          {dirty && (
            <Button disabled={busy} onClick={() => onMeta(meta)}>
              Сохранить источник
            </Button>
          )}
          {photo && (
            <Button kind="link" disabled={busy} onClick={onRemove}>
              Удалить фото
            </Button>
          )}
        </div>
        <p className="a-faint a-photo-hint">
          JPEG, PNG или WebP до 5 МБ.{" "}
          {photo
            ? `Загрузил ${photo.uploaded_by || "администратор"}.`
            : "Без разрешения на использование фото не загружаем."}
        </p>
      </div>
    </div>
  );
}

function SpecRow({
  spec,
  busy,
  onSave,
  onRemove,
}: {
  spec: Spec;
  busy: boolean;
  onSave: (body: Partial<SpecUpdate>) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(spec.value);
  const [unit, setUnit] = useState(spec.unit);
  const [rating, setRating] = useState(spec.rating as SpecUpdate["rating"]);
  const [source, setSource] = useState(spec.source);
  const [retrieved, setRetrieved] = useState(spec.retrieved ?? "");
  const dirty =
    value !== spec.value ||
    unit !== spec.unit ||
    rating !== spec.rating ||
    source !== spec.source ||
    retrieved !== (spec.retrieved ?? "");
  const link = source.split("\n").find((line) => line.startsWith("http"));

  return (
    <SheetRow
      muted={!spec.value}
      cells={[
        <span title={spec.note || undefined}>
          {spec.label}
          {spec.confirmed && <span className="a-faint"> · подтверждено</span>}
        </span>,
        <input
          className="a-input"
          aria-label={`${spec.label}: значение`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="нет данных"
        />,
        <input
          className="a-input"
          aria-label={`${spec.label}: единица`}
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
        />,
        <span className="a-rating">
          <select
            className="u-select"
            title={RATING_NAMES[rating]}
            aria-label={`${spec.label}: оценка`}
            value={rating}
            onChange={(e) => setRating(e.target.value as SpecUpdate["rating"])}
          >
            {RATINGS.map((r) => (
              <option key={r} value={r} title={RATING_NAMES[r]}>
                {r}
              </option>
            ))}
          </select>
        </span>,
        <span className="a-source">
          {/* Источников бывает несколько, по одному в строке: поле растет, чтобы не потерять ни одного */}
          <textarea
            className="a-input"
            rows={Math.min(source.split("\n").length, 3)}
            aria-label={`${spec.label}: источник`}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="ссылка или документ, по одному в строке"
          />
          {link && (
            <a href={link} target="_blank" rel="noreferrer">
              открыть
            </a>
          )}
        </span>,
        <input
          className="a-input mono"
          type="date"
          aria-label={`${spec.label}: дата`}
          value={retrieved}
          onChange={(e) => setRetrieved(e.target.value)}
        />,
        <span className="a-row a-spec-actions">
          {/* Кнопка сохранения появляется, только когда в строке есть правка */}
          {dirty && (
            <Button
              disabled={busy}
              onClick={() => onSave({ value, unit, rating, source, retrieved: retrieved || null })}
            >
              Сохранить
            </Button>
          )}
          <Button kind="link" onClick={onRemove} disabled={busy} title={`Удалить «${spec.label}»`}>
            Удалить
          </Button>
        </span>,
      ]}
    />
  );
}

function History({
  changes,
  withName,
  operations = [],
}: {
  changes: Change[];
  withName?: boolean;
  operations?: OperationInfo[];
}) {
  return (
    <ul className="a-history">
      {changes.map((change) => (
        <li key={change.id}>
          <span className="mono a-faint">{when.format(new Date(change.at))}</span>
          <span>
            <b>{ACTIONS[change.action] ?? change.action}</b>
            {withName && change.solution_name && <> · {change.solution_name}</>}
            <span className="a-faint"> · {change.user_email || "система"}</span>
            {change.note && <span className="a-faint"> · {change.note}</span>}
            {!withName &&
              Object.entries(change.changes).map(([key, pair]) =>
                Array.isArray(pair) ? (
                  <span key={key} className="a-diff">
                    {change.action === "use_set" ? (
                      <>
                        {bindingLabel(key, operations)}: <s>{show(USE_STATUS[pair[0]] ?? pair[0])}</s> →{" "}
                        <b>{show(USE_STATUS[pair[1]] ?? pair[1])}</b>
                      </>
                    ) : (
                      <>
                        {label(key)}: <s>{show(pair[0])}</s> → <b>{show(pair[1])}</b>
                      </>
                    )}
                  </span>
                ) : null,
              )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* Привязка в журнале записана как «склад/операция» кодами, показываем названиями */
function bindingLabel(key: string, operations: OperationInfo[]): string {
  const [facility, operation] = key.split("/");
  const op = operations.find((o) => o.facility === facility && o.id === operation);
  return op ? `${op.facility_label} · ${op.label}` : key;
}

function label(key: string): string {
  const [field, part] = key.split(".");
  if (!part) return LABELS[field] ?? field;
  const parts: Record<string, string> = {
    value: "значение",
    unit: "единица",
    rating: "оценка",
    source: "источник",
    retrieved: "дата",
    note: "пояснение",
    source_type: "тип источника",
    quote: "цитата",
  };
  return `${field} · ${parts[part] ?? part}`;
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "пусто";
  if (typeof value === "boolean") return value ? "да" : "нет";
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
