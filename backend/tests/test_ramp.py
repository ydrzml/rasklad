"""Выход на режим на эталоне по плану: пример руками в docs/calculation.md, раздел "Выход на режим"."""

import copy
from pathlib import Path

import pytest

from app.engine.economics import BASELINE, PURCHASE, RAAS
from app.engine.economics.facility import Task, evaluate_facility
from app.engine.economics.ramp import first_year_share, kind, shares
from app.engine.model_config import load_model

REFERENCE = Path(__file__).parent / "reference" / "fixtures" / "reference_warehouse.yaml"
PLAN_ROUTE_M = 65.73012232415903
# значения по умолчанию из config/model.yaml, заморожены вместе с эталоном
RAMP = {"simple": {"first_month_share": 0.7, "months": 1}, "station": {"first_month_share": 0.2, "months": 5}}


@pytest.fixture(scope="module")
def model():
    return load_model(REFERENCE)[0]


def with_ramp(model):
    changed = copy.deepcopy(model)
    changed["ramp_up"] = copy.deepcopy(RAMP)
    return changed


def test_shares_by_hand():
    assert shares(0.7, 1) == pytest.approx([0.7] + [1.0] * 11)
    assert shares(0.2, 5)[:6] == pytest.approx([0.2, 0.36, 0.52, 0.68, 0.84, 1.0])
    assert shares(0.5, 0) == [1.0] * 12


def test_kind_by_operation():
    """Человек остается у станции: товар к человеку, выход дольше."""
    assert kind({"productivity_after": 200}) == "station"
    assert kind({}) == "simple"
    ramped = {"ramp_up": RAMP}
    assert first_year_share(ramped, {}) == pytest.approx(11.7 / 12)  # 0.975
    assert first_year_share(ramped, {"productivity_after": 200}) == pytest.approx(9.6 / 12)  # 0.8
    assert first_year_share({}, {}) == 1.0  # нет раздела в модели: весь эффект


def test_pallets_by_hand(model):
    plain = evaluate_facility(model, "warehouse", [Task("pallet_transport", "ronavi-h1500")], route_m=PLAN_ROUTE_M)
    ramped = evaluate_facility(
        with_ramp(model), "warehouse", [Task("pallet_transport", "ronavi-h1500")], route_m=PLAN_ROUTE_M
    )
    for scenario_id in (PURCHASE, RAAS):
        first = ramped.scenarios[scenario_id].years[0]
        # люди без роботов 23.75 * 1 880 640 = 44.665 млн, после роботов 0; не отпустили 2.5%: 1.117 млн
        assert first.ramp == pytest.approx(44_665_200 * 0.025)
        assert first.effect == pytest.approx(plain.scenarios[scenario_id].years[0].effect - 1_116_630)
        # со второго года все как было
        assert ramped.scenarios[scenario_id].years[1].effect == pytest.approx(
            plain.scenarios[scenario_id].years[1].effect
        )
    purchase = ramped.scenarios[PURCHASE]
    assert purchase.years[0].effect == pytest.approx(31_595_878.33, abs=0.01)
    assert purchase.payback_cumulative == pytest.approx(1.255954, abs=1e-6)
    assert purchase.npv == pytest.approx(83_945_232, abs=1_000)
    # без роботов выход на режим не меняет ничего
    assert ramped.scenarios[BASELINE].tco == pytest.approx(plain.scenarios[BASELINE].tco)


def test_tco_identity_holds(model):
    ramped = evaluate_facility(
        with_ramp(model), "warehouse", [Task("pallet_transport", "ronavi-h1500")], route_m=PLAN_ROUTE_M
    )
    baseline = ramped.scenarios[BASELINE].tco
    for scenario_id in (PURCHASE, RAAS):
        scenario = ramped.scenarios[scenario_id]
        assert baseline - scenario.tco == pytest.approx(scenario.effect_total - scenario.investment_total, abs=1)
