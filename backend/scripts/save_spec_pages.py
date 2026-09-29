"""Сохранить строки страниц производителей для проверки обновлений без интернета.

Берем со страницы только строки с подписями характеристик, которые мы с нее собирали, и соседние
строки со значениями. Всю страницу не храним: нам нужны цифры, а не текст и оформление сайта.

    python -m scripts.save_spec_pages https://ronavi-robotics.ru/catalogue/h1500 ...
"""

import csv
import re
import sys
from datetime import date

from app.services import catalog_updates
from app.settings import settings


def keep(text: str, labels: list[str]) -> str:
    # длинные абзацы с рекламой не нужны: подписи и значения стоят короткими строками
    lines = [line for line in text.splitlines() if len(line) <= 120]
    flat = [catalog_updates._flat(line) for line in lines]
    wanted: set[int] = set()
    for i, line in enumerate(flat):
        if any(label and label in line for label in labels):
            wanted.update(j for j in (i - 1, i, i + 1) if 0 <= j < len(lines))
    return "\n".join(lines[i] for i in sorted(wanted)) + "\n"


def main(urls: list[str]) -> None:
    folder = settings.data_dir / "specs" / "saved"
    folder.mkdir(parents=True, exist_ok=True)
    index = folder / "pages.csv"
    rows: dict[str, dict[str, str]] = {}
    if index.exists():
        with index.open(encoding="utf-8", newline="") as file:
            rows = {row["url"]: row for row in csv.DictReader(file, delimiter=";")}
    targets = catalog_updates.targets()
    for url in urls:
        labels = [catalog_updates._flat(catalog_updates._split(t.quote)[0]) for t in targets if t.url == url]
        if not labels:
            print(f"{url}: этой страницы нет среди источников производителей, пропускаем")
            continue
        try:
            text = catalog_updates.page_text(catalog_updates.fetch(url))
        except (catalog_updates.Offline, catalog_updates.Failed) as error:
            print(f"{url}: не открылась ({error}), пропускаем")
            continue
        name = re.sub(r"[^a-z0-9]+", "-", url.split("://", 1)[1].lower()).strip("-") + ".txt"
        (folder / name).write_text(keep(text, labels), encoding="utf-8", newline="\n")
        rows[url] = {"url": url, "file": name, "saved": date.today().isoformat()}
        print(f"{url}: {name}")
    with index.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=["url", "file", "saved"], delimiter=";", lineterminator="\n")
        writer.writeheader()
        writer.writerows(sorted(rows.values(), key=lambda row: row["url"]))


if __name__ == "__main__":
    main(sys.argv[1:])
