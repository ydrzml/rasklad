import type { ReactNode } from "react";

/* Метка: балл, "пилот", "проверено ФЦ БАС". Отдельным файлом, чтобы настройки брали ее,
   не подключая весь набор: иначе index, account и settings ссылались друг на друга по кругу */
export function Badge({ children, tone = "grey" }: { children: ReactNode; tone?: "grey" | "blue" | "best" }) {
  const look = { grey: "u-badge", blue: "u-badge u-badge-blue", best: "u-badge u-badge-best" }[tone];
  return <span className={look}>{children}</span>;
}
