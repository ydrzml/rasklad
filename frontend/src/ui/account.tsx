import { useEffect, useRef, useState, type ReactNode } from "react";
import { forgetBrowser } from "../app/saving";
import { Avatar } from "./avatar";
import { openSettings } from "./settings";

/* Кнопка аккаунта в шапке. Гость видит «Войти». Вошедший видит кружок с буквой и имя из профиля
   (без имени почту), по нажатию открывается меню: кабинет, профиль, выход. Выход стоит последним и отделен
   чертой, чтобы не нажать его вместо кабинета. Одна и та же кнопка на лендинге, в мастере и в кабинете.
   "Новый расчет" из меню убрали: он есть в кабинете. Служебные таблицы и каталог у администратора
   стоят в шапке ссылками (AccountLinks), в меню они только на телефоне, где ссылкам в шапке нет места. */

type Me = { role: "guest" | "user" | "admin"; email?: string | null; name?: string };

const ROLE: Record<Me["role"], string> = {
  guest: "Гость",
  user: "Пользователь",
  admin: "Администратор",
};

// Кто вошел, один запрос на страницу: его ждут и шапка, и кнопка аккаунта
let asked: Promise<Me> | null = null;

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let live = true;
    asked ??= fetch("/api/auth/me", { credentials: "same-origin" })
      .then((response) => (response.ok ? (response.json() as Promise<Me>) : { role: "guest" as const }))
      .catch(() => ({ role: "guest" as const }));
    asked.then((found) => live && setMe(found));
    return () => {
      live = false;
    };
  }, []);
  return me;
}

/* Ссылки в шапке по роли: первой главная, дальше у администратора служебные таблицы, каталог
   решений и проекты, у пользователя проекты. На телефоне их нет, они в меню аккаунта */
export function AccountLinks() {
  const me = useMe();
  if (!me || me.role === "guest") return null;
  return (
    <>
      {/* главная первой: вошедший с любого экрана возвращается к своей сводке */}
      <a className="u-wide-only" href={homeOf(me.role)}>
        Главная
      </a>
      {me.role === "admin" && (
        <>
          <a className="u-wide-only" href="/api/db">
            Служебные таблицы
          </a>
          <a className="u-wide-only" href="/admin">
            Каталог решений
          </a>
        </>
      )}
      <a className="u-wide-only" href="/projects">
        Мои проекты
      </a>
    </>
  );
}

export function AccountMenu({ guest }: { guest?: ReactNode }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      box.current?.querySelector<HTMLButtonElement>(".u-account")?.focus();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc);
    box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // Пока не знаем, кто это, место держим пустым: иначе «Войти» мигнет у вошедшего
  if (!me) return <span className="u-account-slot" aria-hidden="true" />;

  if (me.role === "guest") {
    return (
      guest ?? (
        <a className="u-btn u-btn-dark u-account-login" href="/login">
          Войти
        </a>
      )
    );
  }

  const email = me.email ?? "";
  const title = me.name?.trim() || email;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => null);
    forgetBrowser();
    window.location.assign("/");
  }

  return (
    <div className="u-account-box" ref={box}>
      <button
        type="button"
        className="u-account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Avatar name={title} />
        <span className={me.name?.trim() ? "u-account-mail" : "u-account-mail mono"}>{title}</span>
        <svg className="u-account-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="u-menu u-account-menu" role="menu" aria-label="Аккаунт">
          <div className="u-account-who">
            {me.name?.trim() && <strong>{me.name}</strong>}
            <span className="mono">{email}</span>
            <span>{ROLE[me.role]}</span>
          </div>
          <span className="u-menu-line" />
          <a role="menuitem" className="u-narrow-item" href={homeOf(me.role)}>
            Главная
          </a>
          <a role="menuitem" href="/projects">
            Мои проекты
          </a>
          <a role="menuitem" href="/projects?view=profile">
            Профиль и пароль
          </a>
          {/* ссылкой, а не кнопкой: так пункт выглядит как соседние; окно открывается поверх страницы */}
          <a
            role="menuitem"
            href="#settings"
            onClick={(event) => {
              event.preventDefault();
              setOpen(false);
              openSettings();
            }}
          >
            Настройки
          </a>
          {me.role === "admin" && (
            <>
              <a role="menuitem" className="u-narrow-item" href="/admin">
                Каталог решений
              </a>
              <a role="menuitem" className="u-narrow-item" href="/api/db">
                Служебные таблицы
              </a>
            </>
          )}
          <span className="u-menu-line" />
          <button type="button" role="menuitem" onClick={logout}>
            Выйти из аккаунта
          </button>
        </div>
      )}
    </div>
  );
}

/* Главная вошедшего: у администратора своя, с делами и правками каталога */
export function homeOf(role: string): string {
  return role === "admin" ? "/admin/home" : "/home";
}
