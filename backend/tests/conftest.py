import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import throttle
from app.db import get_session
from app.main import app
from app.services import catalog_photos, catalog_uses, selection
from app.services.catalog_import import seed_team_catalog
from app.storage.models import Base


def memory_database():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    # SQLite без этой настройки не удаляет связанные строки следом (ondelete=CASCADE), а Postgres удаляет
    event.listen(engine, "connect", lambda connection, _: connection.execute("pragma foreign_keys=on"))
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine, autoflush=False)


def catalog_database():
    """Каталог для подбора, как после первого запуска сервера: наши решения, фото и привязки из data/.
    Ставим до сбора тестов: некоторые модули читают каталог прямо при импорте."""
    _, make_session = memory_database()
    with make_session() as session:
        seed_team_catalog(session)
        catalog_photos.seed_photos(session)
        catalog_uses.seed_uses(session)
    return make_session


selection.sessions = catalog_database()


@pytest.fixture
def db_client():
    """Клиент API с чистой базой в памяти: тестам не нужен запущенный Postgres."""
    engine, make_session = memory_database()

    def session_override():
        with make_session() as session:
            yield session

    app.dependency_overrides[get_session] = session_override
    throttle.clear()
    yield TestClient(app)
    app.dependency_overrides.pop(get_session, None)
    engine.dispose()
