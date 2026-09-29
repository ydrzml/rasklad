"""Импорт на файлах, которые ломали сервер: раздутая область листа, nan и inf, CSV без разделителя,
пустой штат, смены из файла вместе с правками человека."""

import json
import re
import time
import zipfile
from io import BytesIO

from fastapi.testclient import TestClient
from openpyxl import Workbook

from app.main import app

client = TestClient(app)
VOLUME = "facilities.warehouse.operations.pallet_transport.volume_per_day"
SHIFTS = "facilities.warehouse.schedule.shifts"
SHIFT_HOURS = "facilities.warehouse.schedule.shift_hours"


def upload(content: bytes, name: str, **form):
    return client.post("/api/import", files={"file": (name, content)}, data={"facility_id": "warehouse", **form})


def csv_rows(*rows: str) -> bytes:
    return "\n".join(["Код;Параметр;Значение;Единица", *rows]).encode("utf-8")


def test_sheet_that_claims_a_huge_area_is_read_quickly():
    book = Workbook()
    book.active.append(["Код", "Значение"])
    book.active.append([VOLUME, 2500])
    out = BytesIO()
    book.save(out)
    # файл сам объявляет область на 16384 колонки и 2000 строк: 32 млн пустых ячеек
    source, bloated = zipfile.ZipFile(out), BytesIO()
    with zipfile.ZipFile(bloated, "w") as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                data = re.sub(rb'<dimension ref="[^"]+"', b'<dimension ref="A1:XFD2000"', data)
            target.writestr(item, data)
    started = time.monotonic()
    response = upload(bloated.getvalue(), "big.xlsx")
    assert response.status_code == 200, response.text
    assert time.monotonic() - started < 10
    assert response.json()["overrides"] == {VOLUME: 2500}


def test_nan_and_inf_are_not_numbers():
    for word in ("nan", "inf", "-inf", "Infinity"):
        response = upload(csv_rows(f"{VOLUME};;{word};паллет/сут"), "file.csv")
        assert response.status_code == 200, (word, response.text)
        result = response.json()
        assert result["overrides"] == {}, word
        assert result["rows"][0]["message"] == "Не число", word


def test_nan_in_manual_overrides_is_refused():
    body = '{"overrides": {"' + VOLUME + '": NaN}}'
    response = client.post("/api/calculations/preview", content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422, response.text


def test_csv_without_delimiter_says_what_is_missing():
    response = upload("Параметр\nabc\n".encode(), "one.csv")
    assert response.status_code == 200, response.text
    assert "колонки" in response.json()["rows"][0]["message"]


def test_empty_staff_sheet_keeps_the_staff():
    text = "Роль;Мест в штате;Занято людьми;Оклад в месяц, руб;Люди подрядчика (да/нет)\n"
    only_head = upload(text.encode(), "staff.csv").json()
    assert only_head["staff"] is None
    typos = upload((text + "Опертор погрузчка;5;5;60000;нет\n").encode(), "staff.csv").json()
    assert typos["staff"] is None
    assert any("оставили штат" in row["message"] for row in typos["rows"])


def test_shift_hours_from_file_are_checked_with_shifts_typed_by_hand():
    thirteen = csv_rows(f"{SHIFT_HOURS};;13;ч")
    # у человека одна смена: 13 часов в сутки это нормально
    alone = upload(thirteen, "file.csv", overrides=json.dumps({SHIFTS: 1})).json()
    assert alone["overrides"] == {SHIFT_HOURS: 13}
    # у человека три смены, в файле по 10 ч: 30 часов в сутки не подставляем
    ten = upload(csv_rows(f"{SHIFT_HOURS};;10;ч"), "file.csv", overrides=json.dumps({SHIFTS: 3})).json()
    assert ten["overrides"] == {}
    assert ten["rows"][0]["status"] == "error"


def test_broken_overrides_field_is_refused():
    assert upload(csv_rows(), "file.csv", overrides="не json").status_code == 422
