import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  norms,
  type Norm,
  type NormChange,
  type NormEdit,
  type NormImportResult,
  type NormList,
} from "../../api/norms";
import {
  Alert,
  Badge,
  BlockHead,
  Button,
  Check,
  Notice,
  Pill,
  Search,
  Sheet,
  SheetRow,
  Toolbar,
  Trust,
  Waiting,
} from "../../ui";
import { groupDigits, plainDigits, unitText } from "../../ui/digits";
import "./norms.css";

// Раздел "Нормативы": взносы, рабочие часы, резервы, цены и значения по умолчанию параметров.
// Значения по умолчанию с источниками лежат в config/model.yaml, правка администратора хранится
// в базе поверх и сразу идет в расчет. Каждая правка, возврат и загрузка файла попадают в журнал.

const RATINGS: NormEdit["trust"][] = ["S", "A", "B", "C", "D", "E", "F"];
const RATING_NAMES: Record<string, string> = {
  S: "эталон: закон, ТЗ, производственный календарь",
  A: "проверено: производитель и независимая проверка",
  B: "подтверждено: сходятся два типа источников",
  C: "один источник",
  D: "слабо: только организатор или только СМИ",
  E: "спорно: источники расходятся",
  F: "нет данных, допущение команды",
};
const ACTIONS: Record<string, string> = {
  edit: "поправлен норматив",
  reset: "возвращено значение из файла",
  import: "загружен из файла",
};
const PARTS: Record<string, string> = { value: "значение", source: "источник", date: "дата", trust: "оценка" };
const WEAK = "EF";

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

function number(value: number): string {
  return groupDigits(String(value));
}

function range(norm: Norm): string {
  const hard = `допустимо от ${number(norm.min)} до ${number(norm.max)}`;
  const typical =
    norm.typical_min !== null && norm.typical_max !== null
      ? `, по датасету ${number(norm.typical_min)}-${number(norm.typical_max)}`
      : "";
  return `${hard}${typical}${norm.whole ? ", целое" : ""}`;
}

function valueWord(count: number): string {
  if (count % 10 === 1 && count % 100 !== 11) return "значение";
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return "значения";
  return "значений";
}

