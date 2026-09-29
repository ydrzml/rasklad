"""Эталонный пример из docs/calculation.md на данных склада из датасета организатора.

Все ожидаемые числа посчитаны формулами в Excel, независимо от кода: файл эталона ведет Саша, в репозиторий
не кладем. Если тест упал после правки расчета, сначала пересчитайте эталон. Ожидаемые значения не меняем под то, что выдал код.
"""

import copy
from pathlib import Path

import pytest

from app.engine.economics import BASELINE, PURCHASE, RAAS, evaluate
from app.engine.economics.fleet import linear_throughput_curve
from app.engine.economics.staff import employee_full_cost
from app.engine.model_config import find_unsourced_numbers, load_full_model, load_model
from app.settings import settings

REFERENCE = Path(__file__).parent / "fixtures" / "reference_warehouse.yaml"
MODEL = settings.config_dir / "model.yaml"


@pytest.fixture(scope="module")
def model():
    return load_model(REFERENCE)[0]


@pytest.fixture(scope="module")
def pallets(model):
    return evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500")


@pytest.fixture(scope="module")
def risk(model):
    """Лист «Паллеты риск»: на объекте требуют двоих дежурных в смену, а не одного."""
    changed = copy.deepcopy(model)
    changed["facilities"][0]["min_operator_posts"] = 2
    return evaluate(changed, "warehouse", "pallet_transport", "ronavi-h1500")


@pytest.fixture(scope="module")
def picking(model):
    return evaluate(model, "warehouse", "piece_picking", "ronavi-m")


# --- Парк и люди ------------------------------------------------------------------


def test_pallet_fleet(pallets):
    s = pallets.sizing
    assert s.peak_demand == pytest.approx(129.5454545)  # 2000 * 25/25 * 0.95 / 22 * 1.5
    assert s.design_demand == pytest.approx(148.9772727)  # * 1.15
    assert s.route_m == pytest.approx(75)  # 0.75 * sqrt(10 000)
    assert s.robot_rate == pytest.approx(21.1764706)  # 3600 / (2 * 75 / 1.0 + 20)
    assert s.effective_rate == pytest.approx(15.8823529)  # * 0.75
    assert s.fleet == 10  # 148.98 / 15.88 = 9.38 -> 10
    assert s.chargers == 2  # ceil(10 / 5)


def test_employee_full_cost(model):
    payroll = model["economics"]["payroll"]
    assert employee_full_cost(120_000, payroll) == pytest.approx(1_880_640)  # 1 440 000 * (1 + 0.30 + 0.006)
    # 3 600 000 в год: 2 979 000 * 0.30 + 621 000 * 0.151 + 3 600 000 * 0.006
    assert employee_full_cost(300_000, payroll) == pytest.approx(3_600_000 + 893_700 + 93_771 + 21_600)


def test_pallet_staff(pallets):
    s = pallets.sizing
    assert s.fte_per_post == pytest.approx(5.0900101)  # 22 * 365 / 1972 * 1.25
    assert s.operator_posts == 1  # нагрузка 10 * 1.5 / 60 = 0.25 поста, но минимум один дежурный
    assert s.operators_fte == pytest.approx(5.0900101)
    assert s.fte_before == pytest.approx(23.75)  # заменяем 25 из 25, из них 5% негабарита остается людям
    assert s.fte_after == 0
    assert s.retrained_fte == pytest.approx(5.0900101)  # операторов берем из высвобожденных
    assert s.operators_short_fte == 0
    assert s.vacancies_closed_fte == 0  # штат полный, роботы забирают работу у живых людей
    assert s.released_net_fte == pytest.approx(18.6599899)  # 23.75 - 5.09
    assert s.people_per_shift_before == pytest.approx(4.666002)  # 23.75 / 5.09
    assert s.people_per_shift_after == pytest.approx(1)
    assert s.worker_cost == pytest.approx(1_880_640)
    # оператор робозоны это переученный сотрудник той же роли, надбавки пока нет
    assert s.operator_cost == pytest.approx(1_880_640)


