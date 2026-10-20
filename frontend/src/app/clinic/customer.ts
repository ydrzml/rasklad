import type { ClinicQuotes } from "../../api/client";

export const QUOTE_FIELDS = [
  ["price_rub", "Цена одного робота, ₽"],
  ["commissioning_rub", "Пусконаладка одного робота, ₽"],
  ["maintenance_rub_year", "Сервис одного робота, ₽/год"],
  ["life_years", "Срок до замены, лет"],
  ["rent_month_rub", "Аренда одного робота, ₽/мес"],
  ["rent_first_month_rub", "Первый месяц, ₽"],
  ["rent_year_rub", "Аренда при оплате за год, ₽"],
  ["rent_first_year_rub", "Первый год, ₽"],
  ["rent_service_included", "Сервис включен в аренду: 1 да, 0 нет"],
] as const;

export function restoreClinicQuotes(raw: unknown): ClinicQuotes {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .slice(0, 30)
      .flatMap(([id, value]) => {
        if (!id || id.length > 64 || !value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as Record<string, unknown>;
        const quote: Record<string, number | string> = {};
        if (typeof record.source === "string") quote.source = record.source.slice(0, 1000);
        for (const [key] of QUOTE_FIELDS) {
          const amount = record[key];
          if (
            typeof amount === "number" &&
            Number.isFinite(amount) &&
            amount >= 0 &&
            amount <= 1e9 &&
            (key !== "rent_service_included" || amount === 0 || amount === 1) &&
            (key !== "life_years" || (Number.isInteger(amount) && amount >= 1 && amount <= 30))
          )
            quote[key] = amount;
        }
        return [[id, quote]];
      }),
  );
}

export function downloadClinic(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
