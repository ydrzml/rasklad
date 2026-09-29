"""Собирает docs/documentation.pdf из docs/documentation.md в стиле PDF-отчета сервиса:
те же шрифты (Onest, JetBrains Mono), цвета и логика полей, что в app/reports/pdf.py.

Нужны пакеты weasyprint и markdown (pip install weasyprint markdown) и системные
библиотеки Pango, HarfBuzz, Fontconfig снизу WeasyPrint. На Windows их обычно нет,
проще собрать через Docker:

    docker run --rm -v "%cd%":/work -w /work python:3.12-slim bash -c "
      apt-get update -qq && apt-get install -y -qq --no-install-recommends
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libfribidi0 fonts-dejavu-core >/dev/null &&
      pip install -q weasyprint==62.3 markdown==3.7 &&
      python docs/build_documentation_pdf.py"

Запуск из корня репозитория:
    python docs/build_documentation_pdf.py
    python docs/build_documentation_pdf.py --output other.pdf --stand-access access.md
"""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path

import markdown as md_lib
from weasyprint import HTML

DOCS = Path(__file__).resolve().parent
REPO = DOCS.parent
FONTS = REPO / "backend" / "app" / "reports" / "fonts"
SOURCE = DOCS / "documentation.md"
IMAGES = DOCS

TITLE = "Расклад. Сопроводительная документация"
SUBTITLE = "Команда unicorn, хакатон \"Лидеры цифровой трансформации 2026\", задача №1 (ФЦ БАС)"

GITHUB_REPO = "https://github.com/ydrzml/rasklad"


def current_branch() -> str:
    try:
        name = subprocess.check_output(
            ["git", "branch", "--show-current"], cwd=REPO, text=True
        ).strip()
    except Exception:
        name = ""
    return name or "main"


BRANCH = current_branch()
REPO_BLOB_BASE = f"{GITHUB_REPO}/blob/{BRANCH}/"
REPO_TREE_BASE = f"{GITHUB_REPO}/tree/{BRANCH}/"

# Разделы уровня ## (не ###), у которых новая страница обязательна: пункты 6.x,
# "Что мы прорабатывали сами", приложения. "Карта материалов" намеренно не входит -
# она уже стоит сразу после оглавления и не требует отдельного разрыва.
MAJOR_HEADING = re.compile(r"^(6\.\d+\.|Как проверить за 10 минут|Что мы прорабатывали сами|Приложение [А-Я]\.)")

FENCE = re.compile(r"```.*?```", re.DOTALL)
URL_RE = re.compile(r"https?://[^\s<>\]\)\|]+")
PATH_RE = re.compile(r"(?<![\w/])(`)?((?:docs|data)/[\w./-]*)(`)?")


def linkify_urls(text: str) -> str:
    def repl(m: re.Match) -> str:
        url = m.group(0)
        trail = ""
        while url and url[-1] in ".,;:":
            trail = url[-1] + trail
            url = url[:-1]
        return f"[{url}]({url}){trail}"

    return URL_RE.sub(repl, text)


def linkify_paths(text: str) -> str:
    def repl(m: re.Match) -> str:
        open_tick, path, close_tick = m.group(1), m.group(2), m.group(3)
        base = REPO_TREE_BASE if path.endswith("/") else REPO_BLOB_BASE
        url = base + path
        label = f"`{path}`" if open_tick and close_tick else path
        return f"[{label}]({url})"

    return PATH_RE.sub(repl, text)


def linkify(text: str) -> str:
    """Делает ссылки кликабельными: голые URL и относительные пути docs/, data/
    превращает в markdown-ссылки. Содержимое ```-блоков (примеры команд) не трогает."""
    parts = FENCE.split(text)
    fences = FENCE.findall(text)
    out = []
    for i, part in enumerate(parts):
        part = linkify_urls(part)
        part = linkify_paths(part)
        out.append(part)
        if i < len(fences):
            out.append(fences[i])
    return "".join(out)


def inject_stand_access(text: str, extra_path: Path | None) -> str:
    """Вставляет подраздел "Доступ к стенду" сразу после "Как проверить за 10 минут"
    и подставляет нужную формулировку в карту материалов."""
    if extra_path is not None:
        extra = extra_path.read_text(encoding="utf-8").strip()
        block = "\n\n### Доступ к стенду\n\n" + extra + "\n"
        marker = "\n## 6.1. "
        idx = text.index(marker)
        text = text[:idx] + block + text[idx:]
        note = 'в разделе "Доступ к стенду"'
    else:
        note = "в README на Диске с материалами сдачи"
    return text.replace("{{STAND_ACCESS_NOTE}}", note)


