"""Чертеж DXF как подложка: единицы и габарит, слои, отказы и защита от чужого файла.

Чертежи делаем в тесте сами, настоящих файлов с открытой лицензией нет."""

from __future__ import annotations

import io
import re
import threading
import time
from pathlib import Path

import ezdxf
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import dxf_underlay

client = TestClient(app)
NGINX = Path(__file__).resolve().parents[3] / "frontend" / "nginx.conf"
PATH_TEXT = re.compile(r"^[Ml0-9. \-]*$")


def dxf_bytes(doc) -> bytes:
    out = io.StringIO()
    doc.write(out)
    return out.getvalue().encode("utf-8")


def warehouse(units: int | None = 4, scale: float = 1000.0):
    """Склад 60 на 36 м: стены, шесть рядов, ряд из вставок блока, ворота, размеры и надпись.
    scale: единиц чертежа в метре (1000 для миллиметров)"""
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 0 if units is None else units  # 0: единицы в файле не записаны
    for name in ("СТЕНЫ_КОНТУР", "RACK-ZONE", "A-DOOR", "Layer 1", "DIM"):
        doc.layers.add(name)
    block = doc.blocks.new("STELL")
    # слой 0 внутри блока это слой вставки
    block.add_lwpolyline([(0, 0), (2.7 * scale, 0), (2.7 * scale, 1.1 * scale), (0, 1.1 * scale)], close=True)
    msp = doc.modelspace()
    w, h = 60 * scale, 36 * scale
    msp.add_lwpolyline([(0, 0), (w, 0), (w, h), (0, h)], close=True, dxfattribs={"layer": "СТЕНЫ_КОНТУР"})
    for i in range(5):
        x = (6 + i * 8) * scale
        msp.add_line((x, 0), (x + 3.6 * scale, 0), dxfattribs={"layer": "A-DOOR"})
    for r in range(6):
        y = (10 + r * 4.6) * scale
        msp.add_lwpolyline(
            [(8 * scale, y), (48 * scale, y), (48 * scale, y + 2.2 * scale), (8 * scale, y + 2.2 * scale)],
            close=True,
            dxfattribs={"layer": "RACK-ZONE"},
        )
    for k in range(12):
        msp.add_blockref("STELL", ((8 + k * 2.7) * scale, 31 * scale), dxfattribs={"layer": "Layer 1"})
    msp.add_line((0, -2 * scale), (w, -2 * scale), dxfattribs={"layer": "DIM"})
    msp.add_text("60", dxfattribs={"layer": "DIM", "height": 0.4 * scale}).set_placement((30 * scale, -1.8 * scale))
    return doc


def upload(content: bytes, name: str = "sklad.dxf"):
    return client.post("/api/plan/dxf", files={"file": (name, content, "application/octet-stream")})


def layers_of(response) -> dict:
    return {one["name"]: one for one in response.json()["layers"]}


def test_millimetre_drawing_gives_units_size_and_layers():
    response = upload(dxf_bytes(warehouse()))

    assert response.status_code == 200
    body = response.json()
    assert body["units"]["factor_m"] == 0.001 and body["units"]["source"] == "file"
    assert body["width"] == pytest.approx(60000, abs=1)
    assert body["height"] == pytest.approx(38000, abs=1)  # вместе с размерной линией под стеной
    layers = layers_of(response)
    assert layers["СТЕНЫ_КОНТУР"]["role"] == "walls" and layers["СТЕНЫ_КОНТУР"]["on"]
    assert layers["RACK-ZONE"]["role"] == "racks" and layers["RACK-ZONE"]["lines"] == 6
    assert layers["A-DOOR"]["role"] == "doors" and layers["A-DOOR"]["lines"] == 5
    assert layers["DIM"]["role"] == "noise" and layers["DIM"]["on"] is False and layers["DIM"]["texts"] == 1
    # вставки блока рисуются на слое вставки, а не на слое 0
    assert layers["Layer 1"]["lines"] == 12 and "0" not in layers


