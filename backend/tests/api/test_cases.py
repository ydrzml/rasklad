from fastapi.testclient import TestClient

from app.main import app
from app.services import demo_cases

client = TestClient(app)


def scenario(result: dict, scenario_id: str) -> dict:
    return next(one for one in result["scenarios"] if one["id"] == scenario_id)


def test_pallet_case_repeats_vkusvill():
    """Разбор паллет повторяет РЦ ВкусВилла (Хабр, блог Автомакона, 11.02.2025): 110 000 м2, 7 000 паллет
    в сутки, роботы везут 29% потока, погрузчики Автомакон. Штат водителей не опубликован: штат датасета
    под объем, 88 водителей, как поставит мастер. Покупка 2,94 года, внутри их прогноза 2-3 года.
    До 19.10.2026 разбор стоял на складе датасета: 9 Ronavi H1500, 33,04 млн, 1,06 года, аренда 0,36."""
    demo_cases.forget()
    case = client.get("/api/cases/pallets").json()
    request = case["request"]
    assert request["robot_id"] == "avtomakon-ak-2000-2"
    assert request["overrides"]["facilities.warehouse.operations.pallet_transport.volume_per_day"] == 7000
    assert [(line["role"], line["headcount"]) for line in request["staff"]] == [("forklift_operator", 88)]
    purchase = scenario(case["result"], "purchase")
    assert case["result"]["sizing"]["fleet"] == 22
    assert round(purchase["capex_total_rub"] / 1e6, 2) == 77.56
    assert round(purchase["payback_cumulative_years"], 2) == 2.94
    assert round(scenario(case["result"], "raas")["payback_cumulative_years"], 2) == 1.48
    payback = next(check for check in case["result"]["plausibility"] if check["id"] == "payback_years")
    assert payback["status"] == "inside"


def test_picking_case_repeats_vostok_servis():
    """Разбор отбора повторяет Восток-Сервис (retail.ru, 28.06.2024): зона 7 000 м2, 5 233 строки в сутки,
    80 комплектовщиков, робот Ronavi H1500. Станций 6, как у них; людей 80 -> 32, у них в 2-3 раза меньше;
    аренда 0,44 года при их 6 месяцах оплаты за действие. До 19.10.2026: 16 Ronavi M, 2,07 года."""
    demo_cases.forget()
    case = client.get("/api/cases/picking").json()
    assert case["request"]["robot_id"] == "ronavi-h1500"
    assert [(line["role"], line["headcount"]) for line in case["request"]["staff"]] == [("picker", 80)]
    assert case["measures"]["stations"] == 6
    sizing = case["result"]["sizing"]
    assert (sizing["fleet"], sizing["fte_before"], sizing["fte_after"]) == (23, 80, 32)
    assert round(scenario(case["result"], "purchase")["payback_cumulative_years"], 2) == 1.32
    assert round(scenario(case["result"], "raas")["payback_cumulative_years"], 2) == 0.44


def test_cleaning_case_repeats_vkusvill_veshki():
    """Разбор уборки повторяет РЦ ВкусВилла в Вешках: 30 000 м2 в сутки, роботы Автомакон AK-SC80. Экономия
    первого года 1,0 млн, как их опубликованный 1 млн в год, но 4 робота по 4 млн за 5 лет не окупаются.
    До 19.10.2026: 1 Клинботикс 600 на 10 000 м2, 3,39 года."""
    demo_cases.forget()
    case = client.get("/api/cases/cleaning").json()
    assert case["request"]["robot_id"] == "avtomakon-ak-sc80"
    assert case["result"]["sizing"]["fleet"] == 4
    purchase = scenario(case["result"], "purchase")
    assert round(purchase["annual_effect_year1_rub"] / 1e6, 1) == 1.0
    assert purchase["payback_cumulative_years"] is None


def test_case_numbers_match_the_wizard():
    """Мастер шлет тот же запрос в /api/calculations/preview: цифры разбора с ним совпадают."""
    case = client.get("/api/cases/pallets").json()
    wizard = client.post("/api/calculations/preview", json=case["request"]).json()
    assert wizard["sizing"]["fleet"] == case["result"]["sizing"]["fleet"]
    for scenario_id in ("baseline", "purchase", "raas"):
        assert scenario(wizard, scenario_id)["tco_rub"] == scenario(case["result"], scenario_id)["tco_rub"]
        assert (
            scenario(wizard, scenario_id)["payback_cumulative_years"]
            == scenario(case["result"], scenario_id)["payback_cumulative_years"]
        )


def test_case_shows_loan_and_leasing_like_the_wizard():
    case = client.get("/api/cases/pallets").json()
    for name, method in demo_cases.FINANCING.items():
        # способ оплаты поверх значений кейса, как правка на шаге экономики
        request = {**case["request"], "overrides": {**case["request"]["overrides"], "financing.method": method}}
        wizard = scenario(client.post("/api/calculations/preview", json=request).json(), "purchase")
        assert case["financing"][name]["tco_rub"] == wizard["tco_rub"]
        assert case["financing"][name]["investment_year0_rub"] == wizard["investment_year0_rub"]
    # в долг на старте платим меньше своих денег, чем при покупке за свои
    own = scenario(case["result"], "purchase")["investment_year0_rub"]
    assert case["financing"]["loan"]["investment_year0_rub"] < own
    assert case["financing"]["leasing"]["investment_year0_rub"] < own


def test_case_is_computed_once_while_data_is_the_same(monkeypatch):
    demo_cases.forget()
    calls = []
    real = demo_cases.build

    def counted(case_id: str):
        calls.append(case_id)
        return real(case_id)

    monkeypatch.setattr(demo_cases, "build", counted)
    first = client.get("/api/cases/cleaning").json()
    second = client.get("/api/cases/cleaning").json()
    assert calls == ["cleaning"]
    assert first["computed_at"] == second["computed_at"]


def test_case_is_recomputed_when_data_changes(monkeypatch):
    client.get("/api/cases/cleaning")
    calls = []
    real = demo_cases.build
    monkeypatch.setattr(demo_cases, "build", lambda case_id: calls.append(case_id) or real(case_id))
    monkeypatch.setattr(demo_cases.versions, "data_version", lambda: "другие данные")
    client.get("/api/cases/cleaning")
    assert calls == ["cleaning"]


def test_unknown_case_is_not_found():
    response = client.get("/api/cases/nope")
    assert response.status_code == 404
    assert response.json()["detail"] == "Такого разбора нет"
