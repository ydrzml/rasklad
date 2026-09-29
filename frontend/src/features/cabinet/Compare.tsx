import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { projects, type Comparison, type CompareRow } from "../../api/projects";
import { Alert, Badge, Button, Hero, Notice, Pill, Toolbar, Waiting } from "../../ui";
import { best, compareUrl, counted, day, delta, problem, PROJECTS, shown } from "./format";

// Проекты рядом: что получилось и что ввели. Первая колонка точка отсчета, у остальных под
// числом разница с ней. Цифры из сохраненных версий, сервер ничего не пересчитывает.

type Item = { project_id: number; version: number | null };

// Пометка снятой с расчета задачи приглушенно: сервер пишет ее в тексте строки «Задачи»
const EXCLUDED_MARK = "(снята с расчета)";

function cell(value: string | number | null, unit: string) {
  if (typeof value !== "string" || !value.includes(EXCLUDED_MARK)) return shown(value, unit);
  return value.split(EXCLUDED_MARK).flatMap((piece, index, all) =>
    index < all.length - 1
      ? [
          piece,
          <span key={index} className="c-faint">
            {EXCLUDED_MARK}
          </span>,
        ]
      : [piece],
  );
}

export function CompareScreen({ items }: { items: Item[] }) {
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyDiff, setOnlyDiff] = useState(false);

  useEffect(() => {
    let live = true;
    projects
      .compare(items)
      .then((found) => live && setData(found))
      .catch((reason) => live && setError(problem(reason)));
    return () => {
      live = false;
    };
    // список в адресе меняется только переходом, сравнивать массивы по ссылке тут незачем
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(items)]);

  const changed = useMemo(
    () => (data ? data.inputs.filter((row) => row.differs).map((row) => row.label.toLowerCase()) : []),
    [data],
  );

  const back = (
    <a className="c-back" href="/projects">
      ← Мои проекты
    </a>
  );

  if (items.length < 2) {
    return (
      <>
        {back}
        <Notice title="Сравнивать нечего">
          Отметьте в кабинете два проекта или больше и нажмите «Сравнить». Можно сравнить и две версии одного проекта из
          его истории.
        </Notice>
      </>
    );
  }
  if (error) {
    return (
      <>
        {back}
        <Notice title="Не получилось сравнить">
          {error}. Проверьте, что проекты не удалены и в них есть сохранения.
        </Notice>
      </>
    );
  }
  if (!data) return <Waiting title="Собираем сравнение" />;

  const without = (index: number) => compareUrl(items.filter((_, at) => at !== index));
  const tone = (column: number) => (column === 0 ? "is-base" : "");

  return (
    <>
      {back}
      <Hero
        compact
        title="Сравнение проектов"
        lead="Цифры из сохраненных версий, как их видели при сохранении. Первая колонка точка отсчета: под числами остальных видно, на сколько они от нее отличаются."
      />

      <p className="c-diff-line">
        {changed.length ? (
          <>
            Во вводе отличается: <b>{changed.join(", ")}</b>.
          </>
        ) : (
          "Ввод у всех одинаковый: разница только в том, когда сохраняли."
        )}
      </p>

      <Toolbar>
        <Pill active={!onlyDiff} onClick={() => setOnlyDiff(false)}>
          Все строки
        </Pill>
        <Pill active={onlyDiff} onClick={() => setOnlyDiff(true)}>
          Только отличия
        </Pill>
        {data.horizon_years && (
          <span className="c-faint c-horizon">Стоимость владения за {data.horizon_years} лет</span>
        )}
      </Toolbar>

      {data.columns.some((column) => !column.same_data) && (
        <p className="c-said">
          <Alert tone="note">
            Часть проектов сохранена на прежних нормативах или каталоге. Чтобы сравнить на одних данных, откройте их в
            расчете и сохраните заново.
          </Alert>
        </p>
      )}

      <Scroller count={data.columns.length}>
        <table className="c-compare" style={{ "--n": data.columns.length } as CSSProperties}>
          <thead>
            <tr>
              <th scope="col" className="c-compare-corner" />
              {data.columns.map((column, index) => (
                <th scope="col" key={`${column.project_id}.${column.version}`} className={tone(index)}>
                  <a href={`/calc?project=${column.project_id}&version=${column.version}&open=1`} title={column.name}>
                    {column.name}
                  </a>
                  <span className="c-compare-meta mono">
                    версия {column.version} · {day(column.saved_at)}
                  </span>
                  {index === 0 ? (
                    <Badge tone="blue">точка отсчета</Badge>
                  ) : (
                    <a className="c-compare-drop" href={without(index)}>
                      убрать
                    </a>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <Block title="Что получилось" rows={data.results} onlyDiff={onlyDiff} deltas tone={tone} />
          <Block title="Что ввели" rows={data.inputs} onlyDiff={onlyDiff} tone={tone} />
        </table>
      </Scroller>

      <p className="c-faint c-hint">
        Голубым отмечен ввод, который отличается. «Лучше» стоит у самой низкой стоимости и самого короткого срока в
        строке.
      </p>
      <div className="c-row">
        <Button kind="ghost" onClick={() => window.print()}>
          Распечатать
        </Button>
      </div>
    </>
  );
}

function Block({
  title,
  rows,
  onlyDiff,
  deltas,
  tone,
}: {
  title: string;
  rows: CompareRow[];
  onlyDiff: boolean;
  deltas?: boolean;
  tone: (column: number) => string;
}) {
  const shownRows = onlyDiff ? rows.filter((row) => row.differs) : rows;
  return (
    <tbody>
      <tr className="c-compare-block">
        <th scope="colgroup" colSpan={(rows[0]?.values.length ?? 0) + 1}>
          <span className="c-compare-block-name">{title}</span>
        </th>
      </tr>
      {shownRows.length === 0 && (
        <tr>
          <td className="c-faint" colSpan={(rows[0]?.values.length ?? 0) + 1}>
            Здесь все одинаково
          </td>
        </tr>
      )}
      {shownRows.map((row, index) => {
        // подпись блока (задача, сценарий) над первой его строкой
        const head = row.group !== shownRows[index - 1]?.group ? row.group : null;
        const winner = best(row);
        return (
          <tr key={row.key} className={row.differs && !deltas ? "is-diff" : undefined}>
            <th scope="row">
              {head && <span className="c-compare-group">{head}</span>}
              {row.label}
            </th>
            {row.values.map((value, index) => {
              const change = deltas && index > 0 ? delta(value, row.values[0], row.unit) : null;
              return (
                <td key={index} className={tone(index)}>
                  <span className={typeof value === "string" ? undefined : "mono"}>{cell(value, row.unit)}</span>
                  {change && <span className="c-compare-delta mono">{change}</span>}
                  {winner === index && <Badge tone="blue">лучше</Badge>}
                </td>
              );
            })}
          </tr>
        );
      })}
    </tbody>
  );
}

// Таблица шире экрана (на телефоне уже третий проект не помещается) прокручивается вбок внутри себя.
// Чтобы это было видно, над ней строка "листайте вбок", а у правого края тень, пока справа еще что-то есть
function Scroller({ count, children }: { count: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => {
      const hidden = node.scrollWidth - node.clientWidth;
      setWide(hidden > 2);
      setMore(hidden - node.scrollLeft > 2);
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      watch.disconnect();
    };
  }, []);

  return (
    <>
      {wide && (
        <p className="c-compare-swipe" aria-hidden="true">
          {counted(count, PROJECTS)} рядом, листайте вбок <span>→</span>
        </p>
      )}
      <div className={more ? "c-compare-frame is-more" : "c-compare-frame"}>
        <div className="c-compare-scroll" ref={box}>
          {children}
        </div>
      </div>
    </>
  );
}