def test_picking_staff_counts_actual_headcount(picking):
    s = picking.sizing
    # 100 ставок отборщиков, роботам посильны 30% объема: 100 * 0.3 = 30
    assert s.fte_before == pytest.approx(30)
    assert s.fte_after == pytest.approx(22.5)  # 30 * 150 / 200
    assert s.fleet == 105  # 2352.27 / (30 * 0.75) = 104.5 -> 105
    assert s.stations == 12  # ceil(2352.27 / 200)
    # операторов нужно больше, чем высвободилось: 7.5 переучиваем, на остальных людей нет
    assert s.operator_posts == 3  # ceil(105 * 1.5 / 60)
    assert s.operators_fte == pytest.approx(15.2700304)
    assert s.retrained_fte == pytest.approx(7.5)
    assert s.operators_short_fte == pytest.approx(7.7700304)


# --- CAPEX и годы -------------------------------------------------------------------


def test_pallet_capex(pallets):
    purchase = pallets.scenarios[PURCHASE]
    assert purchase.capex == pytest.approx(
        {
            "hardware": 27_000_000,
            "chargers": 600_000,
            "software": 1_500_000,
            "stations": 0,
            "integration": 5_000_000,
            "infrastructure": 3_000_000,
            "commissioning": 2_700_000,
            "retraining": 50_900.10,
            "reserve": 3_985_090.01,
        }
    )
    assert purchase.capex_total == pytest.approx(43_835_990.11)
    assert pallets.scenarios[RAAS].capex_total == pytest.approx(11_825_990.11)


def test_picking_capex_has_no_hiring(picking):
    """Наем операторов с рынка убран: своей ставки у роли нет, выдумывать ее мы не будем.

    Прежний эталон включал 388 501,52 на подбор 7,77 ставки. Без этой строки уходит она сама
    и ее доля резерва: 388 501,52 * 1,1 = 427 351,67.
    """
    assert "hiring" not in picking.scenarios[PURCHASE].capex
    assert picking.scenarios[PURCHASE].capex_total == pytest.approx(328_982_500.00)
    assert picking.scenarios[RAAS].capex_total == pytest.approx(43_202_500.00)


def test_pallet_purchase_years(pallets):
    years = pallets.scenarios[PURCHASE].years
    assert [y.effect for y in years] == pytest.approx(
        [32_481_373.33, 34_815_342.46, 34_394_419.00, 39_991_192.33, 42_857_144.94], abs=0.01
    )
    assert years[2].opex["battery"] == pytest.approx(2_920_320)  # 10 * 270 000 * 1.04^2
    assert years[0].amortization == pytest.approx(8_767_198.02)  # 43.8 млн / 5


def test_pallet_raas_years(pallets):
    years = pallets.scenarios[RAAS].years
    assert [y.opex.get("raas_fee", 0) for y in years] == pytest.approx([12_000_000] * 3 + [0, 0])
    assert [y.investment for y in years] == pytest.approx([0, 0, 10_800_000, 0, 0])  # выкуп 10 * 2.7 млн * 0.4
    assert [y.effect for y in years] == pytest.approx(
        [22_161_373.33, 24_562_542.46, 27_131_827.00, 39_991_192.33, 42_857_144.94], abs=0.01
    )


def test_raas_without_buyout_renews_with_indexation(model):
    r = evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500", raas_buyout=False)
    fees = [y.opex["raas_fee"] for y in r.scenarios[RAAS].years]
    # 10 * 100 000 * 12 = 12 млн на первый контракт, при продлении * 1.04^3
    assert fees == pytest.approx([12_000_000] * 3 + [13_498_368] * 2)


