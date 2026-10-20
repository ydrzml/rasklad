"""План по слоям чертежа DXF: здание, ряды, ворота, повороты, предупреждения и отказы.

Чертежи делаем в тесте сами, настоящих файлов склада с открытой лицензией нет."""

from __future__ import annotations

import json
import math
import time

import ezdxf
import pytest
from ezdxf.math import Matrix44
from fastapi.testclient import TestClient

from app.main import app
from app.services import dxf_underlay
from tests.api.test_dxf_underlay import dxf_bytes, warehouse

client = TestClient(app)
ROLES = {"СТЕНЫ_КОНТУР": "walls", "RACK-ZONE": "racks", "Layer 1": "racks", "A-DOOR": "doors"}


def build(doc_or_bytes, roles=None, unit=0.001, name="sklad.dxf"):
    content = doc_or_bytes if isinstance(doc_or_bytes, bytes) else dxf_bytes(doc_or_bytes)
    return client.post(
        "/api/plan/dxf/build",
        files={"file": (name, content, "application/octet-stream")},
        data={"roles": json.dumps(ROLES if roles is None else roles), "unit_m": str(unit)},
    )


def racks(body):
    return [i for i in body["items"] if i["kind"] == "racks"]


def docks(body):
    return [i for i in body["items"] if i["kind"] == "dock"]


def rect_doc(layers: dict[str, list[tuple[float, float, float, float]]], size=(60000, 36000), walls="WALL"):
    """Чертеж в миллиметрах: стены прямоугольником и прямоугольники по слоям"""
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    doc.layers.add(walls)
    msp.add_lwpolyline(
        [(0, 0), (size[0], 0), (size[0], size[1]), (0, size[1])], close=True, dxfattribs={"layer": walls}
    )
    for layer, boxes in layers.items():
        doc.layers.add(layer)
        for x, y, w, h in boxes:
            msp.add_lwpolyline(
                [(x, y), (x + w, y), (x + w, y + h), (x, y + h)], close=True, dxfattribs={"layer": layer}
            )
    return doc


def test_warehouse_becomes_building_rows_docks_and_buffer():
    response = build(warehouse())

    assert response.status_code == 200
    body = response.json()
    assert (body["width_m"], body["length_m"]) == (60, 36) and body["outline"] == [] and body["turn_deg"] == 0
    assert body["warnings"] == []
    # шесть рядов по 40 м и ряд из двенадцати секций блока, склеенных в один
    assert body["counts"] == {"racks": 7, "docks": 5, "buffers": 1}
    row = next(r for r in racks(body) if r["y"] == 10)
    assert (row["x"], row["w"], row["h"], row["rows"], row["row_m"]) == (8, 40, 2, "x", 2.0)
    block = next(r for r in racks(body) if r["y"] == 31)
    assert (block["x"], block["w"], block["h"]) == (8, 32, 1)


def test_docks_stand_on_the_wall_with_a_gap_and_the_buffer_behind_them():
    body = build(warehouse()).json()

    on_south = sorted(docks(body), key=lambda d: d["x"])
    assert all((d["y"], d["h"]) == (0, 1) for d in on_south)
    assert [(d["x"], d["w"]) for d in on_south] == [(6, 4), (14, 4), (22, 4), (30, 4), (38, 4)]
    buffer = next(i for i in body["items"] if i["kind"] == "buffer")
    assert (buffer["x"], buffer["w"], buffer["y"]) == (6, 36, 1) and buffer["y"] + buffer["h"] < 10


def test_everything_stands_on_whole_metres():
    body = build(warehouse()).json()

    for item in body["items"]:
        assert all(float(item[k]).is_integer() for k in ("x", "y", "w", "h"))


def test_the_engine_accepts_the_built_plan_and_counts_its_docks():
    body = build(warehouse()).json()
    plan = {
        "width_m": body["width_m"],
        "length_m": body["length_m"],
        "template": "custom",
        "edited": True,
        "sections": [{"id": "s1", "x": 0, "y": 0, "w": body["width_m"], "h": body["length_m"], "ceiling_m": 10}],
        "items": body["items"],
    }

    answer = client.post("/api/plan/measure", json=plan)

    assert answer.status_code == 200
    measures = answer.json()["measures"]
    assert measures["docks"] == 5 and measures["storage_m2"] > 0
    assert not [c for c in measures["checks"] if not c["ok"] and "Есть ворота" in c["label"]]


@pytest.mark.parametrize("turn", [30.0, 12.5])
def test_drawing_turned_as_a_whole_is_turned_back_along_the_walls(turn):
    doc = warehouse()
    matrix = Matrix44.z_rotate(math.radians(turn))
    for entity in doc.modelspace():
        entity.transform(matrix)

    body = build(doc).json()

    assert abs(body["width_m"] - 60) <= 1 and abs(body["length_m"] - 36) <= 1
    assert body["turn_deg"] == pytest.approx(turn, abs=0.3)
    assert len(racks(body)) == 7 and len(docks(body)) == 5
    assert any("повернут" in w for w in body["warnings"])


