"""План объекта: строится из шаблона, ложится на сетку и дает расчету числа, а не картинку."""

import pytest
from fastapi.testclient import TestClient

from app.engine import plan as P
from app.engine.model_config import find_unsourced_numbers, load_model
from app.main import app
from app.services import plan as service

client = TestClient(app)
AREA = 10_000


@pytest.fixture(scope="module")
def constants():
    return service.constants()


@pytest.fixture(scope="module")
def warehouse(constants):
    return P.generate(service.template("one_side"), constants, AREA, ceiling_m=10, margin_m=service.LOT_MARGIN_M)


def test_size_comes_from_area_and_proportion(warehouse, constants):
    # длины и ширины склада нет ни в ТЗ, ни в датасете, поэтому выводим их из площади и пропорции
    measures = P.measure(warehouse, constants)
    assert measures.area_m2 == pytest.approx(AREA, rel=0.01)
    # длинная сторона лежит вдоль x: лист в редакторе широкий
    assert measures.width_m / measures.length_m == pytest.approx(1.4, rel=0.02)
    # участок больше здания: вокруг есть место, чтобы дорисовать пристройку
    assert warehouse.width_m > measures.width_m


def test_docks_come_from_area(warehouse, constants):
    # одни ворота на 1000 м2: источники расходятся вдвое, мы взяли реже
    assert len(warehouse.of(P.DOCK)) == AREA / constants["area_per_dock_m2"]
    assert {item.role for item in warehouse.of(P.DOCK)} == {"receiving", "shipping"}
    assert len({item.x for item in warehouse.of(P.DOCK)}) == 1  # шаблон «с одной стороны»: одна стена


def test_racks_block_cells_and_aisles_stay_free(warehouse, constants):
    grid = P.rasterize(warehouse, constants)
    assert any(value == P.RACK_CELL for value in grid.cells)
    assert any(value == P.FREE for value in grid.cells)
    # проезд между рядами шире стеллажа, поэтому проезжих клеток больше, чем занятых
    assert sum(1 for value in grid.cells if value == P.FREE) > sum(1 for value in grid.cells if value == P.RACK_CELL)


def test_route_goes_around_racks_not_through_them(warehouse, constants):
    """Волна считает объезд, а не расстояние по прямой: в этом вся разница с квадратом."""
    grid = P.rasterize(warehouse, constants)
    doors = [grid.point(*cell) for cell in P.sources_of(grid, warehouse.of(P.DOCK))]
    field_m = P.distances(grid, P.sources_of(grid, warehouse.of(P.DOCK)))
    detours = 0
    for cell in P.task_cells(grid):
        by_wave = field_m[cell[1] * grid.cols + cell[0]]
        if by_wave == P.INF:
            continue
        x, y = grid.point(*cell)
        straight = min(abs(x - door[0]) + abs(y - door[1]) for door in doors)
        assert by_wave >= straight - 1e-6  # объезд не бывает короче прямой
        detours += by_wave > straight + 1e-6
    assert detours > 0  # вокруг длинных рядов роботу приходится ехать в обход


def test_path_is_a_polyline_with_turns(warehouse, constants):
    grid = P.rasterize(warehouse, constants)
    field_m = P.distances(grid, P.sources_of(grid, warehouse.of(P.DOCK)))
    paths = [P.trace(grid, field_m, cell) for cell in P.task_cells(grid)]
    assert any(len(path) > 2 for path in paths)  # прямым отрезком такой путь не описать
    docks = warehouse.of(P.DOCK)

    def near(x: float, y: float) -> bool:
        return any(d.x - 2 <= x <= d.x + d.w + 2 and d.y - 2 <= y <= d.y + d.h + 2 for d in docks)

    assert all(near(*path[-1]) for path in paths if len(path) > 1)  # кончается у ворот


