"""Масштаб, процессы и окно суток: один контракт для объемов, экономики и проигрывателя."""

from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from app.engine.clinic.routes import Navigator, Ride, StaffNavigator
from app.main import app
from app.schemas import clinic as schema
from app.services import clinic, clinic_optimizer
from app.services.clinic_contract import from_schema
from tests.clinic.helpers import ROBOT

client = TestClient(app)


def building(floors=1):
    response = client.post(
        "/api/clinic/generate", json=dict(width_m=48, length_m=24, floors=floors, wards_per_floor=3, lifts=1)
    )
    assert response.status_code == 200, response.text
    return response.json()


def scenario(**changes):
    return schema.ClinicScenario.model_validate(changes).model_dump(mode="json")


def workload(house, tasks=None):
    response = client.post(
        "/api/clinic/workload", json={"building": house, "operation_ids": tasks or list(schema.TASKS)}
    )
    assert response.status_code == 200, response.text
    return response.json()


def room(house, role, floor=0):
    return next(
        item["id"] for item in house["floors"][floor]["items"] if item["role"] == role and item["kind"] == "room"
    )


def jobs(house, seed=42):
    return clinic.jobs(from_schema(schema.Building.model_validate(house)), clinic.dataset({}), seed)


@pytest.mark.parametrize("mode,factor", [("per_point", 2), ("building", 1)])
def test_scale_changes_delivery_only_in_the_selected_volume_mode(mode, factor):
    small, large = building(1), building(2)
    for house in (small, large):
        house["scenario"] = scenario(meds={"mode": mode, "per_day": 220}, supplies={"enabled": False})
    a, b = workload(small), workload(large)
    assert b["processes"][0]["per_day"] == pytest.approx(a["processes"][0]["per_day"] * factor)
    assert sum(b["cleaning_m2"].values()) > sum(a["cleaning_m2"].values())


def test_weights_exclude_a_post_without_increasing_fixed_building_volume():
    house = building()
    targets = [item["id"] for item in house["floors"][0]["items"] if item["role"] == "ward"]
    house["scenario"] = scenario(
        shift_hours=24,
        schedule="uniform",
        meds={"mode": "building", "per_day": 600},
        supplies={"enabled": False},
        point_weights=dict(zip(targets, [0, 1, 3], strict=True)),
    )
    found = jobs(house)
    assert len(found) == 600
    assert targets[0] not in {job.target for job in found}
    assert sum(job.target == targets[2] for job in found) > 380
    assert workload(house)["effective_points"] == 4


def test_day_volume_is_not_multiplied_by_number_of_shifts():
    house = building()
    house["scenario"] = scenario(
        shift_start_h=0,
        shift_hours=24,
        schedule="uniform",
        meds={"mode": "building", "per_day": 120},
        supplies={"enabled": False},
    )
    day = workload(house)
    assert sum(day["demand_per_hour"]) == pytest.approx(120)
    assert len(jobs(house)) == 120
    house["scenario"]["shift_hours"] = 8
    assert sum(workload(house)["demand_per_hour"]) == pytest.approx(40)
    assert len(jobs(house)) == 40


def test_custom_schedule_crosses_midnight_and_keeps_global_day_normalization():
    house = building()
    weights = [0] * 24
    weights[23], weights[0] = 2, 1
    house["scenario"] = scenario(
        shift_start_h=23,
        shift_hours=2,
        schedule="custom",
        hourly_weights=weights,
        meds={"mode": "building", "per_day": 90},
        supplies={"enabled": False},
    )
    out = workload(house)
    assert out["demand_per_hour"] == pytest.approx([60, 30])
    assert len(jobs(house)) == 90
    house["scenario"]["shift_start_h"] = 1
    assert not jobs(house)


