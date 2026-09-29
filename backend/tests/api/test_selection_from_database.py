"""Подбор читает каталог из базы: правка в админке видна в подборе и на первом шаге без перезапуска."""

import pytest

from app.db import get_session
from app.main import app
from app.services import catalog_import, catalog_uses, selection

BASE = "/api/admin/catalog"
H1500 = "5760e938-9a43-45a7-b8e8-f4f2e6383930"  # Ronavi H1500, перевозка паллет, есть в расчетной модели


def session():
    return next(app.dependency_overrides[get_session]())


@pytest.fixture
def admin(db_client, monkeypatch):
    """Админ и подбор смотрят в одну базу, как на сервере."""
    db_client.post("/api/auth/demo", json={"role": "admin"})
    s = session()
    catalog_import.seed_team_catalog(s)
    catalog_uses.seed_uses(s)
    monkeypatch.setattr(selection, "sessions", session)
    selection.forget()
    yield db_client
    selection.forget()


def pick(client, solution_id, operation="pallet_transport"):
    found = client.get("/api/catalog/solutions", params={"operation": operation}).json()
    return next((s for s in found if s["id"] == solution_id), None)


def spec_id(client, solution_id, field):
    card = client.get(f"{BASE}/{solution_id}").json()
    return next(spec["id"] for spec in card["specs"] if spec["field"] == field)


def operation_count(client, operation):
    facilities = {f["id"]: f for f in client.get("/api/catalog/facilities").json()}
    return next(o["solutions_count"] for o in facilities["warehouse"]["operations"] if o["id"] == operation)


def test_spec_edit_changes_selection(admin):
    before = pick(admin, H1500)
    assert before["status"] != "excluded"

    payload = spec_id(admin, H1500, "payload_kg")
    assert admin.patch(f"{BASE}/{H1500}/specs/{payload}", json={"value": "300", "rating": "C"}).status_code == 200

    after = pick(admin, H1500)
    assert after["status"] == "excluded"
    assert any(c["label"] == "Грузоподъемность" and c["outcome"] == "blocks" for c in after["checks"])
    assert {
        "field": "payload_kg",
        "label": "Грузоподъемность, кг",
        "value": "300",
        "trust": "C",
        "unit": "кг",
    } in after["specs"]


def preview(client):
    response = client.post("/api/calculations/preview", json={})
    assert response.status_code == 200, response.text
    return response.json()


def test_price_edit_goes_to_selection_and_economics(admin):
    """Цена, которую поставил администратор, идет и в карточку подбора, и в экономику,
    а в "Откуда цифры" видно, кто и когда ее поправил."""
    before = preview(admin)
    fleet = before["sizing"]["fleet"]
    assert before["scenarios"][1]["capex_rub"]["hardware"] == fleet * 2_700_000

    assert admin.patch(f"{BASE}/{H1500}", json={"price_rub": "3100000"}).status_code == 200

    card = pick(admin, H1500)
    assert card["price_rub"] == 3_100_000 and card["can_calculate"] and card["calc_note"] == ""
    after = preview(admin)
    assert after["scenarios"][1]["capex_rub"]["hardware"] == after["sizing"]["fleet"] * 3_100_000
    price = next(s for s in after["sources"] if s["path"] == "robots.ronavi-h1500.price_rub")
    assert price["value"] == 3_100_000
    assert price["source"].startswith("Цена из каталога, правил администратор") and price["date"]


def test_catalog_price_equal_to_model_keeps_model_source(admin):
    price = next(s for s in preview(admin)["sources"] if s["path"] == "robots.ronavi-h1500.price_rub")
    assert price["value"] == 2_700_000 and not price["source"].startswith("Цена из каталога")


def test_new_solution_appears_after_task_is_confirmed_and_is_marked_as_not_calculated(admin):
    count = operation_count(admin, "pallet_transport")
    new = admin.post(BASE, json={"name": "Тележка-тест", "company": "ООО Тест", "status": "operation"}).json()
    assert pick(admin, new["id"]) is None

    confirm = admin.put(f"{BASE}/{new['id']}/uses/warehouse/pallet_transport", json={"status": "confirmed"})
    assert confirm.status_code == 200

    found = pick(admin, new["id"])
    assert found is not None
    assert not found["can_calculate"] and found["robot_id"] is None
    assert found["calc_note"].startswith("Не считается: нет расчетных параметров")
    assert operation_count(admin, "pallet_transport") == count + 1


def test_rejected_task_removes_solution_from_selection(admin):
    assert pick(admin, H1500) is not None
    # у H1500 две задачи склада: перевозка паллет и кандидат на отбор товара
    for operation in ("pallet_transport", "piece_picking"):
        reject = admin.put(f"{BASE}/{H1500}/uses/warehouse/{operation}", json={"status": "rejected"})
        assert reject.status_code == 200
    assert pick(admin, H1500) is None


def test_catalog_edit_changes_data_version(admin):
    """Проект, сохраненный до правки каталога в админке, при открытии скажет, что данные поменялись."""
    from app.services.versions import data_version

    before = data_version()
    assert data_version() == before
    assert admin.patch(f"{BASE}/{H1500}", json={"price_rub": "3100000"}).status_code == 200
    assert data_version() != before


def test_zero_price_in_catalog_does_not_make_robots_free(admin):
    """Ноль в цене каталога значит "цена не указана", а не "роботы бесплатно": расчет берет цену модели."""
    assert admin.patch(f"{BASE}/{H1500}", json={"price_rub": "0"}).status_code == 200
    after = preview(admin)
    assert after["scenarios"][1]["capex_rub"]["hardware"] == after["sizing"]["fleet"] * 2_700_000
