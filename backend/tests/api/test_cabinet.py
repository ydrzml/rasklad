"""Кабинет: папки, сравнение проектов, копия с правкой и профиль."""

from tests.api.test_projects import IVAN, MASHA, new_project, sign_in

W = "facilities.warehouse."
VOLUME = W + "operations.pallet_transport.volume_per_day"

# Снимок ввода, как его сохраняет мастер: по нему сервер умеет пересчитать вариант
STATE = {
    "facilityId": "warehouse",
    "taskIds": ["pallet_transport"],
    "choices": {"pallet_transport": "ronavi-h1500"},
    "robotId": "ronavi-h1500",
    "overrides": {},
    "staff": [
        {"id": "a", "role": "forklift_operator", "headcount": 25, "filled": 25, "salary_month": 120000},
    ],
    "plan": {"width_m": 150, "length_m": 117, "template": "one_side", "edited": False},
}


def result(fleet: int, tco: float, payback: float | None) -> dict:
    return {
        "horizon_years": 5,
        "sizing": {"fleet": fleet, "people_per_shift_before": 4.7, "people_per_shift_after": 1},
        "scenarios": [
            {"id": "baseline", "name": "Без роботизации", "tco_rub": 256e6},
            {
                "id": "purchase",
                "name": "Покупка",
                "tco_rub": tco,
                "investment_year0_rub": 41e6,
                # все свои деньги за горизонт: старт, обновление, выкуп, платежи по долгу
                "investment_total_rub": 95e6,
                "payback_cumulative_years": payback,
            },
        ],
    }


def test_folders_hold_projects_and_removing_folder_keeps_them(db_client):
    sign_in(db_client, IVAN)
    one = new_project(db_client, state=STATE)
    two = new_project(db_client, state=STATE)
    folder = db_client.post("/api/projects/folders", json={"name": "Подольск", "projects": [one["id"]]})
    assert folder.status_code == 201
    folder = folder.json()

    assert db_client.patch(f"/api/projects/{two['id']}", json={"folder_id": folder["id"]}).json()["folder_id"]
    listed = {p["id"]: p["folder_id"] for p in db_client.get("/api/projects").json()}
    assert listed == {one["id"]: folder["id"], two["id"]: folder["id"]}

    # переименование проекта не вынимает его из папки, а folder_id: null вынимает
    assert db_client.patch(f"/api/projects/{one['id']}", json={"name": "Корпус А"}).json()["folder_id"] == folder["id"]
    assert db_client.patch(f"/api/projects/{one['id']}", json={"folder_id": None}).json()["folder_id"] is None

    renamed = db_client.patch(f"/api/projects/folders/{folder['id']}", json={"name": "Склад в Подольске"})
    assert renamed.json()["name"] == "Склад в Подольске"
    assert db_client.delete(f"/api/projects/folders/{folder['id']}").status_code == 204
    assert db_client.get("/api/projects/folders").json() == []
    assert all(p["folder_id"] is None for p in db_client.get("/api/projects").json())
    assert len(db_client.get("/api/projects").json()) == 2


