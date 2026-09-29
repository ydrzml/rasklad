"""Общий обработчик ошибок: понятный ответ по-русски и запись в лог (app/errors.py)."""

import logging

import pytest
from fastapi.testclient import TestClient

from app.errors import SERVER_FAILED
from app.main import app
from app.services import calculation

# Как в работе: ошибку сервера клиент получает ответом, а не исключением в тесте
client = TestClient(app, raise_server_exceptions=False)


def test_unknown_robot_is_not_found_without_quotes():
    response = client.post("/api/calculations/preview", json={"robot_id": "нет-такого"})
    assert response.status_code == 404
    assert response.json()["detail"] == "Не нашли нет-такого в справочнике"


def test_bug_in_code_is_server_error_not_not_found(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture):
    """Проверяем, что опечатка в ключе конфига не отвечает 404 "Не найдено" и попадает в лог."""

    def broken(_):
        return {}["нет такого ключа"]

    monkeypatch.setattr(calculation, "calculate", broken)
    with caplog.at_level(logging.ERROR, logger="app"):
        response = client.post("/api/calculations/preview", json={})
    assert response.status_code == 500
    assert response.json()["detail"] == SERVER_FAILED
    assert "POST /api/calculations/preview" in caplog.text
    assert "KeyError" in caplog.text


def test_field_errors_are_in_russian():
    response = client.post("/api/calculations/preview", json={"overrides": {"economics.inflation": "abc"}})
    assert response.status_code == 422
    [error] = response.json()["detail"]
    assert error["msg"] == "overrides.economics.inflation: нужно число"
    assert error["loc"] == ["body", "overrides", "economics.inflation"]


def test_own_russian_message_stays_as_written():
    response = client.post("/api/auth/register", json={"email": "ivan@example.com", "password": "123"})
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "Пароль нужен не короче 8 символов"
