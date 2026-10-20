"""Уборка: парк под площадь смены, а не под пиковый час склада.

Пример руками (Клинботикс 400 PRO). Робот моет и когда склад закрыт, окно 24 часа в сутки
(robot_hours_per_day у задачи уборки), смены склада на парк уборки не влияют:
    роботам отдано 10 000 м² в сутки (робот проходит те же проезды, что машина) на 24 часа = 416,7 м² в час
    пикового часа нет (steady), с резервом 15%: 479,2 м² в час
    робот моет 700 м²/ч, с загрузкой 0,75 это 525 м²/ч: 479,2 / 525 = 0,91, вверх 1 робот по формуле
    если бы считали пик склада: 416,7 * 1,5 * 1,15 = 718,8, это уже 2
По прогону на плане по умолчанию одному роботу не хватает: 500 м² в час меньше 479,2 / 0,9 = 532,4,
прогон берет двоих. На плане демо уборки площадь меньше, и там хватает одного.
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
    assert peak_demand(cleaning, facility) == pytest.approx(10_000 / 24, rel=1e-6)
    # у потока паллет пик остается, и спрос делится на 22 часа смен склада, а не на окно 24 часа
    assert peak_demand(pallets, facility) == pytest.approx(2000 * pallets["automatable_share"] / 22 * 1.5, rel=1e-6)


def test_cleaning_fleet_by_formula_is_one_robot(model):
    for robot_id in ("clinbotics-400-pro", "clinbotics-600"):
        comparison = evaluate(model, "warehouse", "cleaning", robot_id)
        assert comparison.sizing.fleet == 1, robot_id
        assert comparison.sizing.design_demand == pytest.approx(10_000 / 24 * 1.15, rel=1e-6)
    purchase = evaluate(model, "warehouse", "cleaning", "clinbotics-400-pro").scenarios[PURCHASE]
    # один робот вместо трех: 1,5 млн изделие, старт около 1,8 млн вместо 5,3
    assert purchase.investment_year0 < 2.5e6


def test_shift_search_takes_two_cleaners_and_they_wash_through_the_shift():
    """Прогон на плане по умолчанию: робот моет всю площадь машины, 10 000 м² в сутки, и одному
    Клинботикс 600 на двух seed из трех выходит 500 м² в час, меньше спроса с резервом и простоем
    479,2 / 0,9 = 532,4, поэтому поиск берет двоих. Участки разложены по смене, поэтому последняя мойка начинается во второй
    половине смены, а не все в первые часы."""
    plan = service.plan_for("warehouse", "cleaning", None)
    search = service.fleet_for("warehouse", "cleaning", "clinbotics-600", plan)
    assert search.working == 2
    model, _ = model_with_overrides({})
    facility = by_id(model["facilities"], "warehouse")
    operation = by_id(facility["operations"], "cleaning")
    hours = model["engine"]["simulation"]["hours"]
    result = service.run("warehouse", "cleaning", "clinbotics-600", 2, plan, True, False, {})

    demand = sum(service.shift_demand(model, facility, operation))
    assert result.kpi.done * 1000 == pytest.approx(demand, rel=0.01)
    washes = [part for part in result.segments if part.action == "моет"]
    assert washes and max(part.from_s for part in washes) > hours * 3600 * 0.5
    # двое на спрос, которому одного чуть не хватает: каждый занят около четверти смены
    assert 0.2 < result.kpi.busy_share < 0.85
    assert "площадь за смену" in result.kpi.bottleneck or "узкого места нет" in result.kpi.bottleneck
