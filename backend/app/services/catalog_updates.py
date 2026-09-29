"""Автообновление характеристик: проверяем страницы производителей и предлагаем правки администратору.

Что проверяем. Страницы производителей из data/specs/sources.csv, с которых мы собирали характеристики.
У каждого значения там записана цитата, например "Грузоподъемность; до 1500 кг". Ищем на странице
подпись из цитаты и берем число за ней. Разбора под каждый сайт нет, поэтому страница, которую
переделали, честно уходит в "проверить руками".

Что делаем с найденным. Каталог сами не меняем:
- число то же, что в каталоге (расхождение до 10%, как в правилах данных): записываем дату проверки;
- число другое: предложение правки, администратор принимает или отклоняет, решение идет в журнал;
- подпись не нашли, страница не открылась, это PDF: "проверить руками";
- сайт запрещает сбор в robots.txt: на страницу не ходим.

Единицы на странице бывают другие, чем в каталоге: минуты вместо часов, км/ч вместо м/с. Поэтому
число со страницы переводим в единицы каталога той же долей, что и число в цитате.

Без интернета проверка идет по сохраненным строкам нескольких страниц из data/specs/saved.
"""

from __future__ import annotations

import csv
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from html.parser import HTMLParser
from urllib.parse import quote, urlsplit
from urllib.robotparser import RobotFileParser

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.engine.selection import number
from app.services.catalog_admin import FIELD_IDS
from app.settings import settings
from app.storage.models import CatalogChange, Solution, SolutionSpec, SpecCheck, User

# Представляемся честно: кто ходит и как часто. Заголовок только латиницей, так требует HTTP
USER_AGENT = "RaskladCatalogCheck/1.0 (catalog spec check, one page per 2 seconds)"
PAUSE_S = 2.0
TIMEOUT_S = 15
TOLERANCE = 0.10  # как в правилах данных: значения сходятся, если отличаются не больше чем на 10%
TEXT_FIELDS = {"navigation_type", "dimensions_mm"}  # здесь не одно число, сверяем текст цитаты
OFFLINE_AFTER = 3  # столько страниц подряд не открылись по сети с самого начала: интернета нет

# Сессии и загрузка страниц. Тесты подменяют их на базу в памяти и заготовленные страницы
sessions: Callable[[], Session] = SessionLocal


class Blocked(Exception):
    """Сайт запрещает сбор этой страницы."""


class Offline(Exception):
    """Сеть недоступна: страница не открылась не по вине сайта."""


class Failed(Exception):
    """Сайт ответил ошибкой."""


def fetch(url: str) -> str:
    request = urllib.request.Request(quote(url, safe=":/?&=%#+"), headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read(2_000_000).decode(charset, errors="replace")
    except urllib.error.HTTPError as error:
        raise Failed(f"сайт ответил {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise Offline(str(getattr(error, "reason", error))) from error


@dataclass(frozen=True)
class Target:
    """Одно значение, которое проверяем: решение, характеристика, страница и цитата с нее."""

    solution_id: str
    field: str
    url: str
    quote: str
    value: str  # значение из этой цитаты в единицах каталога
    chosen: str  # значение, которое правила данных выбрали для каталога при сборе


def targets() -> list[Target]:
    path = settings.data_dir / "specs" / "sources.csv"
    with path.open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file, delimiter=";"))
    with (settings.data_dir / "specs" / "specs.csv").open(encoding="utf-8-sig", newline="") as file:
        chosen = {(row["catalog_id"], row["field"]): row["value"] for row in csv.DictReader(file, delimiter=";")}
    return [
        Target(
            row["catalog_id"],
            row["field"],
            row["source"].strip(),
            row["quote"],
            row["value"],
            chosen.get((row["catalog_id"], row["field"]), ""),
        )
        for row in rows
        if row["source_type"] == "производитель"
        and row["current"] != "устарело"
        and row["source"].strip().startswith("http")
        and row["quote"].strip()
        and row["field"] in FIELD_IDS
    ]


def saved_pages() -> dict[str, str]:
    """Сохраненные строки страниц для проверки без интернета: адрес -> текст."""
    folder = settings.data_dir / "specs" / "saved"
    index = folder / "pages.csv"
    if not index.exists():
        return {}
    with index.open(encoding="utf-8-sig", newline="") as file:
        return {
            row["url"]: (folder / row["file"]).read_text(encoding="utf-8")
            for row in csv.DictReader(file, delimiter=";")
        }


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: object) -> None:
        if tag in ("script", "style", "noscript"):
            self._skip += 1
        self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
        self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def page_text(html: str) -> str:
    """Текст страницы без разметки: ячейки таблицы и строки списка остаются отдельными строками."""
    parser = _Text()
    parser.feed(html)
    lines = (" ".join(line.split()) for line in "".join(parser.parts).replace("\xa0", " ").splitlines())
    return "\n".join(line for line in lines if line)


