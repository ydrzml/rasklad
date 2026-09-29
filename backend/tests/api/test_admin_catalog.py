from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.db import get_session
from app.main import app
from app.services import catalog_import
from app.storage.models import CatalogChange, Solution, SolutionSpec

BASE = "/api/admin/catalog"
HEADER = (
    "id;Название;тип;статус;компания;описание;Тип;Подтип;Сценарий;Кейсы;УГТ;Рын Потенциал;Регион;Отрасль;Цена изделия"
)
ORGANIZER_FILE = Path(__file__).resolve().parents[3] / "data" / "organizer" / "catalog_export_v4.csv"

UNIT = "9b20417a-0ac7-4786-985b-f3459a15075d"  # есть в нашем каталоге из 31 решения


def row(
    id_: str,
    name: str,
    *,
    kind="brs",
    status="operation",
    trl="9",
    price="2 700 000,00",
    company="ООО «Рога»",
    industry="Промышленность",
    scenario="Внутрискладская логистика",
):
    return (
        f"{id_};{name};{kind};{status};{company};Описание;Мобильные роботы;AMR;{scenario};"
        f"Кейс;{trl};;Москва;{industry};{price}"
    )


def csv_file(*rows: str) -> bytes:
    return ("\ufeff" + "\n".join([HEADER, *rows]) + "\n").encode("utf-8")


def session():
    return next(app.dependency_overrides[get_session]())


def count(model) -> int:
    return session().scalar(select(func.count()).select_from(model))


@pytest.fixture
def admin(db_client):
    db_client.post("/api/auth/demo", json={"role": "admin"})
    return db_client


@pytest.fixture
def seeded(admin):
    assert catalog_import.seed_team_catalog(session()) == 31
    return admin


def upload(client, content: bytes, dry_run: bool = False, name: str = "catalog.csv"):
    return client.post(f"{BASE}/import?dry_run={str(dry_run).lower()}", files={"file": (name, content, "text/csv")})


def test_only_admin_gets_in(db_client):
    assert db_client.get(BASE).status_code == 401
    db_client.post("/api/auth/demo", json={"role": "user"})
    assert db_client.get(BASE).status_code == 403
    assert db_client.post(BASE, json={"name": "x"}).status_code == 403
    assert upload(db_client, csv_file()).status_code == 403
    assert db_client.get(f"{BASE}/changes").status_code == 403


def test_seed_puts_our_31_solutions_with_specs_once(seeded):
    assert count(Solution) == 31
    assert count(SolutionSpec) > 250
    assert catalog_import.seed_team_catalog(session()) == 0

    card = seeded.get(f"{BASE}/{UNIT}").json()
    assert card["name"] == "Unit"
    runtime = next(spec for spec in card["specs"] if spec["field"] == "runtime_h")
    # у Unit источники по заряду сошлись после разбора спорных значений (docs/data-sources.md)
    assert runtime["rating"] == "B" and runtime["confirmed"] is True
    assert runtime["label"] == "Работа от одного заряда"
    assert card["history"] == []


def test_list_filters_search_and_counts(seeded):
    page = seeded.get(BASE, params={"limit": 5}).json()
    assert page["total"] == 31 and len(page["items"]) == 5
    found = seeded.get(BASE, params={"search": "ronavi"}).json()
    assert found["total"] >= 1 and all("ronavi" in i["name"].lower() for i in found["items"])
    row_ = found["items"][0]
    assert row_["specs_total"] >= row_["specs_filled"] >= row_["specs_confirmed"]


NEW = "11111111-1111-4111-8111-111111111111"


