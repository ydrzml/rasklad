"""Что подготовить на складе: пункты из плана, характеристик робота и прогона смены."""

import pytest
from fastapi.testclient import TestClient

from app.engine import plan as P
from app.engine import readiness as R
from app.main import app
from app.services import plan as plan_service

client = TestClient(app)


@pytest.fixture(scope="module")
def constants():
    return plan_service.constants()


@pytest.fixture(scope="module")
def warehouse(constants):
    return P.generate(
        plan_service.template("one_side"), constants, 10_000, ceiling_m=10, margin_m=plan_service.LOT_MARGIN_M
    )


def _robot(**changes) -> R.RobotFacts:
    base = dict(
        name="Робот",
        task="",
        mobile=True,
        fleet=9,
        chargers=3,
        charger_price_rub=450_000,
        charger_price=R.Spec("450000", "C", "Ronavi Charger 450 000 руб"),
    )
    return R.RobotFacts(**{**base, **changes})


def _plan(**changes) -> R.PlanFacts:
    return R.PlanFacts(**{**dict(aisle_m=3.5, rack_top_m=6.8, closed_racks=0), **changes})


def _raised_with_ramp(warehouse, w=4, h=6):
    """Антресоль на 1,2 м вдоль северной стены и пандус поперек ее края: юг внизу, север наверху."""
    hall = warehouse.sections[0]
    top = P.Section("mezzanine", hall.x, hall.y + hall.h - 20, hall.w, 20, 1.2, 8.8)
    ramp = P.Item(id="ramp", kind=P.RAMP, x=top.x + 2, y=top.y - h / 2, w=w, h=h)
    return P.Plan(
        width_m=warehouse.width_m,
        length_m=warehouse.length_m,
        template=warehouse.template,
        items=[*warehouse.items, ramp],
        sections=[*warehouse.sections, top],
    )


def test_ramp_length_goes_along_the_floor_change(warehouse, constants):
    # отметка меняется с юга на север, значит длина пандуса это его высота на плане, 6 м, а не 4
    plan = _raised_with_ramp(warehouse)
    ramps = R.ramps_of(plan, P.rasterize(plan, constants))
    assert len(ramps) == 1
    assert ramps[0].length_m == 6
    assert ramps[0].drop_m == pytest.approx(1.2)
    assert ramps[0].slope == pytest.approx(20)


def test_steep_ramp_is_redo_with_the_length_it_needs():
    robot = _robot(conditions=[R.Spec("уклон ≤5%, ступень 5 мм, впадина 30 мм", "C", "производитель")])
    items = R.ramp_items(_plan(ramps=[R.Ramp(6, 1.2)]), robot)
    assert [item.status for item in items] == [R.REDO]
    # 1,2 м подъема при 5% это 24 м пандуса
    assert "не короче 24,0 м" in items[0].why


def test_ramp_without_published_incline_is_to_check():
    items = R.ramp_items(_plan(ramps=[R.Ramp(24, 1.2)]), _robot())
    assert [item.status for item in items] == [R.CHECK]
    assert "не публикует" in items[0].why


def test_ramp_that_leads_nowhere_is_redo():
    items = R.ramp_items(_plan(ramps=[R.Ramp(6, 0.0)]), _robot())
    assert items[0].status == R.REDO


def test_incline_in_degrees_becomes_percent():
    robot = _robot(conditions=[R.Spec("макс. уклон 2°; твердые промышленные полы")])
    allowed, _ = R.incline(robot)
    assert allowed == pytest.approx(3.49, abs=0.01)


def test_floor_and_temperature_are_split_from_one_source_line():
    robot = _robot(conditions=[R.Spec("+5…+25 °C; ровный промышленный пол", "D", "организатор")])
    assert R.floor_needs(robot)[0].value == "ровный промышленный пол"
    assert R.temperature(robot).value == "+5…+25 °C"


