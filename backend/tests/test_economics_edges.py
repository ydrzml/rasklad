"""Экономика трех сценариев за пределами эталона: длинный горизонт, субсидия, короткий контракт аренды,
ноль роботов, пустой штат, огромные числа.

Ожидаемые числа посчитаны руками по формулам из docs/calculation.md, в комментариях видно как.
Данные берем из замороженного эталона tests/reference/fixtures/reference_warehouse.yaml,
чтобы правка config/model.yaml не ломала эти проверки.
"""

import copy
import math
from pathlib import Path

import pytest

from app.engine.economics import BASELINE, PURCHASE, RAAS, evaluate
from app.engine.model_config import load_model

REFERENCE = Path(__file__).parent / "reference" / "fixtures" / "reference_warehouse.yaml"

WORKER_COST = 1_880_640  # 120 000 * 12 * (1 + 0.30 + 0.006)
FTE_BEFORE = 23.75  # 25 операторов погрузчиков * 0.95 автоматизируемой доли
BASE_YEAR_1 = FTE_BEFORE * WORKER_COST  # 44 665 200 рублей на людей в первый год
HARDWARE = 10 * 2_700_000  # парк по эталону 10 роботов
CAPEX_PURCHASE = 43_835_990.11  # из эталона
EFFECT_PURCHASE_YEAR_1 = 32_481_373.33  # из эталона


@pytest.fixture(scope="module")
def model():
    return load_model(REFERENCE)[0]


def with_horizon(model: dict, years: int) -> dict:
    changed = copy.deepcopy(model)
    changed["economics"]["horizon_years"] = years
    return changed


def pallets(model: dict, **kwargs):
    return evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500", **kwargs)


def wage_index_sum(years: int, growth: float = 0.07) -> float:
    """1 + 1.07 + ... + 1.07^(years-1), сумма индексов зарплат за горизонт."""
    return sum((1 + growth) ** (t - 1) for t in range(1, years + 1))


# --- Горизонт 5, 7 и 10 лет -----------------------------------------------------------


@pytest.mark.parametrize("horizon", [5, 7, 10])
def test_every_year_of_the_horizon_is_counted(model, horizon):
    result = pallets(with_horizon(model, horizon))
    for scenario in result.scenarios.values():
        assert len(scenario.years) == horizon
        assert [y.t for y in scenario.years] == list(range(1, horizon + 1))


@pytest.mark.parametrize("horizon", [5, 7, 10])
def test_baseline_tco_is_people_cost_with_wage_growth(model, horizon):
    # без роботов платим только людям: 44 665 200 * (1 + 1.07 + ... + 1.07^(H-1))
    # H=5: сумма индексов 5.750739, TCO 256 857 908 (сходится с эталоном)
    # H=7: сумма индексов 8.654021, TCO 386 533 583
    # H=10: сумма индексов 13.816448, TCO 617 114 411
    expected = BASE_YEAR_1 * wage_index_sum(horizon)
    assert pallets(with_horizon(model, horizon)).scenarios[BASELINE].tco == pytest.approx(expected, rel=1e-9)


@pytest.mark.parametrize("horizon", [5, 7, 10])
def test_tco_identity_holds_on_any_horizon(model, horizon):
    """Проверка из методики: TCO без роботов - TCO сценария = сумма эффектов - вложения за горизонт."""
    result = pallets(with_horizon(model, horizon))
    base = result.scenarios[BASELINE].tco
    for scenario in (result.scenarios[PURCHASE], result.scenarios[RAAS]):
        assert base - scenario.tco == pytest.approx(scenario.effect_total - scenario.investment_total)
        # и сам TCO складывается из вложений и всех затрат по годам
        yearly = sum(y.staff_cost + y.opex_total for y in scenario.years)
        assert scenario.tco == pytest.approx(scenario.investment_total + yearly)


def test_fleet_is_renewed_at_the_end_of_service_life_but_not_in_the_last_year(model):
    # срок службы 5 лет: на горизонте 7 парк обновляем в году 5, на горизонте 5 год 5 последний, не обновляем
    # цена обновления 27 000 000 * 1.04^(5-1) = 27 000 000 * 1.16985856 = 31 586 181.12
    seven = pallets(with_horizon(model, 7)).scenarios[PURCHASE]
    assert [y.investment for y in seven.years] == pytest.approx([0, 0, 0, 0, 31_586_181.12, 0, 0], abs=0.01)
    five = pallets(model).scenarios[PURCHASE]
    assert [y.investment for y in five.years] == pytest.approx([0] * 5)
    # на 10 лет обновление одно: год 10 последний
    ten = pallets(with_horizon(model, 10)).scenarios[PURCHASE]
    assert [t for t, y in enumerate(ten.years, 1) if y.investment] == [5]


