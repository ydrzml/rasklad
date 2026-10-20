"""Бюджет на старте: сколько роботов влезает со всеми вложениями, а не по цене изделия.

Пример руками, Ronavi H1500 на перевозке паллет, бюджет 20 млн ₽. Цены без НДС 22% (делим на 1,22),
постоянная часть от размера проекта: доля n / 10, но не меньше 0,2 (config/model.yaml, scale_ref_fleet):
    постоянная часть на 10 роботов: ПО 1,5 + интеграция 5 + инфраструктура 3 = 9,5 млн
    на робота: цена 2,7 + пусконаладка 10% 0,27 = 2,97 млн, зарядка 0,45 млн на каждые 4 робота,
    переобучение на присмотр 1,5 / 60 поста * 5,09 ставки (22 ч, 365 дней) * 10 000 = 1 272,5 ₽ (без НДС)
    5 роботов: (9,5 * 0,5 + 14,85 + 0,9) / 1,22 + 0,0063625 = 16,80964, с резервом 10% 18,4906 млн, влезает
    6 роботов: (9,5 * 0,6 + 17,82 + 0,9) / 1,22 + 0,007635 = 20,02403, с резервом 22,0264 млн, уже нет
Значит в 20 млн влезает 5 роботов, а по цене изделия вышло бы 9. Всего нужно 10 по формуле.
"""

import pytest
from fastapi.testclient import TestClient

from app.engine.economics.scenarios import PURCHASE, evaluate
from app.main import app
from app.schemas.economics import CalculationRequest
from app.services import budget
from app.services.calculation import calculate, model_with_overrides

client = TestClient(app)
PALLETS = ("warehouse", "pallet_transport", "ronavi-h1500")


@pytest.fixture(scope="module")
def model():
    return model_with_overrides({})[0]


def investment(model, fleet):
    return evaluate(model, *PALLETS, fleet=fleet).scenarios[PURCHASE].investment_year0


def test_hand_example_two_robots_in_twenty_million(model):
    fit = budget.fit_task(model, *PALLETS, 20_000_000)
    assert fit.fleet_needed == 10
    assert fit.fleet_fits == 5
    assert fit.investment_rub == pytest.approx(18_490_605.3, abs=1)
    assert investment(model, 6) == pytest.approx(22_026_431.3, abs=1)
    # аренда: роботы в плате за месяц, на старте только подготовка объекта, она в 20 млн влезает
    assert fit.raas_fits is True
    assert fit.raas_start_rub < 20_000_000


def test_fit_is_the_largest_fleet_within_budget(model):
    # все суммы меньше вложений в весь парк по формуле (10 роботов, 36,6 млн): иначе роботов больше не берем
    for money in (12_000_000, 25_000_000, 35_000_000):
        fit = budget.fit_task(model, *PALLETS, money)
        assert investment(model, fit.fleet_fits) <= money
        assert investment(model, fit.fleet_fits + 1) > money


def test_enough_budget_gives_the_whole_fleet(model):
    fit = budget.fit_task(model, *PALLETS, 100_000_000)
    assert fit.fleet_fits == fit.fleet_needed == 10
    assert fit.investment_rub == pytest.approx(fit.investment_needed_rub)


def test_budget_below_site_preparation_gives_zero(model):
    # пилот на одного робота: (9,5 * 0,2 + 2,97 + 0,45) / 1,22 + 0,0012725 = 4,36193, с резервом 4,798 млн.
    # В 4 млн не влезает и он
    fit = budget.fit_task(model, *PALLETS, 4_000_000)
    assert fit.fleet_fits == 0
    assert fit.investment_rub == pytest.approx(0.0) or fit.investment_rub > 4_000_000
    assert investment(model, 1) == pytest.approx(4_798_121.1, abs=1)


def test_largest_fitting_walks_a_step_function():
    cost = [0, 10, 20, 30, 40, 50]
    assert budget.largest_fitting(lambda n: cost[n], 25, 5) == 2
    assert budget.largest_fitting(lambda n: cost[n], 50, 5) == 5
    assert budget.largest_fitting(lambda n: cost[n], 5, 5) == 0
    assert budget.largest_fitting(lambda n: 100, 5, 5) == 0


