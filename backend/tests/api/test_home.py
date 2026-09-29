"""Главная: новости каталога для вошедшего и числа для администратора."""

from app.services import catalog_import, catalog_uses
from tests.api.test_catalog_uses import session

BASE = "/api/admin/catalog"
H1500 = "5760e938-9a43-45a7-b8e8-f4f2e6383930"


def test_news_need_login(db_client):
    assert db_client.get("/api/catalog/news").status_code == 401


def test_news_tell_what_changed_in_catalog_without_emails(db_client):
    db_client.post("/api/auth/demo", json={"role": "admin"})
    s = session()
    catalog_import.seed_team_catalog(s)
    catalog_uses.seed_uses(s)

    new = db_client.post(BASE, json={"name": "PuduBot 2", "company": "Pudu", "status": "operation"}).json()
    db_client.put(f"{BASE}/{new['id']}/uses/clinic/floor_delivery", json={"status": "confirmed"})
    db_client.patch(f"{BASE}/{H1500}", json={"price_rub": "3100000"})
    card = db_client.get(f"{BASE}/{H1500}").json()
    payload = next(spec["id"] for spec in card["specs"] if spec["field"] == "payload_kg")
    db_client.patch(f"{BASE}/{H1500}/specs/{payload}", json={"value": "1600"})

    news = db_client.get("/api/catalog/news").json()
    texts = {(item["kind"], item["title"], item["text"]) for item in news}
    assert ("spec", card["name"], "Грузоподъемность 1500 → 1600 кг") in texts
    assert ("price", card["name"], "Цена 2,7 млн ₽ → 3,1 млн ₽, поправил администратор") in texts
    assert ("task", "PuduBot 2", "Теперь в подборе: Медучреждение, доставка по этажам") in texts
    assert ("new", "PuduBot 2", "Новое решение в каталоге") in texts
    # свежие сверху, служебного первого запуска и почты нет
    assert news[0]["kind"] == "spec"
    assert all("@" not in item["text"] for item in news)
    assert not any("Первый запуск" in item["text"] for item in news)


def test_stats_for_admin_only(db_client):
    assert db_client.get("/api/admin/stats").status_code == 401
    db_client.post("/api/auth/demo", json={"role": "user"})
    assert db_client.get("/api/admin/stats").status_code == 403
    db_client.post("/api/auth/demo", json={"role": "admin"})
    stats = db_client.get("/api/admin/stats").json()
    assert stats["users"] >= 2 and stats["projects"] >= 0 and stats["versions"] >= 0
    # по дням: две недели, сегодня последним, демо-аккаунты заведены сегодня
    assert len(stats["days"]) == 14
    assert stats["days"][-1]["users"] >= 2