def test_plan_gives_the_numbers_the_calculation_eats(warehouse, constants):
    measures = P.measure(warehouse, constants)
    assert measures.docks == 10  # мест у ворот
    assert measures.aisles > 1  # столько роботов едут, не мешая друг другу
    assert measures.aisle_m == constants["aisle_forklift_m"]  # это число идет в подбор решений
    assert 0 < measures.route_m < warehouse.width_m + warehouse.length_m
    assert measures.buffers == 1  # буфер у ворот: сюда робот ставит паллету
    # верхний ярус идет в подбор штабелеров: ярусов столько, сколько шагов помещается под потолком
    tier = constants["pallet_tier_m"]
    assert measures.rack_top_m <= 10 - constants["rack_top_below_ceiling_m"] < measures.rack_top_m + tier
    assert measures.unreachable_points == 0
    assert not measures.warnings
    assert all(check.ok for check in measures.checks)


def test_templates_differ_by_route(constants):
    """Шаблоны отличаются не картинкой: разный поток дает разную длину маршрута."""
    routes = {}
    for template in service.templates():
        stations = 2 if template["id"] == "robot_zone" else 0
        routes[template["id"]] = P.measure(P.generate(template, constants, AREA, stations), constants).route_m
    assert routes["through"] < routes["one_side"]  # приемка и отгрузка на разных стенах, поток короче
    assert len(set(routes.values())) == len(routes)


def test_blocked_zone_lengthens_the_route(warehouse, constants):
    """Офис или холодильник посреди склада заставляет объезжать, и маршрут становится длиннее."""
    before = P.measure(warehouse, constants).route_m
    racks = warehouse.of(P.RACKS)[0]
    # между воротами на западе и стеллажами, на большую часть длины стены
    wall = P.Item(id="office", kind=P.BLOCKED, x=racks.x - 4, y=racks.y, w=4, h=racks.h * 0.7)
    after = P.measure(_with(warehouse, [*warehouse.items, wall]), constants)
    assert after.route_m > before


def test_sealed_racks_are_reported_not_hidden(constants):
    """Если до мест у стеллажей не доехать, мы об этом пишем, а не считаем по тому, что осталось."""
    plan = P.Plan(
        width_m=12,
        length_m=20,
        template="one_side",
        items=[
            P.Item(id="dock-0", kind=P.DOCK, x=4, y=0, w=4, h=1),
            P.Item(id="racks", kind=P.RACKS, x=2, y=12, w=8, h=6, aisle_m=3, run_m=30),
            P.Item(id="wall", kind=P.BLOCKED, x=0, y=10, w=12, h=2),  # перегородка на всю ширину
        ],
    )
    measures = P.measure(plan, constants)
    assert any("перекрыт" in warning for warning in measures.warnings)


def test_plan_without_docks_says_so(constants):
    plan = P.Plan(width_m=20, length_m=20, template="one_side", items=[])
    assert any("нет ворот" in warning for warning in P.measure(plan, constants).warnings)


def test_layout_constants_all_have_sources():
    """У каждой цифры шаблона источник, дата и оценка: норматива на планировку склада нет."""
    import yaml

    from app.settings import settings

    raw = yaml.safe_load((settings.config_dir / "layouts.yaml").read_text(encoding="utf-8"))
    assert find_unsourced_numbers(raw) == []
    _, provenance = load_model(settings.config_dir / "layouts.yaml")
    assert provenance["constants.area_per_dock_m2"].trust == "E"  # источники расходятся вдвое
    assert provenance["constants.dock_zone_depth_m"].is_weak  # источника нет, наше допущение
    # пропорция здания тоже наша: длины и ширины склада нет ни в ТЗ, ни в датасете
    assert provenance["templates.one_side.aspect"].trust == "F"


def test_api_lists_templates_and_builds_a_plan():
    templates = client.get("/api/plan/templates").json()
    assert {item["id"] for item in templates} >= {"through", "one_side", "robot_zone"}

    built = client.post("/api/plan/generate", json={"template_id": "one_side"}).json()
    assert built["measures"]["route_m"] > 0
    assert built["plan"]["items"]

    measured = client.post("/api/plan/measure", json=built["plan"]).json()
    assert measured["measures"]["route_m"] == pytest.approx(built["measures"]["route_m"])


