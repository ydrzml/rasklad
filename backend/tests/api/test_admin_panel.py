import re
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app import admin_panel
from app.db import get_session
from app.main import app
from app.storage.models import User


@pytest.fixture
def panel(db_client, monkeypatch):
    """Служебные таблицы проверяют роль и читают таблицы сами, своей сессией базы: подменяем ее на тестовую."""
    monkeypatch.setattr(admin_panel, "SessionLocal", lambda: next(app.dependency_overrides[get_session]()))
    bind = next(app.dependency_overrides[get_session]()).get_bind()
    for view in (admin_panel.SolutionView, admin_panel.UserView, admin_panel.ChangeView, admin_panel.NormChangeView):
        monkeypatch.setattr(view, "session_maker", sessionmaker(bind=bind))
    return db_client


def test_guest_goes_to_login(panel):
    response = panel.get(f"{admin_panel.BASE_URL}/", follow_redirects=False)
    assert response.status_code in (302, 303, 307) and response.headers["location"] == "/login"


def test_user_is_refused(panel):
    panel.post("/api/auth/demo", json={"role": "user"})
    response = panel.get(f"{admin_panel.BASE_URL}/", follow_redirects=False)
    assert response.status_code == 403


def test_admin_gets_in_in_russian(panel):
    panel.post("/api/auth/demo", json={"role": "admin"})
    response = panel.get(f"{admin_panel.BASE_URL}/", follow_redirects=False)
    assert response.status_code == 302 and response.headers["location"] == f"{admin_panel.BASE_URL}/solution/list"
    response = panel.get(response.headers["location"])
    assert response.status_code == 200
    assert "Журнал правок каталога" in response.text and "Пользователи" in response.text


def test_tables_in_our_look(panel):
    """Свои стили и шрифт Onest: страница ссылается на них, и сервер их отдает."""
    panel.post("/api/auth/demo", json={"role": "admin"})
    page = panel.get(f"{admin_panel.BASE_URL}/solution/list").text
    assert f"{admin_panel.BASE_URL}/look/admin.css" in page
    css = panel.get(f"{admin_panel.BASE_URL}/look/admin.css")
    assert css.status_code == 200 and "Onest" in css.text
    font = panel.get(f"{admin_panel.BASE_URL}/fonts/onest-cyrillic.woff2")
    assert font.status_code == 200 and font.content[:4] == b"wOF2"


def test_every_catalog_action_has_russian_label():
    """Новое действие в журнале без подписи показалось бы в таблицах кодом вроде uses_seed."""
    services = Path(admin_panel.__file__).parent / "services"
    code = "\n".join(path.read_text(encoding="utf-8") for path in services.glob("catalog*.py"))
    written = set(re.findall(r'action="(\w+)"', code)) | set(re.findall(r'_log\([^)]*?"(\w+)"', code))
    written |= set(re.findall(r'^\s+"(photo_\w+)",$', code, re.M))
    assert written and written <= set(admin_panel.ACTIONS), written - set(admin_panel.ACTIONS)


def test_nobody_is_deleted_past_our_checks(panel):
    """Удалить человека в служебных таблицах нельзя: так стерли бы и общий демо-аккаунт."""
    assert admin_panel.UserView.can_delete is False
    panel.post("/api/auth/demo", json={"role": "user"})
    panel.post("/api/auth/demo", json={"role": "admin"})
    session = next(app.dependency_overrides[get_session]())
    demo = session.scalar(select(User).where(User.role == "user"))
    response = panel.delete(f"{admin_panel.BASE_URL}/user/delete", params={"pks": demo.id})
    assert response.status_code in (403, 404, 405)
    session.expire_all()
    assert session.get(User, demo.id) is not None
