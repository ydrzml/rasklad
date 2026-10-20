"""Забыли пароль: письмо со ссылкой, новый пароль по ней, лимит писем, режим без почты.
Настоящих писем не шлем: отправку подменяем и смотрим, что ушло бы."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.reset import issue_reset_token
from app.db import get_session
from app.main import app
from app.services import mail
from app.settings import settings
from app.storage.models import MailOutbox

IVAN = {"email": "ivan@example.com", "password": "correct-horse"}
NEW = "brand-new-secret"


@pytest.fixture
def letters(monkeypatch) -> list:
    """Почта настроена, письма копятся в списке вместо отправки."""
    sent: list = []
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_user", "rasklad@example.com")
    monkeypatch.setattr(settings, "site_url", "https://rasklad.example")
    monkeypatch.setattr(mail, "deliver", sent.append)
    return sent


def database() -> Session:
    return next(app.dependency_overrides[get_session]())


def sign_up() -> None:
    # Аккаунт сразу, без кода из письма: здесь проверяем только новый пароль
    service.register(database(), IVAN["email"], IVAN["password"])


def token_of(letter) -> str:
    text = letter.get_body(("plain",)).get_content()
    link = next(line for line in text.splitlines() if "/login/reset#" in line)
    return link.split("#", 1)[1]


def test_letter_comes_and_link_sets_a_new_password(db_client, letters):
    sign_up()
    db_client.post("/api/auth/logout")

    answer = db_client.post("/api/auth/forgot", json={"email": " Ivan@Example.com "})
    assert answer.status_code == 200
    assert answer.json()["minutes"] == settings.reset_minutes
    assert len(letters) == 1
    letter = letters[0]
    assert letter["To"] == "ivan@example.com"
    assert "rasklad@example.com" in letter["From"]
    assert letter["Subject"] == mail.SUBJECT
    # ссылка ведет на адрес из настроек, а не на тот, что прислали в запросе
    assert "https://rasklad.example/login/reset#" in letter.get_body(("plain",)).get_content()
    assert "Задать новый пароль" in letter.get_body(("html",)).get_content()

    done = db_client.post("/api/auth/reset", json={"token": token_of(letter), "new_password": NEW})
    assert done.status_code == 200
    assert done.json()["email"] == "ivan@example.com"
    # сразу вошел
    assert db_client.get("/api/auth/me").json()["role"] == "user"
    db_client.post("/api/auth/logout")
    assert db_client.post("/api/auth/login", json=IVAN).status_code == 401
    assert db_client.post("/api/auth/login", json={**IVAN, "password": NEW}).status_code == 200


def test_link_works_once_and_old_links_die_with_it(db_client, letters):
    sign_up()
    db_client.post("/api/auth/forgot", json={"email": IVAN["email"]})
    db_client.post("/api/auth/forgot", json={"email": IVAN["email"]})
    first, second = (token_of(letter) for letter in letters)

    assert db_client.post("/api/auth/reset", json={"token": first, "new_password": NEW}).status_code == 200
    for token in (first, second):
        again = db_client.post("/api/auth/reset", json={"token": token, "new_password": "other-secret-1"})
        assert again.status_code == 400
        assert "Запросите новую" in again.json()["detail"]


def test_link_expires(db_client):
    sign_up()
    user = service.find_by_email(database(), IVAN["email"])
    old = datetime.now(UTC) - timedelta(minutes=settings.reset_minutes + 1)
    token = issue_reset_token(user.id, user.password_hash, now=old)
    assert db_client.post("/api/auth/reset", json={"token": token, "new_password": NEW}).status_code == 400


def test_answer_is_the_same_for_unknown_email(db_client, letters):
    sign_up()
    known = db_client.post("/api/auth/forgot", json={"email": IVAN["email"]})
    unknown = db_client.post("/api/auth/forgot", json={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()
    assert [letter["To"] for letter in letters] == ["ivan@example.com"]


def test_demo_accounts_get_no_letter(db_client, letters):
    service.ensure_demo_accounts(database())
    for email in (settings.demo_user_email, settings.demo_admin_email):
        assert db_client.post("/api/auth/forgot", json={"email": email}).status_code == 200
    assert letters == []


def test_too_many_letters_to_one_email_wait(db_client, letters):
    sign_up()
    for _ in range(3):
        assert db_client.post("/api/auth/forgot", json={"email": IVAN["email"]}).status_code == 200
    stop = db_client.post("/api/auth/forgot", json={"email": IVAN["email"]})
    assert stop.status_code == 429
    assert "Спам" in stop.json()["detail"]
    assert len(letters) == 3
    # незнакомая почта упирается в тот же лимит: по нему не узнать, зарегистрирован ли адрес
    for _ in range(3):
        db_client.post("/api/auth/forgot", json={"email": "nobody@example.com"})
    assert db_client.post("/api/auth/forgot", json={"email": "nobody@example.com"}).status_code == 429


def test_reset_lifts_the_login_lock(db_client, letters):
    sign_up()
    db_client.post("/api/auth/logout")
    for _ in range(10):
        db_client.post("/api/auth/login", json={**IVAN, "password": "wrong-password"})
    assert db_client.post("/api/auth/login", json=IVAN).status_code == 429
    db_client.post("/api/auth/forgot", json={"email": IVAN["email"]})
    db_client.post("/api/auth/reset", json={"token": token_of(letters[0]), "new_password": NEW})
    db_client.post("/api/auth/logout")
    assert db_client.post("/api/auth/login", json={**IVAN, "password": NEW}).status_code == 200


def test_new_password_from_link_cannot_be_trivial(db_client, letters):
    sign_up()
    db_client.post("/api/auth/forgot", json={"email": IVAN["email"]})
    weak = db_client.post("/api/auth/reset", json={"token": token_of(letters[0]), "new_password": "12345678"})
    assert weak.status_code == 422


def test_without_mail_the_link_waits_in_the_admin_table(db_client, monkeypatch):
    monkeypatch.setattr(settings, "smtp_host", "")
    called: list = []
    monkeypatch.setattr(mail, "deliver", called.append)
    sign_up()
    db_client.post("/api/auth/logout")

    assert db_client.post("/api/auth/forgot", json={"email": IVAN["email"]}).status_code == 200
    assert db_client.post("/api/auth/forgot", json={"email": "nobody@example.com"}).status_code == 200
    assert called == []
    (kept,) = database().scalars(select(MailOutbox)).all()
    assert kept.to_email == "ivan@example.com"
    token = kept.link.split("#", 1)[1]
    assert db_client.post("/api/auth/reset", json={"token": token, "new_password": NEW}).status_code == 200


def test_failed_sending_is_logged_without_address_and_link(db_client, monkeypatch, caplog):
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")

    def broken(message):
        raise OSError("connection refused for ivan@example.com")

    monkeypatch.setattr(mail, "deliver", broken)
    sign_up()
    with caplog.at_level("ERROR", logger="app"):
        assert db_client.post("/api/auth/forgot", json={"email": IVAN["email"]}).status_code == 200
    assert "не ушло" in caplog.text
    assert "ivan@example.com" not in caplog.text
    assert "/login/reset" not in caplog.text


def test_letter_escapes_the_address_and_keeps_house_style():
    letter = mail.reset_letter('a"<b>@example.com', "https://rasklad.example/login/reset#abc")
    html = letter.get_body(("html",)).get_content()
    assert "<b>" not in html
    text = letter.get_body(("plain",)).get_content()
    assert f"{settings.reset_minutes} минут" in text
    # без буквы е с точками, длинного тире и кавычек-елочек
    for marker in ("\u0451", "\u2014", "\u00ab"):
        assert marker not in text + html
