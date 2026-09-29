from typing import Annotated

import jwt
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient

from app.auth import throttle, tokens
from app.auth.dependencies import require_admin, require_user
from app.auth.tokens import issue_token
from app.main import app
from app.settings import settings
from app.storage.models import User

# Две закрытые точки только для проверки ролей: настоящие появятся вместе с проектами и админкой
probe = APIRouter(prefix="/api/test-access")


@probe.get("/user")
def only_user(user: Annotated[User, Depends(require_user)]) -> str:
    return user.email


@probe.get("/admin")
def only_admin(user: Annotated[User, Depends(require_admin)]) -> str:
    return user.email


app.include_router(probe)

IVAN = {"email": "Ivan@Example.com", "password": "correct-horse"}


def me(client: TestClient) -> dict:
    return client.get("/api/auth/me").json()


def test_guest_is_answered_without_login(db_client):
    assert me(db_client) == {"role": "guest", "email": None, "name": "", "company": "", "demo": False}


def test_register_logs_in_and_keeps_password_secret(db_client):
    response = db_client.post("/api/auth/register", json=IVAN)
    assert response.status_code == 201
    assert response.json() == {"role": "user", "email": "ivan@example.com", "name": "", "company": "", "demo": False}
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert "correct-horse" not in response.text
    assert me(db_client)["email"] == "ivan@example.com"


def test_same_email_cannot_register_twice(db_client):
    db_client.post("/api/auth/register", json=IVAN)
    again = db_client.post("/api/auth/register", json={**IVAN, "email": "ivan@example.com"})
    assert again.status_code == 409


def test_short_password_and_bad_email_are_rejected(db_client):
    # форма входа показывает сообщение сервера человеку, поэтому оно по-русски
    short = db_client.post("/api/auth/register", json={**IVAN, "password": "123"})
    assert short.status_code == 422
    assert short.json()["detail"][0]["msg"] == "Пароль нужен не короче 8 символов"
    bad = db_client.post("/api/auth/register", json={**IVAN, "email": "not-an-email"})
    assert bad.status_code == 422
    assert bad.json()["detail"][0]["msg"] == "Почта записана с ошибкой, проверьте ее"


def test_login_and_logout(db_client):
    db_client.post("/api/auth/register", json=IVAN)
    db_client.post("/api/auth/logout")
    assert me(db_client)["role"] == "guest"

    assert db_client.post("/api/auth/login", json=IVAN).status_code == 200
    assert me(db_client)["role"] == "user"