export function NormsPanel() {
  const [data, setData] = useState<NormList | null>(null);
  const [recent, setRecent] = useState<NormChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [typed, setTyped] = useState("");
  const [onlyEdited, setOnlyEdited] = useState(false);
  const [onlyWeak, setOnlyWeak] = useState(false);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await norms.list());
      setRecent(await norms.changes(8));
      setError(null);
    } catch (reason) {
      setError(problem(reason));
    }
  }, []);

  useEffect(() => {
    // Список грузится с сервера один раз, дальше после каждой правки
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const items = useMemo(() => {
    const words = typed.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (norm) =>
        (!group || norm.group === group) &&
        (!onlyEdited || norm.edited) &&
        (!onlyWeak || WEAK.includes(norm.trust)) &&
        (!words || `${norm.name} ${norm.code}`.toLowerCase().includes(words)),
    );
  }, [data, group, typed, onlyEdited, onlyWeak]);

  const all = data?.items ?? [];
  const edited = all.filter((norm) => norm.edited).length;
  const weak = all.filter((norm) => WEAK.includes(norm.trust)).length;

  async function changed(message: string) {
    setNotice(message);
    await load();
  }

  return (
    <section>
      <BlockHead
        title="Нормативы"
        note={
          data
            ? `${all.length} ${valueWord(all.length)}${edited ? `, правил администратор: ${edited}` : ""}`
            : undefined
        }
        aside={
          <span className="a-row">
            <a className="u-btn u-btn-ghost" href={norms.exportUrl("xlsx")} download>
              Скачать нормативы
            </a>
            <Button kind="ghost" onClick={() => setImporting(!importing)}>
              Загрузить файл
            </Button>
          </span>
        }
      />
      <p className="a-faint a-lead">
        По умолчанию значения берутся из файла модели с источниками. Правка администратора ложится поверх и сразу идет в
        расчет, в "Откуда цифры" видно, кто и когда ее сделал. Вернуть значение из файла можно одной кнопкой.
      </p>

      {importing && <ImportPanel onDone={changed} onClose={() => setImporting(false)} />}

      <Toolbar>
        <Search value={typed} onChange={setTyped} placeholder="Название или код" />
        <Check
          label={`правил администратор${edited ? ` (${edited})` : ""}`}
          checked={onlyEdited}
          onToggle={() => setOnlyEdited(!onlyEdited)}
        />
        <Check
          label={`без источника, E и F${weak ? ` (${weak})` : ""}`}
          checked={onlyWeak}
          onToggle={() => setOnlyWeak(!onlyWeak)}
        />
      </Toolbar>
      <Toolbar>
        {[{ id: "", name: "Все" }, ...(data?.groups ?? [])].map((item) => (
          <Pill key={item.id} active={group === item.id} onClick={() => setGroup(item.id)}>
            {item.name}
          </Pill>
        ))}
      </Toolbar>

      {notice && (
        <p className="a-said" role="status">
          <Alert tone="note">{notice}</Alert>
        </p>
      )}
      {error && <Notice title="Не получилось загрузить нормативы">{error}</Notice>}
      {!data && !error && <Waiting title="Загружаем нормативы" />}
      {data && items.length === 0 && (
        <Notice title="Ничего не нашлось">Поменяйте раздел или поищите часть названия.</Notice>
      )}
      {items.length > 0 && (
        <Sheet
          columns={[
            { name: "Норматив" },
            { name: "Значение", width: "170px" },
            { name: "Оценка", width: "70px", hint: "От S (закон) до F (источника нет)" },
            { name: "Источник", width: "minmax(0, 1.2fr)" },
            { name: "Что меняет в расчете", width: "minmax(0, 1.1fr)" },
            { name: "", width: "100px" },
          ]}
        >
          {items.map((norm) => {
            const open = openCode === norm.code;
            return (
              <SheetRow
                key={norm.code}
                cells={[
                  <button className="a-name" aria-expanded={open} onClick={() => setOpenCode(open ? null : norm.code)}>
                    <b>{norm.name}</b>
                    <span className="mono a-code">{norm.code}</span>
                  </button>,
                  <span>
                    <span className="mono">{number(norm.value)}</span>{" "}
                    <span className="a-faint">{unitText(norm.unit)}</span>
                    {norm.edited && (
                      <>
                        <br />
                        <Badge tone="blue">правил администратор</Badge>
                      </>
                    )}
                  </span>,
                  <Trust level={norm.trust} title={RATING_NAMES[norm.trust]} />,
                  <span className="a-clamp" title={norm.source}>
                    {norm.source}
                    {norm.date && <span className="a-faint"> · {norm.date}</span>}
                  </span>,
                  <span className="a-faint a-clamp" title={norm.effect}>
                    {norm.effect}
                  </span>,
                  <Button kind="link" onClick={() => setOpenCode(open ? null : norm.code)}>
                    {open ? "Свернуть" : "Править"}
                  </Button>,
                ]}
                notes={
                  open ? <NormEditor key={norm.edited?.at ?? "file"} norm={norm} onChanged={changed} /> : undefined
                }
              />
            );
          })}
        </Sheet>
      )}

      {recent.length > 0 && (
        <div className="a-recent">
          <BlockHead title="Последние правки нормативов" note="весь журнал в служебных таблицах" />
          <History changes={recent} withName />
        </div>
      )}
    </section>
  );
}

