import { useEffect, useRef, useState, type FormEvent } from "react";
import { Mark, Wordmark } from "../../ui";
import { safeNext } from "../../app/saving";
import { homeOf } from "../../ui/account";
import { Pallet07, type Pallet07Eyes, type Pallet07Mood } from "../../ui/robots";
import "./login.css";

// Вход и регистрация по почте и паролю. Демо-аккаунты для экспертизы существуют, но входят
// в них тоже по почте и паролю, как в обычный аккаунт: отдельных кнопок на экране нет.
// Сессия живет в httpOnly-cookie, ее ставит сервер, здесь только отправляем форму.
// После входа ведем в кабинет с проектами или обратно в расчет, если пришли оттуда.
// 07 встречает у формы: смотрит на поле почты, от пароля вежливо отворачивается, а если пароль
// показали кнопкой-глазом, смотрит на него. Вошел: радуется. Ошибка: смущенно качается.

// После входа возвращаем туда, откуда пришли: мастер отправляет сюда с ?next=, когда гость сохраняет расчет
const NEXT = new URLSearchParams(window.location.search).get("next");
// Сколько 07 смотрит на поле пароля, прежде чем отвернуться, и сколько радуется перед переходом
const PEEK_MS = 500;
const CHEER_MS = 700;

type Focus = "none" | "email" | "password";

type Mode = "login" | "register";

async function send(path: string, body: object): Promise<string | null> {
  try {
    const response = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    if (response.status === 401) return "Неверная почта или пароль";
    const data = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    if (typeof data?.detail === "string") return data.detail;
    // Сервер объясняет по-русски, что не так с почтой или паролем: пароль из одних цифр, слишком простой
    if (response.status === 422) {
      const first = Array.isArray(data?.detail) ? (data.detail[0] as { msg?: unknown } | undefined) : undefined;
      return typeof first?.msg === "string" ? first.msg : "Проверьте почту и пароль: пароль не короче 8 символов";
    }
    return "Сервер не ответил, попробуйте еще раз через минуту";
  } catch {
    return "Нет связи с сервером. Проверьте интернет и попробуйте еще раз";
  }
}

export function Login() {
  const [mode, setMode] = useState<Mode>(window.location.hash === "#register" ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<Focus>("none");
  const [shown, setShown] = useState(false);
  const [turned, setTurned] = useState(false);
  const [mood, setMood] = useState<Pallet07Mood>("calm");
  const [moodRun, setMoodRun] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function later(ms: number, action: () => void) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(action, ms);
  }

  function react(next: Pallet07Mood) {
    setMood(next);
    setMoodRun((count) => count + 1);
  }

  function focusPassword() {
    setFocus("password");
    setTurned(false);
    if (!shown) later(PEEK_MS, () => setTurned(true));
  }

  function toggleShown() {
    setShown(!shown);
    setTurned(shown);
  }

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    const problem = await action();
    if (problem) {
      setBusy(false);
      setError(problem);
      react("oops");
      later(950, () => setMood("calm"));
      return;
    }
    react("cheer");
    later(CHEER_MS, () => void afterLogin().then((url) => window.location.assign(url)));
  }

  // Куда смотрит 07. Форма ниже и левее его, поэтому «на поле» это влево и вниз.
  // От скрытого пароля отворачивается вверх и прикрывает глаза. Пока форму не трогают, возится с грузом
  let eyes: Pallet07Eyes | undefined;
  let lean = 0;
  if (mood === "oops") eyes = { x: 0, y: 1 };
  else if (focus === "email") eyes = { x: -4 + Math.min(email.length, 14) * 0.35, y: 3 };
  else if (focus === "password" && (shown || !turned)) {
    eyes = { x: -4, y: 4 };
    lean = shown ? 3 : 0;
  } else if (focus === "password") {
    eyes = { x: 3, y: -4, shut: true };
    lean = -4;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "register" && !agreed) {
      setError("Отметьте согласие на обработку почты, без него аккаунт не завести");
      return;
    }
    run(() => send(mode, { email, password }));
  }

  const isLogin = mode === "login";

  return (
    <div className="g-page">
      <header className="g-head">
        <a className="g-brand" href="/">
          <Mark />
          <Wordmark />
        </a>
      </header>

      <main className="g-main">
        <section className="g-panel" aria-labelledby="login-title">
          <Pallet07
            key={moodRun}
            className="g-robot"
            eyes={eyes}
            lean={lean}
            mood={mood}
            idle={focus === "none" && mood === "calm" && !busy}
          />
          <div className="g-tabs" role="group" aria-label="Что сделать">
            <button type="button" aria-pressed={isLogin} onClick={() => setMode("login")}>
              Вход
            </button>
            <button type="button" aria-pressed={!isLogin} onClick={() => setMode("register")}>
              Регистрация
            </button>
          </div>
          <h1 id="login-title">{isLogin ? "Войдите, чтобы сохранять расчеты" : "Заведите аккаунт"}</h1>
          <p className="g-lead">
            {isLogin
              ? "Проекты, их копии и отчеты хранятся в кабинете. Считать можно и без входа."
              : "Нужны только почта и пароль. Подтверждать почту не придется."}
          </p>

          <form onSubmit={submit} noValidate>
            <label htmlFor="login-email">Почта</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="ivan@company.ru"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onFocus={() => setFocus("email")}
              onBlur={() => setFocus("none")}
              required
            />
            <label htmlFor="login-password">Пароль</label>
            <div className="g-pass">
              <input
                id="login-password"
                type={shown ? "text" : "password"}
                autoComplete={isLogin ? "current-password" : "new-password"}
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onFocus={focusPassword}
                onBlur={() => setFocus("none")}
                required
              />
              <button
                type="button"
                className="g-eye"
                aria-label={shown ? "Скрыть пароль" : "Показать пароль"}
                aria-pressed={shown}
                onMouseDown={(event) => event.preventDefault()}
                onFocus={() => setFocus("password")}
                onBlur={() => setFocus("none")}
                onClick={toggleShown}
              >
                <svg width="20" height="20" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path
                    d="M1.5 9S4.5 3.5 9 3.5 16.5 9 16.5 9 13.5 14.5 9 14.5 1.5 9 1.5 9z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <circle cx="9" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.4" />
                  {!shown && <path d="M3 15L15 3" stroke="currentColor" strokeWidth="1.4" />}
                </svg>
              </button>
            </div>
            {!isLogin && <p className="g-hint">Не короче 8 символов</p>}
            {!isLogin && (
              <label className="g-consent">
                <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
                <span>
                  Соглашаюсь на обработку моей почты для входа в сервис.{" "}
                  <a href="/privacy" target="_blank" rel="noopener">
                    Какие данные храним и зачем
                  </a>
                </span>
              </label>
            )}
            {error && (
              <p className="g-error" role="alert">
                {error}
              </p>
            )}
            <button className="g-submit" type="submit" disabled={busy}>
              {isLogin ? "Войти" : "Зарегистрироваться"}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

/* Куда после входа: туда, откуда прислали (?next=, например сохранение из мастера), иначе на главную по роли */
async function afterLogin(): Promise<string> {
  if (NEXT) return safeNext(NEXT);
  const me = await fetch("/api/auth/me", { credentials: "same-origin" })
    .then((response) => (response.ok ? (response.json() as Promise<{ role: string }>) : { role: "user" }))
    .catch(() => ({ role: "user" }));
  return homeOf(me.role);
}
