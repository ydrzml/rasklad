import { useMemo, useState } from "react";

import type { BudgetFit, Solution } from "../../api/client";
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
  InlineField,
  ListRow,
  Notice,
  Pill,
  Queue,
  Search,
  Split,
  Toolbar,
} from "../../ui";
import { mln, money } from "../format";
import { peakWarning } from "./peak";
import { plural } from "./economicsNames";

// robotId это идентификатор решения в расчетной модели, а не id позиции каталога.
type Props = {
  solutions: Solution[];
  /* решения задачи с долями объема: одно или два */
  picks: { robotId: string; share: number }[];
  onPick: (robotId: string) => void;
  /* снять выбор с решения: нажатие на "Выбрано" */
  onUnpick: (robotId: string) => void;
  /* второе решение на ту же задачу: смешанный парк, доля объема между ними ползунком */
  onAdd: (robotId: string) => void;
  onShare: (share: number) => void;
  /* бюджет на старте в рублях: на карточках видно, сколько роботов в него влезает покупкой */
  budget?: number | null;
  /* ответ сервера по бюджету на каждое решение задачи, по robot_id */
  fits?: Record<string, BudgetFit>;
  /* быстрая оценка пика: задача «товар к человеку» и годится ли под нее план */
  needsStations?: boolean;
  planReady?: boolean;
  onDrop: () => void;
  title?: string;
  /* название задачи у строки доли, когда задач несколько */
  taskName?: string;
  /* задач несколько: у строки доли подписываем задачу */
  manyTasks?: boolean;
};

export type TaskChoice = {
  id: string;
  name: string;
  solutions: Solution[];
  picks: { robotId: string; share: number }[];
  /* задача «товар к человеку»: роботу нужны станции отбора на плане */
  needsStations?: boolean;
};

// Шаг 4 по задачам. Задачи идут по очереди: сверху плитки с тем, что выбрано и что осталось,
// под ними подбор для открытой задачи. Подбор у каждой задачи свой: сервер проверяет решения
// под ее груз, проезды и ярусы. На задачу одно решение или два с долей объема (смешанный парк).
export function ChooseSolutions({
  tasks,
  active,
  onActive,
  onPick,
  onUnpick,
  onAdd,
  onShare,
  onDrop,
  budget,
  onBudget,
  fits,
  planReady = true,
}: {
  tasks: TaskChoice[];
  active: string;
  onActive: (taskId: string) => void;
  onPick: (taskId: string, robotId: string) => void;
  onUnpick: (taskId: string, robotId: string) => void;
  onAdd: (taskId: string, robotId: string) => void;
  onShare: (taskId: string, share: number) => void;
  onDrop: (taskId: string) => void;
  budget: number | null;
  onBudget: (value: number | null) => void;
  fits?: Record<string, BudgetFit>;
  /* план годится под отбор «товар к человеку»: робозона или станции с узкими проездами */
  planReady?: boolean;
}) {
  const index = Math.max(
    0,
    tasks.findIndex((task) => task.id === active),
  );
  const task = tasks[index];
  if (!task) return null;
  return (
    <>
      <BudgetField value={budget} onChange={onBudget} />
      {tasks.length > 1 && (
        <Queue
          items={tasks.map((one) => ({ id: one.id, name: one.name, picked: pickedName(one) }))}
          active={task.id}
          onPick={onActive}
        />
      )}
      <ChooseSolution
        key={task.id}
        solutions={task.solutions}
        picks={task.picks}
        onPick={(robotId) => onPick(task.id, robotId)}
        onUnpick={(robotId) => onUnpick(task.id, robotId)}
        onAdd={(robotId) => onAdd(task.id, robotId)}
        onShare={(share) => onShare(task.id, share)}
        onDrop={() => onDrop(task.id)}
        budget={budget}
        fits={fits}
        needsStations={Boolean(task.needsStations)}
        planReady={planReady}
        title={tasks.length > 1 ? `${index + 1}. ${task.name}: выберите решение` : undefined}
        taskName={task.name}
        manyTasks={tasks.length > 1}
      />
    </>
  );
}

