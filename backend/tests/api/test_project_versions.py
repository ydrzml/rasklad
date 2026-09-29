"""Проекты: копия живет отдельно от оригинала, версии расчета нумеруются подряд и не теряются."""

from app.storage.models import Project, ProjectVersion
from tests.api.test_projects import IVAN, RESULT, STATE, new_project, rows, sign_in


def project_view(client, project_id: int) -> dict:
    response = client.get(f"/api/projects/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()


def save(client, project_id: int, **state) -> dict:
    response = client.post(f"/api/projects/{project_id}/versions", json={"state": {**STATE, **state}, "note": ""})
    assert response.status_code == 201, response.text
    return response.json()


# --- Копия --------------------------------------------------------------------------------


def test_copy_and_original_change_independently(db_client):
    sign_in(db_client, IVAN)
    original = new_project(db_client, state=STATE, result=RESULT)
    copy = db_client.post(f"/api/projects/{original['id']}/copy").json()

    save(db_client, copy["id"], v="copy-2")
    save(db_client, original["id"], v="orig-2")
    save(db_client, original["id"], v="orig-3")

    original_now = project_view(db_client, original["id"])
    copy_now = project_view(db_client, copy["id"])
    assert original_now["versions"] == 3 and copy_now["versions"] == 2
    assert original_now["current"]["state"]["v"] == "orig-3"
    assert copy_now["current"]["state"]["v"] == "copy-2"
    # первая версия копии это снимок оригинала на момент копирования
    assert copy_now["history"][0]["number"] == 1
    assert db_client.get(f"/api/projects/{copy['id']}/versions/1").json()["state"] == STATE


def test_copy_does_not_take_shares_and_deleting_the_original_keeps_the_copy(db_client):
    sign_in(db_client, IVAN)
    original = new_project(db_client, state=STATE, result=RESULT)
    db_client.post(f"/api/projects/{original['id']}/files", files={"file": ("план.csv", b"a;b\n", "text/csv")})
    token = db_client.post(f"/api/projects/{original['id']}/shares").json()["token"]
    copy = db_client.post(f"/api/projects/{original['id']}/copy").json()
    assert copy["shares"] == []

    assert db_client.delete(f"/api/projects/{original['id']}").status_code == 204
    assert db_client.get(f"/api/share/{token}").status_code == 404
    kept = project_view(db_client, copy["id"])
    assert kept["versions"] == 1 and [f["name"] for f in kept["files"]] == ["план.csv"]
    file_id = kept["files"][0]["id"]
    assert db_client.get(f"/api/projects/{copy['id']}/files/{file_id}").content == b"a;b\n"
    assert rows(Project) == 1


def test_copy_of_an_empty_project_is_empty_too(db_client):
    sign_in(db_client, IVAN)
    empty = new_project(db_client)
    copy = db_client.post(f"/api/projects/{empty['id']}/copy")
    assert copy.status_code == 201, copy.text
    assert copy.json()["versions"] == 0 and copy.json()["current"] is None and copy.json()["files"] == []


def test_copy_of_a_copy_keeps_facility_type_and_gets_its_own_name(db_client):
    sign_in(db_client, IVAN)
    original = new_project(db_client, state=STATE, facility_type="airport")
    first = db_client.post(f"/api/projects/{original['id']}/copy").json()
    second = db_client.post(f"/api/projects/{first['id']}/copy").json()
    assert second["name"] == "Склад в Подольске (копия) (копия)"
    assert second["facility_type"] == "airport"
    assert len({original["id"], first["id"], second["id"]}) == 3
    assert {p["id"] for p in db_client.get("/api/projects").json()} == {original["id"], first["id"], second["id"]}


def test_copy_name_is_trimmed_and_empty_name_is_refused(db_client):
    sign_in(db_client, IVAN)
    original = new_project(db_client)
    assert (
        db_client.post(f"/api/projects/{original['id']}/copy", json={"name": "  Вариант  "}).json()["name"] == "Вариант"
    )
    assert db_client.post(f"/api/projects/{original['id']}/copy", json={"name": ""}).status_code == 422


# --- Версии -------------------------------------------------------------------------------


def test_versions_are_numbered_in_order_and_each_is_readable(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE, result=RESULT)
    for n in range(2, 7):
        assert save(db_client, project["id"], step=n)["number"] == n

    view = project_view(db_client, project["id"])
    assert view["versions"] == 6
    assert [v["number"] for v in view["history"]] == [1, 2, 3, 4, 5, 6]
    assert view["current"]["number"] == 6 and view["current"]["state"]["step"] == 6
    for n in range(2, 7):
        assert db_client.get(f"/api/projects/{project['id']}/versions/{n}").json()["state"]["step"] == n
    # первая версия не изменилась
    first = db_client.get(f"/api/projects/{project['id']}/versions/1").json()
    assert first["state"] == STATE and first["result"] == RESULT
    assert rows(ProjectVersion) == 6


def test_version_zero_and_negative_numbers_are_not_found(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    assert db_client.get(f"/api/projects/{project['id']}/versions/0").status_code == 404
    assert db_client.get(f"/api/projects/{project['id']}/versions/-1").status_code == 404


def test_version_needs_a_state_object(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    url = f"/api/projects/{project['id']}/versions"
    assert db_client.post(url, json={"note": "без состояния"}).status_code == 422
    assert db_client.post(url, json={"state": [1, 2, 3]}).status_code == 422
    assert db_client.post(url, json={"state": "строка"}).status_code == 422
    assert db_client.post(url, json={"state": {}, "note": "x" * 501}).status_code == 422
    assert project_view(db_client, project["id"])["versions"] == 1


def test_version_without_result_is_allowed_and_result_stays_null(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client)
    saved = db_client.post(f"/api/projects/{project['id']}/versions", json={"state": STATE})
    assert saved.status_code == 201 and saved.json()["result"] is None and saved.json()["number"] == 1
    assert project_view(db_client, project["id"])["current"]["result"] is None


def test_share_points_to_a_fixed_version_even_after_new_saves(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE, result=RESULT)
    save(db_client, project["id"], v=2)
    latest = db_client.post(f"/api/projects/{project['id']}/shares").json()
    assert latest["version"] == 2
    save(db_client, project["id"], v=3)
    shown = db_client.get(f"/api/share/{latest['token']}").json()
    assert shown["version"] == 2 and shown["state"]["v"] == 2

    # на несуществующую версию ссылку не дадут
    assert db_client.post(f"/api/projects/{project['id']}/shares", json={"version": 9}).status_code == 404
    assert db_client.post(f"/api/projects/{project['id']}/shares", json={"version": 0}).status_code == 422


def test_versions_of_different_projects_do_not_mix(db_client):
    sign_in(db_client, IVAN)
    first = new_project(db_client, name="Первый", state={**STATE, "who": "first"})
    second = new_project(db_client, name="Второй", state={**STATE, "who": "second"})
    save(db_client, first["id"], who="first-2")
    assert db_client.get(f"/api/projects/{second['id']}/versions/1").json()["state"]["who"] == "second"
    assert db_client.get(f"/api/projects/{second['id']}/versions/2").status_code == 404
    assert project_view(db_client, second["id"])["versions"] == 1