def _flat(text: str) -> str:
    """Для сравнения: без регистра, лишних пробелов и знаков между подписью и значением."""
    text = re.sub(r"[;:|]", " ", text.replace("\xa0", " ").replace("\u0451", "\u0435").lower())
    text = re.sub(r"(?<=\d)\s*[xх×*]\s*(?=\d)", "x", text)  # габариты пишут через x, русскую х и знак умножения
    return " ".join(text.split())


def _split(quote: str) -> tuple[str, str]:
    """Цитата -> (подпись, значение). "Грузоподъемность; до 1500 кг" или "Скорость до 1,3 м/с"."""
    if ";" in quote or "|" in quote:
        label, value = re.split(r"[;|]", quote, maxsplit=1)
    elif " ... " in quote:  # мы сокращали длинную цитату многоточием: подпись до него, значение после
        label, value = quote.split(" ... ", 1)
    else:
        found = re.search(r"\d", quote)
        label, value = (quote[: found.start()], quote[found.start() :]) if found else (quote, "")
    return label.strip(" :-\u2013\u2014\t"), value.strip()


def _near(a: float, b: float) -> bool:
    return abs(a - b) <= TOLERANCE * max(abs(a), abs(b))


@dataclass
class Found:
    outcome: str  # same, differs, manual, blocked
    found_text: str = ""
    proposed: str = ""
    note: str = ""


def check(target: Target, text: str, current: str) -> Found:
    """Сверяет одно значение со страницей. current это то, что сейчас стоит в каталоге.

    Сначала ищем цитату целиком: если она на месте, страница не менялась с тех пор, как мы собирали
    данные. Если нет, ищем подпись и берем число сразу за ней, в той же строке или в следующей.
    """
    lines = [_flat(line) for line in text.splitlines()]
    page = " ".join(lines)
    unchanged = _flat(target.quote) in page
    label, quoted = _split(target.quote)
    if target.field in TEXT_FIELDS or number(quoted) is None:
        if unchanged or (quoted and _flat(quoted) in page):
            return Found("same", found_text=target.quote)
        return Found("manual", note="прежней строки на странице нет, сравните руками")
    # число со страницы переводим в единицы каталога той же долей, что число в цитате
    quoted_raw, quoted_value = number(quoted), number(target.value)
    scale = quoted_value / quoted_raw if quoted_raw and quoted_value else 1.0
    if unchanged:
        found, found_text = quoted_raw or 0.0, target.quote
    else:
        found, found_text = _after_label(lines, label, quoted_raw)
        if found is None:
            return Found(
                "manual", note="подписи с числом из цитаты на странице нет или их несколько: страницу переделали"
            )
        unchanged = quoted_raw is not None and _near(found, quoted_raw)
    value = found * scale
    now, chosen = number(current), number(target.chosen)
    if now is not None and _near(value, now):
        return Found("same", found_text=found_text)
    if unchanged and (current.strip() == target.chosen.strip() or (now and chosen and _near(now, chosen))):
        # страница прежняя, а в каталоге по правилам данных стоит значение другого источника или пусто
        return Found("same", found_text=found_text, note="в каталоге значение, выбранное по правилам данных")
    proposed = f"{value:.2f}".rstrip("0").rstrip(".")
    note = "в каталоге значение поменяли после сбора" if unchanged else "на странице теперь другое число"
    if scale != 1.0:
        note += f"; единицы на странице другие, перевели так же, как цитату ({quoted} -> {target.value})"
    return Found("differs", found_text=found_text, proposed=proposed, note=note)


NUMBER_SOON = re.compile(r"^[^\d]{0,12}\d")  # число сразу за подписью: "до 1500", "~30", "1,5"


