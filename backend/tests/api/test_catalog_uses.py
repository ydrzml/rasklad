import csv
from pathlib import Path

import pytest
from sqlalchemy import select

from app.db import get_session
from app.main import app
from app.services import catalog_import, catalog_uses
from app.storage.models import SolutionUse
from tests.api.test_admin_catalog import BASE, csv_file, row, upload

MARK2 = "446c5207-a099-45e0-b615-afd60de08589"  # уборщик: склад, аэропорт и больница
RONAVI_SR = "3f2aaa1b-2237-4d7b-b215-1ac5ec789ed5"  # сортировщик
NEW = "11111111-2222-3333-4444-555555555555"
DRONE = "66666666-2222-3333-4444-555555555555"


def session():
    return next(app.dependency_overrides[get_session]())


@pytest.fixture
def admin(db_client):
    db_client.post("/api/auth/demo", json={"role": "admin"})
    s = session()
    catalog_import.seed_team_catalog(s)
    catalog_uses.seed_uses(s)
    return db_client


def card(client, solution_id):
    return client.get(f"{BASE}/{solution_id}").json()


def uses(data):
    return {(u["facility"], u["operation"]): u["status"] for u in data["uses"]}


def test_our_solutions_are_bound_from_data(admin):
    mark2 = card(admin, MARK2)
    assert uses(mark2) == {
        ("warehouse", "cleaning"): "confirmed",
        ("airport", "cleaning"): "confirmed",
        ("clinic", "cleaning"): "confirmed",
    }
    assert mark2["facilities"] == ["warehouse", "airport", "clinic"]
    assert uses(card(admin, RONAVI_SR)) == {("warehouse", "sorting"): "confirmed"}


def test_seed_twice_changes_nothing(admin):
    before = len(session().scalars(select(SolutionUse)).all())
    assert catalog_uses.seed_uses(session()) == 0
    assert len(session().scalars(select(SolutionUse)).all()) == before


def test_missing_counts_only_what_operations_need(admin):
    sr = card(admin, RONAVI_SR)
    needs = catalog_uses.BY_KEY[("warehouse", "sorting")].needs
    assert sr["needs_total"] == len(needs)
    assert set(sr["missing"]) <= set(needs)
    assert sr["needs_filled"] == sr["needs_total"] - len(sr["missing"])


def test_rule_suggests_by_scenario_and_skips_other_industries(admin):
    report = upload(
        admin,
        csv_file(
            row(NEW, "Новый уборщик", scenario="Уборка помещений"),
            row(DRONE, "Дрон", kind="bas", scenario="Мониторинг теплотрасс"),
        ),
    ).json()
    assert report["suggested"] == 3
    new = card(admin, NEW)
    assert set(uses(new).values()) == {"suggested"}
    assert set(uses(new)) == {("warehouse", "cleaning"), ("airport", "cleaning"), ("clinic", "cleaning")}
    assert new["facilities"] == [] and new["to_check"] == 3
    assert card(admin, DRONE)["uses"] == []


def test_rule_leaves_checked_solutions_alone(admin):
    upload(admin, csv_file(row(RONAVI_SR, "Ronavi SR", scenario="Внутрискладская логистика")))
    assert uses(card(admin, RONAVI_SR)) == {("warehouse", "sorting"): "confirmed"}


def test_lifting_subtype_adds_stacking():
    class Fake:
        scenario = "Внутрискладская логистика"
        subtype = "Робот-штабелер"

    found = {(f, o) for f, o, _ in catalog_uses.suggestions(Fake())}
    assert found == {("warehouse", "pallet_transport"), ("warehouse", "stacking")}


def test_admin_confirms_rejects_and_rule_does_not_return(admin):
    upload(admin, csv_file(row(NEW, "Новый уборщик", scenario="Уборка помещений")))
    url = f"{BASE}/{NEW}/uses"
    admin.put(f"{url}/warehouse/cleaning", json={"status": "confirmed"})
    data = admin.put(f"{url}/clinic/cleaning", json={"status": "rejected", "note": "не для больниц"}).json()
    assert uses(data)[("warehouse", "cleaning")] == "confirmed"
    assert uses(data)[("clinic", "cleaning")] == "rejected"
    assert data["facilities"] == ["warehouse"]
    assert data["history"][0]["action"] == "use_set"

    upload(admin, csv_file(row(NEW, "Новый уборщик", scenario="Уборка помещений")))
    assert uses(card(admin, NEW))[("clinic", "cleaning")] == "rejected"


def test_admin_adds_use_by_hand_and_unknown_is_404(admin):
    data = admin.put(f"{BASE}/{RONAVI_SR}/uses/clinic/floor_delivery", json={"status": "confirmed"}).json()
    assert uses(data)[("clinic", "floor_delivery")] == "confirmed"
    assert admin.put(f"{BASE}/{RONAVI_SR}/uses/clinic/teleport", json={"status": "confirmed"}).status_code == 404
    assert admin.put(f"{BASE}/nope/uses/clinic/cleaning", json={"status": "confirmed"}).status_code == 404


def test_list_filters_and_facets(admin):
    upload(
        admin,
        csv_file(
            row(NEW, "Новый уборщик", scenario="Уборка помещений"),
            row(DRONE, "Дрон", kind="bas", scenario="Мониторинг теплотрасс"),
        ),
    )
    page = admin.get(BASE, params={"limit": 300}).json()
    facets = page["facets"]
    assert facets["none"] == 1 and facets["to_check"] == 1
    assert facets["warehouse"] == 32  # 31 наших и новый уборщик с предложением

    def names(params):
        return {i["name"] for i in admin.get(BASE, params={"limit": 300, **params}).json()["items"]}

    assert names({"facility": "none"}) == {"Дрон"}
    assert names({"to_check": "true"}) == {"Новый уборщик"}
    assert "MARK 2 SE" in names({"facility": "airport"})
    incomplete = admin.get(BASE, params={"limit": 300, "incomplete": "true"}).json()
    assert incomplete["total"] == facets["incomplete"]
    assert all(i["needs_filled"] < i["needs_total"] for i in incomplete["items"])


def test_operations_list(admin):
    ops = admin.get(f"{BASE}/operations").json()
    assert {o["facility"] for o in ops} == {"warehouse", "airport", "clinic"}
    assert all(o["needs"] for o in ops)


def test_real_organizer_file_binds_about_a_third():
    """Сверка правила с настоящей выгрузкой: сколько позиций привяжется. Файла в репозитории нет."""
    path = Path(__file__).resolve().parents[3] / "data" / "organizer" / "catalog_export_v4.csv"
    if not path.exists():
        pytest.skip("выгрузки организатора нет на этой машине")

    class Row:
        def __init__(self, r):
            self.scenario, self.subtype = r["Сценарий"], r["Подтип"]

    rows = list(csv.DictReader(path.open(encoding="utf-8-sig"), delimiter=";"))
    bound = {r["id"] for r in rows if catalog_uses.suggestions(Row(r))}
    assert 40 <= len(bound) <= 70


def test_airport_solution_from_our_list_is_confirmed_after_import(admin):
    """Тягача для аэропорта нет среди 31 складского: он появляется только с выгрузкой организатора."""
    tug = "28a5afa8-0473-4f80-99a9-b2922b76810f"
    report = upload(admin, csv_file(row(tug, "Беспилотный тягач", scenario="Перевозка грузов"))).json()
    assert report["note"] and uses(card(admin, tug)) == {("airport", "baggage_transport"): "confirmed"}
    assert card(admin, tug)["facilities"] == ["airport"]
