from tests.api.test_projects import IVAN, MASHA, RESULT, STATE, new_project, sign_in


def test_share_opens_without_login_and_shows_only_that_version(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE, result=RESULT)
    db_client.post(f"/api/projects/{project['id']}/versions", json={"state": {**STATE, "v": 2}, "note": ""})

    link = db_client.post(f"/api/projects/{project['id']}/shares", json={"version": 1}).json()
    # на ту же версию та же ссылка, а не новая
    again = db_client.post(f"/api/projects/{project['id']}/shares", json={"version": 1}).json()
    assert again["token"] == link["token"] and len(link["token"]) >= 30
    assert db_client.get(f"/api/projects/{project['id']}").json()["shares"][0]["token"] == link["token"]

    db_client.post("/api/auth/logout")
    shown = db_client.get(f"/api/share/{link['token']}")
    assert shown.status_code == 200
    body = shown.json()
    assert body["version"] == 1 and body["state"] == STATE and body["result"] == RESULT
    assert body["name"] == "Склад в Подольске"
    assert "email" not in shown.text


def test_share_without_versions_or_by_stranger_is_not_found(db_client):
    sign_in(db_client, IVAN)
    empty = new_project(db_client)
    assert db_client.post(f"/api/projects/{empty['id']}/shares").status_code == 404
    full = new_project(db_client, state=STATE, result=RESULT)

    sign_in(db_client, MASHA)
    assert db_client.post(f"/api/projects/{full['id']}/shares").status_code == 404


def test_revoked_or_deleted_share_stops_working(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE, result=RESULT)
    token = db_client.post(f"/api/projects/{project['id']}/shares").json()["token"]
    assert db_client.delete(f"/api/projects/{project['id']}/shares/{token}").status_code == 204
    assert db_client.get(f"/api/share/{token}").status_code == 404

    token = db_client.post(f"/api/projects/{project['id']}/shares").json()["token"]
    db_client.delete(f"/api/projects/{project['id']}")
    assert db_client.get(f"/api/share/{token}").status_code == 404
    assert db_client.get("/api/share/no-such-token").status_code == 404