def test_layer_boxes_and_paths_are_plain_numbers_in_drawing_units():
    layers = layers_of(upload(dxf_bytes(warehouse())))

    walls = layers["СТЕНЫ_КОНТУР"]
    assert walls["box"] == pytest.approx([0, 2000, 60000, 38000], abs=1)  # ноль чертежа ниже размерной линии
    for one in layers.values():
        assert PATH_TEXT.match(one["d"]), one["name"]


def test_units_missing_in_file_are_guessed_from_building_size():
    millimetres = upload(dxf_bytes(warehouse(units=None)))
    metres = upload(dxf_bytes(warehouse(units=None, scale=1.0)))

    assert millimetres.json()["units"]["factor_m"] == 0.001 and millimetres.json()["units"]["source"] == "guess"
    assert metres.json()["units"]["factor_m"] == 1.0 and metres.json()["units"]["source"] == "guess"


def test_units_from_file_win_over_size():
    centimetres = upload(dxf_bytes(warehouse(units=5, scale=100.0)))

    assert centimetres.json()["units"]["factor_m"] == 0.01 and centimetres.json()["units"]["source"] == "file"


def test_lost_object_far_away_does_not_stretch_the_drawing():
    doc = warehouse()
    doc.modelspace().add_line((9_000_000, 9_000_000), (9_000_500, 9_000_500), dxfattribs={"layer": "Layer 1"})

    body = upload(dxf_bytes(doc)).json()

    assert body["width"] == pytest.approx(60000, abs=1) and body["far_away"] == 1


def test_dwg_is_refused_with_a_way_out():
    for name in ("sklad.dxf", "sklad.dwg"):
        response = upload(b"AC1027\x00\x00\x00\x00\x00\x00\x00\x00" + b"\x00" * 200, name)
        assert response.status_code == 415
        assert "DWG" in response.json()["detail"] and "DXF" in response.json()["detail"]


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("plan.pdf", b"%PDF-1.7 ..."),
        ("plan.dxf", b"just some text, not a drawing"),
        ("plan.dxf", b"\x89PNG\r\n\x1a\n" + b"\x00" * 100),
        ("plan.dxf", b"AutoCAD Binary DXF\r\n\x1a\x00" + b"\x00" * 100),
        ("plan.png", b"0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"),
        ("plan.dxf", b""),
    ],
)
def test_not_a_dxf_is_refused(name, content):
    assert upload(content, name).status_code == 415


def test_broken_file_gets_a_plain_message():
    broken = b"0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\nabc\n"

    response = upload(broken, "plan.dxf")

    assert response.status_code == 422
    assert "Traceback" not in response.text and "нет линий" in response.json()["detail"]


def test_drawing_with_only_text_is_refused():
    doc = ezdxf.new("R2010")
    doc.modelspace().add_text("штамп")

    response = upload(dxf_bytes(doc))

    assert response.status_code == 422 and "нет линий" in response.json()["detail"]


def test_big_file_is_refused_before_reading(monkeypatch):
    monkeypatch.setattr(dxf_underlay, "MAX_BYTES", 1000)

    response = upload(dxf_bytes(warehouse()))

    detail = response.json()["detail"]
    assert response.status_code == 413 and "больше 80 МБ" in detail and "только нужные слои" in detail


def test_slow_parse_is_stopped(monkeypatch):
    monkeypatch.setattr(dxf_underlay, "TIMEOUT_S", 0.001)

    response = upload(dxf_bytes(warehouse()))

    assert response.status_code == 422 and "слишком долго" in response.json()["detail"]


def test_busy_server_answers_429_and_frees_the_place(monkeypatch):
    monkeypatch.setattr(dxf_underlay, "_slots", threading.BoundedSemaphore(0))
    assert upload(dxf_bytes(warehouse())).status_code == 429
    monkeypatch.setattr(dxf_underlay, "_slots", threading.BoundedSemaphore(1))
    assert upload(dxf_bytes(warehouse())).status_code == 200
    assert dxf_underlay._slots.acquire(blocking=False)  # место вернулось после разбора


