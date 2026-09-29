"""Аэропорт и медучреждение: задачи, поля из датасета и список решений с объяснением (ТЗ, п. 5.5)."""

import csv

from fastapi.testclient import TestClient

from app.main import app
from app.services import facility_catalog
from app.services.catalog_uses import BY_KEY
from app.settings import settings

client = TestClient(app)


def answer(facility: str, tasks: list[str], overrides: dict | None = None) -> dict:
    body = {"facility_id": facility, "operation_ids": tasks, "overrides": overrides or {}}
    response = client.post("/api/catalog/facility-solutions", json=body)
    assert response.status_code == 200
    return response.json()


def by_product(found: dict, product: str) -> dict:
    return next(item for item in found["solutions"] if item["product"] == product)


def test_tasks_come_with_volume_from_dataset_and_count_of_solutions():
    facilities = {f["id"]: f for f in client.get("/api/catalog/facilities").json()}
    airport = {o["id"]: o for o in facilities["airport"]["operations"]}

    baggage = airport["baggage_transport"]
    assert baggage["volume_per_day"] == 35000  # лист "Аэропорт", объем багажа в сутки
    assert baggage["volume_label"] == "Объём перемещения багажа (единиц/сутки)"
    assert baggage["volume_trust"] == "D"  # один источник, файл организатора
    assert baggage["performed_by"] == ["Численность персонала наземного обслуживания (рамп): 320 чел."]
    assert baggage["solutions_count"] == 4
    # кто охраняет перрон, в датасете не сказано, и мы не придумываем
    assert airport["patrol"]["performed_by"] == []

    # на карточке объекта число решений из нашего разбора, а не сырые позиции каталога
    assert facilities["airport"]["catalog"]["count"] == 12
    assert facilities["clinic"]["catalog"]["count"] == 18


def test_parameters_keep_dataset_ranges_and_put_what_checks_read_on_top():
    fields = client.get("/api/catalog/parameters", params={"facility": "clinic", "operations": "cart_transport"}).json()
    by_path = {f["path"]: f for f in fields}

    corridor = by_path["clinic.corridor_width_m"]
    assert (corridor["value"], corridor["min"], corridor["max"]) == (2.4, 1.8, 3.5)
    assert corridor["key"]  # от нее зависит проверка решений, поэтому наверху шага
    assert by_path["clinic.meal_portions_per_day"]["key"]  # объем выбранной задачи
    assert not by_path["clinic.samples_per_day"]["key"]  # задача не выбрана
    # слова вроде "Да (ЕМИАС)" полем не ввести: они приходят условиями вместе со списком решений
    assert "clinic.mis" not in by_path


def test_unknown_task_of_facility_is_not_found():
    response = client.get("/api/catalog/parameters", params={"facility": "airport", "operations": "pallet_transport"})
    assert response.status_code == 404


def test_clinic_checks_read_parameters_with_user_edits():
    found = answer("clinic", ["floor_delivery"])
    flashbot = by_product(found, "Pudu FlashBot Max")
    assert flashbot["status"] == "recommended"
    assert {c["label"]: c["outcome"] for c in flashbot["checks"]} == {
        "Можно ли купить": "fits",
        "Ширина коридора": "fits",
        "Этажи и лифт": "fits",
    }
    # про лифт у PuduBot 2 производитель молчит: требует проверки, а не "подходит"
    assert by_product(found, "PuduBot 2")["status"] == "needs_check"

    # коридор 0,5 м уже любого прохода, который публикуют производители
    narrow = answer("clinic", ["floor_delivery"], {"clinic.corridor_width_m": 0.5})
    assert by_product(narrow, "Pudu FlashBot Max")["status"] == "excluded"

    # в одноэтажном здании лифт не нужен
    flat = answer("clinic", ["floor_delivery"], {"clinic.floors": 1})
    assert by_product(flat, "PuduBot 2")["status"] == "recommended"