def test_many_small_routes_round_the_total_once_and_keep_unique_job_ids():
    house = building()
    flow = {"source": room(house, "pharmacy"), "target": room(house, "ward"), "per_day": 0.2}
    house["scenario"] = scenario(
        shift_hours=24, schedule="uniform", meds={"mode": "routes", "flows": [flow] * 400}, supplies={"enabled": False}
    )
    out = jobs(house)
    assert len(out) == 80
    assert len({job.id for job in out}) == len(out)
    assert workload(house)["processes"][0]["per_day"] == pytest.approx(80)


def test_process_deadlines_and_picking_are_used_by_the_actual_jobs():
    house = building()
    house["scenario"] = scenario(
        meds={"urgent_share": 1, "picking_min": 5, "urgent_deadline_min": 10}, supplies={"enabled": False}
    )
    out = jobs(house)
    assert out and all(job.urgent and job.pick_s == 300 for job in out)
    assert all(job.deadline_s - job.created_s == pytest.approx(900) for job in out)


def test_only_supplies_do_not_require_a_pharmacy():
    house = building()
    for item in house["floors"][0]["items"]:
        if item["role"] == "pharmacy":
            item["role"] = "other"
    house["scenario"] = scenario(meds={"enabled": False})
    checked = client.post("/api/clinic/check", json={"building": house}).json()
    assert checked["valid"], checked
    result = client.post("/api/clinic/runs", json={"building": house, "fleet": 2, "with_events": False}).json()
    assert result["jobs"] and {job["kind"] for job in result["jobs"]} == {"supplies"}


def test_explicit_routes_can_use_other_rooms_without_automatic_post_requirements():
    house = building()
    source, target = room(house, "pharmacy"), room(house, "ward")
    for item in house["floors"][0]["items"]:
        if item["kind"] == "room":
            item["role"] = "other"
    house["scenario"] = scenario(
        meds={"mode": "routes", "flows": [{"source": source, "target": target, "per_day": 10}]},
        supplies={"enabled": False},
    )
    checked = client.post("/api/clinic/check", json={"building": house}).json()
    assert checked["valid"], checked
    assert jobs(house) and {job.target for job in jobs(house)} == {target}


def test_floor_cleaning_passes_change_required_work_and_excluded_floor_needs_no_robot():
    house = building(2)
    default = workload(house)
    # по умолчанию два прохода за сутки (СП 2.1.3678-20), здесь вдвое больше
    house["scenario"] = scenario(cleaning_passes=4, floor_cleaning_passes={2: 0})
    expected = workload(house)
    assert expected["cleaning_m2"]["1"] == default["cleaning_m2"]["1"] * 2
    assert expected["cleaning_m2"]["2"] == 0
    out = client.post("/api/clinic/runs", json={"building": house, "operation_ids": ["cleaning"], "with_events": False})
    assert out.status_code == 200, out.text
    result = out.json()
    assert result["cleaners"] == {"1": 1}
    assert sum(row["area_m2"] for row in result["kpi"]["cleaning"]) == expected["cleaning_m2"]["1"]


def test_cleaning_task_is_physical_area_and_does_not_shrink_for_a_wider_robot():
    house = building()
    door = next(i for i in house["floors"][0]["items"] if i["kind"] == "door")
    door["width_mm"] = 100
    physical = sum(workload(house)["cleaning_m2"].values())
    # Клинботикс 600 шире 400 PRO (проход 750 против 700) и выезжает с базы этого корпуса
    for cleaner_id in [clinic.DEFAULT_CLEANER, "5a5b3599-bd64-4330-9bbb-4f8ce7d780b9"]:
        out = client.post(
            "/api/clinic/economics", json={"building": house, "operation_ids": ["cleaning"], "cleaner_id": cleaner_id}
        )
        assert out.status_code == 200, out.text
        assert out.json()["shift"]["cleaning_required_m2"] == physical


def test_floor_sections_cannot_expand_the_grid_beyond_the_declared_lot():
    house = building()
    house["floors"][0]["sections"][0]["w"] = 1000
    assert client.post("/api/clinic/import", json=house).status_code == 422