def test_a_single_tilted_rack_becomes_an_axis_rectangle_with_a_warning():
    doc = rect_doc({"RACK": [(8000, 10000, 40000, 2200)]})
    centre = (20000, 25000)
    rack = [(-5000, -1100), (5000, -1100), (5000, 1100), (-5000, 1100)]
    c, s = math.cos(math.radians(20)), math.sin(math.radians(20))
    points = [(centre[0] + x * c - y * s, centre[1] + x * s + y * c) for x, y in rack]
    doc.modelspace().add_lwpolyline(points, close=True, dxfattribs={"layer": "RACK"})

    body = build(doc, {"WALL": "walls", "RACK": "racks"}).json()

    assert len(racks(body)) == 2
    tilted = next(r for r in racks(body) if r["y"] > 20)
    assert (tilted["w"], tilted["h"]) == (10, 2)  # площадь сохранена, ряд лег вдоль оси
    assert any("под углом" in w for w in body["warnings"])


def test_rack_at_ninety_degrees_keeps_its_exact_size():
    doc = rect_doc({"RACK": [(10000, 5000, 2200, 20000)]})

    body = build(doc, {"WALL": "walls", "RACK": "racks"}).json()

    only = racks(body)[0]
    assert (only["x"], only["y"], only["w"], only["h"], only["rows"]) == (10, 5, 2, 20, "y")
    assert body["warnings"][0].startswith("Ворота не найдены")


def test_walls_drawn_as_four_separate_lines_are_joined_into_a_building():
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    corners = [(0, 0), (60000, 0), (60000, 36000), (0, 36000)]
    for a, b in zip(corners, corners[1:] + corners[:1], strict=False):
        msp.add_line(a, b, dxfattribs={"layer": "WALL"})

    body = build(doc, {"WALL": "walls"}).json()

    assert (body["width_m"], body["length_m"]) == (60, 36)
    assert not any("не замкнуты" in w for w in body["warnings"])


def test_open_walls_fall_back_to_a_frame_with_a_warning():
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (60000, 0), (60000, 36000), (0, 36000)], dxfattribs={"layer": "WALL"})

    body = build(doc, {"WALL": "walls"}).json()

    assert (body["width_m"], body["length_m"]) == (60, 36)
    assert any("не замкнуты" in w for w in body["warnings"])


def test_l_shaped_building_keeps_its_outline_and_drops_racks_in_the_notch():
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    outline = [(0, 0), (60000, 0), (60000, 20000), (30000, 20000), (30000, 40000), (0, 40000)]
    msp.add_lwpolyline(outline, close=True, dxfattribs={"layer": "WALL"})
    for x, y in ((5000, 5000), (40000, 30000)):  # второй стоит в вырезе
        msp.add_lwpolyline(
            [(x, y), (x + 10000, y), (x + 10000, y + 2200), (x, y + 2200)], close=True, dxfattribs={"layer": "RACK"}
        )

    body = build(doc, {"WALL": "walls", "RACK": "racks"}).json()

    assert (body["width_m"], body["length_m"]) == (60, 40)
    assert body["outline"] == [[0, 0], [60, 0], [60, 20], [30, 20], [30, 40], [0, 40]]
    assert len(racks(body)) == 1
    assert any("вне контура" in w for w in body["warnings"])


def test_skewed_wall_is_kept_with_a_warning():
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    doc.modelspace().add_lwpolyline(
        [(0, 0), (60000, 0), (60000, 30000), (20000, 36000), (0, 36000)], close=True, dxfattribs={"layer": "WALL"}
    )

    body = build(doc, {"WALL": "walls"}).json()

    assert len(body["outline"]) == 5
    assert any("под углом" in w for w in body["warnings"])


def test_double_wall_lines_use_the_outer_contour():
    doc = rect_doc({})
    doc.modelspace().add_lwpolyline(
        [(300, 300), (59700, 300), (59700, 35700), (300, 35700)], close=True, dxfattribs={"layer": "WALL"}
    )

    body = build(doc, {"WALL": "walls"}).json()

    assert (body["width_m"], body["length_m"]) == (60, 36)
    assert any("несколько замкнутых контуров" in w for w in body["warnings"])


def test_rack_sections_drawn_as_loose_lines_are_found_and_merged():
    doc = rect_doc({})
    msp = doc.modelspace()
    doc.layers.add("RACK")
    for k in range(4):  # четыре секции по 2,7 м, каждая из четырех отрезков
        x = 8000 + k * 2700
        corners = [(x, 10000), (x + 2700, 10000), (x + 2700, 11100), (x, 11100)]
        for a, b in zip(corners, corners[1:] + corners[:1], strict=False):
            msp.add_line(a, b, dxfattribs={"layer": "RACK"})

    body = build(doc, {"WALL": "walls", "RACK": "racks"}).json()

    assert len(racks(body)) == 1
    assert (racks(body)[0]["x"], racks(body)[0]["w"]) == (8, 11)


