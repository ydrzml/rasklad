"""Выбранные задачи и парк одинаковы в проверке, деньгах и проигрывателе."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import clinic

client = TestClient(app)


def post(path, body):
    response = client.post(f"/api/clinic/{path}", json=body)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("tasks", [["floor_delivery"], ["cleaning"], ["floor_delivery", "cleaning"]])
def test_money_and_replay_use_the_same_tasks_robots_and_fleet(tasks):
    building = client.get("/api/clinic/template").json()
    request = {"building": building, "operation_ids": tasks}
    answer = post("economics", request)
    shift = answer["shift"]
    run = post("runs", request | {"fleet": shift["fleet"], "cleaners": shift["cleaners"]})
    assert run["fleet"] == shift["fleet"]
    assert run["cleaners"] == shift["cleaners"]
    assert run["kpi"]["created"] == shift["jobs"]
    assert run["kpi"]["on_time_share"] == pytest.approx(shift["on_time_share"], abs=0.01)
    assert run["kpi"]["cleaned_m2"] == pytest.approx(shift["cleaned_m2"], abs=0.1)
    assert {fleet["operation_id"] for fleet in answer["fleets"]} == set(tasks)
    for fleet in answer["fleets"]:
        robot = run["robot"] if fleet["operation_id"] == "floor_delivery" else run["cleaner"]
        assert fleet["robot_id"] == robot["id"]
    if "floor_delivery" not in tasks:
        assert run["fleet"] == 0 and not run["jobs"] and shift["search"] is None
        assert all(segment["role"] == "cleaning" for segment in run["segments"])
        assert not any(run["demand_per_hour"])


def test_cleaning_does_not_require_a_pharmacy_wards_or_delivery_chargers():
    building = client.get("/api/clinic/template").json()
    for floor in building["floors"]:
        floor["items"] = [
            item for item in floor["items"] if not (item["kind"] == "charge" and item["role"] != "cleaning")
        ]
        for item in floor["items"]:
            if item["kind"] == "room":
                item["role"] = "other"
    request = {"building": building, "operation_ids": ["cleaning"]}
    assert post("check", request)["valid"]
    answer = post("economics", request)
    assert answer["shift"]["jobs"] == 0 and answer["shift"]["cleaned_m2"] > 0


def test_floor_without_cleaning_base_does_not_get_a_phantom_cleaner():
    building = client.get("/api/clinic/template").json()
    missing_floor = building["floors"][0]
    missing_floor["items"] = [
        item for item in missing_floor["items"] if not (item["kind"] == "charge" and item["role"] == "cleaning")
    ]
    answer = post("economics", {"building": building, "operation_ids": ["cleaning"]})
    assert str(missing_floor["number"]) not in answer["shift"]["cleaners"]
    assert answer["fleets"][0]["count"] == len(building["floors"]) - 1


def test_selected_delivery_robot_is_used_and_failed_search_is_visible():
    robot = next(one for one in clinic.robots(clinic.DELIVERY) if one.spec and not one.spec.size.rides_lift)
    answer = post("economics", {"operation_ids": ["floor_delivery"], "robot_id": robot.id})
    assert answer["fleets"][0]["robot_id"] == robot.id
    assert answer["shift"]["search"]["needed"] is None
    assert answer["shift"]["search"]["stopped"]


def test_missing_cleaner_specs_are_an_error_instead_of_silent_zero_effect():
    robot = next(one for one in clinic.robots(clinic.CLEANING) if one.missing)
    answer = client.post("/api/clinic/economics", json={"operation_ids": ["cleaning"], "cleaner_id": robot.id})
    assert answer.status_code == 422
    assert "характеристик" in answer.text


def test_selected_cleaner_that_cannot_leave_its_base_is_a_plan_error_not_a_silent_zero():
    robot = next(one for one in clinic.robots(clinic.CLEANING) if one.spec and one.spec.size.need_mm > 900)
    building = client.get("/api/clinic/template").json()
    request = {"building": building, "operation_ids": ["cleaning"], "cleaner_id": robot.id}
    checks = post("check", request)
    assert not checks["valid"]
    assert any(one["code"] == "cleaning_blocked" and one["level"] == "error" for one in checks["checks"])
    answer = client.post("/api/clinic/economics", json=request)
    assert answer.status_code == 422
    assert "дверь помещения базы 900 мм" in answer.text


def test_disconnected_corridor_is_not_counted_as_cleaned_by_repeating_reachable_cells():
    building = client.get("/api/clinic/template").json()
    building["floors"] = building["floors"][:1]
    building["floors"][0]["items"].append({"id": "partition", "kind": "blocked", "x": 25, "y": 0, "w": 1, "h": 24})
    request = {"building": building, "operation_ids": ["cleaning"]}
    checked = post("check", request)
    assert any(one["code"] == "cleaning_unreachable" for one in checked["checks"])
    answer = post("economics", request)
    assert 0 < answer["shift"]["cleaned_m2"] < checked["corridor_m2"]["1"]
