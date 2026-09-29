"""Роли и доступ: гость, пользователь, администратор. Чужой проект не видно и не изменить,
ссылка «Поделиться» открывается без входа, удаление аккаунта уносит все его данные."""

from sqlalchemy import func, select

from app.db import get_session
from app.main import app
from app.storage.models import Project, ProjectFile, ProjectVersion, Share, User
from tests.api.test_projects import IVAN, MASHA, RESULT, STATE, new_project, sign_in


def count(model) -> int:
    session = next(app.dependency_overrides[get_session]())
    return session.scalar(select(func.count()).select_from(model))


def me(client) -> dict:
    return client.get("/api/auth/me").json()


def full_project(client) -> tuple[dict, str]:
    """Проект с расчетом, файлом и ссылкой: возвращает проект и токен ссылки."""
    project = new_project(client, state=STATE, result=RESULT)
    client.post(f"/api/projects/{project['id']}/files", files={"file": ("штат.csv", b"role;count\n", "text/csv")})
    token = client.post(f"/api/projects/{project['id']}/shares").json()["token"]
    return project, token


# --- Гость ------------------------------------------------------------------------------


def test_guest_gets_401_on_every_project_action(db_client):
    sign_in(db_client, IVAN)
    project, token = full_project(db_client)
    file_id = db_client.get(f"/api/projects/{project['id']}").json()["files"][0]["id"]
    db_client.post("/api/auth/logout")
    assert me(db_client)["role"] == "guest"

    base = f"/api/projects/{project['id']}"
    calls = [
        ("get", "/api/projects", None),
        ("post", "/api/projects", {"name": "x"}),
        ("get", base, None),
        ("patch", base, {"name": "x"}),
        ("delete", base, None),
        ("post", f"{base}/copy", None),
        ("post", f"{base}/versions", {"state": {}}),
        ("get", f"{base}/versions/1", None),
        ("get", f"{base}/files/{file_id}", None),
        ("delete", f"{base}/files/{file_id}", None),
        ("post", f"{base}/shares", None),
        ("delete", f"{base}/shares/{token}", None),
        ("delete", "/api/auth/me", {"password": IVAN["password"]}),
    ]
    for method, url, body in calls:
        response = db_client.request(method.upper(), url, json=body)
        assert response.status_code == 401, (method, url, response.status_code)

    # а ссылку гость открыть может: она для этого и нужна
    assert db_client.get(f"/api/share/{token}").status_code == 200


def test_guest_can_calculate_and_take_the_template_without_login(db_client):
    assert me(db_client)["role"] == "guest"
    assert db_client.post("/api/calculations/preview", json={}).status_code == 200
    assert db_client.post("/api/import/template", json={}).status_code == 200
    assert db_client.get("/api/catalog/facilities").status_code == 200


# --- Пользователь и чужой проект -------------------------------------------------------


def test_stranger_cannot_touch_someone_elses_share(db_client):
    sign_in(db_client, IVAN)
    project, token = full_project(db_client)

    sign_in(db_client, MASHA)
    assert db_client.delete(f"/api/projects/{project['id']}/shares/{token}").status_code == 404
    assert db_client.post(f"/api/projects/{project['id']}/shares", json={"version": 1}).status_code == 404
    # ссылка жива, и вошедший чужой пользователь по ней тоже проходит, но почты владельца не видит
    shown = db_client.get(f"/api/share/{token}")
    assert shown.status_code == 200
    assert IVAN["email"] not in shown.text

    sign_in(db_client, IVAN)
    assert db_client.get(f"/api/projects/{project['id']}").json()["shares"][0]["token"] == token


def test_stranger_cannot_upload_a_file_into_someone_elses_project(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client)
    sign_in(db_client, MASHA)
    response = db_client.post(f"/api/projects/{project['id']}/files", files={"file": ("x.csv", b"1", "text/csv")})
    assert response.status_code == 404
    sign_in(db_client, IVAN)
    assert db_client.get(f"/api/projects/{project['id']}").json()["files"] == []