def test_api_takes_the_size_the_person_typed():
    """Тянуть мышью в метр неудобно, поэтому габариты можно ввести числами."""
    built = client.post("/api/plan/generate", json={"width_m": 60, "length_m": 200}).json()
    assert built["measures"]["width_m"] == 60
    assert built["measures"]["length_m"] == 200


def test_api_says_which_template_it_does_not_know():
    assert client.post("/api/plan/generate", json={"template_id": "нет такого"}).status_code == 404


def _with(plan, items=None, sections=None):
    from dataclasses import replace

    return replace(
        plan,
        items=list(items if items is not None else plan.items),
        sections=list(sections if sections is not None else plan.sections),
    )


def _raised(plan, depth: int = 20, floor_m: float = 1.2):
    """Антресоль поперек северной части склада: секция сверху основного зала на другой отметке.
    Глубина такая, чтобы буфер у западных ворот на антресоль не заходил."""
    hall = plan.sections[0]
    top = P.Section("mezzanine", hall.x, hall.y + hall.h - depth, hall.w, depth, floor_m, 8.8)
    return _with(plan, sections=[*plan.sections, top]), top


def test_building_takes_any_shape(warehouse, constants):
    """Форма здания задается секциями: пристройка сбоку добавляет площадь, вырез ее убирает."""
    before = P.measure(warehouse, constants)
    hall = warehouse.sections[0]
    annex = P.Section("annex", hall.x - 10, hall.y + 20, 10, 20, 0.0, 10.0)
    wider = P.measure(_with(warehouse, sections=[*warehouse.sections, annex]), constants)
    assert wider.area_m2 == before.area_m2 + 200
    assert wider.width_m == before.width_m + 10
    hole = P.Section("yard", hall.x, hall.y + hall.h - 10, 10, 10, hole=True)
    cut = P.measure(_with(warehouse, sections=[*warehouse.sections, hole]), constants)
    assert cut.area_m2 == before.area_m2 - 100


def test_longer_section_makes_a_longer_building(warehouse, constants):
    """Удлинить склад значит потянуть секцию за край: площадь растет, габарит тоже."""
    hall = warehouse.sections[0]
    longer = P.Section(**{**vars(hall), "h": hall.h + 20})
    measures = P.measure(_with(warehouse, sections=[longer]), constants)
    assert measures.length_m == hall.h + 20


def test_other_floor_level_is_cut_off_without_a_ramp(warehouse, constants):
    """Часть склада на другой отметке пола: робот туда не доедет, пока не поставить пандус."""
    raised, top = _raised(warehouse)
    cut = P.measure(raised, constants)
    assert cut.levels == 2
    assert any("другом уровне пола" in warning for warning in cut.warnings)

    ramp = P.Item(id="ramp", kind=P.RAMP, x=top.x + 2, y=top.y - 3, w=4, h=6)
    joined = P.measure(_with(raised, [*raised.items, ramp]), constants)
    assert joined.ramps == 1
    assert joined.unreachable_points < cut.unreachable_points
    assert not any("другом уровне пола" in warning for warning in joined.warnings)


def test_same_floor_with_another_ceiling_is_still_one_floor(warehouse, constants):
    """Секция с другим потолком, но на той же отметке пола, робота не отрезает."""
    raised, _ = _raised(warehouse, floor_m=0.0)
    assert P.measure(raised, constants).unreachable_points == 0


def test_racks_higher_than_ceiling_are_reported(warehouse, constants):
    racks = warehouse.of(P.RACKS)[0]
    tall = P.Item(**{**vars(racks), "tiers": 0, "rack_top_m": 12.0})
    items = [tall if item is racks else item for item in warehouse.items]
    measures = P.measure(_with(warehouse, items), constants)
    assert measures.rack_top_m == 12
    assert any("выше потолка" in warning for warning in measures.warnings)


