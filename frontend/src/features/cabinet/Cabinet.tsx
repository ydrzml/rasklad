import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  account,
  ApiError,
  facilities,
  projects,
  type Folder,
  type Me,
  type Project,
  type ProjectSummary,
} from "../../api/projects";
import {
  ActionBar,
  Alert,
  ask,
  Badge,
  Button,
  Check,
  EmptyState,
  Header,
  Hero,
  Notice,
  Pill,
  Search,
  Select,
  Sheet,
  SheetRow,
  Waiting,
} from "../../ui";
import { Keeper03, Sleeper06 } from "../../ui/robots";
import { api } from "../../api/client";
import { DRAFT_KEY, draftOf, draftTitle, draftUrl, requestFrom, saveBlob, type SavedInput } from "../../app/saving";
import { CompareScreen } from "./Compare";
import { ProfileScreen } from "./Profile";
import { VariantDialog } from "./Variant";
import { money, term } from "../../app/format";
import { compareItems, compareUrl, counted, day, problem, PROJECTS, SAVES, when } from "./format";
import "./cabinet.css";

// Кабинет: проекты по папкам, сравнение, профиль. Все на одном адресе /projects:
// ?compare=12,15 открывает сравнение, ?view=profile профиль. Собран из набора компонентов,
// своих цветов и теней не заводит.

const CALC = "/calc?new=1";
const LOGIN = "/login";
// Сравнение шире четырех колонок на экране 1366 уже не читается
const MAX_COMPARE = 4;

type Sort = "recent" | "name";

type Screen =
  | { state: "loading" }
  | { state: "guest" }
  | { state: "error"; message: string }
  | { state: "ready"; me: Me; list: ProjectSummary[]; folders: Folder[] };

export function Cabinet() {
  const [screen, setScreen] = useState<Screen>({ state: "loading" });
  const [facilityNames, setFacilityNames] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<number[]>([]);

  const query = new URLSearchParams(window.location.search);
  const comparing = query.has("compare");
  const profile = query.get("view") === "profile";

  const load = useCallback(async () => {
    try {
      const me = await account.me();
      if (me.role === "guest") {
        setScreen({ state: "guest" });
        return;
      }
      const [list, folders] = await Promise.all([projects.list(), projects.folders()]);
      setScreen({ state: "ready", me, list, folders });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setScreen({ state: "guest" });
      else setScreen({ state: "error", message: problem(error) });
    }
  }, []);

  useEffect(() => {
    // Загрузка при открытии страницы: данные приходят с сервера, ставить состояние здесь и нужно
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    facilities()
      .then((list) => setFacilityNames(Object.fromEntries(list.map((facility) => [facility.id, facility.name]))))
      .catch(() => setFacilityNames({}));
  }, [load]);

  const ready = screen.state === "ready" ? screen : null;

  return (
    <div className="u-page">
      <Header />
      <main className="u-main u-wrap">
        {!comparing && !profile && (
          <Hero
            compact
            title="Мои проекты"
            lead="Сохраненные расчеты. Варианты одного склада лежат в папке, их можно сравнить рядом."
          />
        )}

        {screen.state === "loading" && <Waiting title="Загружаем проекты" />}

        {screen.state === "error" && (
          <Notice title="Не получилось загрузить проекты">
            {screen.message}. Обновите страницу через минуту: сохраненное никуда не делось.
          </Notice>
        )}

        {screen.state === "guest" && (
          <EmptyState
            title="Проекты видны после входа"
            apart
            robot={<Keeper03 />}
            actions={
              <>
                <a className="u-btn u-btn-dark" href={LOGIN}>
                  Войти или зарегистрироваться
                </a>
                <a className="u-btn u-btn-link" href={CALC}>
                  Посчитать без входа
                </a>
              </>
            }
          >
            Считать можно и без входа, а чтобы сохранить расчет, вернуться к нему и сравнить варианты, нужен аккаунт.
            Для проверки есть демо-аккаунт, пароль не нужен.
          </EmptyState>
        )}

        {ready && comparing && <CompareScreen items={compareItems(window.location.search)} />}
        {ready && profile && <ProfileScreen me={ready.me} />}

        {ready && !comparing && !profile && (
          <>
            <DraftCard />
            <ProjectList
              list={ready.list}
              folders={ready.folders}
              facilityNames={facilityNames}
              openId={openId}
              onOpen={setOpenId}
              search={search}
              onSearch={setSearch}
              sort={sort}
              onSort={setSort}
              notice={notice}
              picked={picked}
              onPick={setPicked}
              onChanged={async (message, nextOpen) => {
                setNotice(message);
                if (nextOpen !== undefined) setOpenId(nextOpen);
                await load();
              }}
            />
          </>
        )}
      </main>
    </div>
  );
}

