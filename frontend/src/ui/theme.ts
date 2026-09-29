import { useEffect, useState } from "react";

/* Тема интерфейса: как в системе, светлая или темная. Выбор лежит в браузере под ключом lct.theme.
   До первой отрисовки data-theme на html ставит маленький скрипт в index.html, иначе страница
   мигала бы белым; здесь то же самое для выключателя в настройках. Без data-theme тема берется
   из системы правилом @media в tokens.css. Цвета обеих тем там же. */

export type Theme = "system" | "light" | "dark";

const THEME_KEY = "lct.theme";
const CHANGED = "lct-theme";

export function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function setTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // без хранилища выбор живет до перезагрузки страницы
  }
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  window.dispatchEvent(new Event(CHANGED));
}

function isDark(): boolean {
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme === "dark" || theme === "light") return theme === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/* Темная ли сейчас страница. Для холстов: они не понимают var() и перерисовываются по смене темы */
export function useDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(isDark());
    media.addEventListener("change", update);
    window.addEventListener(CHANGED, update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener(CHANGED, update);
    };
  }, []);
  return dark;
}

/* Тот же цвет с прозрачностью: токены записаны как #rrggbb */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