def _points(d: str) -> list[list[tuple[float, float]]]:
    """Путь обратно в точки: M с точкой, дальше l со сдвигами от предыдущей"""
    lines = []
    for part in d.split("M")[1:]:
        start, _, moves = part.partition("l")
        x, y = map(float, start.split())
        line = [(x, y)]
        numbers = list(map(float, moves.split()))
        for dx, dy in zip(numbers[::2], numbers[1::2], strict=True):
            x, y = x + dx, y + dy
            line.append((x, y))
        lines.append(line)
    return lines


def test_path_points_come_back_to_drawing_coordinates():
    layers = layers_of(upload(dxf_bytes(warehouse())))

    (walls,) = _points(layers["СТЕНЫ_КОНТУР"]["d"])
    # ноль в левом верхнем углу чертежа, y вниз: верх стены на нуле, низ на 36 м
    assert walls == [(0, 36000), (60000, 36000), (60000, 0), (0, 0), (0, 36000)]


def test_blocks_turned_scaled_and_nested_land_where_autocad_puts_them():
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    doc.layers.add("WALLS")
    doc.layers.add("RACKS")
    inner = doc.blocks.new("CELL", base_point=(100, 0))
    inner.add_line((100, 0), (1100, 0))  # слой 0: берет слой вставки
    outer = doc.blocks.new("ROW")
    outer.add_blockref("CELL", (0, 0))
    outer.add_blockref("CELL", (0, 500), dxfattribs={"layer": "RACKS"})
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (40000, 0), (40000, 20000), (0, 20000)], close=True, dxfattribs={"layer": "WALLS"})
    msp.add_blockref("ROW", (10000, 10000), dxfattribs={"layer": "WALLS", "rotation": 90, "xscale": 2, "yscale": 2})
    grid = msp.add_blockref("CELL", (20000, 2000), dxfattribs={"layer": "RACKS"})
    grid.grid(size=(2, 3), spacing=(1000, 2000))  # MINSERT: 2 ряда через 1000 по y, 3 колонки через 2000 по x

    layers = layers_of(upload(dxf_bytes(doc)))

    walls = sorted(_points(layers["WALLS"]["d"]), key=len)
    # отрезок 1000 вдоль x, повернут на 90 и растянут вдвое: 2000 вверх от (10000, 10000), y вниз от 20000
    assert walls[0] == [(10000, 10000), (10000, 8000)]
    assert layers["RACKS"]["lines"] == 1 + 6
    # вложенная ячейка: (0..2000, 1000) после поворота встает на x 9000, y 10000..12000; сетка до x 25000, y 3000
    assert layers["RACKS"]["box"] == pytest.approx([9000, 2000, 25000, 12000], abs=1)


def test_drawing_too_detailed_for_the_answer_gets_a_coarser_grid(monkeypatch):
    from app.services import dxf_worker

    # кривая из тысячи точек с шагом 1 мм на чертеже в 100 м
    lines = {"A": [[(x, (x % 7) * 0.5) for x in range(1000)], [(0, 0), (100_000, 50_000)]]}
    fine = dxf_worker._paths(lines, 0, 50_000, 100_000)
    monkeypatch.setattr(dxf_worker, "MAX_PATH_BYTES", len(fine["A"]) - 1)

    rough = dxf_worker._paths(lines, 0, 50_000, 100_000)

    assert len(rough["A"]) < len(fine["A"])
    # длинная линия осталась на месте, мелочь слилась в одну клетку сетки
    assert _points(rough["A"])[-1] == [(0, 50_000), (100_000, 0)]