def test_copy_lands_in_folder_of_original(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    copy = db_client.post(f"/api/projects/{project['id']}/copy").json()

    folders = db_client.get("/api/projects/folders").json()
    assert [f["name"] for f in folders] == ["Склад в Подольске"]
    listed = {p["id"]: p["folder_id"] for p in db_client.get("/api/projects").json()}
    assert listed[project["id"]] == listed[copy["id"]] == folders[0]["id"]

    # следующая копия ложится в ту же папку, новую не заводит
    db_client.post(f"/api/projects/{copy['id']}/copy")
    assert len(db_client.get("/api/projects/folders").json()) == 1


def test_variant_copy_is_recalculated_with_the_change(db_client):
    sign_in(db_client, IVAN)
    # без плана парк считается по складу из параметров: так расчет быстрый и не зависит от раскладки рядов
    project = new_project(db_client, state={**STATE, "plan": None}, result=result(9, 118e6, 1.3))
    made = db_client.post(
        f"/api/projects/{project['id']}/copy", json={"name": "3 000 паллет", "changes": {VOLUME: 3000}}
    )
    assert made.status_code == 201
    made = made.json()
    assert made["name"] == "3 000 паллет"
    assert made["current"]["state"]["overrides"] == {VOLUME: 3000}
    assert "3000 вместо 2000" in made["current"]["note"]
    # результат посчитан заново, а не взят у оригинала
    assert made["current"]["result"]["sizing"]["fleet"] != 9
    assert made["current"]["result"]["applied_overrides"][VOLUME] == 3000
    # оригинал не тронут
    assert db_client.get(f"/api/projects/{project['id']}").json()["current"]["state"]["overrides"] == {}


def test_variant_copy_with_impossible_change_creates_nothing(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state={**STATE, "plan": None})
    bad = db_client.post(
        f"/api/projects/{project['id']}/copy",
        json={"changes": {W + "schedule.shifts": 5, W + "schedule.shift_hours": 11}},
    )
    assert bad.status_code == 422
    assert len(db_client.get("/api/projects").json()) == 1


def test_compare_marks_what_differs(db_client):
    sign_in(db_client, IVAN)
    one = new_project(db_client, state=STATE, result=result(9, 118e6, 1.3))
    two = new_project(db_client, state={**STATE, "overrides": {VOLUME: 3000}}, result=result(14, 146e6, None))
    response = db_client.post(
        "/api/projects/compare", json={"items": [{"project_id": one["id"]}, {"project_id": two["id"]}]}
    )
    assert response.status_code == 200
    data = response.json()
    assert [c["project_id"] for c in data["columns"]] == [one["id"], two["id"]]
    assert data["horizon_years"] == 5

    inputs = {row["key"]: row for row in data["inputs"]}
    assert inputs[VOLUME]["values"] == [2000, 3000] and inputs[VOLUME]["differs"]
    assert not inputs[W + "schedule.shifts"]["differs"]
    assert inputs["plan"]["values"] == ["150 × 117 м", "150 × 117 м"]

    results = {row["key"]: row for row in data["results"]}
    assert results["fleet"]["values"] == [9, 14]
    assert results["purchase.tco"]["better"] == "low"
    assert results["purchase.payback"]["values"] == [1.3, "не окупается"]
    # "Вложения на старте" это деньги в год 0, а не все вложения за горизонт
    assert results["purchase.investment"]["values"] == [41e6, 41e6]


def test_compare_names_tasks_taken_out_of_the_calculation(db_client):
    """Снятая галочкой задача в строке «Задачи» стоит с пометкой: колонки считали разное."""
    sign_in(db_client, IVAN)
    both = {**STATE, "taskIds": ["pallet_transport", "piece_picking"]}
    one = new_project(db_client, state=both, result=result(9, 118e6, 1.3))
    two = new_project(db_client, state={**both, "excluded": ["piece_picking"]}, result=result(9, 110e6, 1.1))
    data = db_client.post(
        "/api/projects/compare", json={"items": [{"project_id": one["id"]}, {"project_id": two["id"]}]}
    ).json()
    tasks = {row["key"]: row for row in data["inputs"]}["tasks"]
    assert tasks["values"] == [
        "Перевозка паллет между зонами, Мелкоштучный отбор",
        "Перевозка паллет между зонами, Мелкоштучный отбор (снята с расчета)",
    ]
    assert tasks["differs"]


def test_compare_two_versions_of_one_project(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE, result=result(9, 118e6, 1.3))
    db_client.post(f"/api/projects/{project['id']}/versions", json={"state": {**STATE, "overrides": {VOLUME: 2500}}})
    data = db_client.post(
        "/api/projects/compare",
        json={"items": [{"project_id": project["id"], "version": 1}, {"project_id": project["id"], "version": 2}]},
    ).json()
    assert [c["version"] for c in data["columns"]] == [1, 2]
    assert [c["calculated"] for c in data["columns"]] == [True, False]


def test_list_shows_main_figures(db_client):
    sign_in(db_client, IVAN)
    new_project(db_client, state=STATE, result=result(9, 118e6, 1.3))
    empty = new_project(db_client)
    listed = {p["id"]: p["figures"] for p in db_client.get("/api/projects").json()}
    assert listed[empty["id"]] is None
    figures = next(f for f in listed.values() if f)
    assert figures == {"fleet": 9, "payback_years": 1.3, "tco_rub": 118e6, "horizon_years": 5}


def test_other_users_folders_and_projects_cannot_be_used(db_client):
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE, result=result(9, 118e6, 1.3))
    folder = db_client.post("/api/projects/folders", json={"name": "Иван"}).json()

    sign_in(db_client, MASHA)
    mine = new_project(db_client, state=STATE, result=result(9, 118e6, 1.3))
    assert db_client.get("/api/projects/folders").json() == []
    # чужой проект не сравнить, даже вместе со своим
    compare = db_client.post(
        "/api/projects/compare", json={"items": [{"project_id": mine["id"]}, {"project_id": project["id"]}]}
    )
    assert compare.status_code == 404
    # в чужую папку ни положить, ни переименовать, ни удалить ее, ни собрать в новую папку чужой проект
    assert db_client.patch(f"/api/projects/{mine['id']}", json={"folder_id": folder["id"]}).status_code == 404
    assert db_client.patch(f"/api/projects/folders/{folder['id']}", json={"name": "Мое"}).status_code == 404
    assert db_client.delete(f"/api/projects/folders/{folder['id']}").status_code == 404
    assert db_client.post("/api/projects/folders", json={"name": "x", "projects": [project["id"]]}).status_code == 404
    assert db_client.get("/api/projects/folders").json() == []
    assert db_client.post(f"/api/projects/{project['id']}/copy", json={"changes": {VOLUME: 3000}}).status_code == 404

    sign_in(db_client, IVAN)
    assert [f["name"] for f in db_client.get("/api/projects/folders").json()] == ["Иван"]