def test_project_ids_of_other_users_are_not_guessable_into_a_copy(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    sign_in(db_client, MASHA)
    assert db_client.post(f"/api/projects/{project['id']}/copy", json={"name": "Украл"}).status_code == 404
    assert db_client.get("/api/projects").json() == []
    assert count(Project) == 1


# --- Администратор --------------------------------------------------------------------


def test_admin_cannot_change_or_delete_a_users_project(db_client):
    sign_in(db_client, IVAN)
    project, token = full_project(db_client)

    db_client.post("/api/auth/logout")
    admin = db_client.post("/api/auth/demo", json={"role": "admin"})
    assert admin.status_code == 200 and admin.json()["role"] == "admin"
    base = f"/api/projects/{project['id']}"
    assert db_client.patch(base, json={"name": "Отобрал"}).status_code == 404
    assert db_client.delete(base).status_code == 404
    assert db_client.post(f"{base}/copy").status_code == 404
    assert db_client.post(f"{base}/versions", json={"state": {"v": 2}}).status_code == 404
    assert db_client.delete(f"{base}/shares/{token}").status_code == 404

    sign_in(db_client, IVAN)
    still = db_client.get(base).json()
    assert still["name"] == "Склад в Подольске" and still["versions"] == 1 and len(still["shares"]) == 1


def test_admin_has_own_projects_like_a_user(db_client):
    db_client.post("/api/auth/demo", json={"role": "admin"})
    project = new_project(db_client, name="Проект админа", state=STATE)
    assert [p["name"] for p in db_client.get("/api/projects").json()] == ["Проект админа"]

    sign_in(db_client, IVAN)
    assert db_client.get(f"/api/projects/{project['id']}").status_code == 404


def test_user_is_not_let_into_admin_catalog(db_client):
    sign_in(db_client, IVAN)
    assert db_client.get("/api/admin/catalog").status_code == 403
    db_client.post("/api/auth/logout")
    assert db_client.get("/api/admin/catalog").status_code == 401


# --- Удаление аккаунта ----------------------------------------------------------------


def test_deleting_account_removes_projects_versions_files_and_shares(db_client):
    sign_in(db_client, MASHA)
    masha_project = new_project(db_client, name="Проект Маши", state=STATE)

    sign_in(db_client, IVAN)
    _project, token = full_project(db_client)
    new_project(db_client, name="Второй", state=STATE)
    assert count(Project) == 3 and count(Share) == 1 and count(ProjectFile) == 1 and count(ProjectVersion) == 3

    gone = db_client.request("DELETE", "/api/auth/me", json={"password": IVAN["password"]})
    assert gone.status_code == 200 and gone.json()["role"] == "guest"
    assert me(db_client)["role"] == "guest"

    assert count(User) == 1 and count(Project) == 1 and count(ProjectVersion) == 1
    assert count(ProjectFile) == 0 and count(Share) == 0
    assert db_client.get(f"/api/share/{token}").status_code == 404
    assert db_client.post("/api/auth/login", json=IVAN).status_code == 401

    # чужое на месте
    sign_in(db_client, MASHA)
    assert db_client.get(f"/api/projects/{masha_project['id']}").json()["name"] == "Проект Маши"


def test_wrong_password_keeps_the_account_and_its_projects(db_client):
    sign_in(db_client, IVAN)
    full_project(db_client)
    assert db_client.request("DELETE", "/api/auth/me", json={"password": "not-my-password"}).status_code == 401
    assert me(db_client)["role"] == "user"
    assert count(Project) == 1 and count(Share) == 1


def test_email_can_be_registered_again_after_deletion_with_empty_cabinet(db_client):
    sign_in(db_client, IVAN)
    new_project(db_client, state=STATE)
    db_client.request("DELETE", "/api/auth/me", json={"password": IVAN["password"]})

    again = db_client.post("/api/auth/register", json={**IVAN, "password": "another-password"})
    assert again.status_code == 201
    assert db_client.get("/api/projects").json() == []
    # старый пароль к новому аккаунту не подходит
    db_client.post("/api/auth/logout")
    assert db_client.post("/api/auth/login", json=IVAN).status_code == 401
