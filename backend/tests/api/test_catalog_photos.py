import pytest
from sqlalchemy import func, select

from app.db import get_session
from app.main import app
from app.services import catalog_import, catalog_photos
from app.settings import settings
from app.storage.models import SolutionPhoto

BASE = "/api/admin/catalog"
UNIT = "9b20417a-0ac7-4786-985b-f3459a15075d"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 64


def session():
    return next(app.dependency_overrides[get_session]())


def photos() -> int:
    return session().scalar(select(func.count()).select_from(SolutionPhoto))


@pytest.fixture
def admin(db_client):
    db_client.post("/api/auth/demo", json={"role": "admin"})
    catalog_import.seed_team_catalog(session())
    return db_client


def put(client, content: bytes, name="robot.png", **meta):
    return client.put(f"{BASE}/{UNIT}/photo", files={"file": (name, content, "image/png")}, data=meta)


def test_upload_shows_in_card_list_and_for_everyone(admin):
    card = put(admin, PNG, source_url="https://yacuai.com/ru/unit/", owner="Яку Роботикс", license="пресс-кит").json()
    photo = card["photo"]
    assert photo["content_type"] == "image/png" and photo["owner"] == "Яку Роботикс"
    assert card["photo_url"] == photo["url"] and photo["url"].startswith(f"/api/catalog/photos/{UNIT}?v=")
    assert card["history"][0]["action"] == "photo_set"

    row = next(r for r in admin.get(BASE, params={"search": "Unit"}).json()["items"] if r["id"] == UNIT)
    assert row["photo_url"] == photo["url"]

    admin.post("/api/auth/logout")
    image = admin.get(f"/api/catalog/photos/{UNIT}")
    assert image.status_code == 200 and image.content == PNG and image.headers["content-type"] == "image/png"


def test_replace_edit_meta_and_delete(admin):
    put(admin, PNG)
    replaced = put(admin, WEBP, name="robot.webp").json()
    assert replaced["photo"]["content_type"] == "image/webp" and photos() == 1

    edited = admin.patch(f"{BASE}/{UNIT}/photo", json={"license": "разрешение по письму от 25.09"}).json()
    assert edited["photo"]["license"] == "разрешение по письму от 25.09"
    assert edited["history"][0]["action"] == "photo_edit"

    removed = admin.delete(f"{BASE}/{UNIT}/photo").json()
    assert removed["photo"] is None and removed["photo_url"] is None and photos() == 0
    assert admin.get(f"/api/catalog/photos/{UNIT}").status_code == 404
    assert admin.delete(f"{BASE}/{UNIT}/photo").status_code == 404


def test_not_an_image_or_too_big_is_refused(admin):
    fake = put(admin, b"<html>not a picture</html>", name="photo.png")
    assert fake.status_code == 415 and "не картинка" in fake.json()["detail"].lower()
    big = put(admin, PNG + b"\x00" * catalog_photos.MAX_BYTES)
    assert big.status_code == 415 and "5 МБ" in big.json()["detail"]
    assert photos() == 0


def test_only_admin_uploads(db_client):
    catalog_import.seed_team_catalog(session())
    db_client.post("/api/auth/demo", json={"role": "user"})
    assert put(db_client, PNG).status_code == 403


def test_photo_goes_away_with_solution(admin):
    put(admin, PNG)
    admin.delete(f"{BASE}/{UNIT}")
    assert photos() == 0


def test_photos_from_data_folder_are_picked_up_once(admin, tmp_path, monkeypatch):
    folder = tmp_path / "catalog" / "photos"
    folder.mkdir(parents=True)
    (folder / f"{UNIT}.webp").write_bytes(WEBP)
    (folder / "не-решение.webp").write_bytes(WEBP)
    (folder / "sources.csv").write_text(
        "solution_id;product;file;source_url;owner;license;permission;retrieved;note\n"
        f"{UNIT};Unit;{UNIT}.webp;https://yacuai.com/ru/unit/;Яку Роботикс;пресс-кит;можно в проекте;2026-09-24;\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "data_dir", tmp_path)

    assert catalog_photos.seed_photos(session()) == 1
    assert catalog_photos.seed_photos(session()) == 0, "повторный запуск ничего не задваивает"
    photo = admin.get(f"{BASE}/{UNIT}").json()["photo"]
    assert photo["owner"] == "Яку Роботикс" and photo["license"] == "пресс-кит можно в проекте"


def test_photo_by_organizer_number_reaches_every_configuration(admin, tmp_path, monkeypatch):
    # У нашего Unit в выгрузке две цены: вторая комплектация получает свой номер, а фото общее.
    # Снимок достается ей сразу при загрузке выгрузки, без перезапуска сервера
    folder = tmp_path / "catalog" / "photos"
    folder.mkdir(parents=True)
    (folder / f"{UNIT}.webp").write_bytes(WEBP)
    monkeypatch.setattr(settings, "data_dir", tmp_path)

    header = "id;Название;тип;статус;компания;описание;Тип;Подтип;Сценарий;Кейсы;УГТ;Рын Потенциал;Регион;Отрасль;Цена изделия"
    rows = [
        f"{UNIT};Unit;brs;operation;Яку;;;;Уборка помещений;;9;;Москва;Торговля;{price}"
        for price in ("2 300 000,00", "2 900 000,00")
    ]
    content = ("﻿" + "\n".join([header, *rows]) + "\n").encode("utf-8")
    admin.post(f"{BASE}/import", files={"file": ("c.csv", content, "text/csv")})

    variants = [v for v in admin.get(BASE, params={"search": "Unit"}).json()["items"] if v["organizer_id"] == UNIT]
    assert len(variants) == 2 and all(v["photo_url"] for v in variants)
    assert catalog_photos.seed_photos(session()) == 0, "при запуске сервера снимки не задваиваются"
