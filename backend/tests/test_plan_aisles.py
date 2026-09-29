"""Проезд между рядами уже, чем нужно роботу: шаг плана говорит об этом проверкой, а шаг
экономики понятной причиной с кнопкой к плану, а не голым отказом 422.

Тестировщик поставил много рядов с проездом 0,5 м. Сетка плана в метр, и такой проезд на ней то
исчезает, то становится проезжей клеткой: расчет выходил по дороге, которой нет, а проверка
погрузчика писала "Робот проедет".
"""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.engine import plan as engine
from app.main import app
from app.services import plan as plan_service

client = TestClient(app)
ROBOT_CHECK = "Робот проходит между рядами"


def _rows(gap: float, count: int = 12, kind: str = "front") -> list[engine.Item]:
    constants = plan_service.constants()
    defaults = engine.rack_defaults(engine.rack_type(constants, kind), constants)
    band = defaults["row_m"] * defaults["block_rows"]
    first = engine.Item(id="r0", kind=engine.RACKS, x=30, y=15, w=band, h=50, rows="y", group="g", **defaults)
    return [replace(first, id=f"r{n}", x=round(30 + n * (band + gap), 3), aisle_m=gap) for n in range(count)]


def _plan_with(rows: list[engine.Item]) -> dict:
    built = client.post(
        "/api/plan/generate",
        json={
            "operation_ids": ["pallet_transport"],
            "template_id": "custom",
            "width_m": 118,
            "length_m": 85,
            "custom": {"docks": [{"wall": "west", "count": 6}], "racks": "none"},
        },
    )
    assert built.status_code == 200, built.text
    plan = built.json()["plan"]
    plan["items"] += [
        {key: getattr(row, key) for key in ("id", "kind", "x", "y", "w", "h", "rows", "group", "rack_type")}
        | {
            "row_m": row.row_m,
            "aisle_m": row.aisle_m,
            "cross_m": row.cross_m,
            "tier_m": row.tier_m,
            "tiers": row.tiers,
            "block_rows": row.block_rows,
        }
        for row in rows
    ]
    plan["edited"] = True
    return plan


def _checks(plan: dict) -> dict[str, dict]:
    measured = client.post("/api/plan/measure", json=plan)
    assert measured.status_code == 200, measured.text
    return {check["label"]: check for check in measured.json()["measures"]["checks"]}


def _body(gap: float, robot: str = "ronavi-h1500") -> dict:
    return {
        "tasks": [{"operation_id": "pallet_transport", "robot_id": robot, "share": 1}],
        "plan": _plan_with(_rows(gap)),
        "use_simulation": True,
    }


def test_rows_half_a_meter_apart_warn_on_the_plan_step():
    """На шаге плана робот еще не выбран: сравниваем с тем, что закладываем, и предупреждаем."""
    checks = _checks(_plan_with(_rows(0.5)))
    robot = checks[ROBOT_CHECK]
    assert not robot["ok"]
    assert robot["detail"].startswith("Между рядами 0,5 м, а мы советуем роботам не меньше 1,2 м.")
    assert "раздвиньте ряды" in robot["detail"]
    # погрузчик тоже не пройдет, и "Робот проедет" там больше не пишем
    assert "Робот проедет" not in checks["Погрузчик проходит в проезды"]["detail"]