def test_layer_name_is_only_text_never_part_of_the_path():
    doc = warehouse()
    doc.layers.add("img src 'q' & a")
    doc.modelspace().add_line((0, 0), (10, 10), dxfattribs={"layer": "img src 'q' & a"})

    layers = layers_of(upload(dxf_bytes(doc)))

    assert "img src 'q' & a" in layers
    assert all(PATH_TEXT.match(one["d"]) for one in layers.values())


def test_large_drawing_with_tens_of_thousands_of_objects():
    """Склад на тысячу пятьсот рядов по двадцать секций: тридцать тысяч объектов"""
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    doc.layers.add("RACKS")
    msp = doc.modelspace()
    for row in range(1500):
        for col in range(20):
            x, y = col * 2800, row * 4600
            msp.add_lwpolyline(
                [(x, y), (x + 2700, y), (x + 2700, y + 1100), (x, y + 1100)], close=True, dxfattribs={"layer": "RACKS"}
            )
    content = dxf_bytes(doc)
    assert 2_000_000 < len(content) <= dxf_underlay.MAX_BYTES

    started = time.monotonic()
    response = upload(content)

    assert response.status_code == 200
    assert response.json()["layers"][0]["lines"] == 30000
    assert time.monotonic() - started < dxf_underlay.TIMEOUT_S


def _dxf_location(text: str) -> str:
    found = re.search(r"location ~ \^/api/plan/dxf\S* \{(.*?)\n    \}", text, re.S)
    assert found, "в nginx.conf нет своего места для чертежа DXF"
    return found.group(1)


def test_only_dxf_point_takes_big_body_and_keeps_rate_limit():
    text = NGINX.read_text(encoding="utf-8")
    place = _dxf_location(text)

    assert "client_max_body_size 81m;" in place and "limit_req zone=heavy" in place
    assert "error_page 429 = @too_many;" in place and "error_page 413 = @dxf_too_large;" in place
    # весь остальной сайт как был: 11 МБ, большой предел нигде больше не стоит
    assert re.search(r"^    client_max_body_size 11m;", text, re.M)
    assert text.count("client_max_body_size") == 2
    pattern = re.compile(re.search(r"location ~ (\S+) \{", text[text.index("location ~ ^/api/plan/dxf") :]).group(1))
    assert pattern.match("/api/plan/dxf") and pattern.match("/api/plan/dxf/build")
    assert not pattern.match("/api/plan/dxf/other") and not pattern.match("/api/plan/import")


def test_size_limit_is_the_same_on_server_screen_and_nginx():
    mb = dxf_underlay.MAX_MB
    screen = (Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "plan" / "dxf.ts").read_text("utf-8")

    assert f"export const DXF_MAX_MB = {mb};" in screen
    assert dxf_underlay.TOO_LARGE in NGINX.read_text(encoding="utf-8")
    assert f"client_max_body_size {mb + 1}m;" in _dxf_location(NGINX.read_text(encoding="utf-8"))


def test_big_file_gets_longer_time_but_not_longer_than_nginx_waits():
    mb = 1024 * 1024

    assert dxf_underlay.timeout_s(2 * mb) == dxf_underlay.TIMEOUT_S
    assert 100 < dxf_underlay.timeout_s(61 * mb) < dxf_underlay.MAX_TIMEOUT_S
    assert dxf_underlay.timeout_s(dxf_underlay.MAX_BYTES) == dxf_underlay.MAX_TIMEOUT_S < 180


def test_two_big_drawings_are_not_parsed_at_once(monkeypatch):
    monkeypatch.setattr(dxf_underlay, "BIG_BYTES", 1000)
    monkeypatch.setattr(dxf_underlay, "_big", threading.BoundedSemaphore(1))
    assert dxf_underlay._big.acquire(blocking=False)  # другой большой чертеж уже разбирается

    response = upload(dxf_bytes(warehouse()))

    assert response.status_code == 429
    assert dxf_underlay._slots.acquire(blocking=False)  # общее место вернулось
    dxf_underlay._slots.release()
    dxf_underlay._big.release()
    assert upload(dxf_bytes(warehouse())).status_code == 200
