import type { Change } from "../../api/admin";

/* Журнал правок словами администратора, а не разработчика. Записи первого запуска и загрузки файла
   каталога сервер пишет с путями к папкам и рабочими словами ("data/", "выгрузка организатора").
   Такие записи собираем заново из чисел записи, остальные показываем как есть.
   Старые записи в базе тоже читаются: текст строим при показе, а не при записи */

const count = (value: unknown) => (Array.isArray(value) ? value.length : Number(value) || 0);

export function journalNote(change: Pick<Change, "action" | "changes" | "note">): string {
  const c = change.changes ?? {};
  switch (change.action) {
    case "seed":
      return `при запуске добавлено складских решений с характеристиками: ${count(c.solutions)}`;
    case "photo_seed":
      return `при запуске добавлено фото: ${count(c.photos)}`;
    case "uses_seed":
      return `объекты и задачи: из нашего списка ${count(c.confirmed)}, предложено правилом ${count(c.suggested)}`;
    case "import":
      return (
        `файл каталога ФЦ БАС: добавлено ${count(c.added)}, обновлено ${count(c.updated)}, ` +
        `склеено строк ${count(c.merged)}, ручных правок сохранено ${count(c.kept)}, ` +
        `предложено правилом ${count(c.suggested)}`
      );
    default:
      return change.note;
  }
}