@pytest.mark.parametrize(
    ("need", "status"),
    [("750", R.READY), ("3500", R.READY), ("3600", R.REDO), (None, R.CHECK)],
)
def test_aisle_against_the_robot(need, status):
    robot = _robot(aisle_mm=R.Spec(need, "B") if need else None)
    assert R.aisle_item(_plan(), robot).status == status


def test_lift_is_checked_only_for_stackers():
    # подхват с пола до яруса не тянется: у паллетной тележки с подъемом 60 мм пункта нет
    assert R.lift_item(_plan(), _robot(lift_mm=R.Spec("60"))) is None
    short = R.lift_item(_plan(rack_top_m=8.0), _robot(lift_mm=R.Spec("7000", "C")))
    assert short.status == R.CHECK
    assert R.lift_item(_plan(rack_top_m=6.8), _robot(lift_mm=R.Spec("7000", "C"))).status == R.READY


@pytest.mark.parametrize(
    ("navigation", "status", "word"),
    [
        ("QR-метки + SLAM", R.CHECK, "QR-метки на пол"),
        ("камера + потолочные оптические метки", R.CHECK, "на потолке"),
        ("RTLS (радиомаяки-анкеры) + лидар", R.CHECK, "радиомаяки"),
        ("3D-лидар 360°, SLAM", R.READY, "Меток не нужно"),
    ],
)
def test_navigation_says_what_to_put_on_the_floor(navigation, status, word):
    item = R.navigation_item(_robot(navigation=R.Spec(navigation, "C")))
    assert item.status == status
    assert word in item.why


def test_things_we_cannot_see_are_never_ready():
    # покрытие сети, пол и температуру клиента мы не знаем: такие пункты всегда проверить
    robot = _robot(connectivity=R.Spec("Wi-Fi 5 ГГц", "C"), conditions=[R.Spec("+5…+25 °C; ровный пол")])
    items = R.robot_items(_plan(), robot, 300_000, R.Spec("", "F"))
    for key in ("network", "floor", "temperature"):
        assert next(item for item in items if item.id == key).status == R.CHECK


def test_charger_cost_only_with_a_source():
    item = R.charge_item(_robot())
    assert item.cost == "1,35 млн ₽"
    assert "3 места по 450 тыс. ₽" in item.cost_note
    free = R.charge_item(_robot(charger_price_rub=0, charger_price=R.Spec("0", "F", "цены отдельно нет")))
    assert free.cost == "" and free.cost_note == R.NO_PRICE


def test_queue_is_to_check_and_names_the_place():
    busy = R.queue_item(_robot(waits={"ворота": 0.25, "проезд": 0.02}, waiting_share=0.27))
    assert busy.status == R.CHECK
    assert "у ворот" in busy.why
    calm = R.queue_item(_robot(waits={"ворота": 0.01}, waiting_share=0.01))
    assert calm.status == R.READY


def test_list_goes_redo_check_ready():
    found = R.collect(
        _plan(ramps=[R.Ramp(6, 1.2)]),
        [_robot(aisle_mm=R.Spec("750", "B"), conditions=[R.Spec("уклон ≤5%")])],
        300_000,
        R.Spec("", "F"),
    )
    order = [R.ORDER[item.status] for item in found.items]
    assert order == sorted(order)
    assert found.counts[R.REDO] == 1


def test_api_gives_the_list_for_the_default_warehouse():
    answer = client.post(
        "/api/readiness",
        json={"tasks": [{"operation_id": "pallet_transport", "robots": [{"robot_id": "ronavi-h1500", "fleet": 9}]}]},
    )
    assert answer.status_code == 200
    data = answer.json()
    by_id = {item["id"]: item for item in data["items"]}
    # Ronavi H1500 ездит по QR-меткам, у него Wi-Fi 5 ГГц и зарядка 450 тыс. за место на 4 робота
    assert by_id["navigation"]["status"] == "check"
    assert "5 ГГц" in by_id["network"]["why"]
    assert by_id["charge"]["cost"] == "1,35 млн ₽"
    assert by_id["aisle"]["status"] == "ready"
    assert "queues" in by_id
    assert sum(data["counts"].values()) == len(data["items"])
    assert data["plan_edited"] is False