def test_cart_payload_is_checked_against_heaviest_cart():
    tug = by_product(answer("clinic", ["cart_transport"]), "Aethon TUG T3")
    cart = next(c for c in tug["checks"] if c["label"] == "Масса тележки")
    assert cart["outcome"] == "fits"
    assert "340" in cart["detail"] and "120" in cart["detail"]

    heavy = by_product(answer("clinic", ["cart_transport"], {"clinic.meal_cart_mass_kg": 400}), "Aethon TUG T3")
    assert heavy["status"] == "excluded"


def test_apron_frost_is_compared_with_published_range():
    found = answer("airport", ["baggage_transport"])
    frost = {
        item["product"]: next(c for c in item["checks"] if c["label"] == "Мороз на перроне")
        for item in found["solutions"]
    }
    # EVOCARGO: от -40 °C по данным организатора, на перроне -25 °C
    assert frost["EVOCARGO N1"]["outcome"] == "fits"
    # у тягача Cognitive Pilot диапазон не опубликован: не проверили, а не "подходит"
    assert frost["Беспилотный тягач Cognitive Pilot"]["outcome"] == "unknown"

    colder = answer("airport", ["baggage_transport"], {"airport.apron_winter_temp_c": -45})
    assert by_product(colder, "EVOCARGO N1")["status"] == "excluded"


def test_discontinued_model_is_not_recommended():
    guide = by_product(answer("airport", ["passenger_help"]), "LG CLOi GuideBot")
    assert guide["status"] == "excluded"


def test_text_value_gets_no_unit():
    evocargo = by_product(answer("airport", ["baggage_transport"]), "EVOCARGO N1")
    runtime = next(spec for spec in evocargo["specs"] if spec["field"] == "runtime_h")
    assert runtime["value"] == "до недели на одной зарядке (маркетинг)"


def test_prototype_is_not_recommended():
    ultrabot = by_product(answer("clinic", ["disinfection"]), "Ультработ (Сколтех)")
    assert ultrabot["status"] == "excluded"
    assert ultrabot["checks"][0]["detail"] == "прототип, купить нельзя"


def test_every_characteristic_has_source_date_and_trust():
    for facility in ("airport", "clinic"):
        tasks = [task.id for task in facility_catalog.operations(facility)]
        for item in answer(facility, tasks)["solutions"]:
            assert item["why"] and item["limits"]
            assert item["price_source"]  # цена или честное "не нашли"
            for spec in item["specs"]:
                assert spec["trust"] in "SABCDEF"
                assert spec["sources"]
                assert spec["date"]
                # нет значения только там, где нет данных
                assert bool(spec["value"]) == (spec["trust"] != "F")


def test_solution_list_matches_catalog_marks_and_tasks():
    """Решения каталога в списке те же, что в разметке data/catalog/uses.csv, и с той же задачей."""
    with (settings.data_dir / "catalog" / "uses.csv").open(encoding="utf-8") as file:
        marked = {
            (row["solution_id"], row["facility"], row["operation"])
            for row in csv.DictReader(file, delimiter=";")
            if row["facility"] in ("airport", "clinic")
        }
    listed = facility_catalog._solutions()
    from_catalog = {
        (r["catalog_id"], r["facility"], r["operation"]) for r in listed if not r["catalog_id"].startswith("ext-")
    }
    assert from_catalog == marked
    assert all((row["facility"], row["operation"]) in BY_KEY for row in listed)
    # ТЗ просит 5-10 новых решений на тип из открытых источников
    for facility in ("airport", "clinic"):
        found = [row for row in listed if row["facility"] == facility and row["catalog_id"].startswith("ext-")]
        assert len(found) >= 5


def test_short_path_facilities_say_what_comes_next():
    facilities = {f["id"]: f for f in client.get("/api/catalog/facilities").json()}
    assert facilities["warehouse"]["next"] == []
    for facility in ("airport", "clinic"):
        lines = facilities[facility]["next"]
        assert 3 <= len(lines) <= 5
        assert not any("ё" in line or "—" in line for line in lines)
    assert any("лифт" in line for line in facilities["clinic"]["next"])
    assert any("перрон" in line for line in facilities["airport"]["next"])
