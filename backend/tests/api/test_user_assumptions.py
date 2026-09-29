"""Допущения, которые пользователь меняет сам (ТЗ, п. 3.5.3), и масса груза в подборе."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
LOAD = "facilities.warehouse.operations.pallet_transport.load_kg"


def test_robot_fields_carry_catalog_price_and_its_source():
    fields = client.get("/api/catalog/robot-parameters", params={"robots": "ronavi-h1500"}).json()
    by_path = {field["path"]: field for field in fields}
    price = by_path["robots.ronavi-h1500.price_rub"]
    # по умолчанию та же цена, что берет расчет, и границы от нее, а не общие на всех роботов
    assert price["value"] > 0 and price["min"] == price["value"] * 0.5 and price["max"] == price["value"] * 2
    assert price["source"] and price["ours"] and price["group"] == "robot:ronavi-h1500"
    assert {"robots.ronavi-h1500.maintenance_share_year", "robots.ronavi-h1500.service_life_years"} <= set(by_path)


def test_unknown_robot_is_404():
    assert client.get("/api/catalog/robot-parameters", params={"robots": "nope"}).status_code == 404


def test_robot_price_edit_goes_into_the_calculation():
    body = {"facility_id": "warehouse", "operation_id": "pallet_transport", "robot_id": "ronavi-h1500"}
    base = client.post("/api/calculations/preview", json=body).json()
    cheaper = client.post(
        "/api/calculations/preview", json=body | {"overrides": {"robots.ronavi-h1500.price_rub": 1500000}}
    ).json()
    capex = {s["id"]: s["capex_total_rub"] for s in base["scenarios"]}
    capex_cheaper = {s["id"]: s["capex_total_rub"] for s in cheaper["scenarios"]}
    assert capex_cheaper["purchase"] < capex["purchase"]


def test_load_mass_is_a_field_and_drives_the_payload_rule():
    fields = client.get("/api/catalog/parameters", params={"operations": "pallet_transport"}).json()
    load = next(field for field in fields if field["path"] == LOAD)
    # среди главных полей шага, когда выбрана перевозка паллет (bdc25ed)
    assert load["value"] == 800 and not load["ours"] and load["key"]

    light = client.get("/api/catalog/solutions", params={"operation": "pallet_transport"}).json()
    heavy = client.get("/api/catalog/solutions", params={"operation": "pallet_transport", "load_kg": 1400}).json()
    status = {s["id"]: s["status"] for s in light}
    blocked = [s for s in heavy if s["status"] == "excluded" and status[s["id"]] != "excluded"]
    assert blocked, "тяжелый груз должен отсеять хотя бы одного робота, который возит 800 кг"
    assert all(any(c["label"] == "Грузоподъемность" and "1400 кг" in c["detail"] for c in s["checks"]) for s in blocked)
