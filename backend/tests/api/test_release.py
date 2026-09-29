"""Настройки для стенда: выключенный демо-вход и тип скачиваемого файла."""

from app.settings import settings
from tests.api.test_projects import IVAN, new_project, sign_in


def test_demo_status_follows_setting(db_client, monkeypatch):
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