def test_api_unknown_robot_is_404():
    answer = client.post(
        "/api/readiness",
        json={"tasks": [{"operation_id": "pallet_transport", "robots": [{"robot_id": "nobody", "fleet": 3}]}]},
    )
    assert answer.status_code == 404


def test_zero_fleet_gives_a_list_without_charging_and_queues():
    # при нулевом объеме парк ноль: отчет все равно собирается, гонять смену нечего
    answer = client.post(
        "/api/readiness",
        json={"tasks": [{"operation_id": "pallet_transport", "robots": [{"robot_id": "ronavi-h1500", "fleet": 0}]}]},
    )
    assert answer.status_code == 200
    ids = {item["id"] for item in answer.json()["items"]}
    assert "charge" not in ids and "queues" not in ids


def test_source_shows_the_site_not_the_long_address():
    from app.services.readiness import site

    assert site("https://khvrptyuackxdmxadmin.dikom-a.ru/wp-content/uploads/2025/10/buklet.pdf") == "dikom-a.ru"
    assert site("https://www.kiit.ru/product/amr") == "kiit.ru"
    assert site("https://ronavi-robotics.ru/catalogue/h1500") == "ronavi-robotics.ru"


def test_two_solutions_on_one_task_bring_both_requirements():
    # смешанный парк: пункт один на задачу, в нем оба робота, состояние по самому строгому
    answer = client.post(
        "/api/readiness",
        json={
            "tasks": [
                {
                    "operation_id": "pallet_transport",
                    "robots": [{"robot_id": "ronavi-h1500", "fleet": 4}, {"robot_id": "dikom-dmr-1200", "fleet": 3}],
                }
            ]
        },
    )
    assert answer.status_code == 200
    items = answer.json()["items"]
    aisles = [item for item in items if item["id"] == "aisle"]
    assert len(aisles) == 1
    assert aisles[0]["solution"] == "Ronavi H1500, DMR 1200"
    # H1500 ездит по QR-меткам, DMR 1200 по лидару: строже H1500, пункт "проверить" его словами
    navigation = next(item for item in items if item["id"] == "navigation")
    assert navigation["status"] == "check" and navigation["why"].startswith("Ronavi H1500:")
    # зарядки у каждого свои: 1 место на 4 H1500 за 450 тыс. и 1 на 3 DMR 1200, у ДиКом станция в комплекте, 0
    charge = next(item for item in items if item["id"] == "charge")
    assert charge["cost"] == "450 тыс. ₽"
    floor = next(item for item in items if item["id"] == "floor")
    assert floor["status"] == "check"


def test_merge_takes_the_strictest_status():
    steep = R.Spec("уклон ≤5%", "C", "производитель")
    gentle = R.Spec("допустимый уклон 8%", "C", "производитель")
    found = R.collect(
        _plan(ramps=[R.Ramp(20, 1.2)]),
        [
            _robot(name="Первый (1 т)", operation="pallet", conditions=[gentle]),
            _robot(name="Второй (2 т)", operation="pallet", conditions=[steep]),
        ],
        0,
        R.Spec("", "F"),
    )
    ramp = next(item for item in found.items if item.id == "ramp-1")
    # 6% на плане: первый берет 8%, второй только 5%, значит переделать и слова второго
    assert ramp.status == R.REDO
    assert ramp.solution == "Первый, Второй"
    assert ramp.why.startswith("Второй:")


def test_merged_texts_go_on_separate_lines():
    # у двух роботов с одинаковым состоянием слова каждого своей строкой, а не одним абзацем
    found = R.collect(
        _plan(),
        [_robot(name="Первый (1 т)", operation="pallet"), _robot(name="Второй (2 т)", operation="pallet")],
        0,
        R.Spec("", "F"),
    )
    floor = next(item for item in found.items if item.id == "floor")
    lines = floor.why.split("\n")
    assert [line.split(":")[0] for line in lines] == ["Первый", "Второй"]
