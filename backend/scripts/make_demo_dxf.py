"""Демонстрационный чертеж склада для загрузки на шаге 3: python -m scripts.make_demo_dxf [куда].

Склад 102 на 72 м в миллиметрах, как чертят в AutoCAD. Слои с понятными именами:
СТЕНЫ (наружная стена в две линии и офис), КОЛОННЫ (сетка 12 на 12 м), СТЕЛЛАЖИ (секции
блоком 2,7 на 1,1 м, двойные ряды), ВОРОТА (6 ворот приемки и 6 отгрузки на южной стене),
ПРОЕЗДЫ (оси проездов), РАЗМЕРЫ и ТЕКСТ. По умолчанию файл ложится в frontend/public/examples.
"""

from __future__ import annotations

import sys
from pathlib import Path

import ezdxf

OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "examples" / "sklad-demo.dxf"

W, H = 102_000, 72_000  # здание, мм
WALL = 400
SECTION = (2_700, 1_100)  # секция стеллажа: вдоль ряда и глубина
ROWS_X0, ROW_PITCH, ROWS = 7_000, 5_800, 14  # двойной ряд 2,2 м и проезд 3,6 м
BLOCKS_Y = ((19_000, 8), (45_500, 8))  # где начинается блок рядов и сколько в нем секций
GATE_W, GATE_STEP = 3_600, 7_000
RECEIVING_X0, SHIPPING_X0 = 6_000, 56_000
OFFICE = (88_000, 58_000)  # юго-западный угол офиса в северо-восточном углу склада
LAYERS = {
    "СТЕНЫ": 7,
    "КОЛОННЫ": 8,
    "СТЕЛЛАЖИ": 5,
    "ВОРОТА": 1,
    "ПРОЕЗДЫ": 3,
    "РАЗМЕРЫ": 2,
    "ТЕКСТ": 6,
}


def _rect(x: float, y: float, w: float, h: float) -> list[tuple[float, float]]:
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def _walls(msp) -> None:
    on = {"layer": "СТЕНЫ"}
    # наружная грань стены это габарит здания, внутренняя на толщину стены внутри
    msp.add_lwpolyline(_rect(0, 0, W, H), close=True, dxfattribs=on)
    msp.add_lwpolyline(_rect(WALL, WALL, W - 2 * WALL, H - 2 * WALL), close=True, dxfattribs=on)
    ox, oy = OFFICE
    msp.add_lwpolyline([(ox, H - WALL), (ox, oy), (W - WALL, oy)], dxfattribs=on)


def _columns(msp) -> None:
    for x in range(12_000, W, 12_000):
        for y in range(12_000, H, 12_000):
            if x >= OFFICE[0] and y >= OFFICE[1]:
                continue
            msp.add_lwpolyline(_rect(x - 200, y - 200, 400, 400), close=True, dxfattribs={"layer": "КОЛОННЫ"})


def _racks(doc, msp) -> None:
    long, deep = SECTION
    block = doc.blocks.new("СЕКЦИЯ")
    # слой 0 внутри блока: секция берет слой вставки
    block.add_lwpolyline(_rect(0, 0, deep, long), close=True)
    block.add_line((0, 0), (deep, long))
    for row in range(ROWS):
        x = ROWS_X0 + row * ROW_PITCH
        for y0, sections in BLOCKS_Y:
            for k in range(sections):
                for side in (0, deep):
                    msp.add_blockref("СЕКЦИЯ", (x + side, y0 + k * long), dxfattribs={"layer": "СТЕЛЛАЖИ"})


def _gates(msp) -> None:
    on = {"layer": "ВОРОТА"}
    for x0 in (RECEIVING_X0, SHIPPING_X0):
        for k in range(6):
            x = x0 + k * GATE_STEP
            msp.add_line((x, 0), (x + GATE_W, 0), dxfattribs=on)
            # откосы в толще стены, как ворота рисуют на плане
            msp.add_line((x, 0), (x, WALL), dxfattribs=on)
            msp.add_line((x + GATE_W, 0), (x + GATE_W, WALL), dxfattribs=on)


def _aisles(msp) -> None:
    on = {"layer": "ПРОЕЗДЫ", "linetype": "CENTER"}
    msp.add_line((2_000, 15_500), (W - 2_000, 15_500), dxfattribs=on)
    msp.add_line((2_000, 42_500), (OFFICE[0] - 1_000, 42_500), dxfattribs=on)
    for row in range(ROWS - 1):
        x = ROWS_X0 + row * ROW_PITCH + 2 * SECTION[1] + (ROW_PITCH - 2 * SECTION[1]) / 2
        msp.add_line((x, 17_000), (x, H - 2_000), dxfattribs=on)


def _notes(msp) -> None:
    dims = {"layer": "РАЗМЕРЫ"}
    msp.add_linear_dim(base=(0, -6_000), p1=(0, 0), p2=(W, 0), dxfattribs=dims).render()
    msp.add_linear_dim(base=(-6_000, 0), p1=(0, 0), p2=(0, H), angle=90, dxfattribs=dims).render()
    x = ROWS_X0 + 2 * SECTION[1]
    msp.add_linear_dim(
        base=(0, 17_500), p1=(x, 19_000), p2=(x + ROW_PITCH - 2 * SECTION[1], 19_000), dxfattribs=dims
    ).render()
    text = {"layer": "ТЕКСТ", "height": 1_200}
    labels = (
        ("Зона приемки", (RECEIVING_X0 + 10_000, 8_000)),
        ("Зона отгрузки", (SHIPPING_X0 + 10_000, 8_000)),
        ("Офис", (OFFICE[0] + 3_000, OFFICE[1] + 6_000)),
        ("Склад 102 x 72 м, единицы чертежа миллиметры", (0, H + 4_000)),
    )
    for words, place in labels:
        msp.add_text(words, dxfattribs=text).set_placement(place)


def make(out: Path = OUT) -> Path:
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4  # миллиметры
    for name, color in LAYERS.items():
        doc.layers.add(name, color=color)
    msp = doc.modelspace()
    _walls(msp)
    _columns(msp)
    _racks(doc, msp)
    _gates(msp)
    _aisles(msp)
    _notes(msp)
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(out, encoding="utf-8")
    return out


if __name__ == "__main__":
    print(make(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT))