def test_raas_after_buyout_renews_the_fleet_like_an_owner(model):
    # аренда 3 года, выкуп в конце года 3 за 10.8 млн, в году 5 роботам 5 лет и их обновляют как при покупке
    raas = pallets(with_horizon(model, 7)).scenarios[RAAS]
    assert [y.investment for y in raas.years] == pytest.approx([0, 0, 10_800_000, 0, 31_586_181.12, 0, 0], abs=0.01)
    assert [y.opex.get("raas_fee", 0) for y in raas.years] == pytest.approx([12_000_000] * 3 + [0] * 4)


def with_robot(model: dict, **changes) -> dict:
    changed = copy.deepcopy(model)
    robot = next(r for r in changed["robots"] if r["id"] == "ronavi-h1500")
    for key, value in changes.items():
        if key == "contract_months":
            robot["raas"]["contract_months"] = value
        else:
            robot[key] = value
    return changed


def test_raas_renews_the_fleet_when_service_life_ends_at_the_buyout(model):
    """Срок службы 3 года, договор 36 месяцев, горизонт 5. Выкуп по остаточной стоимости
    27 000 000 * max(0, 1 - 3 / 3) = 0: роботы изношены. После выкупа затраты как при покупке,
    поэтому в году 3 владелец обновляет парк так же, как покупка: 27 000 000 * 1.04^2 = 29 203 200.
    Раньше обновление пропадало, потому что год 3 еще считался арендой, и аренда выходила
    на эти 29,2 млн дешевле."""
    changed = with_robot(model, service_life_years=3)
    purchase = pallets(changed).scenarios[PURCHASE]
    raas = pallets(changed).scenarios[RAAS]
    assert [y.investment for y in purchase.years] == pytest.approx([0, 0, 29_203_200, 0, 0], abs=0.01)
    assert [y.investment for y in raas.years] == pytest.approx([0, 0, 29_203_200, 0, 0], abs=0.01)


def test_raas_for_five_years_renews_like_purchase_on_ten_year_horizon(model):
    # договор 60 месяцев, срок службы 5 лет, горизонт 10: выкуп в году 5 за 0 и обновление
    # 27 000 000 * 1.04^4 = 31 586 181.12, как у покупки в том же году
    changed = with_horizon(with_robot(model, contract_months=60), 10)
    raas = pallets(changed).scenarios[RAAS]
    assert [t for t, y in enumerate(raas.years, 1) if y.investment] == [5]
    assert raas.years[4].investment == pytest.approx(31_586_181.12, abs=0.01)


@pytest.mark.xfail(
    reason="Методика: замена АКБ в год, кратный ресурсу АКБ, кроме последнего (годы 3, 6, 9). "
    "Код считает возраст парка после обновления в году 5 и меняет АКБ в годы 3 и 8. "
    "Код выглядит разумнее, но расходится с docs/calculation.md: надо поправить одно из двух",
    strict=True,
)
def test_battery_is_replaced_every_three_years_as_the_method_says(model):
    ten = pallets(with_horizon(model, 10)).scenarios[PURCHASE]
    assert [t for t, y in enumerate(ten.years, 1) if y.opex["battery"]] == [3, 6, 9]


def test_longer_horizon_keeps_payback_and_raises_roi(model):
    # окупаемость наступает на втором году, поэтому от горизонта не зависит
    five, ten = pallets(model).scenarios[PURCHASE], pallets(with_horizon(model, 10)).scenarios[PURCHASE]
    assert ten.payback_cumulative == pytest.approx(five.payback_cumulative)
    assert ten.payback_simple == pytest.approx(five.payback_simple)
    # ROI по ТЗ = сумма эффектов / вложения за горизонт: за 10 лет эффектов вдвое больше, вложений на одно обновление
    assert ten.roi_tz == pytest.approx(ten.effect_total / ten.investment_total)
    assert ten.roi_tz > five.roi_tz
    assert ten.npv > five.npv


# --- Субсидия и аренда ----------------------------------------------------------------