def build_toc(toc_tokens: list[dict]) -> str:
    rows = []

    def walk(items: list[dict]) -> None:
        for item in items:
            if item["level"] in (2, 3):
                cls = "toc-entry" if item["level"] == 2 else "toc-entry toc-sub"
                rows.append(
                    f'<li class="{cls}"><a href="#{item["id"]}">{item["name"]}</a></li>'
                )
            walk(item.get("children") or [])

    walk(toc_tokens)
    return "<ul class=\"toc-list\">" + "".join(rows) + "</ul>"


def mark_section_breaks(html: str) -> str:
    """Ставит принудительный разрыв страницы перед каждым разделом уровня ##
    (пункты 6.x, "Что мы прорабатывали сами", приложения), но не перед ###."""

    def repl(m: re.Match) -> str:
        name = re.sub(r"<[^>]+>", "", m.group("name"))
        if MAJOR_HEADING.match(name):
            return m.group(0).replace('<h2 id=', '<h2 class="section-break" id=', 1)
        return m.group(0)

    return re.sub(r'<h2 id="[^"]*">(?P<name>[^<]*)</h2>', repl, html)


def wrap_images(html: str) -> str:
    def repl(m: re.Match) -> str:
        alt = m.group("alt")
        tag = m.group(0)
        caption = f'<figcaption>{alt}</figcaption>' if alt else ""
        return f'<figure class="doc-figure">{tag}{caption}</figure>'

    return re.sub(r'<img[^>]*alt="(?P<alt>[^"]*)"[^>]*>', repl, html)


