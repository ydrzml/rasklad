import pytest
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
    assert [f["id"] for f in facilities] == ["warehouse", "clinic", "airport", "other"]
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
    # частоту уборки организатор не дает, раз в сутки это практика клининга, оценка D
    assert tasks["cleaning"]["volume_trust"] == "D"


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
    """Правки отбора товара (люди от анкеты, выработка, строки за подачу) других задач не трогают.
    Паллеты на типовом плане при режиме 2 смены по 11 ч, 365 дней, парк по формуле:
    2 000 * 0,95 / 22 * 1,5 * 1,15 / 17,83 = 8,4, вверх 9 роботов, 33,04 млн без НДС, 1,06 года, прогон смены
    дает тот же парк (на пятидневке 2 смены по 8 ч с 17.10.2026 было 12 роботов, 41,93 млн, 2,17 года).
    Уборка: 1 робот, робот сравнивается с оператором поломоечной машины и моет всю ее площадь,
    1,46 ставки, окупается за 3,4 года (docs/decisions.md, «Уборка против поломоечной машины»,
    «Уборка: сравниваем с тем, как убирают сейчас»)."""
    plan = client.post("/api/plan/generate", json={"operation_ids": ["pallet_transport"]}).json()["plan"]
    pallets = preview(operation_id="pallet_transport", robot_id="ronavi-h1500", plan=plan)
    purchase = pallets["scenarios"][1]
    assert pallets["sizing"]["fleet"] == 9
    assert round(purchase["capex_total_rub"] / 1e6, 2) == 33.04
    assert round(purchase["payback_cumulative_years"], 2) == 1.06
    cleaning = preview(operation_id="cleaning", robot_id="clinbotics-600")
    assert cleaning["sizing"]["fleet"] == 1
    # машине 10 000 * 365 / 1 250 = 2 920 часов в год, пост 2 000 часов: 1,46 поста, робот берет все
    assert cleaning["sizing"]["fte_before"] == pytest.approx(1.46)
    assert cleaning["scenarios"][1]["payback_cumulative_years"] == pytest.approx(3.39, abs=0.05)


def test_picking_demo_after_checking_the_dataset():
    """Отбор на данных датасета при режиме 2 смены по 11 ч, 365 дней: 35 000 строк, 100 отборщиков * 30% = 30
    ставок, после 30 * 80 / 250 = 9,6. Роботов по формуле 35 000 * 0,3 / 22 * 1,5 * 1,15 / 42,75 = 19,3, вверх 20,
    станций 823 / 250 = 3,3, вверх 4. Покупка окупается за 2,59 года (docs/decisions.md, "Типовой режим
    склада"; на пятидневке 2 смены по 8 ч было 27 роботов на 5 станций, и за 5 лет не окупалось)."""
    result = preview(operation_id="piece_picking", robot_id="ronavi-m")
    assert result["sizing"]["fleet"] == 20
    assert result["sizing"]["stations"] == 4
    assert result["sizing"]["fte_before"] == pytest.approx(30)
    assert result["sizing"]["fte_after"] == pytest.approx(9.6)
    assert round(result["scenarios"][1]["payback_cumulative_years"], 2) == 2.59


def test_preview_refuses_solution_that_selection_excludes():
    heavy = preview(overrides={"facilities.warehouse.operations.pallet_transport.load_kg": 3000})
    assert heavy["feasible"] is False
    assert heavy["scenarios"] == []
    assert "не подходит для задачи" in heavy["message"]
    assert "Ronavi H1500" in heavy["message"]
    assert "3000" in heavy["message"]


def test_preview_refuses_solution_from_other_task():
    other = preview(robot_id="clinbotics-600")
    assert other["feasible"] is False
    assert "Перевозка паллет" in other["message"]


def _risks(result: dict) -> list[str]:
    return next(s for s in result["scenarios"] if s["id"] == "purchase")["verdict"]["risks"]


def test_staff_that_does_not_match_the_volume_is_named_in_the_risks():
    """Экономия идет от анкеты, роботы от объема. 100 отборщиков на 100 000 строк датасета при нормативе
    100 000 * 365 / (80 * 1972) * 1,25 = 289,2:
    отбор считается от анкеты (100 * 0,3 = 30 ставок), и вывод говорит, что по объему нужно больше."""
    staff = [{"id": "p", "role": "picker", "headcount": 100, "filled": 100, "salary_month": 100_000}]
    result = preview(
        operation_id="piece_picking",
        robot_id="ronavi-m",
        staff=staff,
        overrides={"facilities.warehouse.operations.piece_picking.volume_per_day": 100_000},
    )
    assert result["sizing"]["fte_before"] == pytest.approx(30)
    note = next(risk for risk in _risks(result) if risk.startswith("Экономия посчитана от вашего штата"))
    assert "100 мест" in note and "289,2" in note
    # штат по нормативу, расхождения нет, строки нет
    plain = preview(operation_id="piece_picking", robot_id="ronavi-m")
    assert not any(risk.startswith("Экономия посчитана") for risk in _risks(plain))