def test_compare_needs_login_and_two_items(db_client):
    two = {"items": [{"project_id": 1}, {"project_id": 2}]}
    assert db_client.post("/api/projects/compare", json=two).status_code == 401
    sign_in(db_client, IVAN)
    project = new_project(db_client, state=STATE)
    assert db_client.post("/api/projects/compare", json={"items": [{"project_id": project["id"]}]}).status_code == 422


def test_profile_name_company_password_and_email(db_client):
    sign_in(db_client, IVAN)
    me = db_client.patch("/api/auth/me", json={"name": " Иван Петров ", "company": "Склад-Сервис"}).json()
    assert me["name"] == "Иван Петров" and me["company"] == "Склад-Сервис"
    assert db_client.get("/api/auth/me").json()["name"] == "Иван Петров"

    wrong = db_client.post("/api/auth/me/password", json={"password": "не тот", "new_password": "new-secret-1"})
    assert wrong.status_code == 401
    short = db_client.post("/api/auth/me/password", json={"password": IVAN["password"], "new_password": "123"})
    assert short.status_code == 422
    assert (
        db_client.post(
            "/api/auth/me/password", json={"password": IVAN["password"], "new_password": "new-secret-1"}
        ).status_code
        == 200
    )

    sign_in(db_client, MASHA)
    taken = db_client.post("/api/auth/me/email", json={"email": "ivan@example.com", "password": MASHA["password"]})
    assert taken.status_code == 409

    db_client.post("/api/auth/logout")
    assert db_client.post("/api/auth/login", json=IVAN).status_code == 401
    assert db_client.post("/api/auth/login", json={**IVAN, "password": "new-secret-1"}).status_code == 200
    moved = db_client.post("/api/auth/me/email", json={"email": "Ivan.P@Example.com", "password": "new-secret-1"})
    assert moved.json()["email"] == "ivan.p@example.com"
    db_client.post("/api/auth/logout")
    assert (
        db_client.post("/api/auth/login", json={"email": "ivan.p@example.com", "password": "new-secret-1"}).status_code
        == 200
    )


