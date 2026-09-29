"""Подготовка базы при запуске: применить миграции, создать демо-аккаунты, положить наш каталог,
если база пустая. Каталог организатора загружается администратором в админке.
Повторный запуск ничего не ломает."""

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import func, select

from app.auth.service import ensure_demo_accounts
from app.db import SessionLocal
from app.reports.names import plural
from app.services.catalog_import import organizer_file, seed_organizer_catalog, seed_team_catalog
from app.services.catalog_photos import seed_photos
from app.services.catalog_uses import seed_uses
from app.storage.models import Solution

BACKEND_DIR = Path(__file__).resolve().parents[1]


def main() -> None:
    command.upgrade(Config(str(BACKEND_DIR / "alembic.ini")), "head")
    with SessionLocal() as session:
        ensure_demo_accounts(session)
        seed_team_catalog(session)
        seed_photos(session)
        seed_uses(session)
        added = seed_organizer_catalog(session)
        total = session.scalar(select(func.count()).select_from(Solution))
    if not organizer_file().exists():
        print(
            f"Каталог организатора администратор загружает в админке, каталог: {total} {plural(total, 'решение', 'решения', 'решений')}"
        )
    elif added:
        print(
            f"Выгрузка организатора загружена: добавлено {added}, в каталоге {total} {plural(total, 'позиция', 'позиции', 'позиций')}"
        )
    print("База готова: миграции применены, демо-аккаунты и каталог на месте")


if __name__ == "__main__":
    main()