def test_import_adds_updates_glues_and_reports_errors(seeded):
    content = csv_file(
        row(UNIT, "Unit", company="ООО «Яку Роботикс»", price="2 300 000,00"),
        row(NEW, "Новый робот"),
        row(NEW, "Новый робот", industry="Торговля и услуги"),
        row(NEW, "Новый робот", price="3 100 000,00"),
        row("33333333-3333-4333-8333-333333333333", "Кривой", kind="robot"),
        row("не-номер", "Без номера"),
        row("44444444-4444-4444-8444-444444444444", "Плохой УГТ", trl="12"),
        row("55555555-5555-4555-8555-555555555555", "Плохая цена", price="дорого"),
    )
    checked = upload(seeded, content, dry_run=True).json()
    assert checked["dry_run"] and checked["added"] == 2 and count(Solution) == 31

    result = upload(seeded, content).json()
    assert (result["rows"], result["added"], result["updated"], result["merged"]) == (8, 2, 1, 1)
    assert [e["row"] for e in result["errors"]] == [6, 7, 8, 9]
    assert "brs, bas, software" in result["errors"][0]["message"]
    assert count(Solution) == 33

    unit = seeded.get(f"{BASE}/{UNIT}").json()
    assert unit["kind"] == "brs" and unit["description"] == "Описание" and unit["price_rub"] == "2300000.00"
    assert len(unit["specs"]) > 5, "наши характеристики не затерлись"
    assert unit["process"], "процесс, который проставили мы, остался"

    glued = seeded.get(f"{BASE}/{NEW}").json()
    assert glued["industry"] == "Промышленность; Торговля и услуги" and glued["price_rub"] == "2700000.00"
    # SQLite в тестах не знает регистра русских букв, поэтому ищем как написано. В Postgres регистр не важен
    variants = seeded.get(BASE, params={"search": "Новый робот"}).json()["items"]
    assert sorted(v["price_rub"] for v in variants) == ["2700000.00", "3100000.00"]
    assert {v["organizer_id"] for v in variants} == {NEW}

    again = upload(seeded, content).json()
    assert again["added"] == 0 and again["updated"] == 0 and again["unchanged"] == 3
    assert seeded.get(f"{BASE}/changes").json()[0]["action"] == "import"


def test_second_price_of_our_solution_becomes_separate_position(seeded):
    # У нашей позиции в файле две цены: номер остается у первой, вторая комплектация получает свой id
    content = csv_file(row(UNIT, "Unit", price="2 000 000,00"), row(UNIT, "Unit", price="2 500 000,00"))
    result = upload(seeded, content).json()
    assert result["added"] == 1 and result["updated"] == 1
    assert seeded.get(f"{BASE}/{UNIT}").json()["price_rub"] == "2000000.00"
    again = upload(seeded, content).json()
    assert again["added"] == 0 and again["unchanged"] == 2, "повторная загрузка попадает в те же позиции"


def test_without_our_price_number_stays_with_our_process(seeded):
    # Цены у нашего Unit еще нет, процесс «Уборка помещений»: номер достается комплектации с этим сценарием
    content = csv_file(
        row(UNIT, "Unit", price="1 000 000,00", scenario="Мойка полов в цехах"),
        row(UNIT, "Unit", price="2 300 000,00", scenario="Уборка помещений"),
    )
    upload(seeded, content)
    assert seeded.get(f"{BASE}/{UNIT}").json()["price_rub"] == "2300000.00"


def test_whole_file_rejected_with_reason(admin):
    wrong_columns = upload(admin, "\ufeffid;name\n1;x\n".encode())
    assert wrong_columns.status_code == 422 and "Название" in wrong_columns.json()["detail"]
    cp1251 = upload(admin, (HEADER + "\n").encode("cp1251"))
    assert cp1251.status_code == 422 and "UTF-8" in cp1251.json()["detail"]


def test_edit_create_delete_are_logged_with_old_and_new(seeded):
    changed = seeded.patch(f"{BASE}/{UNIT}", json={"price_rub": "2500000", "trl": 8}).json()
    assert changed["price_rub"] == "2500000.00" and changed["trl"] == 8
    entry = changed["history"][0]
    assert entry["action"] == "update" and entry["user_email"] == "admin@example.com"
    assert entry["changes"]["trl"] == [None, 8]
    assert seeded.patch(f"{BASE}/{UNIT}", json={"trl": 12}).status_code == 422

    made = seeded.post(BASE, json={"name": "PuduBot 2", "company": "Pudu Robotics", "industry": "Медицина"})
    assert made.status_code == 201
    pudu = made.json()
    assert pudu["origin"] == "team" and pudu["history"][0]["action"] == "create"

    assert seeded.delete(f"{BASE}/{pudu['id']}").status_code == 204
    assert seeded.get(f"{BASE}/{pudu['id']}").status_code == 404
    log = seeded.get(f"{BASE}/changes").json()
    assert log[0]["action"] == "delete" and log[0]["solution_name"] == "PuduBot 2"


