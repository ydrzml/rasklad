import { useCallback, useEffect, useState } from "react";
import { updates as api, type UpdateItem, type Updates } from "../../api/admin";
import { Alert, Badge, Button, Fold, Waiting } from "../../ui";

// Обновления с сайтов производителей. Сервер обходит страницы, с которых мы собирали характеристики,
// и сверяет цифры. Каталог сам не меняется: расхождение приходит сюда предложением, администратор
// принимает его с оценкой или отклоняет, и то и другое попадает в журнал правок.

const RATINGS = ["S", "A", "B", "C", "D", "E", "F"];
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

export function UpdatesPanel({ onChanged, onClose }: { onChanged: (message: string) => void; onClose: () => void }) {
  const [data, setData] = useState<Updates | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get());
      setError(null);
    } catch (reason) {
      setError(problem(reason));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Пока проверка идет, спрашиваем ход раз в полторы секунды
  const running = data?.run.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(load, 1500);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function start(source: "web" | "saved") {
    try {
      await api.run(source);
    } catch (reason) {
      setError(problem(reason));
    }
    await load();
  }

  async function decide(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      onChanged(message);
    } catch (reason) {
      setError(problem(reason));
    }
    await load();
  }

  const run = data?.run;
  const items = data?.items ?? [];
  const open = items.filter((i) => i.outcome === "differs" && i.status === "new");
  const decided = items.filter((i) => i.outcome === "differs" && i.status !== "new");
  const manual = items.filter((i) => i.outcome === "manual" || i.outcome === "blocked");
  const same = items.filter((i) => i.outcome === "same");
  const pages = new Set(items.map((i) => i.url)).size;

  return (
    <div className="a-plate">
      <h3>Обновления с сайтов производителей</h3>
      <p className="a-faint">
        Сверяем характеристики каталога со страницами производителей, с которых их собирали. Каталог сам не меняется:
        если цифра на странице другая, здесь появится предложение правки со ссылкой и датой. Сайты, которые запрещают
        автоматический сбор, не открываем.
      </p>
      <div className="a-row">
        <Button onClick={() => start("web")} disabled={!data || running}>
          Проверить на сайтах
        </Button>
        <Button kind="ghost" onClick={() => start("saved")} disabled={!data || running || !run?.saved_pages}>
          По сохраненным страницам{run?.saved_pages ? ` (${run.saved_pages})` : ""}
        </Button>
        <span className="a-gap" />
        <Button kind="link" onClick={onClose}>
          Закрыть
        </Button>
      </div>

      {!data && !error && <Waiting title="Загружаем результаты проверки" />}
      {error && <Alert>{error}</Alert>}
      {run?.running && (
        <Waiting
          title={`Проверено ${run.done} из ${run.total} страниц`}
          note="страница раз в две секунды, чтобы не нагружать сайты; окно можно закрыть, проверка идет на сервере"
        />
      )}
      {run && !run.running && run.offline && (
        <Alert>
          Нет доступа в интернет. Проверьте по сохраненным страницам: это строки нескольких сайтов из данных.
        </Alert>
      )}
      {run && !run.running && run.finished_at && !run.offline && (
        <p>
          Проверка {when.format(new Date(run.finished_at))}
          {run.source === "saved" ? " по сохраненным страницам" : ""}: совпало{" "}
          <span className="mono">{run.counts.same ?? 0}</span>, расходится{" "}
          <span className="mono">{run.counts.differs ?? 0}</span>, проверить руками{" "}
          <span className="mono">{(run.counts.manual ?? 0) + (run.counts.blocked ?? 0)}</span>.
        </p>
      )}
      {data && !run?.running && !run?.finished_at && items.length > 0 && (
        <p className="a-faint">
          Ниже результаты прошлой проверки: страниц {pages}, совпало значений {same.length}.
        </p>
      )}

      {open.length > 0 && (
        <div className="a-proposals">
          <b>Предложения правки: {open.length}</b>
          {open.map((item) => (
            <Proposal
              key={item.id}
              item={item}
              onAccept={(value, rating) =>
                decide(
                  () => api.accept(item.id, value, rating),
                  `${item.solution_name}: ${item.label.toLowerCase()} теперь ${value}, источник в журнале`,
                )
              }
              onReject={() =>
                decide(() => api.reject(item.id), `${item.solution_name}: предложение отклонено, записано в журнал`)
              }
            />
          ))}
        </div>
      )}
      {data && open.length === 0 && run?.finished_at && !run.offline && (
        <Alert tone="note">Новых расхождений нет: страницы пишут те же цифры, что в каталоге.</Alert>
      )}

      {decided.length > 0 && (
        <Fold title={`Разобранные предложения: ${decided.length}`}>
          <ul className="a-checks-list">
            {decided.map((item) => (
              <li key={item.id}>
                <Badge tone={item.status === "accepted" ? "blue" : "grey"}>
                  {item.status === "accepted" ? "принято" : "отклонено"}
                </Badge>{" "}
                {item.solution_name} · {item.label}: {item.current} → {item.proposed}
                <span className="a-faint"> · {item.decided_by}</span>
              </li>
            ))}
          </ul>
        </Fold>
      )}
      {manual.length > 0 && (
        <Fold title={`Проверить руками: ${manual.length}`}>
          <ul className="a-checks-list">
            {manual.map((item) => (
              <li key={item.id}>
                {item.solution_name} · {item.label}
                <span className="a-faint"> · {item.note}</span>{" "}
                <a href={item.url} target="_blank" rel="noreferrer">
                  страница
                </a>
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </div>
  );
}

function Proposal({
  item,
  onAccept,
  onReject,
}: {
  item: UpdateItem;
  onAccept: (value: string, rating: string) => void;
  onReject: () => void;
}) {
  const [value, setValue] = useState(item.proposed);
  const [rating, setRating] = useState("C");
  return (
    <div className="a-proposal">
      <div>
        <b>{item.solution_name}</b> · {item.label}
        <span className="a-diff">
          в каталоге <s>{item.current || "пусто"}</s>, на странице <b>{item.proposed}</b>
        </span>
        <span className="a-faint">
          {`"${item.found_text}"`} ·{" "}
          <a href={item.url} target="_blank" rel="noreferrer">
            страница производителя
          </a>{" "}
          · проверено {when.format(new Date(item.checked_at))}
          {item.source === "saved" && " по сохраненной странице"} · {item.note}
        </span>
      </div>
      <span className="a-row">
        <input
          className="a-input"
          aria-label={`${item.label}: новое значение`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <span className="a-rating">
          <select
            className="u-select"
            aria-label={`${item.label}: оценка`}
            title="Оценка доверия. C: один источник, производитель"
            value={rating}
            onChange={(e) => setRating(e.target.value)}
          >
            {RATINGS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </span>
        <Button onClick={() => onAccept(value.trim(), rating)} disabled={!value.trim()}>
          Принять
        </Button>
        <Button kind="link" onClick={onReject}>
          Отклонить
        </Button>
      </span>
    </div>
  );
}