def test_charge_is_placed_by_the_program_and_does_not_block(warehouse, constants):
    """Зарядку ставит программа: у стены, рядом с буфером, и так, чтобы не удлинить маршрут."""
    charge = warehouse.of(P.CHARGE)
    assert len(charge) == 1 and charge[0].auto
    without = _with(warehouse, [item for item in warehouse.items if item.kind != P.CHARGE])
    blocked = _with(without, [*without.items, P.Item(**{**vars(charge[0]), "id": "wall", "kind": P.BLOCKED})])
    route = P.measure(without, constants).route_m
    assert P.measure(blocked, constants).route_m <= route + P.CHARGE_ROUTE_TOLERANCE_M
    assert P.measure(warehouse, constants).charge_detour_m < route  # ближе к буферу, чем стеллажи


def test_moved_charge_stays_where_the_person_put_it(warehouse):
    charge = warehouse.of(P.CHARGE)[0]
    moved = P.Item(**{**vars(charge), "x": charge.x + 20, "auto": False})
    plan = _with(warehouse, [moved if item is charge else item for item in warehouse.items])
    assert service.resolve(plan).of(P.CHARGE)[0].x == charge.x + 20


def test_ramp_on_flat_floor_is_reported(warehouse, constants):
    ramp = P.Item(id="ramp", kind=P.RAMP, x=30, y=30, w=4, h=6)
    measures = P.measure(_with(warehouse, [*warehouse.items, ramp]), constants)
    assert any("Пандус никуда не ведет" in warning for warning in measures.warnings)


def test_docks_inside_the_building_are_reported(warehouse, constants):
    racks = warehouse.of(P.RACKS)[0]
    inner = P.Item(id="dock-x", kind=P.DOCK, x=racks.x + 10, y=racks.y - 3, w=4, h=1, role="both")
    measures = P.measure(_with(warehouse, [*warehouse.items, inner]), constants)
    assert any("не в наружной стене" in warning for warning in measures.warnings)


def test_ramp_inside_the_racks_carves_its_own_place(warehouse, constants):
    """Пандус можно поставить прямо в зону хранения: стеллажей под ним нет, робот по нему едет."""
    raised, top = _raised(warehouse)
    racks = warehouse.of(P.RACKS)[0]
    ramp = P.Item(id="ramp", kind=P.RAMP, x=racks.x + 20, y=top.y - 4, w=4, h=8)
    cut = P.measure(raised, constants)
    joined = P.measure(_with(raised, [*raised.items, ramp]), constants)
    assert joined.unreachable_points < cut.unreachable_points


def test_old_plans_with_floor_rows_still_work(constants):
    """План с полом строками, как его присылали раньше, считается так же."""
    plan = P.Plan(
        width_m=20,
        length_m=20,
        template="one_side",
        floor=["." * 20] + ["." + "0" * 18 + "."] * 18 + ["." * 20],
        levels=[P.Level(0, 10)],
        items=[
            P.Item(id="dock-0", kind=P.DOCK, x=8, y=1, w=4, h=1, role="both"),
            P.Item(id="racks", kind=P.RACKS, x=4, y=6, w=12, h=10, aisle_m=3, run_m=30),
        ],
    )
    measures = P.measure(plan, constants)
    assert measures.area_m2 == 18 * 18
    assert measures.route_m > 0


def _zone(**numbers) -> P.Plan:
    """Зал 40 на 30 с воротами и одной зоной хранения посередине."""
    hall = P.Section("hall", 0, 0, 40, 30, 0.0, 12.0)
    racks = P.Item(id="racks", kind=P.RACKS, x=4, y=8, w=32, h=18, **numbers)
    dock = P.Item(id="dock", kind=P.DOCK, x=18, y=0, w=4, h=1, role="both")
    return P.Plan(width_m=40, length_m=30, template="one_side", items=[dock, racks], sections=[hall])


def test_rows_stand_whole_and_leftover_is_split_between_edges(constants):
    """Рядов ровно столько, сколько помещается целиком, а остаток делится между краями зоны."""
    front = P.rack_defaults(P.rack_type(constants, "front"), constants)
    racks = _zone(**front).of(P.RACKS)[0]
    cut = P.rack_cut(racks, constants)
    assert cut.blocks * cut.band + (cut.blocks - 1) * (cut.pitch - cut.band) <= racks.w
    assert cut.offset == pytest.approx((racks.w - cut.used) / 2)
    assert cut.seg <= racks.run_m and cut.segments * cut.seg + (cut.segments - 1) * cut.cross == pytest.approx(racks.h)