def test_specs_add_edit_delete_with_source_and_date(seeded):
    pudu = seeded.post(BASE, json={"name": "PuduBot 2"}).json()
    url = f"{BASE}/{pudu['id']}/specs"
    spec = {
        "field": "payload_kg",
        "value": "40",
        "unit": "кг",
        "rating": "C",
        "source": "https://www.pudurobotics.com/",
        "source_type": "производитель",
        "retrieved": "2026-09-23",
    }
    card = seeded.post(url, json=spec).json()
    added = card["specs"][0]
    assert added["label"] == "Грузоподъемность" and added["retrieved"] == "2026-09-23"
    assert seeded.post(url, json=spec).status_code == 409
    assert seeded.post(url, json={**spec, "field": "runtime_h", "rating": "Z"}).status_code == 422

    edited = seeded.patch(f"{url}/{added['id']}", json={"value": "45", "rating": "B"}).json()
    assert edited["specs"][0]["value"] == "45" and edited["specs"][0]["confirmed"] is True
    assert edited["history"][0]["changes"]["payload_kg.value"] == ["40", "45"]

    removed = seeded.delete(f"{url}/{added['id']}").json()
    assert removed["specs"] == [] and removed["history"][0]["action"] == "spec_delete"
    assert seeded.delete(f"{url}/{added['id']}").status_code == 404


def test_deleted_solution_takes_specs_along(seeded):
    before = count(SolutionSpec)
    unit_specs = len(seeded.get(f"{BASE}/{UNIT}").json()["specs"])
    seeded.delete(f"{BASE}/{UNIT}")
    assert count(SolutionSpec) == before - unit_specs
    assert count(CatalogChange) >= 2


@pytest.mark.skipif(not ORGANIZER_FILE.exists(), reason="Выгрузки организатора нет в репозитории, она лежит у команды")
def test_real_organizer_file_loads_cleanly(seeded):
    result = upload(seeded, ORGANIZER_FILE.read_bytes()).json()
    assert result["rows"] == 223 and result["errors"] == []
    # 223 строки после склейки по номеру и цене дают 190 позиций (журнал решений)
    assert result["merged"] == 33
    assert count(Solution) == 190
    assert result["added"] + result["updated"] + result["unchanged"] == 190


def test_manual_edit_survives_reimport_and_can_be_reset(seeded):
    content = csv_file(row(UNIT, "Unit", price="2 300 000,00"))
    upload(seeded, content)

    edited = seeded.patch(f"{BASE}/{UNIT}", json={"price_rub": "1990000", "process": "Уборка складов"}).json()
    assert edited["manual_fields"] == ["price_rub"], "процесс наш, а не организатора: его не помечаем"
    assert edited["organizer_values"]["price_rub"] == "2300000.00"

    again = upload(seeded, content).json()
    assert again["kept"] == 1 and again["updated"] == 0
    assert seeded.get(f"{BASE}/{UNIT}").json()["price_rub"] == "1990000.00"

    back = seeded.post(f"{BASE}/{UNIT}/reset/price_rub").json()
    assert back["price_rub"] == "2300000.00" and back["manual_fields"] == []
    assert back["history"][0]["action"] == "reset"
    assert seeded.post(f"{BASE}/{UNIT}/reset/price_rub").status_code == 404


def test_reset_before_any_import_explains_why_not(seeded):
    seeded.patch(f"{BASE}/{UNIT}", json={"trl": 5})
    response = seeded.post(f"{BASE}/{UNIT}/reset/trl")
    assert response.status_code == 409 and "загрузите выгрузку" in response.json()["detail"]


def test_team_solution_has_no_manual_marks(seeded):
    pudu = seeded.post(BASE, json={"name": "PuduBot 2"}).json()
    edited = seeded.patch(f"{BASE}/{pudu['id']}", json={"price_rub": "900000"}).json()
    assert edited["manual_fields"] == []