def test_floor_robot_under_high_racks_is_named_in_the_risks():
    """На типовом плане верхний ярус 6,8 м, а Ronavi H1500 возит паллеты по полу: кто ставит груз в стеллаж."""
    plan = client.post("/api/plan/generate", json={"operation_ids": ["pallet_transport"]}).json()["plan"]
    on_plan = preview(operation_id="pallet_transport", robot_id="ronavi-h1500", plan=plan)
    assert any("возит паллеты по полу" in risk and "6,8 м" in risk for risk in _risks(on_plan))
    # без плана стеллажей мы не знаем, строки нет
    assert not any("возит паллеты по полу" in risk for risk in _risks(preview()))


def test_trial_year_of_rent_then_buyout_is_the_same_engine_with_a_one_year_contract():
    """Год в аренду как проверка, потом выкуп: тот же расчет, что выкуп, только договор на 12 месяцев.

    Руками, паллеты на типовом плане, 9 Ronavi H1500, без НДС 22%: выкуп в конце первого года
    9 * 2,7 млн * (1 - 1 / 5) / 1,22 = 15,93 млн. Стоимость владения та же, что у аренды с выкупом
    при договоре 12 месяцев, которую человек может задать сам на шаге параметров."""
    plan = client.post("/api/plan/generate", json={"operation_ids": ["pallet_transport"]}).json()["plan"]
    result = preview(operation_id="pallet_transport", robot_id="ronavi-h1500", plan=plan)
    rent = next(s for s in result["scenarios"] if s["id"] == "raas")
    trial = rent["trial"]
    assert trial["months"] == 12
    assert trial["price_rub"] == pytest.approx(9 * 2_700_000 * 0.8 / 1.22)
    assert trial["cumulative_cost_rub"][0] == pytest.approx(rent["investment_year0_rub"])
    assert trial["cumulative_cost_rub"][-1] == pytest.approx(trial["tco_rub"])
    same = preview(
        operation_id="pallet_transport",
        robot_id="ronavi-h1500",
        plan=plan,
        raas_buyout=True,
        overrides={"robots.ronavi-h1500.raas.contract_months": 12},
    )
    with_buyout = next(s for s in same["scenarios"] if s["id"] == "raas")
    assert with_buyout["tco_rub"] == pytest.approx(trial["tco_rub"])
    assert with_buyout["trial"] is None


def test_rent_is_without_buyout_and_buyout_is_a_separate_case():
    """Аренда базово как найм: договор продлевается с индексацией, выкупа нет. Выкуп отдельным кейсом.

    Руками, паллеты на типовом плане, 9 Ronavi H1500 по формуле, все без НДС 22%. Выкуп в конце 3 года:
    9 * 2,7 млн * (1 - 3 / 5) / 1,22 = 7,97 млн. После договора аренда в год: плата
    9 * 100 000 * 12 * 1,04^3 / 1,22 = 9,958 млн и порча 1% цены с инфляцией, в среднем за 4 и 5 год 10,19 млн.
    Свои роботы: ТО 10% цены и лицензии, 2,79 млн. Разница 7,39 млн в год, выкуп окупается за
    7,97 / 7,39 = 1,08 года, за 5 лет с выкупом дешевле на 2 * 7,39 - 7,97 = 6,82 млн."""
    plan = client.post("/api/plan/generate", json={"operation_ids": ["pallet_transport"]}).json()["plan"]
    result = preview(operation_id="pallet_transport", robot_id="ronavi-h1500", plan=plan)
    rent = next(s for s in result["scenarios"] if s["id"] == "raas")
    assert rent["name"] == "Аренда"
    assert all(year["investment_rub"] == 0 for year in rent["years"])
    assert rent["years"][3]["opex_rub"]["raas_fee"] == pytest.approx(9 * 100_000 * 12 * 1.04**3 / 1.22)
    assert rent["verdict"]["text"].startswith("Аренда выгоднее людей с первого года")
    buyout = rent["buyout"]
    assert buyout["year"] == 3
    assert buyout["price_rub"] == pytest.approx(9 * 2_700_000 * 0.4 / 1.22)
    assert buyout["rent_year_rub"] == pytest.approx(10.19e6, abs=0.01e6)
    assert buyout["own_year_rub"] == pytest.approx(2.79e6, abs=0.01e6)
    assert buyout["payback_years"] == pytest.approx(7.97 / 7.39, abs=0.01)
    assert buyout["cheaper_rub"] == pytest.approx(6.82e6, abs=0.01e6)

    assert buyout["worth"] is True
    # выкуп по запросу: старая аренда с выкупом, отдельного кейса тогда нет
    bought = preview(operation_id="pallet_transport", robot_id="ronavi-h1500", plan=plan, raas_buyout=True)
    with_buyout = next(s for s in bought["scenarios"] if s["id"] == "raas")
    assert with_buyout["buyout"] is None
    assert with_buyout["tco_rub"] == pytest.approx(buyout["tco_rub"])