def test_capex_grant_is_capped_and_cuts_only_the_purchase(model):
    result = pallets(model, subsidy_ids=("example-grant",))
    purchase, raas = result.scenarios[PURCHASE], result.scenarios[RAAS]
    # 25% от 43 835 990 это 10 958 997, потолок 10 000 000, берем потолок
    assert purchase.grant == pytest.approx(10_000_000)
    assert purchase.investment_year0 == pytest.approx(CAPEX_PURCHASE - 10_000_000)
    # простой срок = (43 835 990.11 - 10 000 000) / 32 481 373.33 = 1.041704
    assert purchase.payback_simple == pytest.approx(1.041704, abs=1e-6)
    # на 10 млн меньше вложений, на 10 млн меньше TCO
    assert purchase.tco == pytest.approx(116_154_426.08 - 10_000_000)
    assert raas.grant == 0 and raas.capex_total == pytest.approx(11_825_990.11)


def test_grant_never_exceeds_capex(model):
    changed = copy.deepcopy(model)
    changed["subsidies"][0]["share"] = 1.0
    changed["subsidies"][0]["cap_rub"] = 10**12
    purchase = pallets(changed, subsidy_ids=("example-grant",)).scenarios[PURCHASE]
    assert purchase.grant == pytest.approx(purchase.capex_total)
    assert purchase.investment_year0 == 0
    assert purchase.payback_cumulative == 0.0


def test_unknown_subsidy_kind_is_refused(model):
    changed = copy.deepcopy(model)
    changed["subsidies"][0]["kind"] = "tax_holiday"
    with pytest.raises(NotImplementedError):
        pallets(changed, subsidy_ids=("example-grant",))


def test_two_year_rental_contract(model):
    changed = copy.deepcopy(model)
    changed["robots"][0]["raas"]["contract_months"] = 24
    raas = pallets(changed).scenarios[RAAS]
    # плата 10 * 100 000 * 12 = 12 млн два года, выкуп в конце года 2: 27 млн * (1 - 2/5) = 16.2 млн
    assert [y.opex.get("raas_fee", 0) for y in raas.years] == pytest.approx([12_000_000, 12_000_000, 0, 0, 0])
    assert [y.investment for y in raas.years] == pytest.approx([0, 16_200_000, 0, 0, 0])
    # после выкупа платим ТО как владелец: 27 млн * 5% * 1.04^2 = 1 460 160 в году 3
    assert raas.years[2].opex["maintenance"] == pytest.approx(1_460_160)
    assert "maintenance" not in raas.years[0].opex


def test_contract_not_in_whole_years_is_refused(model):
    changed = copy.deepcopy(model)
    changed["robots"][0]["raas"]["contract_months"] = 30
    with pytest.raises(ValueError, match="кратен 12"):
        pallets(changed)


def test_rental_longer_than_service_life_has_nothing_to_buy_out(model):
    changed = copy.deepcopy(model)
    changed["robots"][0]["raas"]["contract_months"] = 60
    raas = pallets(changed).scenarios[RAAS]
    # контракт 5 лет на горизонте 5 лет: платим все пять лет, выкупать нечего, остаточная стоимость 0
    assert [y.opex.get("raas_fee", 0) for y in raas.years] == pytest.approx([12_000_000] * 5)
    assert [y.investment for y in raas.years] == pytest.approx([0] * 5)


# --- Ноль роботов, пустой склад -------------------------------------------------------


@pytest.mark.parametrize("path, value", [("volume_per_day", 0), ("automatable_share", 0)])
def test_nothing_to_automate_means_zero_fleet_and_no_payback(model, path, value):
    changed = copy.deepcopy(model)
    changed["facilities"][0]["operations"][0][path] = value
    result = pallets(changed)
    assert result.feasible
    s = result.sizing
    assert s.fleet == 0 and s.chargers == 0
    assert s.fte_before == 0 and s.fte_after == 0 and s.retrained_fte == 0
    purchase = result.scenarios[PURCHASE]
    assert purchase.capex["hardware"] == 0 and purchase.capex["chargers"] == 0 and purchase.capex["commissioning"] == 0
    assert result.scenarios[BASELINE].tco == 0
    assert purchase.payback_simple is None and purchase.payback_cumulative is None
    assert purchase.payback_band == "не окупается"
    assert all(y.opex["electricity"] == 0 for y in purchase.years)