def _after_label(lines: list[str], label: str, expected: float | None) -> tuple[float | None, str]:
    """Число к подписи. В той же строке за подписью, а если строка кончилась, в соседней ячейке:
    на одних сайтах значение стоит после подписи, на других перед ней. Если соседних чисел два
    и ни одно не прежнее, какое из них к подписи, не понять: такое уходит на ручную проверку."""
    key = _flat(label)
    if not key:
        return None, ""
    pattern = re.compile(rf"(?<![\w]){re.escape(key)}(?![\w])")  # "вес" не должен найтись внутри "весом"
    found: list[tuple[float, str]] = []
    for i, line in enumerate(lines):
        hit = pattern.search(line)
        if hit is None:
            continue
        rest = line[hit.end() :].strip()
        if rest:
            if NUMBER_SOON.match(rest):
                found.append((number(rest) or 0.0, rest))
            continue
        near = [lines[j] for j in (i + 1, i - 1) if 0 <= j < len(lines) and NUMBER_SOON.match(lines[j])]
        same = [cell for cell in near if expected is not None and _near(number(cell) or 0.0, expected)]
        if same or len(near) == 1:
            cell = (same or near)[0]
            found.append((number(cell) or 0.0, cell))
    # Прежнее число нашлось хоть у одной подписи: страница его по-прежнему пишет
    for value, cell in found:
        if expected is not None and _near(value, expected):
            return value, f"{label}: {cell[:60]}"
    # Подписей несколько (на странице несколько моделей): какая наша, не понять
    if len(found) == 1 and len(pattern.findall(" \n ".join(lines))) == 1:
        value, cell = found[0]
        return value, f"{label}: {cell[:60]}"
    return None, ""


@dataclass
class Run:
    """Ход проверки. Проверка одна на сервер: вторая кнопка не запускает второй обход."""

    running: bool = False
    source: str = ""
    total: int = 0
    done: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None
    offline: bool = False
    message: str = ""
    counts: dict[str, int] = field(default_factory=dict)


state = Run()
_lock = threading.Lock()


def start(source: str) -> bool:
    """Занимает проверку. False, если она уже идет."""
    global state
    if not _lock.acquire(blocking=False):
        return False
    pages = saved_pages() if source == "saved" else None
    urls = {t.url for t in targets() if pages is None or t.url in pages}
    state = Run(running=True, source=source, total=len(urls), started_at=datetime.now(UTC))
    return True


def run(source: str) -> None:
    """Обходит страницы по одной с паузой. Зовется в фоне после start()."""
    try:
        _run(source)
    except Exception as error:  # проверка не должна молча зависнуть в "идет"
        state.message = f"Проверка прервалась: {error}"
        raise
    finally:
        state.running = False
        state.finished_at = datetime.now(UTC)
        _lock.release()


def _run(source: str) -> None:
    pages = saved_pages() if source == "saved" else None
    by_url: dict[str, list[Target]] = {}
    for target in targets():
        if pages is None or target.url in pages:
            by_url.setdefault(target.url, []).append(target)
    robots: dict[str, RobotFileParser | None] = {}
    counts = {"same": 0, "differs": 0, "manual": 0, "blocked": 0}
    network_errors = 0
    with sessions() as session:
        for url, group in by_url.items():
            text, verdict = "", None
            if pages is not None:
                text = pages[url]
            elif url.lower().endswith(".pdf"):
                verdict = Found("manual", note="это PDF, его сверяем руками")
            else:
                try:
                    text = page_text(_get(url, robots))
                    network_errors = -1  # сеть есть, дальше отдельные ошибки считаем ошибками сайтов
                except Blocked:
                    verdict = Found("blocked", note="сайт запрещает автоматический сбор (robots.txt), проверьте руками")
                except Offline as error:
                    if network_errors >= 0:
                        network_errors += 1
                        if network_errors >= OFFLINE_AFTER:
                            state.offline = True
                            state.message = "Нет доступа в интернет. Можно проверить по сохраненным страницам"
                            return
                    verdict = Found("manual", note=f"страница не открылась: {error}")
                except Failed as error:
                    verdict = Found("manual", note=f"страница не открылась: {error}")
            # с одной страницы бывает несколько цитат про одно поле: засчитываем лучшую из них
            best: dict[tuple[str, str], tuple[Target, Found]] = {}
            for target in group:
                key = (target.solution_id, target.field)
                found = verdict or check(target, text, _value(session, target))
                if key not in best or RANK[found.outcome] < RANK[best[key][1].outcome]:
                    best[key] = (target, found)
            for target, found in best.values():
                spec = _spec(session, target.solution_id, target.field)
                if spec is None:
                    continue
                _save(session, target, spec, found, "saved" if pages is not None else "web")
                counts[found.outcome] += 1
            session.commit()
            state.done += 1
            state.counts = dict(counts)
        session.add(
            CatalogChange(
                action="updates_check",
                changes=counts,
                note=(
                    f"Проверка страниц производителей ({'сохраненные страницы' if pages is not None else 'сайты'}): "
                    f"совпало {counts['same']}, расходится {counts['differs']}, проверить руками {counts['manual']}, "
                    f"сайт запрещает сбор {counts['blocked']}"
                ),
            )
        )
        session.commit()
    state.message = "Проверка закончена"


RANK = {"same": 0, "differs": 1, "manual": 2, "blocked": 3}


def _spec(session: Session, solution_id: str, field_id: str) -> SolutionSpec | None:
    return session.scalar(
        select(SolutionSpec).where(SolutionSpec.solution_id == solution_id, SolutionSpec.field == field_id)
    )


