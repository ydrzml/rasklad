import type { ReactNode } from "react";

/* Метка: балл, "пилот", "проверено ФЦ БАС". Отдельным файлом, чтобы настройки брали ее,
   не подключая весь набор: иначе index, account и settings ссылались друг на друга по кругу */
export function Badge({ children, tone = "grey" }: { children: ReactNode; tone?: "grey" | "blue" }) {
  return <span className={tone === "blue" ? "u-badge u-badge-blue" : "u-badge"}>{children}</span>;
}