// Незаконченный расчет в этом браузере: мастер держит введенное здесь, пока его не сохранили.
// Показываем сверху, чтобы уйти из мастера в кабинет было не страшно: вернуться можно одной кнопкой
function DraftCard() {
  const [draft, setDraft] = useState(() => {
    try {
      return draftOf(window.localStorage.getItem(DRAFT_KEY));
    } catch {
      return null;
    }
  });
  if (!draft) return null;

  async function drop() {
    const sure = await ask({
      title: "Удалить незаконченный расчет?",
      text: "Сохраненные проекты не пострадают, пропадет только то, что не сохранили.",
      yes: "Удалить",
      danger: true,
    });
    if (!sure) return;
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // нечего удалять
    }
    setDraft(null);
  }

  return (
    <Notice title="Незаконченный расчет" level={2}>
      {draftTitle(draft)}. Он хранится в этом браузере, пока его не сохранили в проект.
      <span className="u-action-end c-draft">
        <Button kind="dark" arrow onClick={() => window.location.assign(draftUrl(draft))}>
          Продолжить
        </Button>
        <Button kind="danger" onClick={() => void drop()}>
          Удалить
        </Button>
      </span>
    </Notice>
  );
}

type ListProps = {
  list: ProjectSummary[];
  folders: Folder[];
  facilityNames: Record<string, string>;
  openId: number | null;
  onOpen: (id: number | null) => void;
  search: string;
  onSearch: (value: string) => void;
  sort: Sort;
  onSort: (sort: Sort) => void;
  notice: string | null;
  picked: number[];
  onPick: (ids: number[]) => void;
  onChanged: (message: string | null, nextOpen?: number | null) => Promise<void>;
};

