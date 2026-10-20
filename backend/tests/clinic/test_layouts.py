"""Готовые и собственные корпуса проходят тот же маршрутный движок, что ручной план."""

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


@pytest.mark.parametrize(
    "width,length,floors,wards,lifts",
    [(36, 20, 1, 3, 0), (48, 24, 2, 3, 1), (60, 28, 4, 4, 2), (36, 18, 6, 8, 2), (120, 120, 1, 1, 0)],
)
def test_furnished_layout_is_valid_with_reachable_posts_and_cleaning_bases(width, length, floors, wards, lifts):
    response = client.post(
        "/api/clinic/generate",
        json={"width_m": width, "length_m": length, "floors": floors, "wards_per_floor": wards, "lifts": lifts},
    )
    assert response.status_code == 200, response.text
    building = response.json()
    assert len(building["floors"]) == floors and len(building["lifts"]) == lifts
    for floor in building["floors"]:
        assert sum(item["kind"] == "room" and item["role"] == "ward" for item in floor["items"]) == wards
        assert floor["width_m"] == width and floor["length_m"] == length
    checked = client.post("/api/clinic/check", json={"building": building}).json()
    assert checked["valid"], checked
    assert not any(
        one["code"] in {"ward_unreachable", "cleaning_blocked", "cleaning_unreachable"} for one in checked["checks"]
    ), checked


def test_template_runs_in_the_real_simulator():
    building = client.post("/api/clinic/generate", json={"width_m": 48, "length_m": 24, "floors": 2}).json()
    result = client.post("/api/clinic/runs", json={"building": building, "with_events": False})
    assert result.status_code == 200, result.text
    run = result.json()
    assert run["kpi"]["on_time_share"] >= 0.95
    assert run["kpi"]["blocked"] == 0 and run["kpi"]["cleaned_m2"] > 0


def test_clean_sheet_has_exact_dimensions_and_no_invented_rooms():
    response = client.post(
        "/api/clinic/generate",
        json={"width_m": 15, "length_m": 12, "floors": 3, "floor_height_m": 4.2, "furnished": False},
    )
    assert response.status_code == 200
    building = response.json()
    assert building["floor_height_m"] == 4.2 and not building["lifts"]
    assert all(
        not floor["items"] and floor["width_m"] == 15 and floor["length_m"] == 12 for floor in building["floors"]
    )
    assert client.post("/api/clinic/check", json={"building": building}).json()["valid"] is False


@pytest.mark.parametrize(
    "body",
    [
        {"width_m": 12},
        {"length_m": 201},
        {"floors": 21},
        {"wards_per_floor": 9},
        {"floors": 2, "lifts": 0},
        {"floor_height_m": 2},
        {"width_m": 40.5},
    ],
)
def test_invalid_generation_parameters_are_explained(body):
    response = client.post("/api/clinic/generate", json=body)
    assert response.status_code == 422


def test_json_import_normalizes_defaults_and_refuses_invalid_structures():
    raw = {"version": 1, "floor_height_m": 3.3, "floors": [{"number": 1, "width_m": 30, "length_m": 20}]}
    response = client.post("/api/clinic/import", json=raw)
    assert response.status_code == 200
    floor = response.json()["floors"][0]
    assert floor["items"] == [] and floor["sections"] == []
    assert client.post("/api/clinic/import", json=raw | {"floors": []}).status_code == 422
    assert client.post("/api/clinic/import", json=raw | {"floors": raw["floors"] * 2}).status_code == 422
    assert client.post("/api/clinic/import", json=raw | {"version": 2}).status_code == 422
