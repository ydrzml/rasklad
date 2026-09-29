"""Миграции базы. Адрес базы берем из настроек приложения, тесты подставляют свой через sqlalchemy.url."""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app.settings import settings
from app.storage.models import Base

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

url = config.get_main_option("sqlalchemy.url") or settings.database_url


def run_offline() -> None:
    context.configure(url=url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_online() -> None:
    with create_engine(url).connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_offline()
else:
    run_online()
