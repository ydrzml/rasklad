"""API медучреждения: типовой корпус туда и обратно, проверка плана, прогон, отказы, лимит nginx."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.schemas.clinic import MAX_FLOORS
from app.services import clinic

client = TestClient(app)
NGINX = Path(__file__).resolve().parents[3] / "frontend" / "nginx.conf"


def template() -> dict:
    response = client.get("/api/clinic/template")
    assert response.status_code == 200
    return response.json()


def test_template_is_a_plan_per_floor_like_the_warehouse_drawing():
    building = template()
    assert len(building["floors"]) == 4
    floor = building["floors"][0]
    assert {"width_m", "length_m", "sections", "items"} <= set(floor)
    kinds = {item["kind"] for f in building["floors"] for item in f["items"]}
    assert kinds == {"room", "door", "lift", "charge", "blocked"}
    for item in floor["items"]:
        assert {"id", "kind", "x", "y", "w", "h"} <= set(item)


def test_check_accepts_the_template_and_finds_a_narrow_door():
    building = template()
    good = client.post("/api/clinic/check", json={"building": building}).json()
    assert good["valid"] is True
    assert set(good["corridor_m2"]) == {"1", "2", "3", "4"}
    for floor in building["floors"]:
        for item in floor["items"]:
            if item["kind"] == "door" and "пост" in item["name"]:
                item["width_mm"] = 500
    narrow = client.post("/api/clinic/check", json={"building": building}).json()
    assert "door_narrow" in {check["code"] for check in narrow["checks"]}


def test_run_returns_kpi_effect_and_player_log():
    response = client.post("/api/clinic/runs", json={"building": template()})
    assert response.status_code == 200
    body = response.json()
    assert body["search"]["needed"] == body["fleet"]
    assert body["kpi"]["on_time_share"] >= body["search"]["target"]
    assert body["effect"]["staff_hours_per_shift"] > 0
    segment = body["segments"][0]
    assert {"robot", "from_s", "to_s", "action", "path", "floor"} <= set(segment)
    assert any(seg["floor"] is None and seg["lift"] for seg in body["segments"])
    assert body["lift_segments"] and {"from_floor", "to_floor"} <= set(body["lift_segments"][0])
    assert len(body["demand_per_hour"]) == body["hours"]


def test_run_without_events_is_light():
    body = client.post("/api/clinic/runs", json={"fleet": 2, "with_events": False}).json()
    assert body["segments"] == [] and body["lift_segments"] == []
    assert body["search"] is None


def test_robots_are_from_the_catalog_with_ratings():
    body = client.get("/api/clinic/robots").json()
    products = {robot["product"] for robot in body["delivery"]}
    assert "Pudu FlashBot Max" in products
    assert all(spec["trust"] for robot in body["delivery"] for spec in robot["specs"])


def test_assumptions_list_every_number_with_trust():
    body = client.get("/api/clinic/assumptions").json()
    assert body and all(item["trust"] in "SABCDEF" and item["source"] for item in body)


def test_bad_inputs_are_refused():
    building = template()
    too_many = {**building, "floors": building["floors"] * (MAX_FLOORS // 4 + 1)}
    assert client.post("/api/clinic/check", json={"building": too_many}).status_code == 422
    assert client.post("/api/clinic/runs", json={"fleet": 31}).status_code == 422
    unknown = client.post("/api/clinic/runs", json={"fleet": 1, "overrides": {"clinic.nothing": 1}})
    assert unknown.status_code == 422
    out_of_range = client.post("/api/clinic/runs", json={"fleet": 1, "overrides": {"clinic.drug_orders_per_day": 1e6}})
    assert out_of_range.status_code == 422
    assert client.post("/api/clinic/runs", json={"robot_id": "aethon-moxi"}).status_code == 404


def test_heavy_points_are_rate_limited_in_nginx():
    text = NGINX.read_text(encoding="utf-8")
    heavy = re.search(r"location ~ (\S+) \{\s*limit_req zone=heavy", text)
    assert heavy, "в nginx.conf нет зоны heavy"
    pattern = re.compile(heavy.group(1))
    for path in ("/api/clinic/runs", "/api/clinic/economics", "/api/clinic/optimize", "/api/simulation/runs"):
        assert pattern.match(path), path
    assert not pattern.match("/api/clinic/template")
    # проверку корпуса редактор зовет после каждой правки: своя зона, щедрее heavy
    assert not pattern.match("/api/clinic/check")
    assert re.search(r"location ~ \^/api/clinic/\(check\|fit\)\$ \{\s*limit_req zone=edit", text)


def test_plan_with_errors_and_huge_volumes_are_refused(monkeypatch):
    building = template()
    building["floors"][0]["items"] = [i for i in building["floors"][0]["items"] if i.get("role") != "pharmacy"]
    assert client.post("/api/clinic/runs", json={"building": building, "fleet": 2}).status_code == 422
    monkeypatch.setattr(clinic, "MAX_JOBS", 50)  # типовой корпус дает около 77 заявок за смену
    response = client.post("/api/clinic/runs", json={"fleet": 2})
    assert response.status_code == 422 and "заявок" in response.json()["detail"]


def test_duplicate_ids_and_unknown_floors_for_cleaners():
    building = template()
    building["floors"][1]["items"][0]["id"] = building["floors"][0]["items"][0]["id"]
    assert client.post("/api/clinic/check", json={"building": building}).status_code == 422
    body = client.post("/api/clinic/runs", json={"fleet": 2, "with_events": False, "cleaners": {"1": 1, "99": 3}})
    assert body.status_code == 422  # неверный этаж больше не отбрасывается молча