def test_rack_type_changes_what_the_plan_gives(constants):
    """Тип стеллажа двигает расчет: число проездов, площадь под хранением и то, заезжает ли робот."""
    measured = {
        kind: P.measure(_zone(**P.rack_defaults(P.rack_type(constants, kind), constants)), constants)
        for kind in ("front", "drive_in", "mobile", "shelf")
    }
    assert measured["mobile"].storage_m2 > measured["front"].storage_m2  # плотнее: проход один на блок
    assert measured["mobile"].aisles < measured["front"].aisles
    assert measured["shelf"].aisles > measured["front"].aisles  # полки тонкие, проходов больше
    assert measured["front"].closed_racks == 0
    assert measured["drive_in"].closed_racks == 1 and measured["mobile"].closed_racks == 1


def test_tiers_give_the_top_tier(constants):
    """Нижний ярус стоит на полу, каждый следующий выше на шаг яруса."""
    racks = P.Item(id="r", kind=P.RACKS, x=0, y=0, w=10, h=10, tiers=5, tier_m=1.7, rack_top_m=99)
    assert P.top_of(racks) == pytest.approx(6.8)
    assert P.top_of(P.Item(id="r", kind=P.RACKS, x=0, y=0, w=1, h=1, rack_top_m=7.5)) == 7.5


def test_unreachable_places_are_given_by_cell(constants):
    """Места, до которых не доехать, приходят клетками: редактор красит их на плане."""
    plan = _zone(**P.rack_defaults(P.rack_type(constants, "front"), constants))
    wall = P.Item(id="wall", kind=P.BLOCKED, x=0, y=5, w=40, h=1)
    measures = P.measure(P.Plan(**{**vars(plan), "items": [*plan.items, wall]}), constants)
    assert measures.unreachable_points > 0
    assert len(measures.unreachable) == measures.unreachable_points
    assert not next(check for check in measures.checks if check.label == "Все места у стеллажей доступны").ok


def test_route_map_paints_only_drivable_cells(warehouse, constants):
    """Слой «далеко от ворот»: у проезжих клеток ступень по пути до буфера, стеллажи и улица не красятся."""
    measures = P.measure(warehouse, constants)
    grid = P.rasterize(warehouse, constants)
    rows = measures.route_map.rows
    assert len(rows) == grid.rows and all(len(row) == grid.cols for row in rows)
    bands = measures.route_map.bands_m
    assert 2 <= len(bands) <= P.ROUTE_BANDS + 1
    step = bands[1]
    assert step in P.NICE_STEPS_M
    assert bands[-1] >= measures.route_m
    for row in range(grid.rows):
        for col in range(grid.cols):
            mark = rows[row][col]
            assert (mark == P.OUTSIDE) == (not grid.free(col, row))
    # у буфера путь нулевой, значит первая ступень; самая дальняя клетка в последней или раньше
    buffer = warehouse.of(P.BUFFER)[0]
    col, row = grid.cell(*buffer.center)
    assert rows[row][col] == "0"
    marks = [int(mark, 36) for line in rows for mark in line if mark not in (P.OUTSIDE, "!")]
    assert max(marks) == len(bands) - 2  # последняя ступень не пустая: шкала кончается там, где кончается путь


def test_aisle_cuts_through_the_racks(constants):
    """Проезд поперек зоны хранения убирает под собой стеллажи и укорачивает маршрут."""
    plan = _zone(**P.rack_defaults(P.rack_type(constants, "front"), constants))
    before = P.measure(plan, constants)
    cut = P.Item(id="cut", kind=P.AISLE, x=0, y=20, w=40, h=4)
    after = P.measure(P.Plan(**{**vars(plan), "items": [*plan.items, cut]}), constants)
    grid = P.rasterize(P.Plan(**{**vars(plan), "items": [*plan.items, cut]}), constants)
    assert all(grid.free(col, row) for col, row in grid.cells_of(cut))
    assert after.route_m < before.route_m