def test_door_arcs_and_symbols_at_the_wall_make_one_dock_each():
    doc = rect_doc({})
    msp = doc.modelspace()
    doc.layers.add("DOOR")
    for x in (10000, 30000):
        msp.add_arc((x, 0), 3600, 0, 90, dxfattribs={"layer": "DOOR"})  # дуга открывания
        msp.add_line((x, 0), (x + 3600, 0), dxfattribs={"layer": "DOOR"})  # створка
    msp.add_line((50000, 18000), (50000, 21000), dxfattribs={"layer": "DOOR"})  # значок посреди склада

    body = build(doc, {"WALL": "walls", "DOOR": "doors"}).json()

    assert sorted((d["x"], d["w"]) for d in docks(body)) == [(10, 4), (30, 4)]
    assert any("не у стены" in w for w in body["warnings"])


def test_two_docks_that_almost_touch_become_one():
    doc = rect_doc({})
    msp = doc.modelspace()
    doc.layers.add("DOOR")
    msp.add_line((10000, 0), (13000, 0), dxfattribs={"layer": "DOOR"})
    msp.add_line((13200, 0), (17000, 0), dxfattribs={"layer": "DOOR"})  # зазор в 20 см это один значок

    body = build(doc, {"WALL": "walls", "DOOR": "doors"}).json()

    assert [(d["x"], d["w"]) for d in docks(body)] == [(10, 7)]


def test_a_contour_the_size_of_the_building_on_a_rack_layer_is_skipped():
    doc = rect_doc({"RACK": [(0, 0, 60000, 36000), (8000, 10000, 20000, 2200)]})

    body = build(doc, {"WALL": "walls", "RACK": "racks"}).json()

    assert len(racks(body)) == 1 and any("размером с половину здания" in w for w in body["warnings"])


def test_no_buffer_when_racks_come_right_up_to_the_docks():
    doc = rect_doc({"RACK": [(2000, 1000, 50000, 2200)]})
    doc.layers.add("DOOR")
    doc.modelspace().add_line((10000, 0), (13600, 0), dxfattribs={"layer": "DOOR"})

    body = build(doc, {"WALL": "walls", "RACK": "racks", "DOOR": "doors"}).json()

    assert body["counts"]["buffers"] == 0 and any("под буфер" in w for w in body["warnings"])


def test_wrong_units_say_what_to_check():
    response = build(warehouse(), unit=1.0)

    assert response.status_code == 422
    assert "единицы" in response.json()["detail"]


def test_a_walls_layer_is_required():
    response = build(warehouse(), roles={"RACK-ZONE": "racks"})

    assert response.status_code == 422 and "со стенами" in response.json()["detail"]


@pytest.mark.parametrize(
    "roles", ["not json", '{"A": "floor"}', '["walls"]', json.dumps({f"L{i}": "walls" for i in range(501)})]
)
def test_bad_roles_are_refused_before_parsing(roles):
    response = client.post(
        "/api/plan/dxf/build",
        files={"file": ("s.dxf", dxf_bytes(warehouse()), "application/octet-stream")},
        data={"roles": roles, "unit_m": "0.001"},
    )

    assert response.status_code == 422


@pytest.mark.parametrize("unit", ["0", "-1", "5000", "abc"])
def test_bad_unit_is_refused(unit):
    response = client.post(
        "/api/plan/dxf/build",
        files={"file": ("s.dxf", dxf_bytes(warehouse()), "application/octet-stream")},
        data={"roles": json.dumps(ROLES), "unit_m": unit},
    )

    assert response.status_code == 422


def test_dwg_and_big_files_are_refused_like_the_preview_does(monkeypatch):
    assert build(b"AC1027" + b"\x00" * 100, name="s.dwg").status_code == 415
    monkeypatch.setattr(dxf_underlay, "MAX_BYTES", 1000)
    assert build(warehouse()).status_code == 413


def test_a_big_warehouse_builds_inside_the_time_limit():
    """Двести рядов по сорок секций: восемь тысяч секций, склеиваются в двести рядов"""
    doc = rect_doc({}, size=(110000, 800000), walls="WALL")
    doc.layers.add("RACK")
    msp = doc.modelspace()
    for row in range(200):
        for col in range(40):
            x, y = 2000 + col * 2700, 3000 + row * 4000
            msp.add_lwpolyline(
                [(x, y), (x + 2700, y), (x + 2700, y + 1100), (x, y + 1100)], close=True, dxfattribs={"layer": "RACK"}
            )
    content = dxf_bytes(doc)
    started = time.monotonic()

    response = build(content, {"WALL": "walls", "RACK": "racks"})

    assert response.status_code == 200
    body = response.json()
    assert len(racks(body)) == 200 and all(r["w"] == 108 for r in racks(body))
    assert time.monotonic() - started < dxf_underlay.TIMEOUT_S
