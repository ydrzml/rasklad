"""Регистрация с кодом из письма: включается, когда настроена почта. Настоящих писем не шлем."""

import re
import smtplib
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.api import auth as auth_api
from app.auth import signup
from app.db import get_session
from app.main import app
from app.services import mail
from app.settings import settings
from app.storage.models import PendingSignup, User

IVAN = {"email": "Ivan@Example.com", "password": "correct-horse"}


@pytest.fixture
def letters(monkeypatch) -> list:
    sent: list = []
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_user", "rasklad@example.com")
    monkeypatch.setattr(mail, "deliver", sent.append)
    monkeypatch.setattr(mail, "domain_accepts_mail", lambda email: True)
    return sent


def database():
    return next(app.dependency_overrides[get_session]())


def code_of(letter) -> str:
    return re.search(r"\b(\d{6})\b", letter.get_body(("plain",)).get_content()).group(1)


def test_code_comes_and_account_appears_only_after_it(db_client, letters):
    answer = db_client.post("/api/auth/register", json=IVAN)
    assert answer.status_code == 202
    assert answer.json() == {"email": "ivan@example.com", "minutes": signup.CODE_MINUTES}
    # аккаунта и входа еще нет
    assert "set-cookie" not in answer.headers
    assert db_client.get("/api/auth/me").json()["role"] == "guest"
    assert database().scalars(select(User)).all() == []
    (letter,) = letters
    assert letter["To"] == "ivan@example.com"
    code = code_of(letter)
    assert code in letter["Subject"]

    done = db_client.post("/api/auth/register/confirm", json={"email": IVAN["email"], "code": code})
    assert done.status_code == 201
    assert done.json()["email"] == "ivan@example.com"
    assert db_client.get("/api/auth/me").json()["role"] == "user"
    db_client.post("/api/auth/logout")
    assert db_client.post("/api/auth/login", json=IVAN).status_code == 200
    # заявка ушла, по старому коду второй раз не войти
    assert database().scalars(select(PendingSignup)).all() == []
    again = db_client.post("/api/auth/register/confirm", json={"email": IVAN["email"], "code": code})
    assert again.status_code == 400


def test_wrong_code_five_times_needs_a_new_one(db_client, letters):
    db_client.post("/api/auth/register", json=IVAN)
    code = code_of(letters[0])
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(signup.MAX_ATTEMPTS):
        answer = db_client.post("/api/auth/register/confirm", json={"email": IVAN["email"], "code": wrong})
        assert answer.status_code == 400
        assert "проверьте цифры" in answer.json()["detail"]
    # даже верный код уже не примем: перебрать миллион вариантов по пять нельзя
    late = db_client.post("/api/auth/register/confirm", json={"email": IVAN["email"], "code": code})
    assert late.status_code == 400
    assert "Запросите новый" in late.json()["detail"]


def test_code_expires(db_client, letters):
    old = datetime.now(UTC) - timedelta(minutes=signup.CODE_MINUTES + 1)
    code = signup.start(database(), IVAN["email"], IVAN["password"], now=old)
    answer = db_client.post("/api/auth/register/confirm", json={"email": IVAN["email"], "code": code})
    assert answer.status_code == 400


def test_new_code_replaces_the_old_one(db_client, letters):
    db_client.post("/api/auth/register", json=IVAN)
    db_client.post("/api/auth/register", json={**IVAN, "password": "another-horse"})
    first, second = (code_of(letter) for letter in letters)
    if first != second:
        old = db_client.post("/api/auth/register/confirm", json={"email": IVAN["email"], "code": first})
        assert old.status_code == 400
    new = db_client.post("/api/auth/register/confirm", json={"email": IVAN["email"], "code": second})
    assert new.status_code == 201
    db_client.post("/api/auth/logout")
    # действует пароль из последней заявки
    assert db_client.post("/api/auth/login", json={**IVAN, "password": "another-horse"}).status_code == 200


def test_taken_email_gets_no_code(db_client, letters, monkeypatch):
    monkeypatch.setattr(settings, "smtp_host", "")
    db_client.post("/api/auth/register", json=IVAN)
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    taken = db_client.post("/api/auth/register", json=IVAN)
    assert taken.status_code == 409
    assert "уже зарегистрирована" in taken.json()["detail"]
    assert letters == []


def test_domain_without_mail_is_refused_before_sending(db_client, letters, monkeypatch):
    monkeypatch.setattr(mail, "domain_accepts_mail", lambda email: False)
    answer = db_client.post("/api/auth/register", json={**IVAN, "email": "ivan@gmial.con"})
    assert answer.status_code == 422
    assert "после @" in answer.json()["detail"]
    assert letters == []


def test_codes_to_one_email_and_letters_from_the_server_are_limited(db_client, letters, monkeypatch):
    for _ in range(auth_api.SIGNUP_CODES):
        assert db_client.post("/api/auth/register", json=IVAN).status_code == 202
    stop = db_client.post("/api/auth/register", json=IVAN)
    assert stop.status_code == 429
    assert "Спам" in stop.json()["detail"]

    monkeypatch.setattr(auth_api, "LETTERS_PER_WINDOW", auth_api.SIGNUP_CODES + 2)
    for index in range(2):
        other = {**IVAN, "email": f"u{index}@example.com"}
        assert db_client.post("/api/auth/register", json=other).status_code == 202
    # на сервере кончились письма: ни регистрации, ни ссылки на новый пароль
    assert db_client.post("/api/auth/register", json={**IVAN, "email": "u9@example.com"}).status_code == 429
    assert db_client.post("/api/auth/forgot", json={"email": "u9@example.com"}).status_code == 429
    assert len(letters) == auth_api.SIGNUP_CODES + 2


def test_failed_letter_is_reported_to_the_person(db_client, letters, monkeypatch):
    def broken(message):
        raise smtplib.SMTPServerDisconnected("gone")

    monkeypatch.setattr(mail, "deliver", broken)
    answer = db_client.post("/api/auth/register", json=IVAN)
    assert answer.status_code == 503
    assert "Не получилось отправить" in answer.json()["detail"]


def test_without_mail_registration_logs_in_at_once(db_client):
    # почта не настроена: код не дошел бы, поэтому как раньше, аккаунт сразу
    assert not mail.configured()
    answer = db_client.post("/api/auth/register", json=IVAN)
    assert answer.status_code == 201
    assert db_client.get("/api/auth/me").json()["role"] == "user"


def test_code_is_stored_only_as_a_fingerprint(db_client, letters):
    db_client.post("/api/auth/register", json=IVAN)
    code = code_of(letters[0])
    (pending,) = database().scalars(select(PendingSignup)).all()
    assert code not in pending.code_hash
    assert IVAN["password"] not in pending.password_hash


def test_code_letter_keeps_house_style():
    letter = mail.signup_letter("ivan@example.com", "123456", 15)
    text = letter.get_body(("plain",)).get_content() + letter.get_body(("html",)).get_content()
    assert "123456" in text
    assert "15 минут" in text
    for marker in ("\u0451", "\u2014", "\u00ab"):
        assert marker not in text