def test_aisle_narrower_than_the_robot_blocks_economics_with_a_reason_not_a_bare_422():
    """Проезд уже каталожного минимума выбранного робота (у H1500 750 мм): расчет не идет,
    причина в плане и кнопка к плану."""
    body = _body(0.5)
    response = client.post("/api/calculations/preview", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert not result["feasible"]
    assert result["cause"] == "plan"
    assert result["message"].startswith("Между рядами 0,5 м, а Ronavi H1500 нужно не меньше 0,75 м: раздвиньте ряды")
    # что будет, если: тот же отказ словами, а не расчет по несуществующему проезду
    sensitivity = client.post("/api/calculations/sensitivity", json=body)
    assert sensitivity.status_code == 422
    assert "раздвиньте ряды" in sensitivity.json()["detail"]


def test_aisle_wider_than_the_robot_but_below_our_margin_counts_with_a_risk():
    """1 м: H1500 проходит (ему 0,75 м), но это впритык к нашим 1,2 м. Расчет идет, в рисках строка."""
    result = client.post("/api/calculations/preview", json=_body(1.0)).json()
    assert result["feasible"], result.get("message")
    note = "Между рядами 1,0 м: робот проедет, но запаса почти нет. Мы советуем не меньше 1,2 м"
    robots = [one for one in result["scenarios"] if one["id"] != "baseline"]
    assert robots and all(note in one["verdict"]["risks"] for one in robots)


def test_robot_without_a_published_minimum_is_not_blocked():
    """Минимума в данных нет (AK-2000-2): не знаем, проедет ли, поэтому не блокируем, только риск."""
    from app.services.selection import catalog

    unknown = "avtomakon-ak-2000-2"
    row = next(
        one for one in catalog() if one["product"].startswith("Автомакон AK-2000") or "AK-2000-2" in one["product"]
    )
    assert not row.get("min_aisle_width_mm")
    result = client.post("/api/calculations/preview", json=_body(0.5, unknown)).json()
    assert "раздвиньте ряды" not in (result.get("message") or "")
    if result["feasible"]:
        robots = [one for one in result["scenarios"] if one["id"] != "baseline"]
        assert all(
            any(risk.startswith("Между рядами 0,5 м, а мы закладываем 1,2 м") for risk in one["verdict"]["risks"])
            for one in robots
        )


def test_rows_wide_enough_pass():
    checks = _checks(_plan_with(_rows(3.0)))
    assert checks[ROBOT_CHECK]["ok"]
    assert "Ряды не стоят впритык" not in checks


def test_rows_side_by_side_are_named_touching():
    """Ряды впритык: проезда между ними нет, это не узкий проезд, а стеллажи без подъезда."""
    checks = _checks(_plan_with(_rows(0.0, count=4)))
    touching = checks["Ряды не стоят впритык"]
    assert not touching["ok"]
    assert touching["detail"].startswith("Рядов впритык к соседу: 4.")
    assert checks[ROBOT_CHECK]["ok"]  # узкого проезда нет: его нет совсем


def test_pieces_of_one_row_are_not_touching():
    """Куски одного ряда на одной линии разделяет поперечный проезд: они не соседи."""
    constants = plan_service.constants()
    plan = engine.rows_of(engine.generate(plan_service.template("one_side"), constants, 10_000, margin_m=16), constants)
    assert engine.touching_rows(plan.of(engine.RACKS), constants) == 0


@pytest.mark.parametrize("template_id", [one["id"] for one in plan_service.templates()])
def test_every_template_leaves_the_robot_room(template_id):
    """Типовые схемы и их раскладка на ряды проходят новую проверку: демо-расчет не меняется."""
    constants = plan_service.constants()
    plan = engine.generate(plan_service.template(template_id), constants, 10_000, margin_m=16)
    for one in (plan, engine.rows_of(plan, constants)):
        racks = one.of(engine.RACKS)
        assert engine.narrow_aisles(racks, constants) == []
        assert engine.touching_rows(racks, constants) == 0
        checks = {check.label: check for check in engine.measure(one, constants).checks}
        assert checks[ROBOT_CHECK].ok


def test_plan_the_server_cannot_take_is_named_in_words():
    """Поле объекта вне границ: раньше шаг экономики показывал "Сервер отклонил запрос, код 422",
    а шаг плана молчал. Теперь оба говорят, какой объект, какое поле и где поправить."""
    plan = _plan_with(_rows(3.0, count=2))
    plan["items"][-1]["block_rows"] = 41
    measured = client.post("/api/plan/measure", json=plan)
    assert measured.status_code == 422
    at = len(plan["items"])
    expected = f"План не принят: объект {at} на чертеже, рядов вплотную: должно быть не больше 40"
    assert measured.json()["detail"][0]["msg"].startswith(expected)

    body = {"tasks": [{"operation_id": "pallet_transport", "robot_id": "ronavi-h1500"}], "plan": plan}
    response = client.post("/api/calculations/preview", json=body)
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"].startswith(expected)
    assert response.json()["detail"][0]["msg"].endswith("Поправьте его на шаге плана")
