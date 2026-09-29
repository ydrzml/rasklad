from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import get_session
from app.main import app
from app.services import projects
from app.storage.models import ProjectFile, ProjectVersion

IVAN = {"email": "ivan@example.com", "password": "correct-horse"}
MASHA = {"email": "masha@example.com", "password": "battery-staple"}

STATE = {"facility": "warehouse", "operations": ["pallet_transport"], "overrides": {"staff.salary_rub": 90000}}
RESULT = {"scenarios": {"purchase": {"payback_years": 2.4}}}


def sign_in(client: TestClient, who: dict) -> None:
    client.post("/api/auth/logout")
    if client.post("/api/auth/login", json=who).status_code != 200:
        client.post("/api/auth/register", json=who)


def new_project(client: TestClient, **extra) -> dict:
    response = client.post("/api/projects", json={"name": "Склад в Подольске", **extra})
    assert response.status_code == 201
    return response.json()


def rows(model) -> int:
    session = next(app.dependency_overrides[get_session]())
    return session.scalar(select(func.count()).select_from(model))


def test_guest_cannot_save(db_client):
    assert db_client.get("/api/projects").status_code == 401
    assert db_client.post("/api/projects", json={"name": "x"}).status_code == 401


def test_create_with_calculation_saves_first_version(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE, result=RESULT, note="Первый расчет")

    assert project["versions"] == 1
    assert project["current"]["number"] == 1
    assert project["current"]["state"] == STATE
    assert project["current"]["result"] == RESULT
    assert project["current"]["same_data"] is True
    assert project["current"]["model_version"] and project["current"]["data_version"]
    assert db_client.get("/api/projects").json()[0]["name"] == "Склад в Подольске"


def test_empty_project_has_no_calculation_yet(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client)
    assert project["versions"] == 0 and project["current"] is None and project["history"] == []


def test_each_save_is_a_new_version_and_old_ones_reopen(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE, result=RESULT)
    changed = {**STATE, "overrides": {"staff.salary_rub": 120000}}
    saved = db_client.post(f"/api/projects/{project['id']}/versions", json={"state": changed, "note": "Зарплата выше"})
    assert saved.status_code == 201 and saved.json()["number"] == 2

    again = db_client.get(f"/api/projects/{project['id']}").json()
    assert [v["number"] for v in again["history"]] == [1, 2]
    assert again["current"]["state"] == changed

    first = db_client.get(f"/api/projects/{project['id']}/versions/1").json()
    assert first["state"] == STATE and first["result"] == RESULT
    assert db_client.get(f"/api/projects/{project['id']}/versions/9").status_code == 404


def test_changed_data_is_flagged_on_reopen(db_client, monkeypatch):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    monkeypatch.setattr(projects, "data_version", lambda: "другие-данные")
    reopened = db_client.get(f"/api/projects/{project['id']}").json()
    assert reopened["current"]["same_data"] is False


def test_rename_and_list_order(db_client):
    sign_in(db_client, IVAN)
    older = new_project(db_client)
    new_project(db_client, name="Второй склад")
    renamed = db_client.patch(f"/api/projects/{older['id']}", json={"name": "  Склад в Химках "})
    assert renamed.json()["name"] == "Склад в Химках"
    assert [p["name"] for p in db_client.get("/api/projects").json()] == ["Склад в Химках", "Второй склад"]
    assert db_client.patch(f"/api/projects/{older['id']}", json={"name": ""}).status_code == 422


def test_copy_takes_last_version_and_files(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    db_client.post(f"/api/projects/{project['id']}/versions", json={"state": {**STATE, "shift_hours": 22}})
    db_client.post(f"/api/projects/{project['id']}/files", files={"file": ("штат.csv", b"role;count\n", "text/csv")})

    copy = db_client.post(f"/api/projects/{project['id']}/copy")
    assert copy.status_code == 201
    copy = copy.json()
    assert copy["id"] != project["id"]
    assert copy["name"] == "Склад в Подольске (копия)"
    assert copy["versions"] == 1
    assert copy["current"]["state"]["shift_hours"] == 22
    assert "версия 2" in copy["current"]["note"]
    assert [f["name"] for f in copy["files"]] == ["штат.csv"]

    named = db_client.post(f"/api/projects/{project['id']}/copy", json={"name": "Вариант с арендой"}).json()
    assert named["name"] == "Вариант с арендой"


def test_delete_removes_versions_and_files(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    db_client.post(f"/api/projects/{project['id']}/files", files={"file": ("объемы.xlsx", b"PK", "application/zip")})
    assert rows(ProjectVersion) == 1 and rows(ProjectFile) == 1

    assert db_client.delete(f"/api/projects/{project['id']}").status_code == 204
    assert db_client.get(f"/api/projects/{project['id']}").status_code == 404
    assert rows(ProjectVersion) == 0 and rows(ProjectFile) == 0


def test_files_upload_download_and_limits(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client)
    url = f"/api/projects/{project['id']}/files"

    uploaded = db_client.post(url, files={"file": ("объемы.csv", "дата;объем\n".encode(), "text/csv")}).json()
    downloaded = db_client.get(f"{url}/{uploaded['id']}")
    assert downloaded.content == "дата;объем\n".encode()
    assert "filename*=UTF-8''" in downloaded.headers["content-disposition"]

    assert db_client.post(url, files={"file": ("virus.exe", b"MZ", "application/x-msdownload")}).status_code == 415
    too_big = b"x" * (projects.MAX_FILE_BYTES + 1)
    assert db_client.post(url, files={"file": ("big.csv", too_big, "text/csv")}).status_code == 413

    assert db_client.delete(f"{url}/{uploaded['id']}").status_code == 204
    assert db_client.get(f"/api/projects/{project['id']}").json()["files"] == []


def test_too_large_calculation_is_rejected(db_client, monkeypatch):
    sign_in(db_client, IVAN)
    monkeypatch.setattr(projects, "MAX_STATE_BYTES", 100)
    response = db_client.post("/api/projects", json={"name": "x", "state": {"blob": "x" * 200}})
    assert response.status_code == 413


def test_other_users_projects_are_invisible(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    db_client.post(f"/api/projects/{project['id']}/files", files={"file": ("штат.csv", b"1", "text/csv")})
    file_id = db_client.get(f"/api/projects/{project['id']}").json()["files"][0]["id"]

    sign_in(db_client, MASHA)
    base = f"/api/projects/{project['id']}"
    assert db_client.get("/api/projects").json() == []
    assert db_client.get(base).status_code == 404
    assert db_client.get(f"{base}/versions/1").status_code == 404
    assert db_client.patch(base, json={"name": "Мое"}).status_code == 404
    assert db_client.post(f"{base}/copy").status_code == 404
    assert db_client.post(f"{base}/versions", json={"state": {}}).status_code == 404
    assert db_client.get(f"{base}/files/{file_id}").status_code == 404
    assert db_client.delete(f"{base}/files/{file_id}").status_code == 404
    assert db_client.delete(base).status_code == 404

    # Администратор чужих проектов тоже не видит
    db_client.post("/api/auth/demo", json={"role": "admin"})
    assert db_client.get("/api/projects").json() == []
    assert db_client.get(base).status_code == 404

    sign_in(db_client, IVAN)
    still = db_client.get(base).json()
    assert still["name"] == "Склад в Подольске" and still["versions"] == 1 and len(still["files"]) == 1
