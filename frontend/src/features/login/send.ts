/* Отправка формы входа, регистрации, кода и нового пароля */

export type Sent = {
  // null: все хорошо, иначе строка для человека
  problem: string | null;
  // 202 на регистрации: аккаунта еще нет, на почту ушел код
  status: number;
};

export async function post(path: string, body: object): Promise<Sent> {
  try {
    const response = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    return { problem: await problemOf(response), status: response.status };
  } catch {
    return { problem: "Нет связи с сервером. Проверьте интернет и попробуйте еще раз", status: 0 };
  }
}

export async function send(path: string, body: object): Promise<string | null> {
  return (await post(path, body)).problem;
}

async function problemOf(response: Response): Promise<string | null> {
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
}