function NormEditor({ norm, onChanged }: { norm: Norm; onChanged: (message: string) => Promise<void> }) {
  const [value, setValue] = useState(number(norm.value));
  const [trust, setTrust] = useState<NormEdit["trust"]>(norm.trust);
  const [date, setDate] = useState(norm.date ?? "");
  const [source, setSource] = useState(norm.source);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<NormChange[]>([]);

  useEffect(() => {
    norms
      .changes(5, norm.code)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [norm.code]);

  const plain = plainDigits(value);
  const dirty =
    plain !== String(norm.value) || trust !== norm.trust || date !== (norm.date ?? "") || source !== norm.source;

  async function act(action: () => Promise<Norm>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged(message);
    } catch (reason) {
      setError(problem(reason));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (plain === null || plain === "") {
      setError("Значение должно быть числом");
      return;
    }
    act(
      () => norms.save(norm.code, { value: Number(plain), trust, date: date.trim() || null, source }),
      `"${norm.name}" поправлен, расчет уже берет новое значение`,
    );
  }

  return (
    <div className="a-editor">
      <div className="a-form">
        <label className="a-field">
          <span>Значение{norm.unit && `, ${unitText(norm.unit)}`}</span>
          <input
            className="a-input mono"
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <span className="a-faint">{range(norm)}</span>
        </label>
        <label className="a-field">
          <span>Оценка</span>
          <select
            className="u-select"
            title={RATING_NAMES[trust]}
            value={trust}
            onChange={(event) => setTrust(event.target.value as NormEdit["trust"])}
          >
            {RATINGS.map((r) => (
              <option key={r} value={r}>
                {r}, {RATING_NAMES[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="a-field">
          <span>Дата источника</span>
          <input
            className="a-input mono"
            value={date}
            placeholder="ГГГГ-ММ или ГГГГ-ММ-ДД"
            onChange={(event) => setDate(event.target.value)}
          />
          <span className="a-faint">{trust === "F" ? "при F можно не ставить" : "обязательна"}</span>
        </label>
        <span />
        <label className="a-field is-wide">
          <span>Источник</span>
          <textarea className="a-input" rows={2} value={source} onChange={(event) => setSource(event.target.value)} />
        </label>
      </div>
      <p className="a-faint">Что меняет в расчете: {norm.effect}.</p>
      {norm.edited && (
        <Alert tone="note">
          В файле модели: {number(norm.file.value)} {unitText(norm.unit)}, оценка {norm.file.trust}, {norm.file.source}
          {norm.file.date && ` (${norm.file.date})`}
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="a-row">
        <Button onClick={save} disabled={busy || !dirty}>
          Сохранить
        </Button>
        {norm.edited && (
          <Button
            kind="ghost"
            disabled={busy}
            onClick={() => act(() => norms.reset(norm.code), `"${norm.name}": вернули значение из файла модели`)}
          >
            Вернуть из файла
          </Button>
        )}
        <span className="a-faint">
          {norm.edited
            ? `правил ${norm.edited.by || "администратор"}, ${when.format(new Date(norm.edited.at))}`
            : "значение из файла модели"}
        </span>
      </div>
      {history.length > 0 && <History changes={history} />}
    </div>
  );
}

function ImportPanel({ onDone, onClose }: { onDone: (message: string) => Promise<void>; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<NormImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const report = await norms.importFile(file, dryRun);
      setResult(report);
      if (!dryRun) await onDone(`Файл загружен: поменялось нормативов ${report.applied}, с ошибками ${report.errors}`);
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

  const problems = result?.rows.filter((row) => row.status !== "ok") ?? [];

  return (
    <div className="a-plate">
      <h3>Загрузить нормативы файлом</h3>
      <p className="a-faint">
        Excel или CSV в формате кнопки "Скачать нормативы": код, название, значение, единица, источник, дата, оценка.
        Каждая строка проверяется отдельно: известен ли код, число ли значение, та ли единица (для доли можно проценты),
        в границах ли, есть ли источник и дата. Строка с ошибкой не мешает остальным. Значение как в файле модели
        снимает правку. Сначала можно только проверить: ничего не запишется.
      </p>
      <div className="a-row">
        <label className="u-btn u-btn-ghost a-file">
          <input type="file" accept=".csv,.xlsx" onChange={pick} disabled={busy} />
          {file ? file.name : "Выбрать файл"}
        </label>
        <Button kind="ghost" onClick={() => run(true)} disabled={!file || busy}>
          Только проверить
        </Button>
        <Button onClick={() => run(false)} disabled={!file || busy}>
          Загрузить
        </Button>
        <span className="a-gap" />
        <a className="u-btn u-btn-link" href={norms.exportUrl("csv")} download>
          CSV вместо Excel
        </a>
        <Button kind="link" onClick={onClose}>
          Закрыть
        </Button>
      </div>
      {busy && <Waiting title="Проверяем строки" />}
      {error && <Alert>{error}</Alert>}
      {result && (
        <div className="a-report">
          <p>
            <b>{result.dry_run ? "Проверка без записи." : "Загружено."}</b> Строк{" "}
            <span className="mono">{result.rows.length}</span>: поменяется{" "}
            <span className="mono">{result.applied}</span>, без изменений{" "}
            <span className="mono">{result.unchanged}</span>, с предупреждением{" "}
            <span className="mono">{result.warnings}</span>, с ошибками <span className="mono">{result.errors}</span>.
          </p>
          {problems.slice(0, 30).map((row) => (
            <Alert key={`${row.sheet}-${row.row}`} tone={row.status === "warn" ? "note" : "warn"}>
              Строка {row.row}, {row.field}: {row.message}
            </Alert>
          ))}
          {problems.length > 30 && <p className="a-faint">и еще {problems.length - 30}</p>}
        </div>
      )}
    </div>
  );
}

function History({ changes, withName }: { changes: NormChange[]; withName?: boolean }) {
  return (
    <ul className="a-history">
      {changes.map((change) => (
        <li key={change.id}>
          <span className="mono a-faint">{when.format(new Date(change.at))}</span>
          <span>
            <b>{ACTIONS[change.action] ?? change.action}</b>
            {withName && <> · {change.name}</>}
            <span className="a-faint"> · {change.user_email || "система"}</span>
            {change.note && <span className="a-faint"> · {change.note}</span>}
            {!withName &&
              Object.entries(change.changes).map(([key, pair]) =>
                Array.isArray(pair) ? (
                  <span key={key} className="a-diff">
                    {PARTS[key] ?? key}: <s>{show(pair[0])}</s> → <b>{show(pair[1])}</b>
                  </span>
                ) : null,
              )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "пусто";
  if (typeof value === "number") return number(value);
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
