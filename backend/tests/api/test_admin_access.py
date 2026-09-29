"""Каждая точка админки закрыта ролью администратора. Список точек берем из описания API самого
приложения, а не пишем руками: новая точка без require_admin уронит тест, даже если про нее забыли здесь."""

import re

from app.main import app
from tests.api.test_projects import IVAN, sign_in


def calls() -> list[tuple[str, str]]:
    # Вместо {номер} подставляем любое значение: до разбора номера сервер должен отказать по роли
    return [
        (method.upper(), re.sub(r"\{[^}]+\}", "1", path))
        for path, methods in app.openapi()["paths"].items()
        if path.startswith("/api/admin")
        for method in methods
    ]


def test_admin_routes_are_found():
    # Если админку переименуют, тест ниже молча проверял бы пустой список
    assert len(calls()) >= 10


def test_guest_gets_401_and_user_403_everywhere_in_admin(db_client):
    for method, url in calls():
        response = db_client.request(method, url)
        assert response.status_code == 401, (method, url, response.status_code)

    sign_in(db_client, IVAN)
    for method, url in calls():
        response = db_client.request(method, url)
        assert response.status_code == 403, (method, url, response.status_code)
