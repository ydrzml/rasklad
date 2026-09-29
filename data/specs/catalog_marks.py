"""Достает из PDF-каталога организатора отметки «Протестировано ФЦ БАС» и «Есть в 719».

В CSV каталога этих отметок нет, они есть только на карточках PDF. На странице по 3 карточки,
и идут они в том же порядке, что строки CSV внутри отрасли. Номер карточки берем из шапки
страницы, например «Продукты 7-9 из 48».

Результат пишется в catalog_marks.csv рядом со скриптом.
С флагом --photos DIR еще сохраняет фото с карточек в папку DIR.

Запуск: python data/specs/catalog_marks.py "Каталог внедрения.pdf" catalog_export_v4.csv
"""
from __future__ import annotations

import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

import pymupdf

HERE = Path(__file__).parent
# Порядок разделов PDF (по оглавлению) — названия отраслей как в CSV.
SECTIONS = ["Торговля и услуги", "Промышленность", "Сельское хозяйство", "ЖКХ", "Строительство",
            "ТЭК", "Безопасность", "Транспорт и логистика", "Лесное хозяйство"]


def main(pdf_path: str, csv_path: str, photos_dir: str | None = None) -> None:
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f, delimiter=";"))
    by_industry = defaultdict(list)
    for r in rows:
        by_industry[r["Отрасль"]].append(r)

    doc = pymupdf.open(pdf_path)
    section = -1
    last_first = 10**9
    out = []
    for pno, page in enumerate(doc, 1):
        text = page.get_text()
        m = re.search(r"(\d+)\s*[–-]\s*(\d+)\s+из\s+(\d+)", text)
        if not m:
            continue
        first, last, total = map(int, m.groups())
        if first <= last_first:
            section += 1
        last_first = first
        industry = SECTIONS[section]
        width = page.rect.width
        marks = defaultdict(set)
        for x0, y0, x1, y1, word, *_ in page.get_text("words"):
            col = min(2, int(((x0 + x1) / 2) / (width / 3)))
            if "Протест" in word:
                marks[col].add("tested")
            if word == "719":
                marks[col].add("719")
        for col in range(last - first + 1):
            idx = first - 1 + col
            if idx >= len(by_industry[industry]):
                continue
            r = by_industry[industry][idx]
            out.append({"catalog_id": r["id"], "product": r["Название"], "industry": industry, "page": pno,
                        "card": col + 1, "tested_fcbas": int("tested" in marks[col]), "registry_719": int("719" in marks[col])})
            if photos_dir:
                rect = page.rect
                clip = pymupdf.Rect(rect.x0 + rect.width * (0.035 + col * 0.3145), rect.y0 + rect.height * 0.12,
                                    rect.x0 + rect.width * (0.33 + col * 0.3145), rect.y0 + rect.height * 0.42)
                pix = page.get_pixmap(clip=clip, dpi=90)
                Path(photos_dir).mkdir(parents=True, exist_ok=True)
                pix.save(str(Path(photos_dir) / f'{r["id"]}_{r["Отрасль"][:4]}.jpg'), jpg_quality=70)

    with (HERE / "catalog_marks.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0]), delimiter=";")
        w.writeheader()
        w.writerows(out)
    print(f"карточек: {len(out)} из {len(rows)}; протестировано ФЦ БАС: {sum(o['tested_fcbas'] for o in out)}; в реестре 719: {sum(o['registry_719'] for o in out)}")


if __name__ == "__main__":
    args = sys.argv[1:]
    photos = None
    if "--photos" in args:
        i = args.index("--photos")
        photos = args[i + 1]
        del args[i:i + 2]
    main(*args, photos_dir=photos)
