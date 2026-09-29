import { call, json } from "./http";
import type { components } from "./schema";

// Запросы раздела "Нормативы" в админке. Все закрыты ролью администратора на сервере.
// Путь норматива идет в адрес как есть: в нем только латиница, цифры, точки, дефисы и подчеркивания.

type S = components["schemas"];
export type Norm = S["Norm"];
export type NormList = S["NormList"];
export type NormEdit = S["NormEdit"];
export type NormChange = S["NormChange"];
export type NormImportResult = S["NormImportResult"];

const base = "/api/admin/norms";

export const norms = {
  list: () => call<NormList>(base),
  save: (code: string, body: NormEdit) => call<Norm>(`${base}/${encodeURIComponent(code)}`, json("PUT", body)),
  reset: (code: string) => call<Norm>(`${base}/${encodeURIComponent(code)}`, { method: "DELETE" }),
  changes: (limit = 10, path?: string) =>
    call<NormChange[]>(`${base}/changes?limit=${limit}${path ? `&path=${encodeURIComponent(path)}` : ""}`),
  exportUrl: (format: "csv" | "xlsx") => `${base}/export?format=${format}`,
  importFile: (file: File, dryRun: boolean) => {
    const form = new FormData();
    form.append("file", file);
    return call<NormImportResult>(`${base}/import?dry_run=${dryRun}`, { method: "POST", body: form });
  },
};
