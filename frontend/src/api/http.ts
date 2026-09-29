// Общий способ обращения к серверу для кабинета и админки: cookie сессии уходит сама,
// ошибка приходит с кодом и понятным текстом.

/* Ошибка с кодом ответа: экрану важно отличить «не вошел» от «сервер упал». */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Detail = string | { msg?: string; loc?: (string | number)[] }[];

/* FastAPI отвечает на неверные поля списком: берем из него человеческие сообщения.
   Русское сообщение написали мы, и в нем уже сказано, о каком поле речь */
function explain(detail: Detail | undefined, status: number): string {
  if (typeof detail === "string") return detail;
  return fieldsText(detail) ?? `Сервер ответил ${status}`;
}

/* Отказ по полям одной строкой. Без него мастер показывал "Сервер отклонил запрос, код 422", и
   человек не знал, что поправить. Одинаковые строки не повторяем: у рядов одной группы одна причина */
export function fieldsText(detail: unknown): string | null {
  if (!Array.isArray(detail) || !detail.length) return null;
  const lines = (detail as { msg?: string; loc?: (string | number)[] }[]).map((item) =>
    item.msg && /[а-я]/i.test(item.msg)
      ? item.msg
      : `${item.loc?.at(-1) ?? "поле"}: ${item.msg ?? "неверное значение"}`,
  );
  return [...new Set(lines)].join("; ");
}

export async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, "Нет связи с сервером. Проверьте интернет и попробуйте еще раз");
  }
  // 502, 503 и 504 отвечает прокси перед сервером: сам сервер не отвечает, и код человеку ничего не скажет
  if ([502, 503, 504].includes(response.status)) throw new ApiError(response.status, "Сервер не отвечает");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { detail?: Detail } | null;
    throw new ApiError(response.status, explain(data?.detail, response.status));
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export function json(method: string, body?: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  };
}
