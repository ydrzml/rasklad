import { useState, type FormEvent } from "react";
import { Mark, Wordmark } from "../../ui";
import { homeOf } from "../../ui/account";
import { Pallet07, type Pallet07Mood } from "../../ui/robots";
import { send } from "./send";
import "./login.css";

// Новый пароль по ссылке из письма: /login/reset#токен. Токен после #, эта часть адреса не уходит
// на сервер и не попадает в журналы. Сразу убираем его из адресной строки: ссылку не скопируют
// со снимка экрана и не отправят дальше вместе с адресом. Сохранили пароль: сразу вошли.

const TOKEN = window.location.hash.slice(1);
if (TOKEN) window.history.replaceState(null, "", window.location.pathname);

export function Reset() {
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState<Pallet07Mood>("calm");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const problem = await send("reset", { token: TOKEN, new_password: password });
    if (problem) {
      setBusy(false);
      setError(problem);
      setMood("oops");
      return;
    }
    setMood("cheer");
    const me = await fetch("/api/auth/me", { credentials: "same-origin" })
      .then((response) => (response.ok ? (response.json() as Promise<{ role: string }>) : { role: "user" }))
      .catch(() => ({ role: "user" }));
    window.location.assign(homeOf(me.role));
  }

  return (
    <div className="g-page">
      <header className="g-head">
        <a className="g-brand" href="/">
          <Mark />
          <Wordmark />
        </a>
      </header>

      <main className="g-main">
        <section className="g-panel" aria-labelledby="reset-title">
          <Pallet07 className="g-robot" mood={mood} idle={mood === "calm" && !busy} />
          <h1 id="reset-title">Задайте новый пароль</h1>
          {TOKEN ? (
            <>
              <p className="g-lead">После сохранения сразу войдете. На других устройствах вход сбросится.</p>
              <form onSubmit={submit} noValidate>
                <label htmlFor="reset-password">Новый пароль</label>
                <div className="g-pass">
                  <input
                    id="reset-password"
                    type={shown ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={8}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="g-eye"
                    aria-label={shown ? "Скрыть пароль" : "Показать пароль"}
                    aria-pressed={shown}
                    onClick={() => setShown(!shown)}
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
                <p className="g-hint">Не короче 8 символов, не только цифры</p>
                {error && (
                  <p className="g-error" role="alert">
                    {error}
                  </p>
                )}
                <button className="g-submit" type="submit" disabled={busy}>
                  Сохранить и войти
                </button>
                <a className="g-forgot g-back" href="/login#forgot">
                  Запросить новую ссылку
                </a>
              </form>
            </>
          ) : (
            <>
              <p className="g-lead">Ссылка открылась не целиком. Откройте ее из письма еще раз или запросите новую.</p>
              <a className="g-submit g-link" href="/login#forgot">
                Запросить новую ссылку
              </a>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
