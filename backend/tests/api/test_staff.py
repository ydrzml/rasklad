"""Форма штата: из чего выбирают роли, что подставлено по умолчанию и что не сходится.

Проверки ввода нужны по ТЗ, п. 3.2.4: данные проверяем на диапазоны и на связность между собой.
Ни одна из них ничего не запрещает: мы считаем по числам пользователя и говорим, где они спорят.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

STAFF = [
    {"id": "forklift-operators", "role": "forklift_operator", "headcount": 25, "filled": 25, "salary_month": 120_000},
    {"id": "pickers", "role": "picker", "headcount": 100, "filled": 100, "salary_month": 100_000},
]


def check(**body):
    response = client.post("/api/staff/check", json={"operation_ids": ["pallet_transport"], **body})
    assert response.status_code == 200, response.text
    return response.json()


def kinds(review):
    return [note["kind"] for note in review["notes"]]


def test_roles_come_from_the_directory_without_the_ones_robots_bring():
    form = client.get("/api/staff", params={"operations": "pallet_transport"}).json()
    ids = [role["id"] for role in form["roles"]]
    assert "picker" in ids
    # оператора роботов и сервисного инженера пользователь не вводит: их считает модель
    assert "robot_operator" not in ids and "robot_engineer" not in ids

    picker = next(role for role in form["roles"] if role["id"] == "picker")
    assert picker["salary_month"] == 100_000
    assert (picker["salary_min"], picker["salary_max"]) == (70_000, 150_000)
    assert picker["productivity"] == 80 and picker["productivity_unit"] == "строк/ч"
    assert picker["salary_trust"] in "SABCDEF"

    loader = next(role for role in form["roles"] if role["id"] == "loader")
    assert loader["productivity"] is None and loader["no_productivity_note"]


def test_default_staff_covers_only_the_chosen_tasks():
    """Подставляем строки тех ролей, у кого выбранные задачи забирают работу, и только с данными."""
    lines = client.get("/api/staff", params={"operations": "pallet_transport"}).json()["lines"]
    assert [line["role"] for line in lines] == ["forklift_operator"]
    assert lines[0]["headcount"] == 25
    assert lines[0]["filled"] == 25  # пока пользователь не сказал иначе, штат считаем полным
    assert lines[0]["source"] and lines[0]["trust"] in "SABCDEF"

    both = client.get("/api/staff", params={"operations": "pallet_transport,cleaning"}).json()["lines"]
    assert [line["role"] for line in both] == ["forklift_operator", "cleaner"]
    assert both[1]["contractor"]  # уборку почти всегда отдают клининговой компании


def test_dataset_numbers_pass_without_warnings():
    review = check(staff=STAFF)
    assert [note for note in review["notes"] if note["level"] == "warn"] == []
    assert review["headcount_total"] == 125
    assert review["payroll_rub_year"] > 0


def test_volume_and_headcount_that_do_not_add_up():
    """Известное расхождение датасета: 100 000 строк в сутки при выработке 80 требуют 289 ставок, а отборщиков 100."""
    review = check(operation_ids=["piece_picking"], staff=STAFF)
    gap = next(note for note in review["notes"] if note["kind"] == "norm_gap")
    assert gap["role"] == "picker" and gap["level"] == "warn"
    assert "289" in gap["text"] and "100" in gap["text"]

    normative = next(role for role in review["roles"] if role["role"] == "picker")["normative_fte"]
    assert 289 < normative < 290


def test_role_without_productivity_is_named_out_loud():
    """Выработки грузчика мы не нашли, значит объем в ставки по нему не переводится."""
    review = check(staff=[*STAFF, {"id": "l", "role": "loader", "headcount": 12, "filled": 12, "salary_month": 82_000}])
    note = next(note for note in review["notes"] if note["kind"] == "no_productivity")
    assert note["role"] == "loader" and "не нашли" in note["text"]


def test_task_without_people_is_named_out_loud():
    review = check(operation_ids=["cleaning"], staff=STAFF)
    note = next(note for note in review["notes"] if note["kind"] == "no_staff")
    assert note["operation_id"] == "cleaning" and "уборщик" in note["text"]


def test_vacancies_and_surplus_are_told_apart():
    review = check(staff=[{**STAFF[0], "filled": 20}, {**STAFF[1], "filled": 110}])
    assert kinds(review).count("vacancies") == 1
    assert kinds(review).count("overfilled") == 1
    assert review["filled_total"] == 130


def test_salary_outside_the_market_range_is_a_warning_not_a_ban():
    review = check(staff=[{**STAFF[0], "salary_month": 300_000}, STAFF[1]])
    note = next(note for note in review["notes"] if note["kind"] == "salary_out_of_range")
    assert note["level"] == "warn" and "300 000" in note["text"]


def test_role_no_task_touches_is_a_note_not_a_warning():
    extra = {"id": "wms", "role": "wms_operator", "headcount": 3, "filled": 3, "salary_month": 92_000}
    review = check(staff=[*STAFF, extra])
    idle = {note["line_id"]: note for note in review["notes"] if note["kind"] == "idle_line"}
    assert idle["wms"]["level"] == "note"
    # отборщики тоже не участвуют: выбрана только перевозка паллет
    assert set(idle) == {"wms", "pickers"}


def test_entered_staff_goes_into_the_calculation():
    """Штат вводит пользователь, значит расчет обязан считать по нему, а не по отраслевым данным."""
    base = client.post("/api/calculations/preview", json={}).json()
    poor = client.post("/api/calculations/preview", json={"staff": [{**STAFF[0], "salary_month": 60_000}]}).json()
    assert poor["feasible"]
    # люди вдвое дешевле, значит роботы окупаются дольше
    assert poor["scenarios"][1]["payback_cumulative_years"] > base["scenarios"][1]["payback_cumulative_years"]
    assert poor["sizing"]["fleet"] == base["sizing"]["fleet"]  # парк от кадровых планов не зависит


def test_empty_staff_means_there_is_nobody_to_free():
    result = client.post("/api/calculations/preview", json={"staff": []}).json()
    assert result["feasible"]
    assert result["sizing"]["fte_before"] == 0


def test_check_offers_to_rescale_staff_when_volume_moved_after_entering_it():
    """Штат ввели под 2 000 паллет в сутки, объем стал 3 000: предлагаем 25 * 1,5 = 37,5, около 38.
    Занятые 15 * 1,5 = 22,5, 23. Роли и оклады те же. Без basis предложения нет, как и без изменения."""
    volume = "facilities.warehouse.operations.pallet_transport.volume_per_day"
    staff = [{"id": "f", "role": "forklift_operator", "headcount": 25, "filled": 15, "salary_month": 120000}]
    body = {"facility_id": "warehouse", "operation_ids": ["pallet_transport"], "staff": staff}
    quiet = client.post("/api/staff/check", json=body).json()
    assert quiet["rescale"] is None
    same = client.post("/api/staff/check", json={**body, "staff_basis": {volume: 2000}, "overrides": {volume: 2000}})
    assert same.json()["rescale"] is None
    moved = client.post("/api/staff/check", json={**body, "staff_basis": {volume: 2000}, "overrides": {volume: 3000}})
    rescale = moved.json()["rescale"]
    assert rescale is not None
    assert "вырос на 50%" in rescale["text"] and "2 000 -> 3 000 паллет в сутки" in rescale["text"]
    assert "25 мест, из них работает 15 человек" in rescale["text"]
    assert "около 38 мест (23 человек)" in rescale["text"]
    assert rescale["headcount_before"] == 25 and rescale["headcount_after"] == 38
    line = rescale["lines"][0]
    assert (line["headcount"], line["filled"], line["salary_month"], line["role"]) == (
        38,
        23,
        120000,
        "forklift_operator",
    )
    # объем упал: тоже предлагаем, вниз
    down = client.post("/api/staff/check", json={**body, "staff_basis": {volume: 2000}, "overrides": {volume: 1000}})
    assert "упал на 50%" in down.json()["rescale"]["text"]
    assert down.json()["rescale"]["headcount_after"] == 13


def test_default_staff_follows_the_volume_until_touched():
    """Штат по умолчанию это склад датасета: 100 отборщиков на 100 000 строк. Клиент с 15 000 строк
    получает 100 * 0,15 = 15 отборщиков, а не 100; без правок объема все как в данных организатора."""
    volume = "facilities.warehouse.operations.piece_picking.volume_per_day"
    plain = client.post("/api/staff/form", json={"facility_id": "warehouse", "operation_ids": ["piece_picking"]}).json()
    assert [(line["role"], line["headcount"]) for line in plain["lines"]] == [("picker", 100)]
    assert "данных организатора" in plain["note"] and "100 000 строк" in plain["note"]
    scaled = client.post(
        "/api/staff/form",
        json={"facility_id": "warehouse", "operation_ids": ["piece_picking"], "overrides": {volume: 15000}},
    ).json()
    assert [(line["role"], line["headcount"], line["filled"]) for line in scaled["lines"]] == [("picker", 15, 15)]
    assert "пересчитана под ваш объем" in scaled["note"]
    assert "пересчитано под ваш объем" in scaled["lines"][0]["source"]
    # старый адрес без правок остается
    same = client.get("/api/staff?facility=warehouse&operations=piece_picking").json()
    assert same["lines"][0]["headcount"] == 100
