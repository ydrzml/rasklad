from fastapi.testclient import TestClient

from app.main import app
from app.services import calculation

client = TestClient(app)
SALARY = "facilities.warehouse.staff.forklift-operators.salary_month"
VOLUME = "facilities.warehouse.operations.pallet_transport.volume_per_day"


def preview(**body):
    response = client.post("/api/calculations/preview", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_preview_returns_three_scenarios():
    result = preview()
    assert result["feasible"]
    assert [s["id"] for s in result["scenarios"]] == ["baseline", "purchase", "raas"]
    assert result["sizing"]["fleet"] == 10
    purchase = result["scenarios"][1]
    assert purchase["capex_total_rub"] > 0
    assert purchase["verdict"]["band"] == "до 3 лет"
    assert purchase["verdict"]["risks"]
    assert len(purchase["years"]) == result["horizon_years"]


def test_preview_shows_sources_and_weak_values():
    result = preview()
    paths = {s["path"] for s in result["sources"]}
    assert "robots.ronavi-h1500.price_rub" in paths
    # чужой робот в ответе не участвует
    assert not any(path.startswith("robots.ronavi-m") for path in paths)
    assert set(result["weak_value_paths"]) <= paths
    assert all(s["trust"] in "SABCDEF" for s in result["sources"])


def test_override_changes_result_and_is_recorded():
    base = preview()["scenarios"][1]["payback_cumulative_years"]
    changed = preview(overrides={SALARY: 150_000})
    assert changed["applied_overrides"] == {SALARY: 150_000}
    # дороже люди, значит роботы окупаются быстрее
    assert changed["scenarios"][1]["payback_cumulative_years"] < base


def test_unknown_override_path_is_rejected():
    response = client.post("/api/calculations/preview", json={"overrides": {"нет.такого.пути": 1}})
    assert response.status_code == 422


def test_impossible_schedule_is_rejected_with_reason():
    # за границами датасета считаем с пометкой, а больше 24 часов в сутках не считаем совсем
    shifts = "facilities.warehouse.schedule.shifts"
    response = client.post("/api/calculations/preview", json={"overrides": {shifts: 12}})
    assert response.status_code == 422
    assert "в сутках 24" in response.json()["detail"]
    assert preview(overrides={shifts: 2.1})["feasible"]


def test_unknown_robot_is_not_found():
    response = client.post("/api/calculations/preview", json={"robot_id": "нет-такого"})
    assert response.status_code == 404


def test_infeasible_when_robot_cannot_cover_demand():
    result = preview(overrides={"facilities.warehouse.operations.pallet_transport.volume_per_day": 1_900_000})
    assert not result["feasible"]
    assert result["cause"] == "solution"
    # сообщение называет задачу и решение, иначе его читают как про другую покупку
    model, _ = calculation.model_with_overrides({})
    robot = next(one["model"] for one in model["robots"] if one["id"] == result["robot_id"])
    assert result["message"].startswith(f"Перевозка паллет между зонами, {robot}: парк не покрывает пик ")


def test_empty_plan_is_named_as_the_reason_not_the_robot():
    """План без стеллажей: прогону смены некуда везти груз, и не сходится любой робот. Виноват план."""
    built = client.post(
        "/api/plan/generate",
        json={
            "facility_id": "warehouse",
            "operation_ids": ["pallet_transport"],
            "template_id": "custom",
            "overrides": {},
            "width_m": 118,
            "length_m": 85,
            "custom": {"docks": [{"wall": "west", "count": 10}], "racks": "none"},
        },
    )
    assert built.status_code == 200, built.text
    task = {"operation_id": "pallet_transport", "robot_id": "moros-amr-800", "share": 1}
    result = preview(tasks=[task], plan=built.json()["plan"], use_simulation=True)
    assert not result["feasible"]
    assert result["cause"] == "plan"
    assert result["message"].startswith("Перевозка паллет между зонами, AMR 800: парк не покрывает пик ")
    assert "план не заполнен" in result["message"]


def test_catalog_lists_facilities_solutions_and_form_fields():
    facilities = client.get("/api/catalog/facilities").json()
    assert [f["id"] for f in facilities] == ["warehouse", "airport", "clinic", "other"]
    warehouse = facilities[0]
    # задачи объекта, из которых пользователь выбирает, что роботизировать
    assert [o["id"] for o in warehouse["operations"]] == ["pallet_transport", "piece_picking", "cleaning"]
    cleaning = warehouse["operations"][2]
    assert cleaning["unit"] == "м2/сут"
    assert cleaning["processes"] == ["Уборка помещений"]  # по ним подбираются решения из каталога

    solutions = client.get("/api/catalog/solutions").json()
    assert {s["product"] for s in solutions if s["can_calculate"]} >= {"Ronavi H1500 (грузоподъемность до 1 500 кг)"}

    fields = client.get("/api/catalog/parameters", params={"operations": "pallet_transport"}).json()
    assert {f["path"] for f in fields} >= {VOLUME, "economics.horizon_years"}
    volume = next(f for f in fields if f["path"] == VOLUME)
    assert volume["min"] <= volume["value"] <= volume["max"]
    assert volume["unit"] == "паллет/сут"
    # поле знает, в каком блоке экрана оно стоит: объект или конкретная задача
    assert volume["group_name"] == "Перевозка паллет между зонами"
    assert next(f for f in fields if f["path"] == "economics.horizon_years")["group_name"] == "Объект"


def test_pallet_load_is_on_top_when_pallets_are_moved():
    """Масса паллеты решает, какие роботы поднимут груз, поэтому стоит среди главных полей шага."""
    load = "facilities.warehouse.operations.pallet_transport.load_kg"
    fields = client.get("/api/catalog/parameters", params={"operations": "pallet_transport"}).json()
    assert next(f for f in fields if f["path"] == load)["key"]
    # без перевозки паллет поля нет вовсе
    fields = client.get("/api/catalog/parameters", params={"operations": "cleaning"}).json()
    assert load not in {f["path"] for f in fields}


def test_form_fields_cover_what_the_user_may_change():
    """ТЗ, п. 3.5.3: стоимость персонала, режим работы, производительность, горизонт и загрузка."""
    fields = client.get("/api/catalog/parameters", params={"operations": "piece_picking"}).json()
    paths = {f["path"] for f in fields}
    # стоимость персонала правится не полем формы, а строкой штата: одну роль можно завести несколько раз
    assert not any(".staff." in path for path in paths)
    assert "facilities.warehouse.schedule.shifts" in paths
    assert "facilities.warehouse.operations.piece_picking.productivity_before" in paths
    assert "economics.horizon_years" in paths


def test_catalog_data_is_reachable_where_the_app_runs():
    """В контейнере каталог лежит не рядом с репозиторием: проверяем, что путь берется из настроек."""
    from app.services.selection import catalog

    assert len(catalog()) == 31


def test_first_step_tells_what_can_be_calculated_and_what_only_counted():
    """Первый шаг: у склада задачи и расчет, у остальных типов только счет решений и честная пометка."""
    facilities = {f["id"]: f for f in client.get("/api/catalog/facilities").json()}

    warehouse = facilities["warehouse"]
    assert warehouse["status"] == "ready"
    assert warehouse["catalog"]["count"] == 31  # наш отобранный каталог, а не сырые позиции организатора

    # у аэропорта и больницы расчета нет, но есть задачи, параметры и разобранный список решений
    for short in ("airport", "clinic"):
        assert facilities[short]["status"] == "solutions"
        assert facilities[short]["operations"]
    assert facilities["other"]["status"] == "catalog_only"
    assert facilities["other"]["operations"] == []  # выбрать нечего, объекта в расчетной модели нет
    for other in ("airport", "clinic", "other"):
        assert facilities[other]["catalog"]["count"] > 0
        assert facilities[other]["catalog"]["note"]  # число без объяснения на карточке не показываем


def test_task_shows_whose_work_it_is_and_how_robots_take_it():
    """В строке задачи видно, у кого забирают работу и каким способом (docs/ux-flow.md, шаг «Объект»)."""
    warehouse = client.get("/api/catalog/facilities").json()[0]
    tasks = {o["id"]: o for o in warehouse["operations"]}

    assert tasks["pallet_transport"]["performed_by"] == ["Оператор погрузчика", "Грузчик"]
    assert tasks["pallet_transport"]["takeover"] == "replace"
    # у отбора робот подвозит стеллаж, человек остается на станции и работает быстрее
    assert tasks["piece_picking"]["takeover"] == "speedup"
    assert all(task["solutions_count"] > 0 and task["available"] for task in tasks.values())
    assert tasks["cleaning"]["volume_trust"] == "F"  # частоту уборки организатор не дает, это наше допущение


def test_unknown_facility_is_not_found():
    assert client.get("/api/catalog/operations", params={"facility": "нет такого"}).status_code == 404


def test_cleaning_task_is_usable_without_a_load():
    """Робот-уборщик ничего не поднимает: подбор и форма должны работать и без груза у задачи."""
    solutions = client.get("/api/catalog/solutions", params={"operation": "cleaning"})
    assert solutions.status_code == 200
    assert [s for s in solutions.json() if s["status"] != "excluded"]
    assert all("Грузоподъемность" not in [c["label"] for c in s["checks"]] for s in solutions.json())

    fields = client.get("/api/catalog/parameters", params={"operations": "cleaning"})
    assert fields.status_code == 200
    assert "facilities.warehouse.operations.cleaning.volume_per_day" in {f["path"] for f in fields.json()}


def test_several_tasks_bring_the_fields_of_each():
    """На шаге параметров задач может быть несколько, и поля идут блоками в порядке выбора."""
    fields = client.get("/api/catalog/parameters", params={"operations": "cleaning,pallet_transport"}).json()
    groups = list(dict.fromkeys(f["group"] for f in fields))
    assert groups == ["warehouse", "cleaning", "pallet_transport"]


def test_unknown_task_is_not_found():
    assert client.get("/api/catalog/parameters", params={"operations": "нет такой"}).status_code == 404


def test_sources_have_names_in_words():
    # в "Откуда цифры" человек видит название, а не путь в модели вроде economics.annual_work_hours
    for source in preview()["sources"]:
        assert source["name"] and not source["name"].isascii(), source["path"]


def test_demo_numbers_of_other_tasks_stay_where_they_were():
    """Правки отбора товара (люди от объема, выработка, строки за подачу) других задач не трогают.
    Паллетный демо-расчет на типовом плане: 9 роботов, 41,39 млн, 1,33 года; уборка: 1 робот, 3,92 года."""
    plan = client.post("/api/plan/generate", json={"operation_ids": ["pallet_transport"]}).json()["plan"]
    pallets = preview(operation_id="pallet_transport", robot_id="ronavi-h1500", plan=plan)
    purchase = pallets["scenarios"][1]
    assert pallets["sizing"]["fleet"] == 9
    assert round(purchase["capex_total_rub"] / 1e6, 2) == 41.39
    assert round(purchase["payback_cumulative_years"], 2) == 1.33
    cleaning = preview(operation_id="cleaning", robot_id="clinbotics-600")
    assert cleaning["sizing"]["fleet"] == 1
    assert round(cleaning["scenarios"][1]["payback_cumulative_years"], 2) == 3.92


def test_picking_demo_after_checking_the_dataset():
    """Отбор на данных датасета после проверки его цифр: 56 роботов, покупка окупается за 3,25 года."""
    result = preview(operation_id="piece_picking", robot_id="ronavi-m")
    assert result["sizing"]["fleet"] == 56
    assert round(result["scenarios"][1]["payback_cumulative_years"], 2) == 3.25