def test_demo_profile_is_shared_and_cannot_change(db_client):
    db_client.post("/api/auth/demo", json={"role": "user"})
    assert db_client.patch("/api/auth/me", json={"name": "Хулиган"}).status_code == 403
    assert (
        db_client.post(
            "/api/auth/me/password", json={"password": "demo12345", "new_password": "stolen-pass"}
        ).status_code
        == 403
    )
    assert (
        db_client.post("/api/auth/me/email", json={"email": "evil@example.com", "password": "demo12345"}).status_code
        == 403
    )
    assert db_client.get("/api/auth/me").json()["name"] == ""


def test_variant_can_change_people_in_staff(db_client):
    """Штат введен строками и под объем сам не растет: в варианте людей задают числом."""
    sign_in(db_client, IVAN)
    project = new_project(db_client, state={**STATE, "plan": None}, result=result(9, 118e6, 1.3))
    same = db_client.post(f"/api/projects/{project['id']}/copy", json={"changes": {VOLUME: 3000}}).json()
    more = db_client.post(
        f"/api/projects/{project['id']}/copy", json={"changes": {VOLUME: 3000}, "people": 37.5}
    ).json()

    staff = more["current"]["state"]["staff"]
    assert staff[0]["filled"] == 37.5 and staff[0]["role"] == "forklift_operator"
    assert "людей в штате 37,5 вместо 25" in more["current"]["note"]

    def baseline(copy: dict) -> float:
        return next(s["tco_rub"] for s in copy["current"]["result"]["scenarios"] if s["id"] == "baseline")

    # без правки штата сценарий без роботов прежний, с правкой дорожает
    assert baseline(more) > baseline(same)
    data = db_client.post(
        "/api/projects/compare", json={"items": [{"project_id": same["id"]}, {"project_id": more["id"]}]}
    ).json()
    people = next(row for row in data["inputs"] if row["key"] == "staff.people")
    assert people["values"] == [25, 37.5] and people["differs"]


def test_request_from_reads_mixed_fleet_picks():
    """Копия смешанного парка пересчитывается с обоими решениями и их долями, а не с одним первым"""
    from app.services.projects import request_from

    state = {
        **STATE,
        "picks": {
            "pallet_transport": [
                {"robotId": "ronavi-h1500", "share": 0.7},
                {"robotId": "moros-amr-1500", "share": 0.3},
            ]
        },
    }
    tasks = [(task.robot_id, task.share) for task in request_from(state).tasks]
    assert tasks == [("ronavi-h1500", 0.7), ("moros-amr-1500", 0.3)]
    # снимок до смешанного парка: одно решение на задачу с долей 1
    assert [(task.robot_id, task.share) for task in request_from(STATE).tasks] == [("ronavi-h1500", 1)]


def test_request_from_skips_tasks_taken_out_of_the_calculation():
    """Задача, снятая галочкой «в расчете», остается выбранной в снимке, но копия и ссылка
    считают без нее, как считал экран. Иначе копия «что будет, если» получала 233 робота вместо 9"""
    from app.services.projects import request_from

    state = {
        **STATE,
        "taskIds": ["pallet_transport", "piece_picking"],
        "picks": {
            "pallet_transport": [{"robotId": "ronavi-h1500", "share": 1}],
            "piece_picking": [{"robotId": "ronavi-m", "share": 1}],
        },
        "excluded": ["piece_picking"],
    }
    request = request_from(state)
    assert [task.operation_id for task in request.tasks] == ["pallet_transport"]
    assert request.operation_id == "pallet_transport"
    # без снятых считаются обе
    assert [task.operation_id for task in request_from({**state, "excluded": []}).tasks] == [
        "pallet_transport",
        "piece_picking",
    ]
