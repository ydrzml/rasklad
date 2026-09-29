"""Нормативы в админке: правка идет в расчет сразу и пишется в журнал, вернуть значение из файла
можно одной кнопкой, файл проверяется по строкам, выгрузка загружается обратно без изменений."""

import csv
import io

import pytest
from openpyxl import load_workbook

from app.db import get_session
from app.main import app
from app.services import norms, selection, versions
from tests.api.test_projects import IVAN, sign_in

BASE = "/api/admin/norms"
RATE = "economics.discount_rate"
HOURS = "economics.annual_work_hours"
SHIFTS = "facilities.warehouse.schedule.shifts"
SHIFT_HOURS = "facilities.warehouse.schedule.shift_hours"
AVAILABILITY = "engine.simulation.availability"
LEGAL = {"source": "Ключевая ставка ЦБ 18%, решение 24.10.2026", "date": "2026-10", "trust": "C"}


def session():
    return next(app.dependency_overrides[get_session]())


@pytest.fixture
def admin(db_client, monkeypatch):
    """Админ на пустой базе, расчет читает правки из нее же."""
    db_client.post("/api/auth/demo", json={"role": "admin"})
    monkeypatch.setattr(selection, "sessions", session)
    norms.forget()
    selection.forget()
    yield db_client
    norms.forget()
    selection.forget()


def norm(client, code):
    return next(n for n in client.get(BASE).json()["items"] if n["code"] == code)


def purchase(client):
    response = client.post("/api/calculations/preview", json={})
    assert response.status_code == 200, response.text
    result = response.json()
    return result, next(s for s in result["scenarios"] if s["id"] == "purchase")


