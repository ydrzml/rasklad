"""Скрипт возврата демо-данных: демо-проекты и каталог как после первого запуска, чужое не трогаем."""

from sqlalchemy import func, select

from app.db import get_session
from app.main import app
from app.services.catalog_import import organizer_file
from app.storage.models import CatalogChange, Project, Role, Solution, User
from scripts.reset_demo import reset
from tests.api.test_projects import IVAN, new_project, sign_in


def session():
    return next(app.dependency_overrides[get_session]())


def count(db, model) -> int:
    return db.scalar(select(func.count()).select_from(model))


# Каталог после первого запуска: наши 31 решение, а если выгрузка организатора лежит в репозитории,
# то вместе с ней 190 позиций
CATALOG = 190 if organizer_file().exists() else 31


def test_reset_returns_demo_projects_and_catalog(db_client):
    db = session()
    reset(db)
    assert count(db, Solution) == CATALOG

    sign_in(db_client, IVAN)
    new_project(db_client, name="Проект Ивана")

    db_client.post("/api/auth/logout")
    db_client.post("/api/auth/demo", json={"role": "user"})
    new_project(db_client, name="Эксперт поменял")

    db_client.post("/api/auth/demo", json={"role": "admin"})
    first = db_client.get("/api/admin/catalog").json()["items"][0]["id"]
    assert db_client.delete(f"/api/admin/catalog/{first}").status_code == 204

    done = reset(db)
    db.expire_all()
    assert done["projects"] == 1
    assert count(db, Solution) == CATALOG
    assert db.get(Solution, first) is not None
    # журнал очищен, остались только записи о новом заполнении
    assert "delete" not in set(db.scalars(select(CatalogChange.action)))
    names = set(db.scalars(select(Project.name)))
    assert names == {"Проект Ивана"}
    assert db.scalar(select(User.role).where(User.email == "admin@example.com")) == Role.admin