def _value(session: Session, target: Target) -> str:
    spec = _spec(session, target.solution_id, target.field)
    return spec.value if spec else ""


def _get(url: str, robots: dict[str, RobotFileParser | None]) -> str:
    """Страница с оглядкой на robots.txt сайта и паузой перед каждым запросом."""
    parts = urlsplit(url)
    site = f"{parts.scheme}://{parts.netloc}"
    if site not in robots:
        time.sleep(PAUSE_S)
        try:
            rules = RobotFileParser()
            rules.parse(fetch(f"{site}/robots.txt").splitlines())
            robots[site] = rules
        except Failed:
            robots[site] = None  # robots.txt нет: ограничений сайт не объявил
    rules = robots[site]
    if rules is not None and not rules.can_fetch(USER_AGENT, url):
        raise Blocked(url)
    time.sleep(PAUSE_S)
    return fetch(url)


def _save(session: Session, target: Target, spec: SolutionSpec, found: Found, source: str) -> None:
    row = session.scalar(
        select(SpecCheck).where(
            SpecCheck.solution_id == target.solution_id, SpecCheck.field == target.field, SpecCheck.url == target.url
        )
    )
    if row is None:
        row = SpecCheck(solution_id=target.solution_id, field=target.field, url=target.url)
        session.add(row)
    # Решение администратора по тому же числу помним: отклоненное не предлагаем снова
    decided = row.status in ("accepted", "rejected") and row.proposed == found.proposed
    row.quote, row.outcome, row.found_text, row.note = target.quote, found.outcome, found.found_text, found.note
    row.current, row.proposed, row.source = spec.value, found.proposed, source
    row.checked_at = datetime.now(UTC)
    if found.outcome != "differs":
        row.status = ""
    elif not decided:
        row.status, row.decided_by, row.decided_at = "new", "", None


class NotFound(Exception):
    pass


def items(session: Session) -> list[tuple[SpecCheck, Solution | None]]:
    rows = session.scalars(select(SpecCheck).order_by(SpecCheck.solution_id, SpecCheck.field, SpecCheck.id)).all()
    names = {s.id: s for s in session.scalars(select(Solution).where(Solution.id.in_({r.solution_id for r in rows})))}
    return [(row, names.get(row.solution_id)) for row in rows]


def accept(session: Session, user: User, check_id: int, value: str, rating: str) -> SpecCheck:
    """Принять предложение: значение, оценка, страница и цитата уходят в характеристику, правка в журнал."""
    row = _proposal(session, check_id)
    spec = session.scalar(
        select(SolutionSpec).where(SolutionSpec.solution_id == row.solution_id, SolutionSpec.field == row.field)
    )
    if spec is None:
        raise NotFound(f"характеристика {row.field}")
    changes = {}
    checked = row.checked_at.date()
    sources = spec.source.split("\n") if spec.source else []
    new = {
        "value": value,
        "rating": rating,
        "source": "\n".join([row.url, *[s for s in sources if s != row.url]]),
        "source_type": "производитель",
        "quote": row.found_text,
        "retrieved": checked,
    }
    for name, after in new.items():
        before = getattr(spec, name)
        if before != after:
            changes[f"{row.field}.{name}"] = [str(before) if before is not None else None, str(after)]
            setattr(spec, name, after)
    spec.solution.updated_at = datetime.now(UTC)
    row.status, row.decided_by, row.decided_at = "accepted", user.email, datetime.now(UTC)
    _log(session, user, "update_accept", spec.solution, changes, f"автообновление: {row.url}, проверено {checked}")
    session.commit()
    return row


def reject(session: Session, user: User, check_id: int) -> SpecCheck:
    row = _proposal(session, check_id)
    row.status, row.decided_by, row.decided_at = "rejected", user.email, datetime.now(UTC)
    solution = session.get(Solution, row.solution_id)
    _log(
        session,
        user,
        "update_reject",
        solution,
        {f"{row.field}.value": [row.current, row.proposed]},
        f"отклонено предложение с {row.url}, проверено {row.checked_at.date()}",
    )
    session.commit()
    return row


def _proposal(session: Session, check_id: int) -> SpecCheck:
    row = session.get(SpecCheck, check_id)
    if row is None or row.outcome != "differs":
        raise NotFound(f"предложение {check_id}")
    return row


def _log(session: Session, user: User, action: str, solution: Solution | None, changes: dict, note: str) -> None:
    session.add(
        CatalogChange(
            user_id=user.id,
            user_email=user.email,
            action=action,
            solution_id=solution.id if solution else None,
            solution_name=solution.name if solution else "",
            changes=changes,
            note=note,
        )
    )
