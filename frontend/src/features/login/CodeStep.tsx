import { useEffect, useRef, useState, type FormEvent } from "react";
import { post } from "./send";

// Второй шаг регистрации, когда на сервере настроена почта: на месте формы остается только поле
// для 6 цифр из письма. Видно, на какую почту ушел код. "Назад" возвращает к форме с той же почтой
// и паролем, "Прислать код еще раз" доступна через минуту. Шесть цифр набрали: проверяем сразу.

const DIGITS = 6;
const RESEND_SECONDS = 60;

type Props = {
  email: string;
  onBack: () => void;
  onResend: () => Promise<string | null>;
  onDone: () => void;
  onOops: () => void;
};

export function CodeStep({ email, onBack, onResend, onDone, onOops }: Props) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(RESEND_SECONDS);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => field.current?.focus(), []);

  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait(wait - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  async function check(value: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    const { problem } = await post("register/confirm", { email, code: value });
    if (problem) {
      setBusy(false);
      setError(problem);
      setCode("");
      onOops();
      window.setTimeout(() => field.current?.focus());
      return;
    }
    onDone();
  }

  function type(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, DIGITS);
    setCode(digits);
    if (digits.length === DIGITS && !busy) void check(digits);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (code.length === DIGITS) void check(code);
    else setError(`В коде ${DIGITS} цифр`);
  }

  async function resend() {
    setError(null);
    setNote(null);
    const problem = await onResend();
    if (problem) {
      setError(problem);
      return;
    }
    setNote("Отправили новый код, прежний больше не подойдет");
    setWait(RESEND_SECONDS);
    setCode("");
    field.current?.focus();
  }

  return (
    <>
      <h1 id="login-title">Подтвердите почту</h1>
      <p className="g-lead">
        Отправили код на <span className="g-email">{email}</span>. Письмо идет до минуты, если его нет, загляните в
        папку Спам.
      </p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="signup-code">Код из письма</label>
        <input
          ref={field}
          id="signup-code"
          className="g-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={DIGITS}
          placeholder="000000"
          value={code}
          onChange={(event) => type(event.target.value)}
          disabled={busy}
        />
        {error && (
          <p className="g-error" role="alert">
            {error}
          </p>
        )}
        {note && (
          <p className="g-hint" role="status">
            {note}
          </p>
        )}
        <button className="g-submit" type="submit" disabled={busy}>
          Подтвердить
        </button>
        <div className="g-row">
          <button type="button" className="g-forgot" onClick={onBack}>
            Назад
          </button>
          <button type="button" className="g-forgot" onClick={() => void resend()} disabled={wait > 0}>
            {wait > 0 ? `Прислать код еще раз через ${wait} с` : "Прислать код еще раз"}
          </button>
        </div>
      </form>
    </>
  );
}
