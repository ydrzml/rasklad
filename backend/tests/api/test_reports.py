from io import BytesIO

from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.main import app
from app.reports import names

client = TestClient(app)


def test_pdf_report_is_a_pdf_with_a_file_name():
    response = client.post("/api/reports/pdf", json={})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF")
    assert "attachment" in response.headers["content-disposition"]
    assert ".pdf" in response.headers["content-disposition"]


def _years_total(book, scenario: str) -> float:
    """Накопленные затраты сценария по листу «По годам»: сумма колонок людей, роботов и вложений"""
    rows = [r for r in book["По годам"].iter_rows(min_row=6, values_only=True) if r[0] == scenario]
    return sum(r[2] + r[3] + r[4] for r in rows)


def test_excel_holds_the_same_numbers_as_the_screen():
    preview = client.post("/api/calculations/preview", json={}).json()
    response = client.post("/api/reports/xlsx", json={})
    assert response.status_code == 200, response.text
    book = load_workbook(BytesIO(response.content))
    # без прогона смены листа «Смена» нет, чувствительность есть всегда
    assert book.sheetnames == [
        "Итог",
        "По годам",
        "Затраты",
        "Что будет, если",
        "Парк и штат",
        "Параметры",
        "Источники",
    ]
    # итог считается формулами из листа по годам, а сами годы складываются в стоимость владения
    tco = next(r for r in book["Итог"].iter_rows(values_only=True) if str(r[0]).startswith("Стоимость владения"))
    assert all(str(cell).startswith("='По годам'!G") for cell in tco[1:4])
    for name, scenario in zip(["Без роботов", "Покупка", "Аренда"], preview["scenarios"], strict=True):
        assert abs(_years_total(book, name) - scenario["tco_rub"]) < 0.01
    # каждое значение расчета попало на лист источников
    assert book["Источники"].max_row - 5 == len(preview["sources"])


def test_report_keeps_user_edits():
    salary = "facilities.warehouse.staff.forklift-operators.salary_month"
    base = client.post("/api/calculations/preview", json={}).json()
    edited = client.post("/api/calculations/preview", json={"overrides": {salary: 150000}}).json()
    book = load_workbook(BytesIO(client.post("/api/reports/xlsx", json={"overrides": {salary: 150000}}).content))
    assert abs(_years_total(book, "Без роботов") - edited["scenarios"][0]["tco_rub"]) < 0.01
    assert edited["scenarios"][0]["tco_rub"] != base["scenarios"][0]["tco_rub"]


def test_unknown_robot_is_not_found():
    response = client.post("/api/reports/pdf", json={"robot_id": "nope"})
    assert response.status_code in (404, 422)


def test_cumulative_costs_end_at_tco():
    for scenario in client.post("/api/calculations/preview", json={}).json()["scenarios"]:
        points = scenario["cumulative_cost_rub"]
        assert points[0] == scenario["investment_year0_rub"]
        assert abs(points[-1] - scenario["tco_rub"]) < 1
        assert abs(scenario["investment_year0_rub"] + scenario["running_cost_rub"] - scenario["tco_rub"]) < 1


def test_sources_hold_only_the_chosen_task_and_staff_names_are_russian():
    # уборка и отбор в расчете перевозки паллет не участвуют: ни на экране, ни в отчете их нет
    preview = client.post("/api/calculations/preview", json={}).json()
    tasks = {s["path"].split(".")[3] for s in preview["sources"] if ".operations." in s["path"]}
    assert tasks == {"pallet_transport"}
    assert all(".operations.pallet_transport." in p or ".operations." not in p for p in preview["weak_value_paths"])

    path = "facilities.warehouse.staff.pickers.salary_month"
    assert names.name(path, {}, None, {"pickers": "Отборщик"}) == "Оклад в месяц, отборщик"


def test_report_time_is_moscow_and_says_so():
    book = load_workbook(BytesIO(client.post("/api/reports/xlsx", json={}).content))
    cells = [str(cell) for row in book["Итог"].iter_rows(values_only=True) for cell in row if cell]
    assert any("расчет от" in cell and "мск" in cell for cell in cells)


def test_report_checks_robots_by_the_load_the_user_entered():
    """Экран проверяет решение по массе груза с шага параметров, и отчет должен так же: груз 3000 кг
    Ronavi H1500 не поднимает, на экране он исключен, в отчете тоже."""
    from app.reports import content
    from app.schemas.economics import CalculationRequest

    load = "facilities.warehouse.operations.pallet_transport.load_kg"
    report = content.build(CalculationRequest(overrides={load: 3000}))
    robot = report.tasks[0].robot
    assert robot is not None and robot.status == "excluded"
    assert any(c.label == "Грузоподъемность" and c.outcome == "blocks" for c in robot.checks)
