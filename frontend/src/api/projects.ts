import { ApiError, call, json } from "./http";
import type { components } from "./schema";

export { ApiError };

// Запросы кабинета: кто вошел, проекты, версии и файлы. Отдельно от client.ts, чтобы кабинет
// не зависел от шагов мастера. Сессия живет в httpOnly-cookie, ее ставит и снимает сервер.

export type Me = components["schemas"]["Me"];
export type ProjectSummary = components["schemas"]["ProjectSummary"];
export type Project = components["schemas"]["Project"];
export type Version = components["schemas"]["Version"];
export type VersionSummary = components["schemas"]["VersionSummary"];
export type FileInfo = components["schemas"]["FileInfo"];
export type Facility = components["schemas"]["Facility"];
export type ShareInfo = components["schemas"]["ShareInfo"];
export type SharedCalculation = components["schemas"]["SharedCalculation"];
export type Folder = components["schemas"]["Folder"];
export type Comparison = components["schemas"]["Comparison"];
export type CompareRow = components["schemas"]["CompareRow"];
export type CompareItem = components["schemas"]["CompareItem"];

const base = "/api/projects";

export const account = {
  me: () => call<Me>("/api/auth/me"),
  // Удалить аккаунт со всеми проектами. Пароль спрашиваем еще раз: вдруг компьютер чужой и не заперт
  remove: (password: string) => call<Me>("/api/auth/me", json("DELETE", { password })),
  profile: (name: string, company: string) => call<Me>("/api/auth/me", json("PATCH", { name, company })),
  password: (password: string, next: string) =>
    call<Me>("/api/auth/me/password", json("POST", { password, new_password: next })),
  email: (email: string, password: string) => call<Me>("/api/auth/me/email", json("POST", { email, password })),
};

export const projects = {
  list: () => call<ProjectSummary[]>(base),
  get: (id: number) => call<Project>(`${base}/${id}`),
  // Мастер сохраняет расчет: первый раз создает проект сразу с версией, потом добавляет версии
  create: (body: components["schemas"]["ProjectCreate"]) => call<Project>(base, json("POST", body)),
  saveVersion: (id: number, body: components["schemas"]["VersionCreate"]) =>
    call<Version>(`${base}/${id}/versions`, json("POST", body)),
  rename: (id: number, name: string) => call<Project>(`${base}/${id}`, json("PATCH", { name })),
  // null вынимает проект из папки
  move: (id: number, folder: number | null) => call<Project>(`${base}/${id}`, json("PATCH", { folder_id: folder })),
  // Копия ложится в папку оригинала. С правкой сервер сразу считает вариант, до двадцати секунд
  copy: (id: number, body: components["schemas"]["ProjectCopy"] = {}) =>
    call<Project>(`${base}/${id}/copy`, json("POST", body)),
  compare: (items: CompareItem[]) => call<Comparison>(`${base}/compare`, json("POST", { items })),
  folders: () => call<Folder[]>(`${base}/folders`),
  addFolder: (name: string, ids: number[] = []) =>
    call<Folder>(`${base}/folders`, json("POST", { name, projects: ids })),
  renameFolder: (id: number, name: string) => call<Folder>(`${base}/folders/${id}`, json("PATCH", { name })),
  removeFolder: (id: number) => call<void>(`${base}/folders/${id}`, { method: "DELETE" }),
  remove: (id: number) => call<void>(`${base}/${id}`, { method: "DELETE" }),
  version: (id: number, number: number) => call<Version>(`${base}/${id}/versions/${number}`),
  upload: (id: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<FileInfo>(`${base}/${id}/files`, { method: "POST", body: form });
  },
  fileUrl: (id: number, fileId: number) => `${base}/${id}/files/${fileId}`,
  removeFile: (id: number, fileId: number) => call<void>(`${base}/${id}/files/${fileId}`, { method: "DELETE" }),
  // Поделиться версией: ссылка /share/<token>, по ней расчет виден без входа. На версию одна ссылка
  share: (id: number, version?: number) => call<ShareInfo>(`${base}/${id}/shares`, json("POST", { version })),
  revoke: (id: number, token: string) => call<void>(`${base}/${id}/shares/${token}`, { method: "DELETE" }),
};

export const facilities = () => call<Facility[]>("/api/catalog/facilities");

// Расчет по ссылке, без входа
export const shared = (token: string) => call<SharedCalculation>(`/api/share/${encodeURIComponent(token)}`);
