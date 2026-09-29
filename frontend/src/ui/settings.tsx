import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge } from "./badge";
import { savedTheme, setTheme, type Theme } from "./theme";
import "./settings.css";

/* Настройки сервиса: окно поверх страницы из меню аккаунта. Работает темная тема (theme.ts), остальное
   появится после первой версии (docs/tasks.md, T-74): у таких строк метка "скоро" без выключателя,
   чтобы не обещать то, что не работает.
   Устроено как окно подтверждения (confirm.tsx): встроенный <dialog>, Esc и щелчок мимо закрывают. */

const THEMES: { id: Theme; name: string }[] = [
  { id: "system", name: "как в системе" },
  { id: "light", name: "светлая" },
  { id: "dark", name: "темная" },
];

/* Три положения на радиокнопках: работают с клавиатуры стрелками, как любой выбор в наборе */
function ThemeSwitch() {
  const [theme, pick] = useState(savedTheme);
  return (
    <div className="u-settings-theme" role="radiogroup" aria-label="Темная тема">
      {THEMES.map((option) => (
        <label key={option.id}>
          <input
            type="radio"
            name="u-theme"
            checked={theme === option.id}
            onChange={() => {
              pick(option.id);
              setTheme(option.id);
            }}
          />
          <span>{option.name}</span>
        </label>
      ))}
    </div>
  );
}

const ROWS = [
  { name: "Подсказки для первого расчета", about: "Короткое обучение на шагах мастера, его можно выключить" },
  { name: "Язык интерфейса", about: "Сейчас только русский" },
];

export function openSettings() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(
    <dialog
      className="u-dialog u-settings"
      aria-labelledby="u-settings-title"
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="u-dialog-body">
        <h2 id="u-settings-title">Настройки</h2>
        <p>Остальное появится после первой версии сервиса.</p>
        <ul className="u-settings-list">
          <li className="u-settings-wide">
            <span>
              <strong>Темная тема</strong>
              <span>Интерфейс на темном фоне, чертежи остаются светлыми</span>
            </span>
            <ThemeSwitch />
          </li>
          {ROWS.map((row) => (
            <li key={row.name}>
              <span>
                <strong>{row.name}</strong>
                <span>{row.about}</span>
              </span>
              <Badge>скоро</Badge>
            </li>
          ))}
        </ul>
        <div className="u-dialog-actions">
          <button className="u-btn u-btn-primary" autoFocus onClick={close}>
            Понятно
          </button>
        </div>
      </div>
    </dialog>,
  );
}