def test_api_fits_every_robot_of_the_task():
    response = client.post(
        "/api/budget/fit",
        json={"operation_id": "pallet_transport", "robot_ids": ["ronavi-h1500", "ronavi-h2000"], "budget_rub": 2e7},
    )
    assert response.status_code == 200, response.text
    fits = {row["robot_id"]: row for row in response.json()}
    assert fits["ronavi-h1500"]["fleet_fits"] == 5
    assert fits["ronavi-h2000"]["fleet_fits"] >= 1


def test_fit_without_budget_gives_only_the_formula_fleet(model):
    """Шаг решения спрашивает парк по формуле у всех решений задачи, бюджета может и не быть."""
    fit = budget.fit_task(model, *PALLETS, None)
    assert fit.fleet_needed == 10 and fit.fleet_fits == 0 and fit.raas_fits is None
    response = client.post("/api/budget/fit", json={"operation_id": "pallet_transport", "robot_ids": ["ronavi-h1500"]})
    assert response.status_code == 200, response.text
    assert response.json()[0]["fleet_needed"] == 10


def test_calculation_without_budget_has_no_check():
    assert calculate(CalculationRequest(use_simulation=False)).budget is None


def test_calculation_checks_the_budget_by_formula():
    result = calculate(CalculationRequest(use_simulation=False, budget_rub=20_000_000))
    check = result.budget
    assert check is not None
    assert check.purchase_fits is False
    assert check.raas_fits is True
    (task,) = check.tasks
    assert task.fleet_needed == 10
    assert task.fleet_fits == 5
    # без прогона доли спроса нет: прогон гоняет только расчет со сменой
    assert task.done_share is None


def test_shift_run_with_the_budget_fleet_gives_a_share_of_demand():
    """Главная польза: не «влезает 5 из 10», а «5 роботов за смену сделают столько-то спроса».
    Прогон гоняет смену с парком по бюджету на том же плане, что и расчет."""
    result = calculate(CalculationRequest(use_simulation=True, budget_rub=20_000_000))
    (task,) = result.budget.tasks
    assert 0 < task.fleet_fits < task.fleet_needed
    assert task.done_share is not None and 0 < task.done_share < 1
    assert task.ops_per_hour is not None and task.ops_per_hour > 0
    # пять роботов из парка под пик делают меньше спроса, чем весь парк, но больше своей доли парка
    # (5 / 10 = 0,5): у полного парка заметная часть времени без задания
    assert task.fleet_fits / task.fleet_needed < task.done_share < 1


def test_enough_budget_in_calculation_has_no_task_rows():
    check = calculate(CalculationRequest(use_simulation=False, budget_rub=100_000_000)).budget
    assert check is not None and check.purchase_fits is True and check.tasks == []


def test_pay_ways_on_card_match_full_calculation(model):
    """Способы оплаты на карточке решения: те же свои деньги на старте, что в расчете объекта."""
    fit = budget.fit_task(model, *PALLETS, None)
    assert fit.fleet_needed == 10
    purchase = evaluate(model, *PALLETS).scenarios[PURCHASE]

    for method, start in ((1, fit.loan_start_rub), (2, fit.leasing_start_rub)):
        result = calculate(
            CalculationRequest(
                facility_id=PALLETS[0],
                operation_id=PALLETS[1],
                robot_id=PALLETS[2],
                overrides={"financing.method": method},
                use_simulation=False,
            )
        )
        own = next(one for one in result.scenarios if one.id == "purchase")
        assert own.financing is not None
        assert start == pytest.approx(own.investment_year0_rub, rel=1e-6)
        assert 0 < start < purchase.investment_year0
    # аренда без бюджета тоже на карточке: старт и плата за весь парк в месяц
    assert fit.raas_start_rub is not None
    assert fit.raas_month_rub == pytest.approx(10 * 100_000)
