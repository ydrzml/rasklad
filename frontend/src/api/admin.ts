import { call, json } from "./http";
import type { components } from "./schema";

// Запросы экрана «Каталог решений» в админке. Все закрыты ролью администратора на сервере.
// Генератор типов считает обязательными поля, у которых на сервере есть значение по умолчанию,
// поэтому тела запросов на изменение описаны как Partial: уходят только те поля, что поменяли.

type S = components["schemas"];
export type SolutionRow = S["SolutionRow"];
export type SolutionPage = S["SolutionPage"];
export type SolutionCard = S["SolutionCard"];
export type SolutionUpdate = S["SolutionUpdate"];
export type SolutionCreate = S["SolutionCreate"];
export type Spec = S["CatalogSpec"];
export type SpecUpdate = S["SpecUpdate"];
export type Change = S["Change"];
export type FieldInfo = S["FieldInfo"];
export type ImportResult = S["ImportResult"];
export type PhotoMeta = S["PhotoMeta"];
export type OperationInfo = S["OperationInfo"];
export type UseInfo = S["UseInfo"];
export type Updates = S["Updates"];
export type TreeNode = S["TreeNode"];
export type UpdateItem = S["UpdateItem"];
export type UpdateRun = S["UpdateRun"];

export type ListQuery = {
  search: string;
  kind: string;
  status: string;
  origin: string;
  with_specs: boolean;
  facility: string;
  to_check: boolean;
  incomplete: boolean;
  sort: string;
  limit: number;
};

const base = "/api/admin/catalog";

function query(q: ListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) {
    if (value !== "" && value !== false) params.set(key, String(value));
  }
  return params.toString();
}

export const catalog = {
  list: (q: ListQuery) => call<SolutionPage>(`${base}?${query(q)}`),
  fields: () => call<FieldInfo[]>(`${base}/fields`),
  operations: () => call<OperationInfo[]>(`${base}/operations`),
  get: (id: string) => call<SolutionCard>(`${base}/${id}`),
  create: (body: Partial<SolutionCreate> & { name: string }) => call<SolutionCard>(base, json("POST", body)),
  update: (id: string, body: Partial<SolutionUpdate>) => call<SolutionCard>(`${base}/${id}`, json("PATCH", body)),
  remove: (id: string) => call<void>(`${base}/${id}`, { method: "DELETE" }),
  reset: (id: string, field: string) => call<SolutionCard>(`${base}/${id}/reset/${field}`, { method: "POST" }),
  addSpec: (id: string, body: Partial<SpecUpdate> & { field: string }) =>
    call<SolutionCard>(`${base}/${id}/specs`, json("POST", body)),
  updateSpec: (id: string, specId: number, body: Partial<SpecUpdate>) =>
    call<SolutionCard>(`${base}/${id}/specs/${specId}`, json("PATCH", body)),
  removeSpec: (id: string, specId: number) => call<SolutionCard>(`${base}/${id}/specs/${specId}`, { method: "DELETE" }),
  putPhoto: (id: string, file: File, meta: PhotoMeta) => {
    const form = new FormData();
    form.append("file", file);
    for (const [key, value] of Object.entries(meta)) form.append(key, value ?? "");
    return call<SolutionCard>(`${base}/${id}/photo`, { method: "PUT", body: form });
  },
  updatePhoto: (id: string, meta: PhotoMeta) => call<SolutionCard>(`${base}/${id}/photo`, json("PATCH", meta)),
  removePhoto: (id: string) => call<SolutionCard>(`${base}/${id}/photo`, { method: "DELETE" }),
  setUse: (id: string, facility: string, operation: string, status: "confirmed" | "rejected", note = "") =>
    call<SolutionCard>(`${base}/${id}/uses/${facility}/${operation}`, json("PUT", { status, note })),
  changes: (limit = 20) => call<Change[]>(`${base}/changes?limit=${limit}`),
  exportUrl: `${base}/export`,
  tree: () => call<TreeNode[]>(`${base}/tree`),
  importFile: (file: File, dryRun: boolean) => {
    const form = new FormData();
    form.append("file", file);
    return call<ImportResult>(`${base}/import?dry_run=${dryRun}`, { method: "POST", body: form });
  },
};

// Автообновление характеристик: проверка идет на сервере в фоне, экран спрашивает ход
export const updates = {
  get: () => call<Updates>("/api/admin/updates"),
  run: (source: "web" | "saved") => call<UpdateRun>(`/api/admin/updates/run?source=${source}`, { method: "POST" }),
  accept: (id: number, value: string, rating: string) =>
    call<UpdateItem>(`/api/admin/updates/${id}/accept`, json("POST", { value, rating })),
  reject: (id: number) => call<UpdateItem>(`/api/admin/updates/${id}/reject`, { method: "POST" }),
};
