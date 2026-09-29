"""Образ сервера получает все данные, которые сервер читает при работе. Тесты читают data/ прямо
из репозитория, поэтому забытая строка COPY видна только после docker compose up: здесь ловим раньше."""

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Что сервер читает из data/: каталог и фото, характеристики с источниками, сохраненные страницы
# производителей, задачи и решения аэропорта и медучреждения
NEEDED = [
    "data/catalog/warehouse.csv",
    "data/catalog/uses.csv",
    "data/specs/specs.csv",
    "data/specs/sources.csv",
    "data/specs/saved/pages.csv",
    "data/facilities/tasks.csv",
    "data/facilities/solutions.csv",
    "data/facilities/airport.csv",
    "data/facilities/clinic.csv",
]
# Фото решений (сделаны из каталога организатора) лежат только в закрытом репозитории: в образ
# попадают, если они есть
OPTIONAL = ["data/catalog/photos/sources.csv"]


def copied() -> list[str]:
    sources = []
    for line in (REPO / "backend" / "Dockerfile").read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if parts[:1] == ["COPY"] and not any(part.startswith("--") for part in parts):
            sources += parts[1:-1]
    return sources


def test_image_gets_every_data_file_the_server_reads():
    sources = copied()
    missing = [
        path
        for path in NEEDED + OPTIONAL
        if not any(path == s or path.startswith(s.rstrip("/") + "/") for s in sources)
    ]
    assert missing == []


def test_needed_files_exist_in_repository():
    assert [path for path in NEEDED if not (REPO / path).exists()] == []