function ProjectList(props: ListProps) {
  const { list, folders, search, sort, picked } = props;
  const [folderName, setFolderName] = useState<string | null>(null);

  const shown = useMemo(() => {
    const query = search.trim().toLowerCase();
    const found = query ? list.filter((project) => project.name.toLowerCase().includes(query)) : list;
    return sort === "name" ? [...found].sort((a, b) => a.name.localeCompare(b.name, "ru")) : found;
  }, [list, search, sort]);

  if (list.length === 0) {
    return (
      <EmptyState
        title="Проектов пока нет"
        apart
        robot={<Sleeper06 className="c-sleeper" />}
        actions={
          <Button arrow onClick={() => window.location.assign(CALC)}>
            Посчитать склад
          </Button>
        }
      >
        Проект появится, когда вы сохраните расчет. Пройдите шаги от объекта до экономики: значения уже стоят, поправить
        их можно на любом шаге.
      </EmptyState>
    );
  }

  const inFolder = (id: number | null) => shown.filter((project) => (project.folder_id ?? null) === id);
  const loose = inFolder(null);
  const toggle = (id: number) =>
    props.onPick(picked.includes(id) ? picked.filter((one) => one !== id) : [...picked, id]);
  const saved = (ids: number[]) => ids.filter((id) => list.find((project) => project.id === id)?.versions);

  async function newFolder(event: FormEvent) {
    event.preventDefault();
    const name = folderName?.trim();
    setFolderName(null);
    if (!name) return;
    await projects.addFolder(name, picked);
    props.onPick([]);
    await props.onChanged(picked.length ? `Папка «${name}»: ${counted(picked.length, PROJECTS)} внутри` : null);
  }

  async function moveTo(folder: string) {
    const target = folder === "none" ? null : Number(folder);
    await Promise.all(picked.map((id) => projects.move(id, target)));
    props.onPick([]);
    await props.onChanged("Проекты переложены");
  }

  const comparable = saved(picked);

  async function dropTo(folder: number | null, id: number) {
    const moving = picked.includes(id) ? picked : [id];
    const where = folder === null ? null : folders.find((one) => one.id === folder);
    const already = moving.every((one) => (list.find((project) => project.id === one)?.folder_id ?? null) === folder);
    if (already) return;
    await Promise.all(moving.map((one) => projects.move(one, folder)));
    props.onPick([]);
    const what = moving.length > 1 ? counted(moving.length, PROJECTS) : "Проект";
    await props.onChanged(where ? `${what}: в папке «${where.name}»` : `${what}: вынут из папки`);
  }

  return (
    <section>
      <div className="c-top">
        <span className="c-find">
          <Search value={search} onChange={props.onSearch} placeholder="Найти проект по названию" />
        </span>
        <Pill active={sort === "recent"} onClick={() => props.onSort("recent")}>
          Сначала свежие
        </Pill>
        <Pill active={sort === "name"} onClick={() => props.onSort("name")}>
          По названию
        </Pill>
        <span className="c-gap" />
        {folderName === null ? (
          <Button kind="ghost" onClick={() => setFolderName("")}>
            {picked.length ? "Отмеченные в новую папку" : "Новая папка"}
          </Button>
        ) : (
          <form className="c-rename c-new-folder" onSubmit={newFolder}>
            <input
              className="u-search"
              aria-label="Название новой папки"
              placeholder="Например, склад в Подольске"
              maxLength={200}
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              autoFocus
            />
            <button className="u-btn u-btn-dark" type="submit" disabled={!folderName.trim()}>
              Создать
            </button>
            <button className="u-btn u-btn-link" type="button" onClick={() => setFolderName(null)}>
              Отмена
            </button>
          </form>
        )}
        <Button arrow onClick={() => window.location.assign(CALC)}>
          Новый расчет
        </Button>
      </div>

      {props.notice && (
        <p className="c-said" role="status">
          <Alert tone="note">{props.notice}</Alert>
        </p>
      )}

      {shown.length === 0 && (
        <Notice title="Ничего не нашлось">Проекта с «{search.trim()}» в названии нет. Попробуйте часть слова.</Notice>
      )}

      {folders.map((folder) => {
        const inside = inFolder(folder.id);
        if (search.trim() && inside.length === 0) return null;
        return (
          <FolderBlock
            key={folder.id}
            folder={folder}
            projects={inside}
            props={props}
            onToggle={toggle}
            onDrop={(id) => void dropTo(folder.id, id)}
            onCompare={() => {
              const ids = saved(inside.map((project) => project.id)).slice(0, MAX_COMPARE);
              window.location.assign(compareUrl(ids.map((id) => ({ project_id: id }))));
            }}
          />
        );
      })}

      {/* Без папки выглядит так же, как папка: заголовок того же размера. Пока есть папки, стоит всегда,
          даже пустой: на него перетаскивают, чтобы вынуть проект из папки */}
      {(loose.length > 0 || (folders.length > 0 && !search.trim())) && (
        <Group
          title={folders.length > 0 ? "Без папки" : null}
          count={loose.length}
          onDrop={(id) => void dropTo(null, id)}
          empty="Все проекты разложены по папкам. Перетащите проект сюда, чтобы вынуть его из папки."
        >
          {loose.length > 0 && <Rows items={loose} props={props} onToggle={toggle} />}
        </Group>
      )}

      {picked.length > 0 && (
        <ActionBar
          summary={
            <>
              Отмечено: <b>{counted(picked.length, PROJECTS)}</b>
              {comparable.length > MAX_COMPARE && `, сравним первые ${MAX_COMPARE}`}
            </>
          }
        >
          <span className="c-move">
            <Select
              label="Переложить в папку"
              value=""
              onChange={(value) => void moveTo(value)}
              options={[
                { id: "", name: "Переложить в папку..." },
                ...folders.map((folder) => ({ id: String(folder.id), name: folder.name })),
                { id: "none", name: "Вынуть из папки" },
              ]}
            />
          </span>
          <Button kind="link" onClick={() => props.onPick([])}>
            Снять отметки
          </Button>
          {comparable.length < 2 && <span className="c-soon">Для сравнения отметьте два сохраненных проекта</span>}
          <Button
            arrow
            disabled={comparable.length < 2}
            onClick={() =>
              window.location.assign(compareUrl(comparable.slice(0, MAX_COMPARE).map((id) => ({ project_id: id }))))
            }
          >
            Сравнить
          </Button>
        </ActionBar>
      )}
    </section>
  );
}