def test_volume_growth_mode(model):
    """Режим «людей столько же, объем больше»: считаем, сколько людей понадобилось бы на новый объем."""
    changed = copy.deepcopy(model)
    changed["facilities"][0]["operations"][0]["volume_growth"] = 2
    s = evaluate(changed, "warehouse", "pallet_transport", "ronavi-h1500").sizing
    assert s.design_demand == pytest.approx(297.9545455)  # 2000 * 0.95 * 2 / 22 * 1.5 * 1.15
    assert s.fleet == 19  # 297.95 / 15.88 = 18.76 -> 19
    assert s.fte_before == pytest.approx(47.5)  # 25 * 0.95 * 2: столько людей ушло бы на двойной объем
    assert s.fte_after == 0


def test_raas_support_share_cuts_operators(model):
    """При аренде часть присмотра за парком берет поставщик, эти ставки клиент не платит."""
    changed = copy.deepcopy(model)
    changed["robots"][0]["raas"]["support_share"] = 0.5
    r = evaluate(changed, "warehouse", "pallet_transport", "ronavi-h1500")
    operators = [y.opex["operators"] for y in r.scenarios[RAAS].years]
    full = 5.0900101 * 1_880_640  # 5.09 ставки * полная стоимость
    # три года аренды платим половину, после выкупа снова полностью, с индексом зарплат
    assert operators[0] == pytest.approx(full / 2, rel=1e-6)
    assert operators[3] == pytest.approx(full * 1.07**3, rel=1e-6)


# --- Показатели ---------------------------------------------------------------------


def test_pallet_metrics(pallets):
    purchase, raas = pallets.scenarios[PURCHASE], pallets.scenarios[RAAS]
    assert pallets.scenarios[BASELINE].tco == pytest.approx(256_857_908.03)
    assert purchase.payback_simple == pytest.approx(1.349573)
    assert purchase.payback_cumulative == pytest.approx(1.326138)
    assert purchase.payback_band == "до 3 лет"
    assert purchase.roi_tz == pytest.approx(4.209771)
    assert purchase.roi_net == pytest.approx(3.209771)
    assert purchase.tco == pytest.approx(116_154_426.08)
    assert purchase.npv == pytest.approx(80_597_625.66)
    assert purchase.irr == pytest.approx(0.73830, abs=1e-5)
    assert raas.payback_simple == pytest.approx(0.533631)
    assert raas.payback_cumulative == pytest.approx(0.533631)
    assert raas.roi_tz == pytest.approx(6.925844)
    assert raas.tco == pytest.approx(122_779_818.08)
    assert raas.npv == pytest.approx(83_474_062.30)
    assert raas.irr == pytest.approx(1.92827, abs=1e-5)


def test_risk_case_second_operator_post(risk):
    purchase, raas = risk.scenarios[PURCHASE], risk.scenarios[RAAS]
    assert risk.sizing.operator_posts == 2  # минимум дежурных на объекте
    assert risk.sizing.operators_fte == pytest.approx(10.1800203)
    assert purchase.capex_total == pytest.approx(43_891_980.22)
    assert purchase.payback_simple == pytest.approx(1.915936)
    assert purchase.payback_cumulative == pytest.approx(1.853915)
    assert purchase.roi_tz == pytest.approx(2.950212)
    assert purchase.npv == pytest.approx(43_406_090.10)
    assert raas.payback_cumulative == pytest.approx(0.943846)
    assert raas.npv == pytest.approx(46_282_526.74)


def test_picking_does_not_pay_back(picking):
    purchase, raas = picking.scenarios[PURCHASE], picking.scenarios[RAAS]
    assert purchase.payback_cumulative is None and raas.payback_cumulative is None
    assert purchase.payback_band == "не окупается"
    assert purchase.irr is None
    assert purchase.tco == pytest.approx(823_343_849.08)  # прежние 823 771 200,75 минус 427 351,67
    assert picking.scenarios[BASELINE].tco == pytest.approx(270_376_745.29)