def zoned_lifts():
    house = client.post(
        "/api/clinic/generate", json={"width_m": 48, "length_m": 24, "floors": 3, "wards_per_floor": 2, "lifts": 2}
    ).json()
    for index, lift_id in [(0, "L2"), (2, "L1")]:
        house["floors"][index]["items"] = [
            i for i in house["floors"][index]["items"] if not (i["kind"] == "lift" and i["lift"] == lift_id)
        ]
    return house


def test_zoned_lifts_route_through_a_transfer_floor_and_real_replay_uses_both_cabins():
    house = zoned_lifts()
    source, target = room(house, "pharmacy"), room(house, "ward", 2)
    house["scenario"] = scenario(
        schedule="uniform",
        meds={"mode": "routes", "flows": [{"source": source, "target": target, "per_day": 12}]},
        supplies={"enabled": False},
    )
    engine = from_schema(schema.Building.model_validate(house))
    nav = Navigator(engine, ROBOT)
    steps = nav.route(nav.spot(1, source), nav.spot(3, target))
    assert [(s.lift, s.from_floor, s.to_floor) for s in steps if isinstance(s, Ride)] == [("L1", 1, 2), ("L2", 2, 3)]
    result = client.post(
        "/api/clinic/runs", json={"building": house, "operation_ids": ["floor_delivery"], "fleet": 2}
    ).json()
    assert result["kpi"]["blocked"] == 0 and result["kpi"]["done"] > 0
    assert {s["lift"] for s in result["segments"] if s["action"] == "в лифте"} == {"L1", "L2"}
    engine.lifts[1].robots = False
    robot_nav, staff = Navigator(engine, ROBOT), StaffNavigator(engine, 600)
    assert robot_nav.route(robot_nav.spot(1, source), robot_nav.spot(3, target)) is None
    assert staff.route(staff.spot(1, source), staff.spot(3, target)) is not None


@pytest.mark.parametrize(
    "field,change",
    [
        ("point_weights", {"deleted": 1}),
        ("floor_cleaning_passes", {40: 1}),
        ("meds", {"mode": "routes", "flows": [{"source": "missing", "target": "deleted", "per_day": 10}]}),
    ],
)
def test_stale_references_remain_editable_but_cannot_silently_reduce_work(field, change):
    house = building()
    house["scenario"] = scenario(**{field: change})
    assert client.post("/api/clinic/import", json=house).status_code == 200
    checked = client.post("/api/clinic/check", json={"building": house}).json()
    assert not checked["valid"]
    assert any(row["code"] == "scenario" for row in checked["checks"])
    assert client.post("/api/clinic/runs", json={"building": house, "fleet": 1}).status_code == 422


@pytest.mark.parametrize(
    "changes",
    [
        {"schedule": "custom", "hourly_weights": [0] * 24},
        {"schedule": "custom", "hourly_weights": [1] * 23},
        {"shift_hours": 25},
        {"point_weights": {"post": -1}},
        {"floor_cleaning_passes": {1: 13}},
    ],
)
def test_invalid_scenario_values_are_explained(changes):
    with pytest.raises(ValueError):
        schema.ClinicScenario.model_validate(changes)


def test_workload_warns_and_run_refuses_excess_volume_without_truncation():
    house = building()
    house["scenario"] = scenario(
        shift_hours=24, meds={"mode": "building", "per_day": 6000}, supplies={"enabled": False}
    )
    assert any("5000" in warning for warning in workload(house)["warnings"])
    out = client.post("/api/clinic/runs", json={"building": house, "fleet": 1, "with_events": False})
    assert out.status_code == 422 and "5000" in out.text


def test_twenty_floor_layout_and_large_lift_group_have_reachable_destinations():
    out = client.post(
        "/api/clinic/generate", json={"width_m": 60, "length_m": 44, "floors": 20, "wards_per_floor": 1, "lifts": 12}
    )
    assert out.status_code == 200, out.text
    checked = client.post(
        "/api/clinic/check", json={"building": out.json(), "operation_ids": ["floor_delivery"]}
    ).json()
    assert checked["valid"], checked
    assert not any(row["code"] == "ward_unreachable" for row in checked["checks"])
    assert client.post("/api/clinic/generate", json={"width_m": 200, "length_m": 200, "floors": 6}).status_code == 422


