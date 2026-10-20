"""Строка "что нужно, чтобы окупилось": границы одной цифры, за которыми покупка отбора окупается за горизонт."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
PICKING = "facilities.warehouse.operations.piece_picking."
# Отборщик делает 150 строк в час: робот ускоряет его только в 250 / 150 = 1,7 раза, покупка по формуле
# не окупается, но близко, и видны все четыре границы
FASTER = {PICKING + "productivity_before": 150}


def preview(**body):
    response = client.post("/api/calculations/preview", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def picking(overrides: dict) -> dict:
    return preview(operation_id="piece_picking", robot_id="ronavi-m", overrides=overrides)


def purchase_pays(result: dict) -> bool:
    return result["scenarios"][1]["payback_cumulative_years"] is not None


def test_nothing_to_say_when_picking_pays_back():
    """Оклад 150 000: покупка отбора по формуле окупается за 1,7 года, строки нет"""
    result = picking({"facilities.warehouse.staff.pickers.salary_month": 150_000})
    assert purchase_pays(result)
    assert result["payback_needs"] == []


def test_default_picking_pays_back_without_the_line():
    """Отбор по умолчанию (2 смены по 11 ч, 365 дней, цены без НДС, по формуле 20 роботов) окупается
    за 2,59 года, и строки нет. На пятидневке 2 смены по 8 ч было 27 роботов, покупка не окупалась,
    и строка называла три границы"""
    result = picking({})
    assert purchase_pays(result)
    assert result["payback_needs"] == []


def test_faster_pickers_get_the_edges_of_each_number():
    """Отборщик 150 строк в час: границы по формуле до 146, на станции от 256, оклад от 104 000,
    объем от 48 000 строк вместе со штатом."""
    result = picking(FASTER)
    assert not purchase_pays(result)
    needs = {need["label"]: need for need in result["payback_needs"]}
    assert needs["Выработка отборщика сейчас"]["value"] == 146
    assert needs["Выработка на станции"]["value"] == 256
    assert needs["Оклад"]["value"] == 104_000
    assert needs["Объем"]["value"] == 48_000
    assert "не больше 146 строк в час (у вас 150)" in needs["Выработка отборщика сейчас"]["text"]


def test_each_edge_really_pays_back_and_a_step_short_does_not():
    needs = {need["path"]: need["value"] for need in picking(FASTER)["payback_needs"]}
    before = PICKING + "productivity_before"
    after = PICKING + "productivity_after"
    assert purchase_pays(picking({**FASTER, before: needs[before]}))
    assert not purchase_pays(picking({**FASTER, before: needs[before] + 2}))
    assert purchase_pays(picking({**FASTER, after: needs[after]}))
    assert not purchase_pays(picking({**FASTER, after: needs[after] - 2}))


def test_volume_pays_back_together_with_staff():
    """Рост объема вместе со штатом окупает: вложения на объект делятся на больший поток."""
    result = picking(FASTER)
    needs = {need["label"]: need for need in result["payback_needs"]}
    assert needs["Объем"]["value"] > needs["Объем"]["now"] == 35_000
    assert "штат под него" in needs["Объем"]["text"]


def test_pallets_never_get_the_line():
    """Строка только у задач "товар к человеку": у паллет робот заменяет человека целиком."""
    result = preview(overrides={"facilities.warehouse.staff.forklift-operators.salary_month": 30_000})
    assert not purchase_pays(result)
    assert result["payback_needs"] == []