@pytest.mark.parametrize("case", ["pallets", "risk", "picking"])
def test_tco_difference_equals_net_effect(case, request):
    result = request.getfixturevalue(case)
    base = result.scenarios[BASELINE].tco
    for scenario in (result.scenarios[PURCHASE], result.scenarios[RAAS]):
        assert base - scenario.tco == pytest.approx(scenario.effect_total - scenario.investment_total)


def test_bottleneck_plateau_is_infeasible(model):
    # Кривая как из симуляции: после 8 роботов прироста нет, спрос 149 операций в час не покрыть.
    curve = linear_throughput_curve(15.88, 8) + [8 * 15.88] * 50
    assert not evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500", curve=curve).feasible


def test_model_config_has_sources_and_evaluates():
    import yaml

    raw = yaml.safe_load(MODEL.read_text(encoding="utf-8"))
    assert find_unsourced_numbers(raw) == []
    model, provenance = load_full_model(settings.config_dir)
    # цена робота есть и у организатора, и у производителя, поэтому оценка B
    assert provenance["robots.ronavi-h1500.price_rub"].trust == "B"
    assert not provenance["robots.ronavi-h1500.price_rub"].is_weak
    # выработка отборщика: нижняя граница датасета, проверенная его же маршрутом 25 м, поэтому D
    assert provenance["facilities.warehouse.operations.piece_picking.productivity_before"].trust == "D"
    assert evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500").feasible
    assert evaluate(model, "warehouse", "piece_picking", "ronavi-m").feasible


# --- Тот же склад на геометрии плана ------------------------------------------------
# Лист «Паллеты по плану» в Excel: все то же, но маршрут не оценка по площади, а средний путь
# по типовому плану «с одной стороны» на 10 000 м2. Числа ниже посчитал Excel, не код.

PLAN_ROUTE_M = 65.73012232415903


def test_plan_route_is_the_one_in_the_reference():
    """Маршрут в эталоне взят с плана. Если генератор плана поменялся, эталон надо пересчитать."""
    from app.services import plan as plan_service

    plan = plan_service.generate("warehouse", ["pallet_transport"])
    assert plan_service.measure(plan).route_m == pytest.approx(PLAN_ROUTE_M, abs=1e-6)


@pytest.fixture(scope="module")
def on_plan(model):
    return evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500", route_m=PLAN_ROUTE_M)


def test_pallets_on_the_plan(on_plan):
    s = on_plan.sizing
    assert s.robot_rate == pytest.approx(23.7686134)  # 3600 / (2 * 65.73 / 1.0 + 20)
    assert s.effective_rate == pytest.approx(17.8264600)  # * 0.75
    assert s.fleet == 9  # 148.98 / 17.83 = 8.36 -> 9, по площади было 10
    assert s.chargers == 2  # ceil(9 / 5)
    assert s.operators_fte == pytest.approx(5.0900101)  # 9 * 1.5 / 60 = 0.23 поста, минимум один
    purchase, raas = on_plan.scenarios[PURCHASE], on_plan.scenarios[RAAS]
    assert purchase.capex_total == pytest.approx(40_568_990.11)
    assert raas.capex_total == pytest.approx(11_528_990.11)
    assert purchase.years[0].effect == pytest.approx(32_712_508.33, abs=0.01)
    assert raas.years[0].effect == pytest.approx(23_424_508.33, abs=0.01)
    assert purchase.payback_simple == pytest.approx(1.240168)
    assert purchase.payback_cumulative == pytest.approx(1.224103)
    assert purchase.roi_tz == pytest.approx(4.587345)
    assert purchase.tco == pytest.approx(111_322_953.66)
    assert purchase.npv == pytest.approx(84_924_731.72)
    assert purchase.irr == pytest.approx(0.81150, abs=1e-5)
    assert raas.payback_cumulative == pytest.approx(0.492176)
    assert raas.roi_tz == pytest.approx(7.579282)
    assert raas.tco == pytest.approx(117_054_806.46)
    assert raas.npv == pytest.approx(87_744_524.69)
    assert raas.irr == pytest.approx(2.08734, abs=1e-5)