def test_basement_floor_number_survives_finance_and_replay():
    house = building()
    house["floors"][0]["number"] = 0
    request = {"building": house, "operation_ids": ["cleaning"], "cleaners": {"0": 1}}
    money = client.post("/api/clinic/economics", json=request)
    assert money.status_code == 200, money.text
    run = client.post("/api/clinic/runs", json=request | {"with_events": False})
    assert run.status_code == 200, run.text
    assert money.json()["shift"]["cleaners"] == run.json()["cleaners"] == {"0": 1}


def test_unknown_floor_in_sizing_is_rejected_consistently():
    request = {"building": building(), "operation_ids": ["cleaning"], "cleaners": {"20": 1}}
    for path in ["economics", "runs"]:
        assert client.post(f"/api/clinic/{path}", json=request).status_code == 422


@pytest.mark.parametrize(
    "settings",
    [
        {"meds": {"enabled": False}, "supplies": {"enabled": False}},
        {"meds": {"mode": "building", "per_day": 0}, "supplies": {"enabled": False}},
    ],
)
def test_zero_delivery_work_does_not_buy_a_phantom_delivery_robot(settings):
    house = building()
    house["scenario"] = scenario(**settings)
    house["floors"][0]["items"] = [
        i for i in house["floors"][0]["items"] if not (i["kind"] == "charge" and i["role"] != "cleaning")
    ]
    request = {"building": house, "operation_ids": list(schema.TASKS)}
    account = client.post("/api/clinic/economics", json=request)
    assert account.status_code == 200, account.text
    money = account.json()
    assert money["shift"]["fleet"] == money["shift"]["jobs"] == 0
    assert all(fleet["operation_id"] != "floor_delivery" for fleet in money["fleets"])
    run = client.post("/api/clinic/runs", json=request | {"fleet": 0, "with_events": False})
    assert run.status_code == 200, run.text
    assert run.json()["fleet"] == run.json()["kpi"]["created"] == 0
    result = clinic_optimizer.optimize(
        schema.OptimizationRequest.model_validate(
            request
            | {
                "delivery_ids": [clinic.DEFAULT_DELIVERY],
                "cleaner_ids": [clinic.DEFAULT_CLEANER],
                "max_delivery_fleet": 2,
                "max_cleaners_per_floor": 1,
                "time_budget_s": 5,
            }
        )
    )
    assert result.recommended_id
    assert next(c for c in result.candidates if c.id == result.recommended_id).fleet == 0


def test_explicit_zero_fleet_with_positive_demand_is_unserved_work():
    result = client.post(
        "/api/clinic/runs",
        json={"building": building(), "operation_ids": ["floor_delivery"], "fleet": 0, "with_events": False},
    )
    assert result.status_code == 200, result.text
    out = result.json()
    assert out["fleet"] == out["kpi"]["done"] == 0
    assert out["kpi"]["created"] > 0 and out["kpi"]["due"] > 0
    assert out["kpi"]["on_time_share"] == 0


