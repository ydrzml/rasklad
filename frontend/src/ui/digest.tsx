import type { ReactNode } from "react";

import { Arrow } from "./index";
import "./digest.css";

/* Строка-сводка блока: заголовок, одно-три главных числа или вывод строкой и кнопка "Подробнее".
   Строки идут списком одна под другой на всю ширину. Полный блок раскрывается прямо под своей
   строкой; открыть можно несколько сразу, остальные при этом не закрываются.
   Полный блок смонтирован всегда, только спрятан: он считается фоном (что будет, если; готовность)
   и не теряет состояние, а ссылки "как посчитано" находят в нем свои якоря */
export type DigestFact = { label: string; value: string; unit?: string };

export function Digests({ children }: { children: ReactNode }) {
  return <div className="u-digests">{children}</div>;
}

export function Digest({
  id,
  title,
  facts = [],
  line,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  facts?: DigestFact[];
  line?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /* полный блок: встает под строкой, когда она раскрыта */
  children: ReactNode;
}) {
  return (
    <div className={open ? "u-digest is-open" : "u-digest"} data-digest={id}>
      <div className="u-digest-row">
        <div className="u-digest-text">
          <h2>{title}</h2>
          {line && <p className="u-digest-line">{line}</p>}
        </div>
        {facts.length > 0 && (
          <dl className="u-digest-facts">
            {facts.map((fact, index) => (
              <div key={`${fact.label}-${index}`}>
                <dt>{fact.label}</dt>
                <dd className="mono">
                  {fact.value}
                  {fact.unit && <small> {fact.unit}</small>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <button
          type="button"
          className="u-digest-more"
          aria-expanded={open}
          aria-controls={`more-${id}`}
          onClick={onToggle}
        >
          {open ? "Свернуть" : "Подробнее"}
          <span className="u-chev" aria-hidden="true">
            <Arrow />
          </span>
        </button>
      </div>
      <div id={`more-${id}`} className="u-digest-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
