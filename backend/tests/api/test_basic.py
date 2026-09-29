from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_answers_even_without_database(monkeypatch):
    monkeypatch.setattr("app.api.health.database_is_up", lambda: False)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": False}