@pytest.mark.xfail(
    reason="При нулевом парке покупка все равно стоит 10.45 млн: ПО парка 1.5 млн, интеграция 5, "
    "инфраструктура 3 и резерв, плюс 300 тыс. связи в год. Роботов нет, внедрять нечего. "
    "Сомнение: возможно, при нуле роботов расчет должен возвращать пустые сценарии",
    strict=True,
)
def test_zero_fleet_costs_nothing(model):
    changed = copy.deepcopy(model)
    changed["facilities"][0]["operations"][0]["volume_per_day"] = 0
    purchase = pallets(changed).scenarios[PURCHASE]
    assert purchase.capex_total == 0
    assert all(y.opex_total == 0 for y in purchase.years)


@pytest.mark.xfail(
    reason="Парк, заданный снаружи как 0 (так делает чувствительность по объему), все равно "
    "высвобождает всех 23.75 ставки: окупаемость 0.3 года без единого робота",
    strict=True,
)
def test_forced_zero_fleet_frees_nobody(model):
    result = pallets(model, fleet=0)
    assert result.sizing.fte_before == result.sizing.fte_after
    assert result.scenarios[PURCHASE].payback_cumulative is None


@pytest.mark.parametrize("empty", ["headcount", "staff"])
def test_empty_warehouse_has_no_savings_and_does_not_crash(model, empty):
    changed = copy.deepcopy(model)
    if empty == "headcount":
        changed["facilities"][0]["staff"][0]["headcount"] = 0
    else:
        changed["facilities"][0]["staff"] = []
    result = pallets(changed)
    assert result.feasible
    s = result.sizing
    assert s.fleet == 10  # спрос от объема, а не от людей
    assert s.fte_before == 0 and s.worker_cost == 0 and s.retrained_fte == 0
    assert result.scenarios[BASELINE].tco == 0
    for scenario in (result.scenarios[PURCHASE], result.scenarios[RAAS]):
        assert all(y.effect < 0 for y in scenario.years)
        assert scenario.payback_band == "не окупается"
        assert scenario.irr is None
        assert scenario.capex["retraining"] == 0


def test_zero_area_still_gives_a_positive_route_cycle(model):
    changed = copy.deepcopy(model)
    changed["facilities"][0]["active_area_m2"] = 0
    s = pallets(changed).sizing
    # маршрут 0, остается только погрузка и выгрузка 20 с: 3600 / 20 = 180 рейсов в час, с загрузкой 135
    assert s.route_m == 0
    assert s.robot_rate == pytest.approx(180)
    assert s.effective_rate == pytest.approx(135)
    assert s.fleet == 2  # 148.98 / 135 = 1.10, вверх


# --- Огромные числа --------------------------------------------------------------------


def test_huge_volume_is_reported_as_not_covered_not_as_a_crash(model):
    changed = copy.deepcopy(model)
    changed["facilities"][0]["operations"][0]["volume_per_day"] = 10**9
    result = pallets(changed)
    assert not result.feasible
    assert result.sizing is None
    # спрос все равно посчитан: 10^9 * 0.95 / 22 * 1.5
    assert result.peak_demand == pytest.approx(10**9 * 0.95 / 22 * 1.5)


def test_huge_robot_price_gives_finite_numbers(model):
    changed = copy.deepcopy(model)
    changed["robots"][0]["price_rub"] = 10**12
    result = pallets(changed)
    purchase, raas = result.scenarios[PURCHASE], result.scenarios[RAAS]
    assert purchase.capex["hardware"] == 10 * 10**12
    for scenario in (purchase, raas):
        assert math.isfinite(scenario.tco) and math.isfinite(scenario.npv)
        assert scenario.payback_cumulative is None and scenario.payback_band == "не окупается"
        assert scenario.roi_tz < 0
    # выкуп при аренде: 10 * 10^12 * (1 - 3/5)
    assert raas.years[2].investment == pytest.approx(4 * 10**12)


def test_huge_salary_pays_back_within_days(model):
    changed = copy.deepcopy(model)
    changed["facilities"][0]["staff"][0]["salary_month"] = 10**9
    purchase = pallets(changed).scenarios[PURCHASE]
    assert 0 < purchase.payback_cumulative < 0.01
    assert purchase.payback_band == "до 3 лет"
    assert math.isfinite(purchase.npv) and purchase.npv > 0


@pytest.mark.xfail(
    reason="IRR ищется только на отрезке до 1000% годовых: при окладе 10^9 в месяц ставка выше, "
    "и вместо числа возвращается None, как будто проект не окупается",
    strict=True,
)
def test_huge_salary_still_has_an_irr(model):
    changed = copy.deepcopy(model)
    changed["facilities"][0]["staff"][0]["salary_month"] = 10**9
    assert pallets(changed).scenarios[PURCHASE].irr is not None
