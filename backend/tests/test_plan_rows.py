"""Ряды вместо зон хранения: старая зона, разложенная на ряды, считается так же, как целая.

Редактор ставит ряды по одному или сразу несколько, а зоны из старых проектов сервер
раскладывает на ряды при чтении. Расчет от этого меняться не должен.
"""

from dataclasses import replace

import pytest

from app.engine import plan as engine
from app.services import plan as plan_service


def test_zone_split_into_rows_measures_the_same():
    """Старая зона из проекта и она же рядами: стеллажи на тех же клетках, числа те же."""
    constants = plan_service.constants()
    plan = engine.generate(plan_service.template("one_side"), constants, 10_000, margin_m=16)
    zones = plan.of(engine.RACKS)
    assert zones and engine.rack_cut(zones[0], constants).blocks > 1
    apart = engine.rows_of(plan, constants)
    rows = apart.of(engine.RACKS)
    cut = engine.rack_cut(zones[0], constants)
    assert len(rows) == cut.blocks * cut.segments  # поперечный проезд режет ряд на куски
    assert {row.group for row in rows} == {zones[0].id}
    assert all(engine.is_row(row, constants) for row in rows)

    whole_grid = engine.rasterize(plan, constants)
    apart_grid = engine.rasterize(apart, constants)
    assert whole_grid.cells == apart_grid.cells  # стеллажи на тех же клетках

    whole = engine.measure(plan, constants)
    parts = engine.measure(apart, constants)
    assert parts.route_m == pytest.approx(whole.route_m)
    assert parts.aisles == whole.aisles
    assert parts.aisle_m == pytest.approx(whole.aisle_m)
    assert parts.task_points == whole.task_points
    assert parts.storage_m2 == pytest.approx(whole.storage_m2)


def test_cross_aisles_cut_rows_into_pieces_of_one_line():
    """Зона с поперечным проездом: каждый ряд на куски, но проездов столько же, сколько рядов."""
    constants = plan_service.constants()
    zone = engine.Item(id="z", kind=engine.RACKS, x=2, y=2, w=30, h=70, rows="y", row_m=2.3, aisle_m=3.0, run_m=30)
    hall = engine.Section("hall", 0, 0, 40, 80, 0.0, 10.0)
    dock = engine.Item(id="dock", kind=engine.DOCK, x=10, y=0, w=3, h=1)
    plan = engine.Plan(width_m=40, length_m=80, template="custom", items=[dock, zone], sections=[hall])
    apart = engine.rows_of(plan, constants)
    cut = engine.rack_cut(zone, constants)
    assert len(apart.of(engine.RACKS)) == cut.blocks * cut.segments
    assert engine.rasterize(apart, constants).cells == engine.rasterize(plan, constants).cells
    assert engine.measure(apart, constants).aisles == engine.measure(plan, constants).aisles == cut.blocks


def test_corridor_between_rows_is_the_same_as_inside_the_zone():
    """Проезд между двумя рядами прогон смены ограничивает так же, как проезд внутри зоны."""
    constants = plan_service.constants()
    plan = engine.generate(plan_service.template("one_side"), constants, 10_000, margin_m=16)
    apart = engine.rows_of(plan, constants)
    whole_grid = engine.rasterize(plan, constants)
    apart_grid = engine.rasterize(apart, constants)
    cells = engine.task_cells(whole_grid)
    zone = [engine.corridor_of(plan, constants, whole_grid, cell) for cell in cells]
    rows = [engine.corridor_of(apart, constants, apart_grid, cell) for cell in cells]
    assert [one is None for one in zone] == [one is None for one in rows]
    # одинаковые места делят один проезд и там, и там
    pairs = {(a.key, b.key) for a, b in zip(zone, rows, strict=True) if a and b}
    assert len({a for a, _ in pairs}) == len({b for _, b in pairs}) == len(pairs)
    assert all(sorted(a.ends) == sorted(b.ends) for a, b in zip(zone, rows, strict=True) if a and b)


def test_rows_drawn_apart_make_no_corridor():
    """Два ряда у главного проезда, шире их проезда: это не проезд между рядами."""
    constants = plan_service.constants()
    kind = engine.rack_defaults(engine.rack_type(constants, "front"), constants)
    band = kind["row_m"]
    a = engine.Item(id="a", kind=engine.RACKS, x=4, y=4, w=band, h=20, rows="y", **kind)
    near = replace(a, id="b", x=4 + band + kind["aisle_m"])
    far = replace(a, id="c", x=4 + band + kind["aisle_m"] + 6)
    assert len(engine.gaps_between([a, near], constants)) == 1
    assert engine.gaps_between([a, far], constants) == []
    # третий ряд между двумя закрывает проезд: проездов два, а не три
    third = replace(near, id="d", x=near.x + band + kind["aisle_m"])
    assert len(engine.gaps_between([a, third, near], constants)) == 2


def test_building_outline_by_points():
    """Склад буквой Г одним контуром: пол только внутри контура, угол выреза пустой."""
    constants = plan_service.constants()
    outline = [(0, 0), (40, 0), (40, 20), (20, 20), (20, 30), (0, 30)]
    hall = plan_service.from_dict(
        {
            "width_m": 50,
            "length_m": 40,
            "sections": [{"id": "hall", "x": 0, "y": 0, "w": 1, "h": 1, "ceiling_m": 10, "points": outline}],
        }
    )
    section = hall.sections[0]
    assert (section.x, section.y, section.w, section.h) == (0, 0, 40, 30)  # рамку считает сервер
    measures = engine.measure(hall, constants)
    assert measures.area_m2 == 40 * 20 + 20 * 10
    grid = engine.rasterize(hall, constants)
    assert grid.floor(5, 25) and not grid.floor(30, 25)


def test_zone_without_cross_aisle_is_one_piece():
    """Поперечный проезд 0 значит сплошные ряды: зону по фото рисуют так, а проезд кладут рукой."""
    constants = plan_service.constants()
    zone = engine.Item(id="z", kind=engine.RACKS, x=0, y=0, w=80, h=20, rows="y", row_m=2.2, aisle_m=3.0, run_m=0)
    cut = engine.rack_cut(zone, constants)
    assert cut.segments == 1
    assert cut.seg == pytest.approx(20)
    # а с проездом каждые 30 м длинный ряд режется
    long = replace(zone, w=20, h=80, run_m=30)
    assert engine.rack_cut(long, constants).segments == 3