def test_route_map_marks_cut_off_cells(constants):
    """Клетка, до которой не доехать, отмечена восклицательным знаком, а не ступенью."""
    plan = _zone(**P.rack_defaults(P.rack_type(constants, "front"), constants))
    wall = P.Item(id="wall", kind=P.BLOCKED, x=0, y=5, w=40, h=1)
    measures = P.measure(P.Plan(**{**vars(plan), "items": [*plan.items, wall]}), constants)
    assert any("!" in row for row in measures.route_map.rows)


def test_api_builds_a_custom_plan_from_answers():
    """Анкета «Свой склад»: ворота на названной стене и в названном числе, без стеллажей пусто."""
    body = {
        "template_id": "custom",
        "width_m": 100,
        "length_m": 60,
        "custom": {"docks": [{"wall": "south", "count": 6}, {"wall": "west", "count": 2}], "racks": "none"},
    }
    answer = client.post("/api/plan/generate", json=body).json()
    docks = [item for item in answer["plan"]["items"] if item["kind"] == "dock"]
    assert len(docks) == 8
    hall = answer["plan"]["sections"][0]
    assert sum(1 for dock in docks if dock["y"] == hall["y"]) == 6  # южная стена
    assert sum(1 for dock in docks if dock["x"] == hall["x"]) == 2  # западная стена
    assert not [item for item in answer["plan"]["items"] if item["kind"] == "racks"]
    assert answer["measures"]["width_m"] == 100 and answer["measures"]["length_m"] == 60

    body["custom"] = {"docks": [{"wall": "east", "count": 4}], "racks": "along"}
    answer = client.post("/api/plan/generate", json=body).json()
    racks = [item for item in answer["plan"]["items"] if item["kind"] == "racks"]
    assert racks and racks[0]["rows"] == "x"  # поток с востока идет вдоль x, ряды вдоль потока
    assert [item for item in answer["plan"]["items"] if item["kind"] == "dock"]


def test_api_lists_rack_types():
    kinds = {kind["id"]: kind for kind in client.get("/api/plan/rack-types").json()}
    assert set(kinds) >= {"front", "drive_in", "mobile", "shelf", "pods"}
    assert not kinds["drive_in"]["robot_inside"]
    assert kinds["front"]["row_m"] > 0 and kinds["front"]["tier_m"] > 0


def _station_check(measures):
    return next(check for check in measures.checks if check.label == "Станции не перекрывают проезд")


def test_robot_zone_stations_do_not_block(constants):
    """В робозоне станции стоят у края зоны: проверка закрыта."""
    zone = P.generate(
        service.template("robot_zone"), constants, AREA, stations=4, ceiling_m=10, margin_m=service.LOT_MARGIN_M
    )
    assert zone.of(P.STATION)
    assert _station_check(P.measure(zone, constants)).ok


def test_station_across_the_aisles_is_reported(warehouse, constants):
    """Станция поперек проездов между рядами: на листе через нее едут, на деле там человек и роботы."""
    rows = warehouse.of(P.RACKS)
    top = max(item.y + item.h for item in rows)
    bottom = min(item.y for item in rows)
    left = min(item.x for item in rows)
    right = max(item.x + item.w for item in rows)
    # полоса станций поперек всех рядов посередине: перекрывает каждый проезд
    across = P.Item(id="st", kind=P.STATION, x=left, y=(top + bottom) / 2 - 2, w=right - left, h=4)
    check = _station_check(P.measure(_with(warehouse, [*warehouse.items, across]), constants))
    assert not check.ok
    assert "Поставьте станции у края зоны" in check.detail


def test_plan_without_stations_has_no_station_check(warehouse, constants):
    assert not [
        check for check in P.measure(warehouse, constants).checks if check.label == "Станции не перекрывают проезд"
    ]
