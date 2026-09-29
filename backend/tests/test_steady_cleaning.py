"""Уборка: парк под площадь смены, а не под пиковый час склада.

Пример руками (склад датасета, Клинботикс 400 PRO):
    роботам отдано 10 000 * 0,7 = 7 000 м² в сутки на 2 смены по 11 часов = 318,2 м² в час
    пикового часа нет (steady), с резервом 15%: 365,9 м² в час
    робот моет 700 м²/ч, с загрузкой 0,75 это 525 м²/ч: 365,9 / 525 = 0,70, вверх 1 робот
    раньше: 318,2 * 1,5 (пик склада) = 477,3, с резервом 548,9, / 525 = 1,05, вверх 2 по формуле
    и 3 по прогону, из которых два стояли
Площадь смены 3 500 м² один робот моет за 3 500 / 700 = 5 часов, с водой около 5,6 из 11.
"""

import pytest

from app.engine.economics.fleet import peak_demand
from app.engine.economics.scenarios import PURCHASE, by_id, evaluate
from app.services import simulation as service
from app.services.calculation import model_with_overrides


@pytest.fixture(scope="module")
def model():
    return model_with_overrides({})[0]


def test_cleaning_has_no_peak_hour(model):
    facility = by_id(model["facilities"], "warehouse")
    cleaning = by_id(facility["operations"], "cleaning")
    pallets = by_id(facility["operations"], "pallet_transport")
    assert cleaning.get("steady")
    assert peak_demand(cleaning, facility) == pytest.approx(7000 / 22, rel=1e-6)
    # у потока паллет пик остается
    assert peak_demand(pallets, facility) == pytest.approx(2000 * pallets["automatable_share"] / 22 * 1.5, rel=1e-6)


def test_cleaning_fleet_by_formula_is_one_robot(model):
    for robot_id in ("clinbotics-400-pro", "clinbotics-600"):
        comparison = evaluate(model, "warehouse", "cleaning", robot_id)
        assert comparison.sizing.fleet == 1, robot_id
        assert comparison.sizing.design_demand == pytest.approx(7000 / 22 * 1.15, rel=1e-6)
    purchase = evaluate(model, "warehouse", "cleaning", "clinbotics-400-pro").scenarios[PURCHASE]
    # один робот вместо трех: 1,5 млн изделие, старт около 1,8 млн вместо 5,3
    assert purchase.investment_year0 < 2.5e6


def test_shift_search_takes_one_cleaner_and_it_washes_through_the_shift():
    """Прогон: один Клинботикс 400 PRO домывает площадь смены, участки разложены по смене,
    поэтому последняя мойка начинается во второй половине смены, а не все в первые часы."""
    plan = service.plan_for("warehouse", "cleaning", None)
    search = service.fleet_for("warehouse", "cleaning", "clinbotics-400-pro", plan)
    assert search.working == 1
    model, _ = model_with_overrides({})
    facility = by_id(model["facilities"], "warehouse")
    operation = by_id(facility["operations"], "cleaning")
    hours = model["engine"]["simulation"]["hours"]
    result = service.run("warehouse", "cleaning", "clinbotics-400-pro", 1, plan, True, False, {})
    demand = sum(service.shift_demand(model, facility, operation))
    assert result.kpi.done * 933 == pytest.approx(demand, rel=0.01)
    washes = [part for part in result.segments if part.action == "моет"]
    assert washes and max(part.from_s for part in washes) > hours * 3600 * 0.5
    assert 0.35 < result.kpi.busy_share < 0.85
    assert "площадь за смену" in result.kpi.bottleneck or "узкого места нет" in result.kpi.bottleneck
