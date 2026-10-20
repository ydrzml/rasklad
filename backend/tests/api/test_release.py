"""Настройки для стенда: выключенный демо-вход и тип скачиваемого файла."""

from app.settings import Settings, settings
from tests.api.test_projects import IVAN, new_project, sign_in


def test_passwordless_demo_login_is_off_by_default(db_client, monkeypatch):
    """Кнопок демо-входа нет: без явного DEMO_LOGIN=true вход без пароля закрыт, администратором не войти"""
    monkeypatch.delenv("DEMO_LOGIN", raising=False)
    defaults = Settings(_env_file=None)
    assert defaults.demo_login is False
    monkeypatch.setattr(settings, "demo_login", defaults.demo_login)
    assert db_client.get("/api/auth/demo").json() == {"enabled": False}
    assert db_client.post("/api/auth/demo", json={"role": "admin"}).status_code == 404
    assert db_client.get("/api/auth/me").json()["role"] == "guest"


def test_demo_status_follows_setting(db_client, monkeypatch):
    # тесты включают вход без пароля фикстурой в conftest.py
    assert db_client.get("/api/auth/demo").json() == {"enabled": True}

    monkeypatch.setattr(settings, "demo_login", False)
    assert db_client.get("/api/auth/demo").json() == {"enabled": False}
    assert db_client.post("/api/auth/demo", json={"role": "admin"}).status_code == 404
    assert db_client.get("/api/auth/me").json()["role"] == "guest"


def test_file_type_comes_from_extension_not_from_upload(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client)
    base = f"/api/projects/{project['id']}/files"
    # Загрузивший назвал файл таблицей, а тип указал страницей: браузер не должен открыть его как сайт
    added = db_client.post(base, files={"file": ("штат.csv", b"<script>alert(1)</script>", "text/html")}).json()
    assert added["content_type"] == "text/csv"

    response = db_client.get(f"{base}/{added['id']}")
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"].startswith("attachment")

    xlsx = db_client.post(base, files={"file": ("план.XLSX", b"PK", "text/html")}).json()
    assert xlsx["content_type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
