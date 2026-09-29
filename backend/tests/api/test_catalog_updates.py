"""Автообновление характеристик: проверка страниц производителей, предложения правки и журнал."""

import pytest
from sqlalchemy import select

from app.db import get_session
from app.main import app
from app.services import catalog_import, catalog_updates, catalog_uses
from app.storage.models import CatalogChange, SolutionSpec

BASE = "/api/admin/updates"
H1500 = "5760e938-9a43-45a7-b8e8-f4f2e6383930"
H1500_PAGE = "https://ronavi-robotics.ru/catalogue/h1500"


def session():
    return next(app.dependency_overrides[get_session]())


@pytest.fixture
def admin(db_client, monkeypatch):
    db_client.post("/api/auth/demo", json={"role": "admin"})
    s = session()
    catalog_import.seed_team_catalog(s)
    catalog_uses.seed_uses(s)
    monkeypatch.setattr(catalog_updates, "sessions", session)
    monkeypatch.setattr(catalog_updates, "PAUSE_S", 0)
    return db_client


def web(monkeypatch, pages: dict[str, str]):
    """Интернет понарошку: известные адреса отдают страницу, остальные отвечают 404."""

    def fetch(url):
        if url in pages:
            return pages[url]
        raise catalog_updates.Failed("сайт ответил 404")

    monkeypatch.setattr(catalog_updates, "fetch", fetch)


def spec(field="payload_kg"):
    return session().scalar(select(SolutionSpec).where(SolutionSpec.solution_id == H1500, SolutionSpec.field == field))


def set_payload(client, value):
    card = client.get(f"/api/admin/catalog/{H1500}").json()
    spec_id = next(s["id"] for s in card["specs"] if s["field"] == "payload_kg")
    assert client.patch(f"/api/admin/catalog/{H1500}/specs/{spec_id}", json={"value": value}).status_code == 200


def run(client, source="saved"):
    started = client.post(f"{BASE}/run", params={"source": source})
    assert started.status_code == 202
    return client.get(BASE).json()


def proposals(data):
    return [i for i in data["items"] if i["outcome"] == "differs"]


def test_saved_pages_confirm_our_values(admin):
    data = run(admin)
    assert not data["run"]["running"]
    assert data["run"]["done"] == data["run"]["total"] == data["run"]["saved_pages"] == 3
    assert data["run"]["counts"] == {"same": 20, "differs": 0, "manual": 2, "blocked": 0}
    assert not proposals(data)
    assert session().scalar(select(CatalogChange).where(CatalogChange.action == "updates_check")) is not None


def test_changed_value_becomes_a_proposal_and_accept_writes_source_and_journal(admin):
    set_payload(admin, "1000")
    found = proposals(run(admin))
    assert len(found) == 1
    item = found[0]
    assert (item["field"], item["current"], item["proposed"], item["status"]) == ("payload_kg", "1000", "1500", "new")
    assert item["url"] == H1500_PAGE
    # каталог сам не поменялся
    assert spec().value == "1000"

    accepted = admin.post(f"{BASE}/{item['id']}/accept", json={"value": "1500", "rating": "C"})
    assert accepted.status_code == 200 and accepted.json()["status"] == "accepted"
    after = spec()
    assert (after.value, after.rating, after.source_type) == ("1500", "C", "производитель")
    assert after.source.split("\n")[0] == H1500_PAGE
    assert "1500" in after.quote and after.retrieved is not None
    log = session().scalar(select(CatalogChange).where(CatalogChange.action == "update_accept"))
    assert log.changes["payload_kg.value"] == ["1000", "1500"] and H1500_PAGE in log.note

    # подбор видит принятое значение без перезапуска
    solutions = admin.get("/api/catalog/solutions", params={"operation": "pallet_transport"}).json()
    assert any(s["id"] == H1500 for s in solutions)
    # следующая проверка уже совпадает
    assert not [i for i in proposals(run(admin)) if i["status"] == "new"]


def test_rejected_proposal_is_not_offered_again(admin):
    set_payload(admin, "1000")
    item = proposals(run(admin))[0]
    assert admin.post(f"{BASE}/{item['id']}/reject").json()["status"] == "rejected"
    assert spec().value == "1000"
    again = proposals(run(admin))[0]
    assert again["status"] == "rejected"


def test_second_run_waits_for_the_first(admin):
    assert catalog_updates.start("saved")
    try:
        busy = admin.post(f"{BASE}/run", params={"source": "saved"})
        assert busy.status_code == 409 and "уже идет" in busy.json()["detail"]
    finally:
        catalog_updates.run("saved")
    assert admin.post(f"{BASE}/run", params={"source": "saved"}).status_code == 202


def test_web_page_with_new_number_and_closed_site(admin, monkeypatch):
    page = "<table><tr><td>Грузоподъемность</td><td>до 1 800 кг</td></tr><tr><td>Вес</td><td>250 кг</td></tr></table>"
    web(
        monkeypatch,
        {
            H1500_PAGE: page,
            "https://waybotrobotics.com/robots.txt": "User-agent: *\nDisallow: /",
        },
    )
    data = run(admin, "web")
    assert data["run"]["source"] == "web" and not data["run"]["offline"]
    by_field = {i["field"]: i for i in data["items"] if i["url"] == H1500_PAGE}
    assert by_field["payload_kg"]["outcome"] == "differs" and by_field["payload_kg"]["proposed"] == "1800"
    assert by_field["robot_mass_kg"]["outcome"] == "same"
    closed = [i for i in data["items"] if i["url"].startswith("https://waybotrobotics.com/")]
    assert closed and all(i["outcome"] == "blocked" for i in closed)
    assert all(i["outcome"] == "manual" for i in data["items"] if i["url"].endswith(".pdf"))


def test_without_internet_the_run_stops_and_offers_saved_pages(admin, monkeypatch):
    def offline(url):
        raise catalog_updates.Offline("нет сети")

    monkeypatch.setattr(catalog_updates, "fetch", offline)
    data = run(admin, "web")
    assert data["run"]["offline"] and "сохраненным страницам" in data["run"]["message"]
    assert data["run"]["done"] < data["run"]["total"]


def test_page_text_and_units():
    text = catalog_updates.page_text(
        "<div><script>var x = 5</script><p>3 часа</p><p>Время работы без подзарядки</p><p>1 час</p></div>"
    )
    assert "var" not in text
    target = catalog_updates.Target("x", "runtime_h", "u", "Время работы без подзарядки 3 часа", "3", "3")
    # значение стоит перед подписью, а после нее число другой строки: берем то, что совпало с цитатой
    assert catalog_updates.check(target, text, "3").outcome == "same"
    minutes = catalog_updates.Target("x", "runtime_h", "u", "Время работы мин 240", "4", "4")
    found = catalog_updates.check(minutes, "Время работы мин 300", "4")
    assert (found.outcome, found.proposed) == ("differs", "5")


def test_only_admin_checks_updates(db_client):
    assert db_client.get(BASE).status_code == 401
    db_client.post("/api/auth/demo", json={"role": "user"})
    assert db_client.post(f"{BASE}/run").status_code == 403