def upload(client, rows, name="normativy.csv", dry_run=False):
    out = io.StringIO()
    csv.writer(out, delimiter=";").writerows([norms.HEAD, *rows])
    response = client.post(
        f"{BASE}/import",
        params={"dry_run": dry_run},
        files={"file": (name, out.getvalue().encode("utf-8"), "text/csv")},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_list_has_value_unit_source_and_effect_but_no_engine_constants(admin):
    listing = admin.get(BASE).json()
    codes = {n["code"] for n in listing["items"]}
    assert {RATE, HOURS, SHIFTS, AVAILABILITY, "economics.payroll.insurance_rate"} <= codes
    # технические константы движка и параметры роботов не открыты
    assert not any(c.startswith("robots.") for c in codes)
    assert "engine.simulation.robots_per_aisle" not in codes
    rate = norm(admin, RATE)
    assert rate["unit"] == "доля в год" and rate["trust"] == "C" and rate["source"] and rate["effect"]
    assert rate["edited"] is None and rate["file"]["value"] == rate["value"]
    assert norm(admin, AVAILABILITY)["name"] == "Доля парка в строю после ТО и поломок"


def test_user_and_guest_cannot_see_or_edit_norms(db_client):
    assert db_client.get(BASE).status_code == 401
    sign_in(db_client, IVAN)
    assert db_client.get(BASE).status_code == 403
    assert db_client.put(f"{BASE}/{RATE}", json={"value": 0.2, **LEGAL}).status_code == 403
    assert db_client.post(f"{BASE}/import", files={"file": ("a.csv", b"x", "text/csv")}).status_code == 403


def test_edit_changes_calculation_sources_journal_and_data_version(admin):
    before, buy = purchase(admin)
    version = versions.data_version()

    response = admin.put(f"{BASE}/{RATE}", json={"value": 0.18, **LEGAL})
    assert response.status_code == 200, response.text
    edited = response.json()
    assert edited["value"] == 0.18 and edited["edited"]["by"] == "admin@example.com"
    assert edited["file"]["value"] == 0.14

    # расчет берет новое значение без перезапуска: дороже деньги, меньше приведенная стоимость
    after, buy_after = purchase(admin)
    assert buy_after["npv_rub"] < buy["npv_rub"]
    source = next(s for s in after["sources"] if s["path"] == RATE)
    assert source["value"] == 0.18
    assert source["source"].startswith("Норматив, правил администратор admin@example.com")
    assert source["date"] == "2026-10" and source["trust"] == "C"

    [change] = admin.get(f"{BASE}/changes").json()
    assert change["action"] == "edit" and change["path"] == RATE
    assert change["changes"]["value"] == [0.14, 0.18]
    assert versions.data_version() != version

    # вернуть из файла: значение, источник и версия данных прежние
    back = admin.delete(f"{BASE}/{RATE}").json()
    assert back["value"] == 0.14 and back["edited"] is None
    assert purchase(admin)[1]["npv_rub"] == buy["npv_rub"]
    assert versions.data_version() == version
    assert admin.get(f"{BASE}/changes").json()[0]["action"] == "reset"
    assert before["sources"] == purchase(admin)[0]["sources"]


def test_edit_back_to_file_value_removes_override(admin):
    admin.put(f"{BASE}/{RATE}", json={"value": 0.18, **LEGAL})
    file = norm(admin, RATE)["file"]
    response = admin.put(f"{BASE}/{RATE}", json=file)
    assert response.json()["edited"] is None
    assert [c["action"] for c in admin.get(f"{BASE}/changes").json()] == ["reset", "edit"]


def test_bad_values_are_refused_with_reason(admin):
    cases = [
        (RATE, {"value": 1.5, **LEGAL}, "допустимо от 0 до 1"),
        (SHIFTS, {"value": 2.5, **LEGAL}, "целое"),
        (SHIFT_HOURS, {"value": 13, **LEGAL}, "в сутках 24"),
        (RATE, {"value": 0.2, "source": "ЦБ", "date": None, "trust": "C"}, "должна быть дата"),
        (RATE, {"value": 0.2, "source": "ЦБ", "date": "октябрь", "trust": "C"}, "ГГГГ-ММ"),
    ]
    for path, body, reason in cases:
        response = admin.put(f"{BASE}/{path}", json=body)
        assert response.status_code == 422, (path, body)
        assert reason.lower() in str(response.json()["detail"]).lower(), response.json()
    assert admin.put(f"{BASE}/robots.ronavi-h1500.utilization", json={"value": 0.7, **LEGAL}).status_code == 404
    assert admin.get(f"{BASE}/changes").json() == []


def test_import_reports_every_row_and_writes_only_good_ones(admin):
    rows = [
        [RATE, "Ставка", "0,18", "доля в год", LEGAL["source"], "2026-10", "C"],
        ["economics.payroll.insurance_rate", "Взносы", "30", "%", "НК РФ ст. 425", "2026-09", "S"],
        [HOURS, "Часы", "много", "ч в год", "календарь", "2026-09", "S"],
        ["robots.ronavi-h1500.price_rub", "Цена", "1", "₽", "КП", "2026-09", "C"],
        [SHIFTS, "Смены", "2", "часов", "датасет", "2026-09", "D"],
        [SHIFT_HOURS, "Смена", "13", "ч", "датасет", "2026-09", "D"],
        ["economics.inflation", "Инфляция", "0,05", "доля в год", "ЦБ", "", "C"],
        [AVAILABILITY, "В строю", "0,9", "доля", norm(admin, AVAILABILITY)["source"], "", "F"],
    ]
    checked = upload(admin, rows, dry_run=True)
    assert checked["dry_run"] and checked["applied"] == 2
    assert norm(admin, RATE)["edited"] is None  # проверка ничего не пишет

    report = upload(admin, rows)
    statuses = [(r["row"], r["status"]) for r in report["rows"]]
    assert statuses == [
        (2, "ok"),
        (3, "warn"),
        (4, "error"),
        (5, "error"),
        (6, "error"),
        (7, "error"),
        (8, "error"),
        (9, "ok"),
    ]
    messages = [r["message"] for r in report["rows"]]
    assert "процент" in messages[1]
    assert "числом" in messages[2]
    assert "не открыт" in messages[3]
    assert "Единица" in messages[4]
    assert "в сутках 24" in messages[5]
    assert "дата" in messages[6]
    assert messages[7] == "Без изменений"
    assert (report["applied"], report["unchanged"], report["errors"]) == (2, 1, 5)

    assert norm(admin, RATE)["value"] == 0.18
    assert norm(admin, "economics.payroll.insurance_rate")["value"] == 0.3
    assert {c["action"] for c in admin.get(f"{BASE}/changes").json()} == {"import"}


def test_export_uploaded_back_changes_nothing(admin):
    admin.put(f"{BASE}/{RATE}", json={"value": 0.18, **LEGAL})
    content = admin.get(f"{BASE}/export").content
    rows = list(csv.reader(io.StringIO(content.decode("utf-8-sig")), delimiter=";"))
    assert rows[0] == norms.HEAD
    rate = next(row for row in rows if row[0] == RATE)
    assert rate[2] == "0,18" and rate[6] == "C"

    report = admin.post(f"{BASE}/import", files={"file": ("normativy.csv", content, "text/csv")}).json()
    assert report["errors"] == 0 and report["applied"] == 0
    assert report["unchanged"] == len(rows) - 1
    assert len(admin.get(f"{BASE}/changes").json()) == 1

    book = admin.get(f"{BASE}/export", params={"format": "xlsx"}).content
    sheet = load_workbook(io.BytesIO(book)).active
    assert [c.value for c in sheet[1]] == norms.HEAD
    again = admin.post(
        f"{BASE}/import",
        files={"file": ("normativy.xlsx", book, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    ).json()
    assert again["errors"] == 0 and again["applied"] == 0


def test_row_equal_to_file_removes_override(admin):
    admin.put(f"{BASE}/{RATE}", json={"value": 0.18, **LEGAL})
    file = norm(admin, RATE)["file"]
    report = upload(admin, [[RATE, "", "0,14", "доля в год", file["source"], file["date"], file["trust"]]])
    assert report["rows"][0]["status"] == "warn" and "снимется" in report["rows"][0]["message"]
    assert norm(admin, RATE)["edited"] is None


def test_file_without_header_is_refused(admin):
    response = admin.post(f"{BASE}/import", files={"file": ("a.csv", "просто текст".encode(), "text/csv")})
    assert response.status_code == 415