def test_wrong_password_and_unknown_email_look_the_same(db_client):
    db_client.post("/api/auth/register", json=IVAN)
    db_client.post("/api/auth/logout")
    wrong = db_client.post("/api/auth/login", json={**IVAN, "password": "wrong-password"})
    unknown = db_client.post("/api/auth/login", json={**IVAN, "email": "nobody@example.com"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


def test_forged_or_foreign_token_means_guest(db_client):
    db_client.cookies.set("session", "not-a-token")
    assert me(db_client)["role"] == "guest"
    db_client.cookies.set("session", issue_token(user_id=999, password_hash="x"))
    assert me(db_client)["role"] == "guest"


def test_roles_guard_closed_pages(db_client):
    assert db_client.get("/api/test-access/user").status_code == 401

    db_client.post("/api/auth/demo", json={"role": "user"})
    assert db_client.get("/api/test-access/user").status_code == 200
    assert db_client.get("/api/test-access/admin").status_code == 403

    db_client.post("/api/auth/demo", json={"role": "admin"})
    assert db_client.get("/api/test-access/admin").status_code == 200


def test_demo_accounts_also_open_with_password(db_client):
    db_client.post("/api/auth/demo")
    db_client.post("/api/auth/logout")
    response = db_client.post("/api/auth/login", json={"email": "demo@example.com", "password": "demo12345"})
    assert response.json() == {"role": "user", "email": "demo@example.com", "name": "", "company": "", "demo": True}


def test_demo_login_can_be_switched_off(db_client, monkeypatch):
    monkeypatch.setattr(settings, "demo_login", False)
    assert db_client.post("/api/auth/demo", json={"role": "admin"}).status_code == 404
    assert me(db_client)["role"] == "guest"


def test_changed_demo_password_replaces_the_default_one(db_client, monkeypatch):
    db_client.post("/api/auth/demo")
    db_client.post("/api/auth/logout")
    monkeypatch.setattr(settings, "demo_user_password", "server-only-secret")
    db_client.post("/api/auth/demo")
    db_client.post("/api/auth/logout")

    old = db_client.post("/api/auth/login", json={"email": "demo@example.com", "password": "demo12345"})
    new = db_client.post("/api/auth/login", json={"email": "demo@example.com", "password": "server-only-secret"})
    assert old.status_code == 401
    assert new.status_code == 200


def test_password_guessing_is_stopped(db_client):
    db_client.post("/api/auth/register", json=IVAN)
    db_client.post("/api/auth/logout")
    for _ in range(throttle.MAX_FAILURES):
        assert db_client.post("/api/auth/login", json={**IVAN, "password": "wrong-password"}).status_code == 401

    blocked = db_client.post("/api/auth/login", json=IVAN)
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 0
    # Чужая почта при этом входит спокойно
    assert db_client.post("/api/auth/register", json={**IVAN, "email": "petr@example.com"}).status_code == 201


def test_guessing_counter_forgets_old_attempts():
    throttle.clear()
    for moment in range(throttle.MAX_FAILURES):
        throttle.record_failure("ivan@example.com", now=moment)
    assert throttle.seconds_to_wait("ivan@example.com", now=throttle.MAX_FAILURES) > 0
    assert throttle.seconds_to_wait("ivan@example.com", now=throttle.WINDOW_SECONDS + throttle.MAX_FAILURES) == 0


def test_successful_login_resets_the_counter(db_client):
    db_client.post("/api/auth/register", json=IVAN)
    db_client.post("/api/auth/logout")
    for _ in range(throttle.MAX_FAILURES - 1):
        db_client.post("/api/auth/login", json={**IVAN, "password": "wrong-password"})
    assert db_client.post("/api/auth/login", json=IVAN).status_code == 200
    assert db_client.post("/api/auth/login", json={**IVAN, "password": "wrong-password"}).status_code == 401


def test_account_is_deleted_only_with_password(db_client):
    assert db_client.request("DELETE", "/api/auth/me", json={"password": "correct-horse"}).status_code == 401

    db_client.post("/api/auth/register", json=IVAN)
    wrong = db_client.request("DELETE", "/api/auth/me", json={"password": "wrong-password"})
    assert wrong.status_code == 401
    assert me(db_client)["role"] == "user"

    assert db_client.request("DELETE", "/api/auth/me", json={"password": "correct-horse"}).json()["role"] == "guest"
    assert me(db_client)["role"] == "guest"
    assert db_client.post("/api/auth/login", json=IVAN).status_code == 401
    # Почта освободилась, можно зарегистрироваться заново
    assert db_client.post("/api/auth/register", json=IVAN).status_code == 201


def test_old_session_of_deleted_account_means_guest(db_client):
    db_client.post("/api/auth/register", json=IVAN)
    token = db_client.cookies["session"]
    db_client.request("DELETE", "/api/auth/me", json={"password": "correct-horse"})
    db_client.cookies.set("session", token)
    assert me(db_client)["role"] == "guest"


def test_without_configured_key_a_random_one_is_made_and_kept(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "session_secret", "")
    monkeypatch.setattr(tokens, "GENERATED_SECRET_FILE", tmp_path / "key")
    tokens.signing_key.cache_clear()
    try:
        first = tokens.signing_key()
        assert len(first) >= 32
        assert first != "local-development-only-change-me"
        tokens.signing_key.cache_clear()
        assert tokens.signing_key() == first
        # Токен, подписанный любым другим ключом, не принимается
        forged = jwt.encode({"sub": "1"}, "local-development-only-change-me", algorithm="HS256")
        assert tokens.read_token(forged) is None
    finally:
        tokens.signing_key.cache_clear()


def test_demo_account_cannot_be_deleted(db_client):
    # пароль демо лежит в docker-compose.yml, а войти в демо может любой одной кнопкой
    me_now = db_client.post("/api/auth/demo", json={"role": "user"}).json()
    assert me_now["demo"] is True
    response = db_client.request("DELETE", "/api/auth/me", json={"password": settings.demo_user_password})
    assert response.status_code == 403
    assert me(db_client)["role"] == "user"


def test_deleting_account_stops_after_many_wrong_passwords(db_client):
    db_client.post("/api/auth/register", json=IVAN)
    for _ in range(10):
        db_client.request("DELETE", "/api/auth/me", json={"password": "wrong-password"})
    blocked = db_client.request("DELETE", "/api/auth/me", json={"password": IVAN["password"]})
    assert blocked.status_code == 429
