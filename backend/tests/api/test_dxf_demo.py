"""Пример чертежа склада, который лежит в сервисе (frontend/public/examples/sklad-demo.dxf):
читается, слои узнаются по именам, план по ним выходит 102 на 72 м с рядами и воротами."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from scripts import make_demo_dxf

client = TestClient(app)
EXAMPLE = Path(__file__).resolve().parents[3] / "frontend" / "public" / "examples" / "sklad-demo.dxf"
ROLES = '{"СТЕНЫ": "walls", "СТЕЛЛАЖИ": "racks", "ВОРОТА": "doors"}'


def post(url: str, content: bytes, **form):
    return client.post(url, files={"file": ("sklad-demo.dxf", content, "application/octet-stream")}, data=form)


def test_example_layers_are_recognized_by_name():
    body = post("/api/plan/dxf", EXAMPLE.read_bytes()).json()

    assert body["units"] == {"code": 4, "name": "миллиметры", "factor_m": 0.001, "source": "file"}
    layers = {one["name"]: one for one in body["layers"]}
    assert set(layers) == {"СТЕНЫ", "КОЛОННЫ", "СТЕЛЛАЖИ", "ВОРОТА", "ПРОЕЗДЫ", "РАЗМЕРЫ", "ТЕКСТ"}
    assert [layers[name]["role"] for name in ("СТЕНЫ", "СТЕЛЛАЖИ", "ВОРОТА", "РАЗМЕРЫ")] == [
        "walls",
        "racks",
        "doors",
        "noise",
    ]
    assert layers["ТЕКСТ"]["lines"] == 0 and layers["ТЕКСТ"]["texts"] == 4


def test_example_builds_a_warehouse_with_rows_and_gates():
    response = post("/api/plan/dxf/build", EXAMPLE.read_bytes(), roles=ROLES, unit_m="0.001")

    assert response.status_code == 200
    built = response.json()
    assert (built["width_m"], built["length_m"]) == (102, 72)
    assert built["counts"]["racks"] == 28 and built["counts"]["docks"] == 12
    assert built["turn_deg"] == 0


def test_generator_makes_the_same_drawing(tmp_path):
    fresh = make_demo_dxf.make(tmp_path / "sklad-demo.dxf")

    built = post("/api/plan/dxf/build", fresh.read_bytes(), roles=ROLES, unit_m="0.001").json()

    assert (built["width_m"], built["length_m"], built["counts"]) == (
        102,
        72,
        {"racks": 28, "docks": 12, "buffers": 1},
    )