// Бюджет на старте: поле необязательное и пустое, пока пусто, ничего не меняет. Вводят в миллионах,
// наверх уходят рубли, как везде в расчете. Стоит отдельной строкой над задачами, обычным полем
// с короткой подсказкой рядом
function BudgetField({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) {
  return (
    <InlineField
      label="Бюджет на старте"
      unit="млн ₽"
      placeholder="не задан"
      value={value ? value / 1_000_000 : ""}
      onChange={(text) => onChange(text === "" || Number(text) <= 0 ? null : Number(text) * 1_000_000)}
      note={
        value
          ? "на карточках видно, сколько роботов влезает в него со всеми вложениями на старте"
          : "необязательно: на карточках появится, сколько роботов влезает в эту сумму со всеми вложениями"
      }
    />
  );
}

// Сколько роботов влезает в бюджет со всеми вложениями на старте: считает сервер по статьям
// экономики покупки (роботы, зарядки, ПО, станции, пусконаладка, общее на объект, резерв)
function fitLine(fit: BudgetFit | undefined): string | null {
  if (!fit) return null;
  const robots = (count: number) => `${count} ${plural(count, "робот", "робота", "роботов")}`;
  const rent =
    fit.raas_fits === true
      ? ", арендой старт укладывается"
      : fit.raas_fits === false
        ? ", арендой старт тоже не укладывается"
        : "";
  if (fit.fleet_needed === null || fit.fleet_needed === undefined) {
    return "парк под спрос по формуле не сходится, бюджет тут ни при чем";
  }
  if (fit.fleet_fits >= fit.fleet_needed) {
    return `в бюджет влезает весь парк: ${robots(fit.fleet_needed)} со всеми вложениями на старте, ${mln(fit.investment_needed_rub ?? 0)} млн ₽`;
  }
  if (fit.fleet_fits === 0) {
    return `в бюджет не влезает и один робот со всеми вложениями на старте: подготовка объекта дороже${rent}`;
  }
  return `в бюджет влезает ${robots(fit.fleet_fits)} из ${fit.fleet_needed} нужных по формуле, со всеми вложениями на старте${rent}`;
}

export function shortName(solutions: Solution[], robotId: string): string {
  return solutions.find((solution) => solution.robot_id === robotId)?.product.split(" (")[0] ?? robotId;
}

// Что выбрано на задаче словами: «Ronavi H1500» или «Ronavi H1500 60% + Moros AMR 1500 40%»
function pickedName(task: TaskChoice): string | null {
  if (task.picks.length === 0) return null;
  if (task.picks.length === 1) return shortName(task.solutions, task.picks[0].robotId);
  return task.picks
    .map((pick) => `${shortName(task.solutions, pick.robotId)} ${Math.round(pick.share * 100)}%`)
    .join(" + ");
}

const GROUPS: { status: string; title: string; hint: string }[] = [
  { status: "recommended", title: "Подходят", hint: "Ключевые ограничения проверены, данные есть" },
  {
    status: "needs_check",
    title: "Требуют проверки",
    hint: "Ограничение проверить не удалось: производитель не публикует часть характеристик",
  },
  {
    status: "excluded",
    title: "Не подходят",
    hint: "Нарушено ключевое ограничение. Сравнить можно, но в расчет такое решение идет с предупреждением",
  },
];

const SORTS: { id: string; label: string }[] = [
  { id: "score", label: "по баллу" },
  { id: "throughput", label: "по производительности" },
  { id: "price", label: "по цене" },
  { id: "product", label: "по названию" },
];

// Ключевые цифры карточки из каталога, с единицей источника. Нет цифры, нет строки
const KEY_SPECS: { field: string; name: string }[] = [
  { field: "max_speed_m_s", name: "Скорость" },
  { field: "throughput", name: "Производительность" },
  { field: "payload_kg", name: "Грузоподъемность" },
];

// Шаг 3. Подбор с объяснением, фильтрами, поиском, сортировкой и сравнением (ТЗ, пп. 3.3.6 и 3.4).
// Карточка короткая: название, цена и два факта. Почему решение тут оказалось, лежит внутри
// карточки в раскрывающемся блоке, иначе список не пролистать.
function ChooseSolution({
  solutions,
  picks,
  onPick,
  onUnpick,
  onAdd,
  onShare,
  onDrop,
  budget,
  fits,
  needsStations = false,
  planReady = true,
  title,
  taskName,
  manyTasks,
}: Props) {
  const [search, setSearch] = useState("");
  const [onlyFits, setOnlyFits] = useState(false);
  const [onlyRussian, setOnlyRussian] = useState(false);
  const [onlyTested, setOnlyTested] = useState(false);
  const [sort, setSort] = useState("score");
  const [compared, setCompared] = useState<string[]>([]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = solutions.filter((solution) => {
      if (query && !`${solution.product} ${solution.vendor} ${solution.subtype}`.toLowerCase().includes(query)) {
        return false;
      }
      if (onlyFits && solution.status === "excluded") return false;
      if (onlyRussian && !solution.registry_719) return false;
      if (onlyTested && !solution.tested_fcbas) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      // число в час считает сервер из записи каталога; без него решение в конце списка
      if (sort === "throughput") return (b.throughput_per_hour ?? -1) - (a.throughput_per_hour ?? -1);
      if (sort === "price") return (b.price_rub ?? 0) - (a.price_rub ?? 0);
      if (sort === "product") return a.product.localeCompare(b.product, "ru");
      return b.score - a.score;
    });
  }, [solutions, search, onlyFits, onlyRussian, onlyTested, sort]);

  // сколько решений в каталоге под задачу: подходят, делают другую задачу, не хватает данных
  const fitting = solutions.filter((one) => one.status === "recommended");
  const others = solutions.filter((one) => otherTask(one)).length;
  const unchecked = solutions.filter((one) => one.status === "needs_check").length;
  // подходящих нет и ничего не выбрано: раскрываем список, откуда выбирать, а сами не выбираем
  const waiting =
    fitting.length === 0 && picks.length === 0
      ? (GROUPS.find((group) => group.status !== "recommended" && visible.some((one) => one.status === group.status))
          ?.status ?? "")
      : "";
  const toggleCompare = (id: string) =>
    setCompared((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const picked = solutions.filter((solution) => compared.includes(solution.id));

  return (
    <section>
      <BlockHead
        title={title ?? "Что подходит вашему объекту"}
        note={`проверили ${solutions.length} ${plural(solutions.length, "решение", "решения", "решений")} каталога, показываем ${visible.length}`}
      />

      <Toolbar roomy>
        <Search value={search} onChange={setSearch} placeholder="Поиск по названию или компании" />
        <Check label="скрыть неподходящие" checked={onlyFits} onToggle={() => setOnlyFits(!onlyFits)} />
        <Check label="реестр 719" checked={onlyRussian} onToggle={() => setOnlyRussian(!onlyRussian)} />
        <Check label="проверено ФЦ БАС" checked={onlyTested} onToggle={() => setOnlyTested(!onlyTested)} />
        {SORTS.map((item) => (
          <Pill key={item.id} active={sort === item.id} onClick={() => setSort(item.id)}>
            {item.label}
          </Pill>
        ))}
      </Toolbar>

      <CompareBar solutions={picked} onDrop={toggleCompare} />

      {/* подходящих мало: говорим прямо, сколько в каталоге под эту задачу и что делают остальные */}
      {fitting.length <= 1 && solutions.length > 0 && (
        <p className="u-frow-hint">
          Под {taskName ? `«${taskName.toLowerCase()}»` : "эту задачу"} в каталоге ФЦ БАС{" "}
          {fitting.length === 0
            ? "нет решений с проверенными ограничениями"
            : `одно решение: ${shortName(solutions, fitting[0].robot_id ?? "")}`}
          {others > 0 ? `, остальные ${others} делают другие задачи склада` : ""}
          {unchecked > 0 ? `, у ${unchecked} не хватает данных для проверки` : ""}.
          {fitting.length === 0 &&
            picks.length === 0 &&
            (unchecked > 0
              ? " Само решение не выберется: посмотрите список «Требуют проверки» ниже и выберите то, что проверите у поставщика."
              : " Само решение не выберется: выберите сами из списка ниже, расчет пойдет с предупреждением.")}
        </p>
      )}
      {/* смешанный парк: как добавить второе решение и почему не больше двух. Строка стоит и до
          выбора, иначе при выборе она появлялась и сдвигала карточки вниз прямо под курсором */}
      {picks.length < 2 && (
        <p className="u-frow-hint">
          На задачу можно взять два решения: {picks.length === 0 ? "после выбора первого " : ""}у подходящей карточки
          ссылка "взять вторым к этой задаче", объем между ними делится ползунком. Больше двух не берем: доля объема,
          парк и люди делятся между решениями, и с тремя картина уже не читается, а на складе так почти не делают.
        </p>
      )}
      {picks.length === 2 && (
        <Split
          task={manyTasks ? taskName : undefined}
          left={shortName(solutions, picks[0].robotId)}
          right={shortName(solutions, picks[1].robotId)}
          share={picks[0].share}
          onChange={onShare}
          onDrop={onDrop}
        />
      )}

      {visible.length === 0 && (
        <Notice title="Под такие условия решений не нашлось">
          Фильтры отсекли весь каталог. Снимите часть условий или поищите по другому слову.
        </Notice>
      )}

      {GROUPS.map((group) => {
        const items = visible.filter((solution) => solution.status === group.status);
        if (items.length === 0) return null;
        const card = (solution: Solution, compact: boolean) => (
          <SolutionCard
            key={solution.id}
            compact={compact}
            solution={solution}
            pick={picks.find((one) => one.robotId === solution.robot_id) ?? null}
            mixed={picks.length > 1}
            compared={compared.includes(solution.id)}
            budget={budget}
            fit={fits?.[solution.robot_id ?? ""]}
            // предупреждение про пик только у того, что можно посчитать на эту задачу
            peak={
              solution.can_calculate && !otherTask(solution)
                ? peakWarning(fits?.[solution.robot_id ?? ""], needsStations, planReady)
                : null
            }
            onPick={() => solution.robot_id && onPick(solution.robot_id)}
            onUnpick={() => solution.robot_id && onUnpick(solution.robot_id)}
            // второе решение можно добавить, пока первое выбрано, а второго еще нет. Решение
            // для другой задачи (уборщик в списке перевозки) в смешанный парк не зовем: это путает
            onAdd={
              picks.length === 1 && solution.can_calculate && solution.robot_id && !otherTask(solution)
                ? () => solution.robot_id && onAdd(solution.robot_id)
                : undefined
            }
            onCompare={() => toggleCompare(solution.id)}
          />
        );
        // Подходящие карточками, остальные свернутым списком строк: карточек было 31 на
        // странице, и подходящие терялись среди тех, что требуют проверки или не подходят.
        // Список раскрыт сразу, если в нем то, что уже выбрано
        if (group.status === "recommended")
          return (
            <div key={group.status}>
              <BlockHead title={`${group.title}: ${items.length}`} note={group.hint} />
              <Cards>{items.map((solution) => card(solution, false))}</Cards>
            </div>
          );
        return (
          <Fold
            key={group.status}
            title={`${group.title}: ${items.length}`}
            open={
              items.some((solution) => picks.some((one) => one.robotId === solution.robot_id)) ||
              group.status === waiting
            }
          >
            <p className="u-frow-hint">{group.hint}</p>
            <div className="u-lrows">{items.map((solution) => card(solution, true))}</div>
          </Fold>
        );
      })}
    </section>
  );
}

// Что отмечено для сравнения, видно в полосе действия внизу, рядом с главной кнопкой, а не во
// второй такой же полосе сверху: двух полос на экране не нужно. Сама таблица открывается
// панелью сбоку поверх списка: если она разворачивается где-то наверху страницы, кто не
// знает, не находит ее.
function CompareBar({ solutions, onDrop }: { solutions: Solution[]; onDrop: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (solutions.length === 0) return null;
  const names = solutions.map((solution) => solution.product.split(" (")[0]).join(", ");
  return (
    <>
      <ActionExtra>
        <span className="u-compare-note" title={names}>
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
        <Compare solutions={solutions} onDrop={onDrop} />
      </Drawer>
    </>
  );
}

function Compare({ solutions, onDrop }: { solutions: Solution[]; onDrop: (id: string) => void }) {
  const fields = new Map<string, string>();
  solutions.forEach((solution) => (solution.specs ?? []).forEach((spec) => fields.set(spec.field, spec.label)));

  return (
    <table className="compare">
      <thead>
        <tr>
          <th>Характеристика</th>
          {solutions.map((solution) => (
            <th key={solution.id}>
              {solution.product}
              <button className="u-hint" type="button" onClick={() => onDrop(solution.id)}>
                убрать
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Балл подбора</td>
          {solutions.map((solution) => (
            <td key={solution.id}>{scoreText(solution.score)}</td>
          ))}
        </tr>
        <tr>
          <td>Цена</td>
          {solutions.map((solution) => (
            <td key={solution.id}>{solution.price_rub ? money(solution.price_rub) : "нет в каталоге"}</td>
          ))}
        </tr>
        {[...fields].map(([field, label]) => (
          <tr key={field}>
            <td>{label}</td>
            {solutions.map((solution) => {
              const spec = (solution.specs ?? []).find((item) => item.field === field);
              return (
                <td key={solution.id}>
                  {spec ? spec.value : "нет данных"}
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

function SolutionCard({
  compact,
  solution,
  pick,
  mixed,
  compared,
  onPick,
  onUnpick,
  onAdd,
  onCompare,
  budget,
  fit,
  peak,
}: {
  /* строкой в свернутом списке, а не карточкой */
  compact: boolean;
  budget?: number | null;
  fit?: BudgetFit;
  /* быстрая оценка до прогона: решение может не покрыть пик задачи */
  peak?: string | null;
  solution: Solution;
  /* это решение выбрано на задаче, с его долей объема */
  pick: { robotId: string; share: number } | null;
  /* на задаче два решения: у выбранных подпись с долей */
  mixed: boolean;
  compared: boolean;
  onPick: () => void;
  onUnpick: () => void;
  onAdd?: () => void;
  onCompare: () => void;
}) {
  const picked = pick !== null;
  const blocking = solution.checks.filter((check) => check.outcome === "blocks");
  // не подходящее решение выбирается вторым нажатием: первое только спрашивает. Одним нажатием
  // сюда попадали по ошибке и уходили считать заведомо не проходящее
  const [sure, setSure] = useState(false);
  const doubtful = solution.status === "excluded" && !picked;
  const pickOrAsk = () => {
    if (doubtful && !sure) {
      setSure(true);
      return;
    }
    setSure(false);
    onPick();
  };
  const unknown = solution.checks.filter((check) => check.outcome === "unknown");
  const fits = solution.checks.filter((check) => check.outcome === "fits");

  // В каталоге название несет в скобках характеристику: «Ronavi H1500 (грузоподъемность до 1 500 кг)».
  // В заголовке оставляем модель, скобку уводим в строку под ней, иначе название занимает три строки.
  const [name, tail] = splitName(solution.product);

  const common = {
    title: name,
    subtitle: `${solution.vendor} · ${solution.subtype || solution.type}${tail ? ` · ${tail}` : ""}`,
    photo: `/api/catalog/photos/${solution.id}`,
    photoNote: "фото нет: запросим у производителя",
    picked,
    compared,
    onCompare,
    // решение для другой задачи не считаем даже «все равно»: оно не сойдется, это ловушка
    onPick: solution.can_calculate && !otherTask(solution) ? pickOrAsk : undefined,
    onUnpick,
    pickLabel: doubtful && sure ? "Точно посчитать?" : pickLabel(solution, picked, mixed && pick ? pick.share : null),
    extra:
      doubtful && sure ? (
        <span className="u-field-src">
          не подходит: {blocking[0]?.detail ?? "нарушено ключевое ограничение"}. Второе нажатие посчитает с
          предупреждением
        </span>
      ) : onAdd ? (
        // у выбранной карточки ссылка не нужна, но место под нее держим: карточки в ряду одной
        // высоты, и без этого "Выбрано" съезжало ниже соседних "Выбрать"
        <span className={picked ? "u-card-second is-hold" : "u-card-second"} aria-hidden={picked || undefined}>
          <Button kind="link" onClick={onAdd} title="Объем задачи поделится между двумя решениями">
            взять вторым к этой задаче
          </Button>
          <span className="u-field-src">объем задачи поделится между двумя решениями</span>
        </span>
      ) : undefined,
    badges: (
      <>
        <Badge tone="blue">балл {scoreText(solution.score)}</Badge>
        {solution.tested_fcbas && <Badge>проверено ФЦ БАС</Badge>}
        {solution.registry_719 && <Badge>реестр 719</Badge>}
        {solution.maturity === "piloting" && <Badge>пилот</Badge>}
      </>
    ),
    price: (
      <span title="Цена изделия из каталога ФЦ БАС: с НДС, без доставки, пусконаладки и интеграции">
        {solution.price_rub ? money(solution.price_rub) : "цены в каталоге нет"}
        {solution.raas_fee_rub_month && (
          <span className="u-card-rent">или аренда {money(solution.raas_fee_rub_month)} в месяц</span>
        )}
      </span>
    ),
    facts: (
      <>
        {!compact && <KeyNumbers solution={solution} />}
        {solution.can_calculate && solution.calc_note && <span className="warn">{solution.calc_note}</span>}
        {peak && <span className="warn">{peak}</span>}
        {budget && fitLine(fit) && <span className="u-card-budget">{fitLine(fit)}</span>}
        {blocking.slice(0, 2).map((check) => (
          <span key={check.label} className="warn">
            не проходит: {check.detail}
          </span>
        ))}
        {fits.slice(0, blocking.length ? 1 : 2).map((check) => (
          <span key={check.label}>{check.detail}</span>
        ))}
        {unknown.length > 0 && <span className="warn">не проверено: {unknown.length}</span>}
      </>
    ),
    details: (
      <Fold thin title="почему это решение здесь">
        <span className="u-card-facts">
          {fits.map((check) => (
            <span key={check.label}>подходит: {check.detail}</span>
          ))}
          {unknown.map((check) => (
            <span key={check.label} className="warn">
              не проверили: {check.detail}
            </span>
          ))}
          {blocking.map((check) => (
            <span key={check.label} className="warn">
              мешает: {check.detail}
            </span>
          ))}
          {solution.factors.map((factor) => (
            <span key={factor.label}>
              {factor.label}: {lower(factor.detail)}
            </span>
          ))}
          {solution.missing.length > 0 && (
            <span>не хватает характеристик: {solution.missing.map((key) => SPEC_NAMES[key] ?? key).join(", ")}</span>
          )}
        </span>
      </Fold>
    ),
  };

  if (!compact) return <Card {...common} />;
  // в строке одна причина словами: что мешает, что не проверили или что подходит
  const why = blocking[0] ? (
    <span className="warn">не проходит: {lower(blocking[0].detail)}</span>
  ) : unknown[0] ? (
    <span className="warn">не проверили: {unknown.map((check) => lower(check.label)).join(", ")}</span>
  ) : (
    fits[0]?.detail
  );
  return <ListRow {...common} why={why} />;
}

// Скорость, производительность и грузоподъемность строками, как записаны в каталоге: единица
// у каждого решения своя (паллет/ч, м²/ч, циклов/ч), в одну не переводим
function KeyNumbers({ solution }: { solution: Solution }) {
  const specs = new Map((solution.specs ?? []).map((spec) => [spec.field, spec]));
  const rows = KEY_SPECS.flatMap(({ field, name }) => {
    const spec = specs.get(field);
    if (!spec?.value) return [];
    // единица уже внутри записи ("5,2 паллеты/ч на робота") второй раз не пишем
    const unit = spec.unit && !spec.value.includes("/ч") ? ` ${spec.unit}` : "";
    return [{ name, text: `${spec.value.replace(/(\d)\.(\d)/g, "$1,$2")}${unit}`, trust: spec.trust }];
  });
  if (rows.length === 0) return null;
  return (
    <span className="u-card-keys">
      {rows.map((row) => (
        <span key={row.name}>
          <span className="u-card-key-name">{row.name}</span> <b className="mono">{row.text}</b>
        </span>
      ))}
    </span>
  );
}

// Подбор отметил, что решение сделано для другой задачи: проверка "Процесс" не проходит
function otherTask(solution: Solution): boolean {
  return solution.checks.some((check) => check.label === "Процесс" && check.outcome === "blocks");
}

// Балл подбора по-русски, с запятой: 0,79
function scoreText(score: number): string {
  return score.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Пояснение из подбора словами для строки после двоеточия: с маленькой буквы и с запятой в числе
function lower(text: string): string {
  const ru = text.replace(/(\d)\.(\d)/g, "$1,$2");
  return ru ? ru[0].toLowerCase() + ru.slice(1) : ru;
}

// Названия характеристик каталога, как в админке (backend/app/services/catalog_admin.py, FIELDS):
// сервер отдает недостающие ключами
const SPEC_NAMES: Record<string, string> = {
  payload_kg: "грузоподъемность",
  lift_height_mm: "высота подъема",
  min_aisle_width_mm: "ширина проезда",
  max_speed_m_s: "скорость",
  throughput: "производительность",
  runtime_h: "работа от заряда",
  charge_time_h: "время зарядки",
  navigation_type: "навигация",
  positioning_accuracy_mm: "точность позиционирования",
  dimensions_mm: "габариты",
  robot_mass_kg: "масса робота",
};

function splitName(product: string): [string, string] {
  const open = product.indexOf(" (");
  if (open < 0) return [product, ""];
  return [product.slice(0, open), product.slice(open + 2).replace(")", "")];
}

function pickLabel(solution: Solution, picked: boolean, share: number | null): string {
  if (!solution.can_calculate) return solution.calc_note || "Не считается: нет расчетных параметров робота";
  if (otherTask(solution) && !picked) return "Решение для другой задачи";
  if (picked) return share === null ? "Выбрано" : `Выбрано, ${Math.round(share * 100)}% объема`;
  return solution.status === "excluded" ? "Все равно посчитать" : "Выбрать";
}
