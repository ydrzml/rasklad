import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { account, ApiError, type Me } from "../../api/projects";
import { forgetBrowser } from "../../app/saving";
import { Alert, Button, Hero } from "../../ui";
import { Avatar } from "../../ui/avatar";
import { problem } from "./format";

// Профиль. Главное слева: кто вы, крупно и на своей плите. Справа без плит, по той же сетке:
// почта для входа, пароль и внизу строка удаления аккаунта, само удаление в окне поверх страницы.
// Настройки живут в окне из меню аккаунта (ui/settings.tsx). Почту и пароль меняем только
// с текущим паролем: вдруг компьютер чужой и не заперт. Демо-аккаунт общий, у него ничего не меняем.

export function ProfileScreen({ me }: { me: Me }) {
  const [who, setWho] = useState(me);
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <a className="c-back" href="/projects">
        ← Мои проекты
      </a>
      <Hero compact title="Профиль" lead="Как вас называть и как входить в сервис." />
      {who.demo && (
        <p className="c-said">
          <Alert tone="note">
            Это общий демо-аккаунт: в него входят все эксперты, поэтому имя, почту и пароль у него не меняем. Чтобы
            попробовать, заведите свой аккаунт через вход.
          </Alert>
        </p>
      )}
      <div className="c-profile">
        <Names me={who} onSaved={setWho} />
        <div className="c-profile-side">
          <EmailForm me={who} onSaved={setWho} />
          <PasswordForm me={who} />
          <div className="c-profile-end">
            {who.demo ? (
              <span className="c-faint">Демо-аккаунт общий, его не удалить.</span>
            ) : (
              <>
                <span className="c-faint">Удалятся почта, пароль и все проекты. Вернуть будет нельзя.</span>
                <Button kind="danger" onClick={() => setRemoving(true)}>
                  Удалить аккаунт
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
      {removing && <DeleteDialog onClose={() => setRemoving(false)} />}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="c-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Names({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const [name, setName] = useState(me.name ?? "");
  const [company, setCompany] = useState(me.company ?? "");
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const same = name.trim() === (me.name ?? "") && company.trim() === (me.company ?? "");

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      onSaved(await account.profile(name, company));
      setSaid("Сохранено");
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="c-profile-main" onSubmit={save}>
      <div className="c-who">
        <Avatar name={name.trim() || me.email || ""} size={88} />
        <span>
          <strong>{name.trim() || "Имя не указано"}</strong>
          {company.trim() && <span>{company.trim()}</span>}
          <span className="mono">{me.email}</span>
        </span>
      </div>
      <Field label="Имя">
        <input
          className="u-search"
          autoComplete="name"
          maxLength={120}
          value={name}
          disabled={me.demo}
          placeholder="Например, Иван Петров"
          onChange={(event) => {
            setName(event.target.value);
            setSaid(null);
          }}
        />
      </Field>
      <Field label="Компания">
        <input
          className="u-search"
          autoComplete="organization"
          maxLength={200}
          value={company}
          disabled={me.demo}
          placeholder="Например, ООО Склад-Сервис"
          onChange={(event) => {
            setCompany(event.target.value);
            setSaid(null);
          }}
        />
      </Field>
      <div className="c-row">
        <button className="u-btn u-btn-primary" type="submit" disabled={me.demo || busy || same}>
          {busy ? "Сохраняем..." : "Сохранить"}
        </button>
        {said && <span role="status">{said}</span>}
      </div>
      {failure && <Alert>{failure}</Alert>}
    </form>
  );
}

// Поля почты и паролей неуправляемые: пароль не лежит в состоянии и не попадает в value на странице,
// читаем его из формы при отправке и чистим form.reset(). До первого фокуса поля только для чтения:
// так браузер не подставляет сохраненную почту и пароль при открытии профиля, а по щелчку подсказывает как обычно
function useUnlock() {
  const [open, setOpen] = useState(false);
  return { readOnly: !open, onFocus: () => setOpen(true) };
}

function read(form: HTMLFormElement, name: string) {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : "";
}

function EmailForm({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const unlock = useUnlock();
  const [filled, setFilled] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setFailure(null);
    try {
      const next = await account.email(read(form, "new-email"), read(form, "password"));
      onSaved(next);
      setSaid(`Теперь входите по ${next.email}`);
      form.reset();
      setFilled(false);
    } catch (error) {
      setFailure(error instanceof ApiError && error.status === 401 ? "Пароль не подошел" : problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="c-part"
      onSubmit={save}
      onInput={(event) =>
        setFilled(!!read(event.currentTarget, "new-email") && !!read(event.currentTarget, "password"))
      }
    >
      <h2>Почта для входа</h2>
      <p className="c-part-now">
        Сейчас входите по <span className="mono">{me.email}</span>
      </p>
      <div className="c-pair">
        <Field label="Новая почта">
          <input className="u-search" type="email" name="new-email" autoComplete="off" disabled={me.demo} {...unlock} />
        </Field>
        <Field label="Текущий пароль">
          <input
            className="u-search"
            type="password"
            name="password"
            autoComplete="current-password"
            disabled={me.demo}
            {...unlock}
          />
        </Field>
      </div>
      <div className="c-row">
        <button className="u-btn u-btn-dark" type="submit" disabled={me.demo || busy || !filled}>
          Сменить почту
        </button>
        {said && <span role="status">{said}</span>}
      </div>
      {failure && <Alert>{failure}</Alert>}
    </form>
  );
}

function PasswordForm({ me }: { me: Me }) {
  const unlock = useUnlock();
  const [state, setState] = useState({ ready: false, mismatch: false });
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function check(form: HTMLFormElement) {
    const next = read(form, "new-password");
    const again = read(form, "again");
    const mismatch = again.length > 0 && again !== next;
    setState({ mismatch, ready: !!read(form, "password") && next.length >= 8 && !!again && !mismatch });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!state.ready) return;
    setBusy(true);
    setFailure(null);
    try {
      await account.password(read(form, "password"), read(form, "new-password"));
      setSaid("Пароль сменили. На этом компьютере вы остаетесь в аккаунте");
      form.reset();
      setState({ ready: false, mismatch: false });
    } catch (error) {
      setFailure(error instanceof ApiError && error.status === 401 ? "Текущий пароль не подошел" : problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="c-part" onSubmit={save} onInput={(event) => check(event.currentTarget)}>
      <h2>Пароль</h2>
      {/* Браузер запоминает новый пароль к этой почте, а не к пустому имени */}
      <input type="email" name="username" autoComplete="username" value={me.email ?? ""} readOnly hidden />
      <Field label="Текущий пароль">
        <input
          className="u-search"
          type="password"
          name="password"
          autoComplete="current-password"
          disabled={me.demo}
          {...unlock}
        />
      </Field>
      <div className="c-pair">
        <Field label="Новый, от 8 символов">
          <input
            className="u-search"
            type="password"
            name="new-password"
            autoComplete="new-password"
            disabled={me.demo}
            {...unlock}
          />
        </Field>
        <Field label="Новый еще раз">
          <input
            className="u-search"
            type="password"
            name="again"
            autoComplete="new-password"
            disabled={me.demo}
            {...unlock}
          />
        </Field>
      </div>
      {state.mismatch && <Alert>Пароли не совпадают</Alert>}
      <div className="c-row">
        <button className="u-btn u-btn-dark" type="submit" disabled={me.demo || busy || !state.ready}>
          Сменить пароль
        </button>
        {said && <span role="status">{said}</span>}
      </div>
      {failure && <Alert>{failure}</Alert>}
    </form>
  );
}

// Удаление уносит все проекты и файлы без возможности вернуть (ТЗ требует, чтобы это было можно сделать самому).
// Окно поверх страницы: пароль еще раз, фокус на отмене, Esc и щелчок мимо закрывают
function DeleteDialog({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    box.current?.showModal();
  }, []);

  const close = () => {
    if (!busy) onClose();
  };

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = read(event.currentTarget, "password");
    setBusy(true);
    setFailure(null);
    try {
      await account.remove(password);
      forgetBrowser();
      window.location.assign("/");
    } catch (error) {
      setFailure(error instanceof ApiError && error.status === 401 ? "Пароль не подошел" : problem(error));
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={box}
      className="u-dialog"
      aria-labelledby="c-delete-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="u-dialog-body"
        onSubmit={remove}
        onInput={(event) => setFilled(!!read(event.currentTarget, "password"))}
      >
        <h2 id="c-delete-title">Удалить аккаунт?</h2>
        <p>Удалятся почта, пароль и все проекты вместе с версиями и файлами. Вернуть их будет нельзя.</p>
        <label className="c-field c-dialog-field">
          <span>Чтобы подтвердить, введите пароль</span>
          <input className="u-search" type="password" name="password" autoComplete="current-password" />
        </label>
        {failure && <Alert>{failure}</Alert>}
        <div className="u-dialog-actions">
          <button className="u-btn u-btn-ghost" type="button" onClick={close} autoFocus disabled={busy}>
            Отмена
          </button>
          <button className="u-btn u-btn-stop" type="submit" disabled={busy || !filled}>
            {busy ? "Удаляем..." : "Удалить аккаунт"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