CSS = """
@font-face { font-family: "Onest"; src: url("FONTS/Onest-Regular.ttf"); font-weight: 400; }
@font-face { font-family: "Onest"; src: url("FONTS/Onest-Medium.ttf"); font-weight: 500; }
@font-face { font-family: "Onest"; src: url("FONTS/Onest-SemiBold.ttf"); font-weight: 600; }
@font-face { font-family: "JetBrains Mono"; src: url("FONTS/JetBrainsMono-Regular.ttf"); font-weight: 400; }
@font-face { font-family: "JetBrains Mono"; src: url("FONTS/JetBrainsMono-Medium.ttf"); font-weight: 500; }

:root { }

* { box-sizing: border-box; }

body {
  font-family: "Onest", sans-serif;
  font-size: 10.3pt;
  line-height: 1.5;
  color: #0d141b;
}

h2 { string-set: section content(); }

@page {
  size: A4;
  margin: 24mm 18mm 20mm 25mm;
  @top-left { content: "Расклад. Сопроводительная документация"; font-family: Onest; font-size: 8pt; color: #55636f; border-bottom: 0.5pt solid #c9d2db; padding-bottom: 4mm; width: 100%; }
  @top-right { content: string(section); font-family: Onest; font-size: 8pt; color: #55636f; border-bottom: 0.5pt solid #c9d2db; padding-bottom: 4mm; width: 100mm; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @bottom-left { content: "unicorn · ЛЦТ-2026"; font-family: Onest; font-size: 8pt; color: #55636f; border-top: 0.5pt solid #c9d2db; padding-top: 3mm; }
  @bottom-right { content: counter(page); font-family: "JetBrains Mono"; font-size: 8pt; color: #55636f; border-top: 0.5pt solid #c9d2db; padding-top: 3mm; }
}

@page cover {
  margin: 0;
  @top-left { content: none; border: none; }
  @top-right { content: none; border: none; }
  @bottom-left { content: none; border: none; }
  @bottom-right { content: none; border: none; }
}

@page toc {
  @top-right { content: "Оглавление"; }
}

.cover { page: cover; page-break-after: always; height: 297mm; position: relative; background: #0d141b; color: #ffffff; }
.cover-inner { position: absolute; left: 25mm; right: 25mm; bottom: 30mm; }
.cover-kicker { font-family: "JetBrains Mono"; font-size: 10pt; letter-spacing: 0.06em; text-transform: uppercase; color: #8ea9c9; margin-bottom: 10mm; }
.cover-title { font-family: "Onest"; font-weight: 600; font-size: 30pt; line-height: 1.2; margin-bottom: 8mm; }
.cover-subtitle { font-size: 12pt; color: #c9d2db; max-width: 130mm; }
.cover-line { margin-top: 14mm; width: 24mm; height: 1.2mm; background: #0b4fa8; }

.toc-page { page: toc; page-break-after: always; }
.toc-page h1 { font-size: 16pt; margin-bottom: 8mm; }
.toc-list { list-style: none; margin: 0; padding: 0; }
.toc-entry { margin: 0 0 3mm 0; font-size: 10.5pt; }
.toc-entry.toc-sub { margin-left: 8mm; font-size: 9.5pt; color: #55636f; }
.toc-entry a { text-decoration: none; color: #0d141b; }
.toc-entry.toc-sub a { color: #55636f; }
.toc-entry a::after { content: leader(".") target-counter(attr(href), page); color: #55636f; font-family: "JetBrains Mono"; font-size: 9pt; }

h1 { font-family: "Onest"; font-weight: 600; font-size: 18pt; color: #0d141b; margin: 0 0 6mm 0; }
h2 { font-family: "Onest"; font-weight: 600; font-size: 14.5pt; color: #0b4fa8; margin: 10mm 0 4mm 0; padding-top: 2mm; border-top: 0.6pt solid #c9d2db; break-after: avoid-page; }
h2.section-break { break-before: page; border-top: none; padding-top: 0; margin-top: 0; }
h3 { font-family: "Onest"; font-weight: 600; font-size: 12pt; color: #0d141b; margin: 6mm 0 3mm 0; break-after: avoid-page; }
h4 { font-family: "Onest"; font-weight: 500; font-size: 10.8pt; color: #0d141b; margin: 4mm 0 2mm 0; break-after: avoid-page; }

p { margin: 0 0 3mm 0; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 3mm 0; padding-left: 5mm; }
li { margin: 0 0 1.5mm 0; }
a { color: #0b4fa8; }
strong { font-weight: 600; }
code { font-family: "JetBrains Mono"; font-size: 9pt; background: #eff5fd; padding: 0.3mm 1mm; border-radius: 0.8mm; }
pre { font-family: "JetBrains Mono"; font-size: 8.6pt; background: #eff5fd; padding: 3mm; border-radius: 1.5mm; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { margin: 0 0 3mm 0; padding-left: 4mm; border-left: 1pt solid #c9d2db; color: #55636f; }

table { width: 100%; border-collapse: collapse; margin: 0 0 4mm 0; font-size: 9pt; table-layout: fixed; }
th, td { border: 0.5pt solid #c9d2db; padding: 1.5mm 2.1mm; text-align: left; vertical-align: top; overflow-wrap: break-word; }
thead { display: table-header-group; }
thead th { background: #eff5fd; color: #0b4fa8; font-weight: 600; font-family: "Onest"; }
tr { break-inside: avoid; }
/* последняя строка таблицы не должна уезжать одна на новую страницу: запрещаем
   разрыв между предпоследней и последней строкой, они переходят вместе */
tr:nth-last-child(2) { break-after: avoid; }

.doc-figure { margin: 3mm 0 6mm 0; break-inside: avoid; }
.doc-figure img { max-width: 56%; display: block; margin: 0 auto; border: 0.5pt solid #c9d2db; border-radius: 1.5mm; }
.doc-figure figcaption { font-size: 8.6pt; color: #55636f; margin-top: 2mm; }

hr { border: none; border-top: 0.5pt solid #c9d2db; margin: 6mm 0; }
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DOCS / "documentation.pdf"))
    parser.add_argument("--stand-access", default=None, help="файл с текстом подраздела \"Доступ к стенду\"")
    args = parser.parse_args()

    text = SOURCE.read_text(encoding="utf-8")
    text = inject_stand_access(text, Path(args.stand_access) if args.stand_access else None)
    text = linkify(text)

    md = md_lib.Markdown(extensions=["extra", "tables", "toc", "sane_lists"], extension_configs={
        "toc": {"permalink": False, "toc_depth": "2-3"},
    })
    body_html = md.convert(text)
    body_html = mark_section_breaks(body_html)
    body_html = wrap_images(body_html)
    toc_html = build_toc(md.toc_tokens)

    fonts_uri = FONTS.as_uri() + "/"
    css = CSS.replace("FONTS/", fonts_uri)

    html_doc = f"""<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><style>{css}</style></head>
<body>
<div class="cover">
  <div class="cover-inner">
    <div class="cover-kicker">ЛЦТ-2026 · задача №1 · ФЦ БАС</div>
    <div class="cover-title">{TITLE}</div>
    <div class="cover-subtitle">{SUBTITLE}</div>
    <div class="cover-line"></div>
  </div>
</div>
<div class="toc-page">
  <h1>Оглавление</h1>
  {toc_html}
</div>
{body_html}
</body></html>"""

    out_path = Path(args.output)
    base_url = str(IMAGES) + "/"
    HTML(string=html_doc, base_url=base_url).write_pdf(out_path)
    print(out_path)


if __name__ == "__main__":
    main()
