import type { ReactNode } from "react";
import "./checklist.css";

/* Список дел с тремя состояниями: переделать, проверить, готово. Так инженер видит, с чего начать.
   Цвет не единственный знак: у каждой строки состояние написано словом. Готовое свернуто одной
   строкой, иначе оно отодвигает то, что надо сделать. */
export type ChecklistStatus = "redo" | "check" | "ready";

export type ChecklistItem = {
  key: string;
  status: ChecklistStatus;
  title: string;
  /* к чему пункт: название решения, если решений несколько */
  tag?: string;
  text: string;
  /* по какой проверке или характеристике, с источником */
  basis: string;
  trust?: string;
  /* полный адрес источника: сайт из основания становится ссылкой */
  link?: string;
  /* сумма, если у цены есть источник, и из чего она или почему ее нет */
  cost?: string;
  costNote?: string;
};

const WORDS: Record<ChecklistStatus, string> = { redo: "переделать", check: "проверить", ready: "готово" };

function Mark({ status }: { status: ChecklistStatus }) {
  return (
    <span className="u-todo-mark" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        {status === "ready" ? (
          <path d="M2.5 6.3l2.3 2.2 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        ) : status === "redo" ? (
          <path d="M6 2.6v4.2M6 9.2v.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        ) : (
          <circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.5" />
        )}
      </svg>
    </span>
  );
}

/* Сайт источника без служебного поддомена и пути: dikom-a.ru, а не адрес файла целиком */
function site(link: string): string {
  try {
    const parts = new URL(link).hostname.replace(/^www\./, "").split(".");
    return parts.slice(-2).join(".");
  } catch {
    return "";
  }
}

function linked(text: string, link?: string): ReactNode {
  const name = link ? site(link) : "";
  const at = name ? text.indexOf(name) : -1;
  if (!link || at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <a href={link} target="_blank" rel="noreferrer">
        {name}
      </a>
      {text.slice(at + name.length)}
    </>
  );
}

function Row({ item }: { item: ChecklistItem }) {
  return (
    <li className={`u-todo-row is-${item.status}`}>
      <Mark status={item.status} />
      <div className="u-todo-body">
        <div className="u-todo-title">
          <span className="u-todo-word">{WORDS[item.status]}</span>
          <strong>{item.title}</strong>
          {item.tag && <span className="u-todo-tag">{item.tag}</span>}
        </div>
        <p>{item.text}</p>
        <small>
          {item.trust && (
            <span className="u-trust" title={`Оценка доверия ${item.trust}`}>
              {item.trust}
            </span>
          )}
          <span className="u-todo-basis">{linked(item.basis, item.link)}</span>
        </small>
        {item.link && (
          <a className="u-todo-src" href={item.link} target="_blank" rel="noreferrer">
            Источник: {site(item.link)}
          </a>
        )}
      </div>
      <span className="u-todo-cost">
        {item.cost && <span className="mono">{item.cost}</span>}
        {item.costNote && <small>{item.costNote}</small>}
      </span>
    </li>
  );
}

export function Checklist({ items, foot }: { items: ChecklistItem[]; foot?: ReactNode }) {
  const open = items.filter((item) => item.status !== "ready");
  const ready = items.filter((item) => item.status === "ready");
  const count = (status: ChecklistStatus) => items.filter((item) => item.status === status).length;
  return (
    <div className="u-panel u-todo">
      <dl className="u-todo-counts">
        {(["redo", "check", "ready"] as const).map((status) => (
          <div key={status} className={count(status) ? `is-${status}` : `is-${status} is-zero`}>
            <dt>
              <Mark status={status} />
              {WORDS[status]}
            </dt>
            <dd className="mono">{count(status)}</dd>
          </div>
        ))}
        <div className="u-todo-costhead">
          <dt>стоимость</dt>
          <dd>если у цены есть источник</dd>
        </div>
      </dl>
      {open.length > 0 && (
        <ul className="u-todo-list">
          {open.map((item) => (
            <Row key={item.key} item={item} />
          ))}
        </ul>
      )}
      {ready.length > 0 && (
        <details className="u-todo-ready">
          <summary>
            <Mark status="ready" />
            Готово: {[...new Set(ready.map((item) => item.title.toLowerCase()))].join(", ")}
          </summary>
          <ul className="u-todo-list">
            {ready.map((item) => (
              <Row key={item.key} item={item} />
            ))}
          </ul>
        </details>
      )}
      {foot && <div className="u-todo-foot">{foot}</div>}
    </div>
  );
}