// Группа проектов: папка или "Без папки". Заголовок один на всех, значков нет.
// Вся группа принимает брошенный проект: подсвечивается, пока над ней тянут
const DRAG = "application/x-lct-project";

function Group({
  title,
  count,
  onDrop,
  empty,
  actions,
  children,
}: {
  title: ReactNode | null;
  count: number;
  onDrop: (id: number) => void;
  empty: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <section
      className={over ? "c-group is-over" : "c-group"}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        const id = Number(event.dataTransfer.getData(DRAG));
        if (id) {
          event.preventDefault();
          onDrop(id);
        }
      }}
    >
      {title !== null && (
        <header className="c-group-head">
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {count > 0 && <span className="c-group-count">{counted(count, PROJECTS)}</span>}
          <span className="c-gap" />
          {actions}
        </header>
      )}
      {count > 0 ? children : <p className="c-group-empty">{empty}</p>}
    </section>
  );
}

function FolderBlock({
  folder,
  projects: inside,
  props,
  onToggle,
  onDrop,
  onCompare,
}: {
  folder: Folder;
  projects: ProjectSummary[];
  props: ListProps;
  onToggle: (id: number) => void;
  onDrop: (id: number) => void;
  onCompare: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const saved = inside.filter((project) => project.versions).length;

  async function rename(event: FormEvent) {
    event.preventDefault();
    const name = draft?.trim();
    setDraft(null);
    if (!name || name === folder.name) return;
    await projects.renameFolder(folder.id, name);
    await props.onChanged(`Папка переименована в «${name}»`);
  }

  async function remove() {
    const sure = await ask({
      title: `Убрать папку «${folder.name}»?`,
      text: "Проекты из нее не удалятся, они вернутся в общий список.",
      yes: "Убрать папку",
    });
    if (!sure) return;
    await projects.removeFolder(folder.id);
    await props.onChanged(`Папки «${folder.name}» больше нет, проекты в общем списке`);
  }

  const title =
    draft === null ? (
      <h2>{folder.name}</h2>
    ) : (
      <form className="c-rename" onSubmit={rename}>
        <input
          className="u-search"
          aria-label="Название папки"
          maxLength={200}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoFocus
        />
        <button className="u-btn u-btn-dark" type="submit">
          Сохранить
        </button>
        <button className="u-btn u-btn-link" type="button" onClick={() => setDraft(null)}>
          Отмена
        </button>
      </form>
    );

  return (
    <Group
      title={title}
      count={inside.length}
      onDrop={onDrop}
      empty="Папка пустая. Перетащите сюда проект, а копия проекта из этой папки ляжет сюда сама."
      actions={
        draft === null && (
          <>
            <Button kind="link" onClick={() => setDraft(folder.name)}>
              Переименовать
            </Button>
            <Button kind="link" onClick={() => void remove()}>
              Убрать папку
            </Button>
            {saved >= 2 && (
              <Button kind="ghost" onClick={onCompare}>
                Сравнить {saved > MAX_COMPARE ? `первые ${MAX_COMPARE}` : saved === 2 ? "оба" : "все"}
              </Button>
            )}
          </>
        )
      }
    >
      <Rows items={inside} props={props} onToggle={onToggle} />
    </Group>
  );
}

function Rows({
  items,
  props,
  onToggle,
}: {
  items: ProjectSummary[];
  props: ListProps;
  onToggle: (id: number) => void;
}) {
  return (
    <div className="c-list">
      <Sheet
        columns={[
          { name: "", width: "44px" },
          { name: "Проект" },
          { name: "Роботов", width: "90px" },
          { name: "Окупаемость", width: "120px", hint: "Покупка роботов: за сколько вложения вернутся" },
          { name: "Владение", width: "130px", hint: "Стоимость владения покупкой за горизонт расчета" },
          { name: "Изменен", width: "170px" },
          { name: "", width: "110px" },
        ]}
      >
        {items.map((project) => {
          const open = props.openId === project.id;
          const facility = props.facilityNames[project.facility_type] ?? project.facility_type;
          const saves = project.versions ? counted(project.versions, SAVES) : "не сохранен";
          const figures = project.figures;
          const none = <span className="c-faint">нет</span>;
          return (
            <SheetRow
              key={project.id}
              // проект тянут в папку за всю строку. Раскрытую не тянем: в ней поля и выделение текста
              onDragStart={
                open
                  ? undefined
                  : (event) => {
                      event.dataTransfer.setData(DRAG, String(project.id));
                      event.dataTransfer.effectAllowed = "move";
                    }
              }
              dragTitle={open ? undefined : "Перетащите в папку"}
              cells={[
                <Check
                  checked={props.picked.includes(project.id)}
                  onToggle={() => onToggle(project.id)}
                  label=""
                  title={`Отметить «${project.name}»`}
                />,
                <span className="c-drag">
                  <button
                    className="c-name"
                    aria-expanded={open}
                    onClick={() => props.onOpen(open ? null : project.id)}
                  >
                    {project.name}
                  </button>
                  <span className="c-about">
                    {facility} · {saves}
                  </span>
                  {/* На узком экране колонок с цифрами нет: главное пишем строкой под названием */}
                  <span className="c-meta">
                    {figures ? `${figures.fleet ?? "?"} роб. · окупаемость ${term(figures.payback_years)} · ` : ""}
                    {day(project.updated_at)}
                  </span>
                </span>,
                figures?.fleet != null ? <span className="mono">{figures.fleet}</span> : none,
                figures ? <span className="mono c-nowrap">{term(figures.payback_years)}</span> : none,
                figures?.tco_rub != null ? (
                  <span className="mono c-nowrap" title={`за ${figures.horizon_years ?? 5} лет`}>
                    {money(figures.tco_rub)}
                  </span>
                ) : (
                  none
                ),
                <span className="mono c-nowrap">{when(project.updated_at)}</span>,
                <Button kind="link" onClick={() => props.onOpen(open ? null : project.id)}>
                  {open ? "Свернуть" : "Подробнее"}
                </Button>,
              ]}
              notes={open ? <Details id={project.id} folders={props.folders} onChanged={props.onChanged} /> : undefined}
            />
          );
        })}
      </Sheet>
    </div>
  );
}

function Details({ id, folders, onChanged }: { id: number; folders: Folder[]; onChanged: ListProps["onChanged"] }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);
  const [variant, setVariant] = useState(false);

  const reload = useCallback(async () => {
    try {
      setProject(await projects.get(id));
      setError(null);
    } catch (reason) {
      setError(problem(reason));
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  async function act(action: () => Promise<unknown>, message: string | null, nextOpen?: number | null) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged(message, nextOpen);
      if (nextOpen === undefined) await reload();
    } catch (reason) {
      setError(problem(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return error ? <Alert>{error}</Alert> : <Waiting title="Открываем проект" />;
  }

  const current = project.current;
  const links = project.shares ?? [];

  async function copyLink(token: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/share/${token}`);
    } catch {
      // буфер обмена недоступен: ссылка все равно открывается по «Версия N» в списке
    }
  }

  async function revoke(token: string) {
    const sure = await ask({
      title: "Отозвать ссылку?",
      text: "Кто ее получил, больше не откроет расчет.",
      yes: "Отозвать",
      danger: true,
    });
    if (sure) act(() => projects.revoke(id, token), "Ссылка отозвана");
  }

  function rename(event: FormEvent) {
    event.preventDefault();
    const name = draft?.trim();
    if (!name || name === project!.name) {
      setDraft(null);
      return;
    }
    act(() => projects.rename(id, name), `Проект переименован в «${name}»`).then(() => setDraft(null));
  }

  async function remove() {
    const sure = await ask({
      title: `Удалить «${project!.name}»?`,
      text: `Вместе с ним удалятся ${counted(project!.versions, SAVES)} и ссылки на расчет. Вернуть не получится.`,
      yes: "Удалить проект",
      danger: true,
    });
    if (sure) act(() => projects.remove(id), `Проект «${project!.name}» удален`, null);
  }

  // Отчет по последней версии: сервер считает его заново по сохраненному вводу, до полуминуты
  async function download(kind: "pdf" | "xlsx") {
    if (!current) return;
    setExporting(kind);
    setError(null);
    try {
      const { blob, name } = await api.report(kind, requestFrom(current.state as unknown as SavedInput) as never);
      saveBlob(blob, name);
    } catch (reason) {
      setError(`Файл не собрался: ${problem(reason)}`);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="c-details">
      <div className="c-row">
        {draft === null ? (
          <>
            <Button kind="ghost" onClick={() => setDraft(project.name)} disabled={busy}>
              Переименовать
            </Button>
            {/* копия нужна, чтобы посмотреть другой вариант того же склада, не трогая этот */}
            {current && (
              <Button kind="ghost" onClick={() => setVariant(true)} disabled={busy}>
                Копия: что будет, если...
              </Button>
            )}
            <span className="c-move">
              <Select
                label="Папка проекта"
                value={project.folder_id ? String(project.folder_id) : "none"}
                onChange={(value) =>
                  act(
                    () => projects.move(id, value === "none" ? null : Number(value)),
                    value === "none" ? "Проект вынут из папки" : "Проект переложен",
                  )
                }
                options={[
                  { id: "none", name: "Без папки" },
                  ...folders.map((folder) => ({ id: String(folder.id), name: `Папка: ${folder.name}` })),
                ]}
              />
            </span>
            <Button kind="danger" onClick={() => void remove()} disabled={busy}>
              Удалить проект
            </Button>
            <span className="c-gap" />
            {current && (
              <>
                <Button kind="light" disabled={exporting !== null} onClick={() => void download("pdf")}>
                  {exporting === "pdf" ? "Собираем отчет..." : "Отчет PDF"}
                </Button>
                <Button kind="light" disabled={exporting !== null} onClick={() => void download("xlsx")}>
                  {exporting === "xlsx" ? "Собираем таблицы..." : "Таблицы Excel"}
                </Button>
              </>
            )}
            {/* Открываем последнее сохранение, мастер пересчитает цифры сам. Пустой проект открывать нечем */}
            {current ? (
              <Button kind="dark" arrow onClick={() => window.location.assign(`/calc?project=${id}&open=1`)}>
                Открыть в расчете
              </Button>
            ) : (
              <>
                <span className="c-soon">Откроется в расчете после первого сохранения</span>
                <Button kind="dark" disabled>
                  Открыть в расчете
                </Button>
              </>
            )}
          </>
        ) : (
          <form className="c-rename" onSubmit={rename}>
            <input
              className="u-search"
              aria-label="Новое название проекта"
              maxLength={200}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              autoFocus
            />
            <button className="u-btn u-btn-dark" type="submit" disabled={busy}>
              Сохранить
            </button>
            {/* type="button": кнопка набора внутри формы иначе отправила бы переименование */}
            <button className="u-btn u-btn-link" type="button" onClick={() => setDraft(null)}>
              Отмена
            </button>
          </form>
        )}
      </div>

      {error && <Alert>{error}</Alert>}
      {variant && <VariantDialog project={project} onClose={() => setVariant(false)} />}

      <div className="c-cols">
        <div>
          <h3 className="c-sub">История сохранений</h3>
          {current ? (
            <Sheet
              columns={[
                { name: "№", width: "44px" },
                { name: "Что поменяли" },
                { name: "Сохранено", width: "170px" },
                { name: "Данные", width: "120px", hint: "Те же ли нормативы и каталог стоят сейчас" },
                { name: "", width: "110px" },
              ]}
            >
              {[...project.history].reverse().map((version, index, all) => {
                const before = all[index + 1];
                return (
                  <SheetRow
                    key={version.number}
                    cells={[
                      <a
                        href={`/calc?project=${id}&version=${version.number}&open=1`}
                        title="Открыть эту версию в расчете"
                      >
                        <span className="c-label">Версия </span>
                        <span className="mono">{version.number}</span>
                      </a>,
                      version.note || <span className="c-faint">без комментария</span>,
                      <span>
                        <span className="c-label">Сохранено </span>
                        <span className="mono c-nowrap">{when(version.saved_at)}</span>
                      </span>,
                      version.same_data ? <Badge tone="blue">не менялись</Badge> : <Badge>обновились</Badge>,
                      before ? (
                        <a
                          href={compareUrl([
                            { project_id: id, version: before.number },
                            { project_id: id, version: version.number },
                          ])}
                          title={`Сравнить версию ${version.number} с версией ${before.number}`}
                        >
                          сравнить с {before.number}
                        </a>
                      ) : (
                        ""
                      ),
                    ]}
                  />
                );
              })}
            </Sheet>
          ) : (
            <Notice title="Расчет еще не сохраняли">
              Проект создан пустым. Сохранения появятся здесь, каждое отдельной строкой.
            </Notice>
          )}
          {project.history.some((version) => !version.same_data) && (
            <p className="c-said">
              <Alert tone="note">
                С тех пор мы обновили нормативы или каталог. Сохраненные цифры покажем как были, а пересчитать можно на
                текущих данных.
              </Alert>
            </p>
          )}
        </div>

        <div>
          <h3 className="c-sub">Ссылки на расчет</h3>
          {links.length > 0 && (
            <ul className="c-files">
              {links.map((item) => (
                <li key={item.token}>
                  <a href={`/share/${item.token}`} target="_blank" rel="noreferrer">
                    Версия {item.version}
                  </a>
                  <span className="mono c-faint">{day(item.created_at)}</span>
                  <Button kind="link" onClick={() => void copyLink(item.token)}>
                    Скопировать
                  </Button>
                  <Button kind="danger" onClick={() => void revoke(item.token)} disabled={busy}>
                    Отозвать
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {current && !links.some((item) => item.version === current.number) && (
            <Button
              kind="ghost"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const made = await projects.share(id, current.number);
                  await copyLink(made.token);
                }, `Ссылка на версию ${current.number} скопирована`)
              }
            >
              Поделиться версией {current.number}
            </Button>
          )}
          <p className="c-faint c-hint">
            По ссылке расчет видно без входа, только для просмотра. Ваша почта и другие версии не видны.
          </p>
        </div>
      </div>
    </div>
  );
}
