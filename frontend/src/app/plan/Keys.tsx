import { useEffect, useRef } from "react";

/* Горячие клавиши чертежа списком. Открывается клавишей "?" или кнопкой у масштаба. Все клавиши
   здесь уже работают на листе: окно только собирает их в одном месте. */

type Row = [keys: string, what: string];

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Выбрать и поправить",
    rows: [
      ["Щелчок", "выбрать объект"],
      ["Двойной щелчок по ряду", "выбрать один ряд из группы"],
      ["Shift + щелчок", "добавить к выбранному или убрать"],
      ["Рамка по пустому месту", "выбрать все, что она задела"],
      ["Ctrl + A", "выбрать все на листе"],
      ["Del", "удалить выбранное"],
      ["Esc", "снять выбор или выйти из инструмента"],
    ],
  },
  {
    title: "Копировать",
    rows: [
      ["Ctrl + C", "скопировать выбранное"],
      ["Ctrl + V", "вставить туда, где мышь"],
      ["Ctrl + D", "дублировать рядом"],
    ],
  },
  {
    title: "Двигать",
    rows: [
      ["Стрелки", "сдвинуть выбранное на 1 м"],
      ["Shift + стрелки", "сдвинуть на 5 м"],
      ["Alt при перетаскивании", "без прилипания к соседям"],
      ["R", "повернуть ряды или линию движения"],
      ["S", "змейка по проездам между рядами"],
      ["Shift при отпускании", "оставить инструмент в руке"],
    ],
  },
  {
    title: "Отмена",
    rows: [
      ["Ctrl + Z", "отменить"],
      ["Ctrl + Shift + Z или Ctrl + Y", "повторить"],
    ],
  },
  {
    title: "Лист",
    rows: [
      ["Колесо мыши, + и -", "масштаб"],
      ["F", "вписать лист"],
      ["Пробел с мышью или средняя кнопка", "сдвинуть лист"],
      ["1, 2, 3 и дальше", "инструмент по порядку в колонке слева"],
      ["Цифры после постановки", "размер числами: длина, Tab, ширина, Enter"],
      ["?", "эта подсказка"],
    ],
  },
];

export function Keys({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  // кто держал фокус до окна: туда он вернется, когда окно закроют
  const from = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => {
    close.current?.focus();
    const back = from.current;
    return () => {
      if (back instanceof HTMLElement) back.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className="u-hotkeys"
      role="dialog"
      aria-label="Горячие клавиши"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "?") {
          // Esc не доходит до листа на весь экран: закрываем только окно
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Tab") {
          // в окне одна кнопка: фокус остается на ней, пока окно открыто
          event.preventDefault();
          close.current?.focus();
        }
      }}
    >
      <div className="u-hotkeys-head">
        <h3>Горячие клавиши</h3>
        <button
          ref={close}
          type="button"
          className="u-icon"
          aria-label="Закрыть"
          title="Закрыть, Esc"
          onClick={onClose}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M4 4l7 7M11 4l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <p className="u-hotkeys-note">На Mac вместо Ctrl работает Cmd.</p>
      <div className="u-hotkeys-body">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <h4>{group.title}</h4>
            <dl>
              {group.rows.map(([keys, what]) => (
                <div key={keys}>
                  <dt>{keys}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
