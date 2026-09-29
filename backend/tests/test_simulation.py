"""Прогон смены: парк упирается в потолок, очереди растут, кривая уходит в расчет экономики (ТЗ, п. 3.6)."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.engine.simulation import (
    Gate,
    Layout,
    RobotSpec,
    build_layout,
    demand_profile,
    run_shift,
    split,
    throughput_curve,
)
from app.main import app
from app.schemas.economics import CalculationRequest
from app.services import plan as plan_service
from app.services.calculation import calculate

client = TestClient(app)

# Три места у стеллажей, в среднем 75 метров от ворот: столько же дает старая оценка по
# площади для склада в 10 000 м2. На таком маршруте цикл считается руками и сходится с формулой.
FAR = [25.0, 75.0, 125.0]
POINTS = [(50.0, distance) for distance in FAR]
ROOMY = Layout(task_points=POINTS, to_dock_m=FAR, dock_points=2)
# Узкий план: все места в одном проезде на троих и одни ворота. На нем видно, как парк упирается в потолок.
TIGHT = Layout(task_points=POINTS, to_dock_m=FAR, aisle_of=[0, 0, 0], inside_dock_m=FAR, aisle_slots=3, dock_points=1)
ROBOT = RobotSpec(speed_m_s=1.0, handling_s=20, run_time_h=6, charge_time_h=0.3)
PLENTY = 5_000  # заданий больше, чем парк вытянет: меряем потолок, а не поток


def shift(fleet: int, layout: Layout = ROOMY, demand: float = PLENTY, hours: float = 8, seed: int = 42):
    return run_shift(layout, ROBOT, fleet, demand, hours, seed)


def test_one_robot_matches_the_formula():
    # цикл = 2 * 75 м / 1 м/с + 20 с погрузки = 170 с, это около 21 операции в час
    kpi = shift(1).kpi
    assert kpi.ops_per_hour == pytest.approx(21, abs=2)
    assert kpi.avg_cycle_s == pytest.approx(170, abs=15)


def test_same_seed_gives_same_result():
    assert shift(6).kpi.done == shift(6).kpi.done
    assert shift(6, seed=1).kpi.done != shift(6, seed=2).kpi.done


def test_fleet_grows_while_the_zone_is_free():
    curve = throughput_curve(ROOMY, ROBOT, 8, PLENTY, every=1)
    assert curve[0] == 0
    assert curve[8] == pytest.approx(8 * curve[1], rel=0.1)  # места хватает, парк растет линейно


def test_fleet_hits_the_ceiling_in_a_tight_zone():
    curve = throughput_curve(TIGHT, ROBOT, 12, PLENTY, every=1)
    assert curve[4] > curve[2] > curve[1]
    assert curve[12] == pytest.approx(curve[8], rel=0.05)  # плато: роботы мешают друг другу
    assert curve[12] < 12 * curve[1]  # потолок ниже, чем сумма одиночных роботов


def test_curve_through_one_matches_the_full_one():
    """Кривую считаем через один размер парка и достраиваем между: так вдвое быстрее."""
    full = throughput_curve(ROOMY, ROBOT, 8, PLENTY, every=1)
    sparse = throughput_curve(ROOMY, ROBOT, 8, PLENTY, every=2)
    assert sparse[8] == pytest.approx(full[8], rel=0.01)
    assert sparse[5] == pytest.approx(full[5], rel=0.1)


def test_crowded_fleet_waits_in_queues():
    free = shift(2, TIGHT).kpi
    crowded = shift(20, TIGHT).kpi
    assert free.waiting_share < crowded.waiting_share
    assert crowded.waiting_share > 0.3
    assert "очереди" in crowded.bottleneck


def test_stations_make_their_own_queue():
    """Схема «товар к человеку»: узкое место переезжает на станции комплектации."""
    with_stations = Layout(
        task_points=POINTS,
        to_dock_m=FAR,
        to_station_m=FAR,
        dock_points=2,
        stations=2,
        station_service_s=18,
    )
    small = run_shift(with_stations, ROBOT, 20, PLENTY, 8, 42).kpi
    big = run_shift(with_stations, ROBOT, 60, PLENTY, 8, 42).kpi
    ceiling = 2 * 3600 / 18  # две станции по 18 секунд на позицию
    assert big.ops_per_hour < ceiling  # выше станций парк не прыгнет
    assert big.waiting_share > small.waiting_share > 0  # лишние роботы копятся в очередях


def test_log_is_made_of_segments_not_dots():
    """Отрезок говорит, откуда, куда и когда едет робот: по точке на момент времени так нельзя."""
    result = shift(3, hours=1)
    assert result.segments
    assert {part.action for part in result.segments} <= {"едет", "ждет", "грузит", "заряжается", "без задания"}
    assert all(part.to_s >= part.from_s for part in result.segments)
    assert all(0 <= part.from_s <= 3600 for part in result.segments)
    assert all(part.path for part in result.segments)
    # у стоячих действий в ломаной одна точка, у движения две и больше
    assert all(len(part.path) == 1 for part in result.segments if part.action == "ждет")
    assert any(len(part.path) >= 2 for part in result.segments if part.action == "едет")


def test_layout_comes_from_the_plan():
    """Проезды и места у ворот больше не константы: их дает план объекта. Место в проезде
    у каждого стеллажа свое, а не общий пул на весь склад."""
    plan = plan_service.generate("warehouse", ["pallet_transport"])
    measures = plan_service.measure(plan)
    layout = build_layout(plan, plan_service.constants(), measures, robots_per_aisle=3)
    assert layout.dock_points == measures.docks
    assert layout.aisle_slots == 3
    corridors = {aisle for aisle in layout.aisle_of if aisle >= 0}
    assert len(corridors) >= measures.aisles  # у каждого проезда между блоками хотя бы одна часть ряда
    inside = [
        (metres, run)
        for aisle, metres, run in zip(layout.aisle_of, layout.inside_dock_m, layout.to_dock_m, strict=True)
        if aisle >= 0
    ]
    assert all(0 <= metres <= run for metres, run in inside)
    assert max(metres for metres, _ in inside) > 0
    assert len(layout.task_points) == len(layout.to_dock_m) > 0
    assert min(layout.to_dock_m) > 0


def test_api_returns_kpi_plan_numbers_and_curve():
    result = client.post("/api/simulation/runs", json={"fleet": 8}).json()
    assert result["layout"]["docks"] >= 1
    assert result["layout"]["route_m"] > 0
    assert result["kpi"]["ops_per_hour"] > 0
    assert result["kpi"]["bottleneck"]
    assert len(result["curve_ops_per_hour"]) > 8
    assert result["segments"]
    assert result["plan_edited"] is False  # плана не прислали, взяли типовой по шаблону


def test_api_runs_the_shift_on_the_drawn_plan():
    """Проигрыватель смены шлет нарисованный план: смена идет по нему, а не по типовому."""
    drawn = plan_service.generate("warehouse", ["pallet_transport"], "one_side", width_m=60, length_m=200)
    result = client.post(
        "/api/simulation/runs", json={"fleet": 6, "plan": {**plan_service.to_dict(drawn), "edited": True}}
    )
    assert result.status_code == 200
    body = result.json()
    assert body["plan_edited"] is True
    assert body["layout"]["width_m"] == 60 or body["layout"]["length_m"] == 60
    assert body["segments"]
    # шкала проигрывателя: спрос по часам смены с пиком и спрос, на который брали парк
    assert len(body["demand_per_hour"]) == body["hours"]
    assert max(body["demand_per_hour"]) > min(body["demand_per_hour"])
    assert body["design_demand"] >= max(body["demand_per_hour"])


def test_drawn_plan_changes_the_route_and_the_fleet():
    """Геометрия идет в размер парка, а не только в картинку."""
    wide = plan_service.generate("warehouse", ["pallet_transport"], "one_side", width_m=60, length_m=200)
    short = plan_service.generate("warehouse", ["pallet_transport"], "through")
    by_default = calculate(CalculationRequest())
    by_long = calculate(CalculationRequest(plan=plan_service.to_dict(wide)))
    by_short = calculate(CalculationRequest(plan=plan_service.to_dict(short)))
    assert by_long.sizing.route_m > by_short.sizing.route_m
    assert by_long.sizing.fleet > by_short.sizing.fleet

    # Про типовую планировку говорим прямо, даже когда считаем по ней: геометрия сгенерированного
    # плана все равно честнее квадрата, но подтверждал ее не человек, а мы сами
    typical = plan_service.to_dict(short)
    drawn = {**typical, "edited": True}
    assert any("вы не чертили" in risk for risk in by_default.scenarios[1].verdict.risks)
    assert any(
        "вы не чертили" in risk for risk in calculate(CalculationRequest(plan=typical)).scenarios[1].verdict.risks
    )
    assert not any(
        "вы не чертили" in risk for risk in calculate(CalculationRequest(plan=drawn)).scenarios[1].verdict.risks
    )
    # план по анкете или фото человек не правил, но ворота и размеры назвал сам
    answered = {**typical, "template": "custom"}
    assert not any(
        "вы не чертили" in risk for risk in calculate(CalculationRequest(plan=answered)).scenarios[1].verdict.risks
    )


def test_simulation_gives_a_different_fleet_than_the_formula():
    """Симуляция видит очереди и зарядку, поэтому парк получается другим, и это видно в ответе."""
    by_formula = calculate(CalculationRequest())
    by_shift = calculate(CalculationRequest(use_simulation=True))
    assert by_formula.sizing.fleet_source == "формула"
    assert by_shift.sizing.fleet_source == "прогон смены"
    assert by_shift.sizing.fleet != by_formula.sizing.fleet


def test_robots_queue_only_in_their_own_aisle():
    """Место в проезде у каждого стеллажа свое: в один проезд на одного роботы встают в очередь,
    а по разным проездам едут, не мешая друг другу."""
    shared = Layout(task_points=POINTS, to_dock_m=FAR, aisle_of=[0, 0, 0], inside_dock_m=[10.0] * 3, dock_points=6)
    apart = Layout(task_points=POINTS, to_dock_m=FAR, aisle_of=[0, 1, 2], inside_dock_m=[10.0] * 3, dock_points=6)
    crowded = run_shift(shared, ROBOT, 6, PLENTY, 8, 42).kpi
    spread = run_shift(apart, ROBOT, 6, PLENTY, 8, 42).kpi
    assert crowded.waiting_share > spread.waiting_share
    assert crowded.ops_per_hour < spread.ops_per_hour


def test_path_is_cut_where_the_aisle_ends():
    near, far = split([(0.0, 0.0), (0.0, 10.0), (30.0, 10.0)], 0.25)  # 10 из 40 метров
    assert near == [(0.0, 0.0), (0.0, 10.0)]
    assert far == [(0.0, 10.0), (30.0, 10.0)]
    near, far = split([(0.0, 0.0), (40.0, 0.0)], 0.5)
    assert near[-1] == far[0] == (20.0, 0.0)


SHORT = RobotSpec(speed_m_s=1.0, handling_s=20, run_time_h=0.5, charge_time_h=0.3)  # садится за полчаса


def test_robots_queue_for_chargers_when_places_are_few():
    """Зарядных мест столько, сколько покупает экономика: парк, деленный на роботов на место."""
    few = run_shift(ROOMY, replace(SHORT, per_charger=6), 6, PLENTY, 8, 42).kpi
    enough = run_shift(ROOMY, replace(SHORT, per_charger=1), 6, PLENTY, 8, 42).kpi
    assert few.waiting_share > enough.waiting_share
    assert few.ops_per_hour < enough.ops_per_hour
    assert "зарядк" in few.bottleneck or "очереди" in few.bottleneck


def test_battery_goes_on_handling_too():
    """Батарея садится и от погрузки: при долгой погрузке робот заряжается чаще."""
    quick = run_shift(ROOMY, SHORT, 1, PLENTY, 8, 42).kpi
    slow = run_shift(ROOMY, replace(SHORT, handling_s=200), 1, PLENTY, 8, 42).kpi
    assert slow.charging_share == pytest.approx(quick.charging_share, rel=0.15)  # доля зарядки та же
    assert slow.done < quick.done


def test_robots_do_not_all_charge_at_once():
    """Заряд на старте у всех разный, поэтому в первый же час кто-то уже заряжается, а не все разом через шесть."""
    result = run_shift(ROOMY, replace(ROBOT, per_charger=0), 10, PLENTY, 8, 42)
    starts = sorted(part.from_s for part in result.segments if part.action == "заряжается")
    assert starts and starts[0] < 3600
    assert starts[-1] - starts[0] > 3 * 3600


def test_cleaner_washes_at_the_place_and_only_refills_at_the_base():
    """Уборщик моет на участке, а на базе только сливает и наливает воду, без очереди.

    Пример руками: одно место в 50 м от базы, скорость 1 м/с, мойка с водой 1000 с, из них
    100 с слив и налив. Рейс: 50 с туда, 900 с мойки у места, 50 с обратно, 100 с на базе,
    всего 1100 с, столько же, сколько при делении времени пополам (50 + 500 + 50 + 500).
    """
    near = Layout(task_points=[(0.0, 50.0)], to_dock_m=[50.0], dock_points=1)
    cleaner = RobotSpec(speed_m_s=1.0, handling_s=1000, run_time_h=100, charge_time_h=1, refill_s=100)
    result = run_shift(near, cleaner, 1, PLENTY, 2, 42)
    # в журнале уборщик моет и меняет воду, а не грузит
    assert "грузит" not in {part.action for part in result.segments}
    washing = [part for part in result.segments if part.action == "моет"]
    refilling = [part for part in result.segments if part.action == "меняет воду"]
    assert {part.path[0] for part in washing} == {(0.0, 50.0)}
    assert (0.0, 50.0) not in {part.path[0] for part in refilling}
    at_place = [part.to_s - part.from_s for part in washing]
    at_base = [part.to_s - part.from_s for part in refilling]
    assert at_place[0] == pytest.approx(900)
    assert at_base[0] == pytest.approx(100)
    assert result.kpi.avg_cycle_s == pytest.approx(1100)

    # пятеро уборщиков на базе с одним местом у ворот не ждут друг друга
    crowd = run_shift(near, cleaner, 5, PLENTY, 2, 42).kpi
    assert crowd.waiting_share == 0
    loader = run_shift(near, replace(cleaner, refill_s=None), 5, PLENTY, 2, 42).kpi
    assert loader.waiting_share > 0  # у перевозки половина погрузки у ворот, и там очередь


def test_cleaner_drives_a_snake_while_washing():
    """Пока уборщик моет, он ездит по своему участку змейкой по проездам, а не стоит у места.

    Мойка не одна точка, иначе на плане уборщики стоят по часу. Время мойки и итоги смены
    от пути не зависят: змейка нужна только проигрывателю. Путь идет по проезжим клеткам, отрезки
    вдоль осей, начинается и кончается у места, где робот начал мыть: дальше он едет к базе оттуда.
    """
    from app.engine import plan as plan_engine

    plan = plan_service.generate("warehouse", ["cleaning"])
    layout = build_layout(
        plan, plan_service.constants(), plan_service.measure(plan), robots_per_aisle=3, with_trails=True
    )
    grid = plan_engine.rasterize(plan, plan_service.constants())
    cleaner = RobotSpec(speed_m_s=0.7, handling_s=4000, run_time_h=100, charge_time_h=1, refill_s=400, area_m2=600)
    result = run_shift(layout, cleaner, 2, 1.5, 3, 42)
    washing = [part for part in result.segments if part.action == "моет"]
    assert washing
    for part in washing:
        assert len(part.path) > 4
        metres = sum(abs(b[0] - a[0]) + abs(b[1] - a[1]) for a, b in zip(part.path, part.path[1:], strict=False))
        assert metres > 100  # участок в 600 м2 полосами в метр это сотни метров, а не пятачок
        for a, b in zip(part.path, part.path[1:], strict=False):
            assert a[0] == b[0] or a[1] == b[1]
            steps = round(abs(b[0] - a[0]) + abs(b[1] - a[1]))
            for k in range(steps + 1):
                share = k / steps if steps else 0.0
                assert grid.free(*grid.cell(a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share))
    whole = [part for part in washing if part.to_s < 3 * 3600]
    assert whole and all(part.path[0] == part.path[-1] for part in whole)
    # итоги те же, что у уборщика, который моет стоя
    still = run_shift(layout, replace(cleaner, area_m2=0), 2, 1.5, 3, 42)
    assert {len(part.path) for part in still.segments if part.action == "моет"} == {1}
    assert result.kpi.done == still.kpi.done
    assert result.kpi.avg_cycle_s == still.kpi.avg_cycle_s
    # смена кончилась посреди мойки: змейка пройдена в той же доле, что и участок
    short = run_shift(layout, cleaner, 1, 1.0, 0.5, 42)
    last = [part for part in short.segments if part.action == "моет"][-1]
    assert last.to_s == pytest.approx(1800)
    assert last.path[-1] != last.path[0]
    # роботов больше, чем участков: кто домыл, стоит, и подпись говорит об этом, а не о пике спроса
    spare = run_shift(layout, cleaner, 6, 0.5, 3, 42).kpi
    assert "площадь смены" in spare.bottleneck


def test_ramp_is_a_single_lane():
    """По пандусу едут по одному: разъехаться на нем негде. Скорость на нем та же, что по полу."""
    gate = Gate(6, list(FAR), [0.0] * 3, [(0.0, 0.0)] * 3, [5.0] * 3, [20.0] * 3)
    upstairs = Layout(task_points=POINTS, to_dock_m=FAR, gates=[gate], gate_of=[0, 0, 0], ramps=1)
    flat = Layout(task_points=POINTS, to_dock_m=FAR, gates=[gate], gate_of=[0, 0, 0], ramps=0)
    alone = run_shift(upstairs, ROBOT, 1, PLENTY, 8, 42).kpi
    assert alone.avg_cycle_s == pytest.approx(run_shift(flat, ROBOT, 1, PLENTY, 8, 42).kpi.avg_cycle_s, rel=0.01)
    crowded = run_shift(upstairs, ROBOT, 12, PLENTY, 8, 42)
    assert crowded.kpi.waiting_share > run_shift(flat, ROBOT, 12, PLENTY, 8, 42).kpi.waiting_share
    assert crowded.kpi.ops_per_hour < 12 * alone.ops_per_hour * 0.9


def test_demand_has_a_peak_and_the_same_day_total():
    """Пример из докстроки, посчитанный руками: 1900 паллет за 22 часа, пик 1,5 два часа."""
    hours = demand_profile(1900 / 22, 1.5, 2, 22, 8)
    assert len(hours) == 8
    assert hours.count(pytest.approx(129.55, abs=0.01)) == 2
    assert hours[0] == pytest.approx(82.05, abs=0.01)
    assert 2 * 129.545 + 20 * hours[0] == pytest.approx(1900, abs=0.5)  # за сутки тот же объем
    assert hours[3] > hours[0] and hours[4] > hours[0]  # пик в середине смены


def test_shift_follows_the_demand_by_hour():
    """Роботов с запасом: сколько заданий пришло, столько и сделали, по профилю, а не по пику весь день."""
    hours = demand_profile(60, 1.5, 2, 22, 8)
    kpi = run_shift(ROOMY, ROBOT, 10, hours, 8, 42).kpi
    assert kpi.done == pytest.approx(sum(hours), abs=5)


def test_availability_takes_robots_not_stations():
    """10% роботов в ТО: парк работает как 90% исправных, а станции с людьми тянут столько же.
    Всю кривую не умножаем, иначе потолок двух станций 400 строк в час упадет до 360."""
    stations = Layout(
        task_points=POINTS, to_dock_m=FAR, to_station_m=FAR, dock_points=2, stations=2, station_service_s=18
    )
    curve = throughput_curve(stations, ROBOT, 60, PLENTY, 8, 42, every=4, availability=0.9)
    assert max(curve) == pytest.approx(2 * 3600 / 18, rel=0.03)
    plain = throughput_curve(ROOMY, ROBOT, 10, PLENTY, 8, 42, every=1)
    shifted = throughput_curve(ROOMY, ROBOT, 10, PLENTY, 8, 42, every=1, availability=0.9)
    assert shifted[10] == pytest.approx(plain[9], rel=0.02)  # 10 роботов работают как 9


def test_curve_stops_once_it_covers_the_demand():
    """Дальше спроса кривую не считаем: расчету парка она не нужна, а время ограничено."""
    curve = throughput_curve(ROOMY, ROBOT, 200, PLENTY, 8, 42, until=100)
    assert curve[-1] >= 100
    assert len(curve) < 20


def test_cleaner_gets_the_whole_shift_at_the_start_and_partial_zones_count():
    """Уборщик знает площадь на смену с утра и моет подряд, а недомытый к концу участок идет в зачет долей.

    Пример руками: участок в 50 м от базы, 1 м/с, мойка 1000 с, из них 100 с на базе, рейс 1100 с.
    Спрос 2,5 участка за смену в 1 час: три задания лежат с начала, третье на половину участка.
    Один уборщик за 3600 с успевает: рейс 1100, рейс 1100, третий начинает на 2200 с, доезжает
    за 50 с и моет 450 с (половина от 900), кончает на 2700 с и едет на базу. Сделано 2,5, весь спрос.
    Если смена короче, 1500 с, второй участок к концу вымыт на (1500 - 1150) / 900 = 0,389:
    сделано 1,389, а не 1.
    """
    near = Layout(task_points=[(0.0, 50.0)], to_dock_m=[50.0], dock_points=1)
    cleaner = RobotSpec(speed_m_s=1.0, handling_s=1000, run_time_h=100, charge_time_h=1, refill_s=100)
    result = run_shift(near, cleaner, 1, 2.5, 1, 42)
    washing = sorted(part.from_s for part in result.segments if part.action == "моет")
    assert washing[0] == pytest.approx(50)  # первый участок с утра, а не когда накапало
    assert result.kpi.done == pytest.approx(2.5)
    short = run_shift(near, cleaner, 1, 2.5 * 3600 / 1500, 1500 / 3600, 42)
    assert short.kpi.done == pytest.approx(1 + (1500 - 1150) / 900)
    # участок домыт на 950 с, робот едет к базе до 1000 с и меняет воду до 1100 с. Смена кончилась
    # на 1020 с, по дороге: участок засчитан целиком, вымытые метры не пропали
    on_the_way = run_shift(near, cleaner, 1, 1 * 3600 / 1020, 1020 / 3600, 42)
    assert on_the_way.kpi.done == pytest.approx(1)

    # у перевозки ничего не поменялось: задания приходят потоком, первое на 1440 с, второе на 2880 с,
    # и второй рейс (1100 с) к концу часа не успевает. Считаются только целые рейсы: сделан один
    loader = run_shift(near, replace(cleaner, refill_s=None), 1, 2.5, 1, 42)
    assert loader.kpi.done == 1
    assert float(loader.kpi.done).is_integer()


def test_cleaning_shift_on_the_warehouse_covers_the_demand():
    """Склад по умолчанию, уборка на Клинботикс 400 PRO: сделано столько, сколько спрос. Иначе
    первый участок появился бы через три часа, третий не успел бы, и сделано 2 участка из 2,97."""
    from app.services import calculation
    from app.services import simulation as service

    plan = service.plan_for("warehouse", "cleaning", None)
    result = service.run("warehouse", "cleaning", "clinbotics-400-pro", 1, plan, False, False, {})
    model, _ = calculation.model_with_overrides({})
    facility = next(f for f in model["facilities"] if f["id"] == "warehouse")
    operation = next(o for o in facility["operations"] if o["id"] == "cleaning")
    demand = sum(service.shift_demand(model, facility, operation))
    assert result.kpi.done * 933 == pytest.approx(demand, rel=0.01)
    assert result.kpi.busy_share > 0.5