def test_optimizer_economics_and_replay_share_custom_processes_and_window():
    house = building(2)
    house["scenario"] = scenario(
        shift_start_h=22,
        shift_hours=12,
        schedule="uniform",
        meds={
            "mode": "routes",
            "flows": [{"source": room(house, "pharmacy"), "target": room(house, "ward", 1), "per_day": 24}],
        },
        supplies={"enabled": False},
        floor_cleaning_passes={1: 2, 2: 1},
    )
    original = deepcopy(house)
    optimized = clinic_optimizer.optimize(
        schema.OptimizationRequest.model_validate(
            {
                "building": house,
                "operation_ids": list(schema.TASKS),
                "delivery_ids": [clinic.DEFAULT_DELIVERY],
                "cleaner_ids": [clinic.DEFAULT_CLEANER],
                "max_delivery_fleet": 3,
                "max_cleaners_per_floor": 1,
                "time_budget_s": 15,
            }
        )
    )
    assert optimized.recommended_id
    chosen = next(row for row in optimized.candidates if row.id == optimized.recommended_id)
    request = {
        "building": house,
        "operation_ids": list(schema.TASKS),
        "robot_id": chosen.robot_id,
        "cleaner_id": chosen.cleaner_id,
        "fleet": chosen.fleet,
        "cleaners": chosen.cleaners,
    }
    money = client.post("/api/clinic/economics", json=request).json()
    run = client.post("/api/clinic/runs", json=request).json()
    assert house == original
    assert money["shift"]["hours"] == run["hours"] == 12
    assert money["shift"]["shift_start_h"] == run["shift_start_h"] == 22
    assert money["shift"]["jobs"] == run["kpi"]["created"] == 12
    assert money["shift"]["expected_jobs"] == pytest.approx(sum(run["demand_per_hour"]))
    assert money["shift"]["cleaning_required_m2"] == sum(row["area_m2"] for row in run["kpi"]["cleaning"])
    assert {job["kind"] for job in run["jobs"]} == {"meds"}
    assert max(seg["to_s"] for seg in run["segments"]) <= 12 * 3600


@pytest.mark.parametrize("layout", [(36, 20, 1, 3, 0), (48, 24, 2, 3, 1), (60, 28, 4, 4, 2)])
@pytest.mark.parametrize("mode", ["per_point", "building", "routes"])
@pytest.mark.parametrize("start,length", [(7, 8), (22, 8), (0, 24)])
@pytest.mark.parametrize("tasks", [["floor_delivery"], ["cleaning"], ["floor_delivery", "cleaning"]])
def test_process_matrix_keeps_workload_money_and_replay_consistent(layout, mode, start, length, tasks):
    width, depth, floors, wards, lifts = layout
    house = client.post(
        "/api/clinic/generate",
        json=dict(width_m=width, length_m=depth, floors=floors, wards_per_floor=wards, lifts=lifts),
    ).json()
    settings = {}
    for kind, role, volume in [("meds", "pharmacy", 24), ("supplies", "supplies", 12)]:
        settings[kind] = {
            "mode": mode,
            "per_day": volume,
            "urgent_share": 0,
            "flows": [{"source": room(house, role), "target": room(house, "ward", floors - 1), "per_day": volume}],
        }
    house["scenario"] = scenario(shift_start_h=start, shift_hours=length, schedule="uniform", **settings)
    request = {
        "building": house,
        "operation_ids": tasks,
        "fleet": 6 if "floor_delivery" in tasks else 0,
        "cleaners": {str(f["number"]): 1 for f in house["floors"]} if "cleaning" in tasks else {},
    }
    preview = workload(house, tasks)
    account = client.post("/api/clinic/economics", json=request)
    replay = client.post("/api/clinic/runs", json=request | {"with_events": False})
    assert account.status_code == replay.status_code == 200, (account.text, replay.text)
    money, run = account.json(), replay.json()
    assert money["shift"]["jobs"] == run["kpi"]["created"]
    assert money["shift"]["done"] == run["kpi"]["done"]
    assert money["shift"]["cleaned_m2"] == pytest.approx(run["kpi"]["cleaned_m2"])
    assert money["shift"]["hours"] == run["hours"] == length
    assert money["shift"]["cleaners"] == run["cleaners"]
    assert money["shift"]["expected_jobs"] == pytest.approx(sum(preview["demand_per_hour"]))
    assert abs(run["kpi"]["created"] - money["shift"]["expected_jobs"]) < 2 + 1e-9
    assert money["shift"]["cleaning_required_m2"] == sum(preview["cleaning_m2"].values())
    assert money["people"]["hours_per_year"] == pytest.approx(money["people"]["hours_per_shift"] * 365)
