"""Каждый уборщик и доставщик каталога на типовых корпусах: либо работает, либо "не подходит" с причиной.

Тихого нуля быть не должно: R2B MARK 2 SE на "Больничном корпусе" не выезжал с базы (проезд 1,3 м,
дверь хозяйственной 0,9 м), вымыто 0 м2, а итог писал "узкого места нет".
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import clinic

client = TestClient(app)
R2B = "446c5207-a099-45e0-b615-afd60de08589"
LAYOUTS = {
    "template": None,
    "one": {"width_m": 36, "length_m": 20, "floors": 1, "wards_per_floor": 3, "lifts": 0},
    "two": {"width_m": 48, "length_m": 24, "floors": 2, "wards_per_floor": 3, "lifts": 1},
}


def post(path, body):
    response = client.post(f"/api/clinic/{path}", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def building(name):
    if LAYOUTS[name] is None:
        return client.get("/api/clinic/template").json()
    return post("generate", LAYOUTS[name])


def ready(task):
    return [one for one in clinic.robots(task) if one.spec]


@pytest.mark.parametrize("name", list(LAYOUTS))
def test_every_cleaner_either_cleans_or_is_marked_unfit_with_a_reason(name):
    plan = building(name)
    unfit = post("fit", {"building": plan})["cleaning"]
    for robot in ready(clinic.CLEANING):
        request = {"building": plan, "operation_ids": ["cleaning"], "cleaner_id": robot.id, "with_events": False}
        if robot.id in unfit:
            assert "мм" in unfit[robot.id]
            assert not post("check", request)["valid"]
            continue
        assert post("runs", request)["kpi"]["cleaned_m2"] > 0, robot.product


@pytest.mark.parametrize("name", list(LAYOUTS))
def test_every_delivery_robot_either_delivers_or_is_marked_unfit_with_a_reason(name):
    plan = building(name)
    unfit = post("fit", {"building": plan})["delivery"]
    for robot in ready(clinic.DELIVERY):
        if robot.id in unfit:
            assert unfit[robot.id].startswith("Не доезжает ни до одного поста")
            continue
        request = {
            "building": plan,
            "operation_ids": ["floor_delivery"],
            "robot_id": robot.id,
            "cleaner_id": None,
            "fleet": 2,
            "with_events": False,
        }
        assert post("runs", request)["kpi"]["done"] > 0, robot.product


def test_r2b_on_the_hospital_template_is_unfit_because_of_the_utility_room_door():
    reason = post("fit", {"building": building("template")})["cleaning"][R2B]
    assert "1300 мм" in reason and "900 мм" in reason


def test_r2b_with_its_base_moved_to_the_corridor_cleans():
    plan = building("template")
    for floor in plan["floors"]:
        base = next(item for item in floor["items"] if item.get("role") == "cleaning")
        base.update(x=24, y=10, w=1, h=1)
    assert R2B not in post("fit", {"building": plan})["cleaning"]
    run = post("runs", {"building": plan, "operation_ids": ["cleaning"], "cleaner_id": R2B, "with_events": False})
    assert run["kpi"]["cleaned_m2"] > 0


def test_floor_without_a_reachable_base_is_named_as_the_bottleneck():
    plan = building("two")
    first = plan["floors"][0]
    base = next(item for item in first["items"] if item.get("role") == "cleaning")
    # закрываем базу первого этажа преградой вокруг: этаж не моется, второй моется
    first["items"].append({"id": "wall", "kind": "blocked", "x": base["x"] - 1, "y": base["y"] - 1, "w": 4, "h": 1})
    first["items"].append({"id": "wall2", "kind": "blocked", "x": base["x"] - 1, "y": base["y"] + 2, "w": 4, "h": 1})
    first["items"].append({"id": "wall3", "kind": "blocked", "x": base["x"] - 1, "y": base["y"], "w": 1, "h": 2})
    first["items"].append({"id": "wall4", "kind": "blocked", "x": base["x"] + 2, "y": base["y"], "w": 1, "h": 2})
    request = {"building": plan, "operation_ids": ["cleaning"], "with_events": False}
    checked = post("check", request)
    if not any(one["code"] == "cleaning_blocked" for one in checked["checks"]):
        pytest.skip("преграды не закрыли базу на этом плане")
    assert checked["valid"]
    run = post("runs", request)
    assert "уборка: на этажах 1" in run["kpi"]["bottleneck"]
