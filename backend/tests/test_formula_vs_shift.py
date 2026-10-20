"""Парк по формуле считает то же, что прогон смены, только без очередей (docs/calculation.md, 1.3).

До 20.10.2026 на разборе Восток-Сервиса формула давала 9 роботов при 23 по прогону: прогон держит
робота у станции, пока человек снимает строки со стеллажа, а формула эту стоянку не считала. На разборе
уборки формула давала 2 робота при 4: AK-SC80 работает 4 ч и заряжается 5 ч, а формула брала загрузку
0,75, как у робота с короткой зарядкой."""

import pytest

from app.engine.economics.fleet import robot_ops_per_hour, station_service_s, work_share
from app.engine.economics.scenarios import by_id, size
from app.services.calculation import model_with_overrides
from app.services.demo_cases import CASES

# маршрут робозоны разбора: plan_service.measure(plan).route_m для типовой робозоны 7 000 м2
VOSTOK_ROUTE_M = 45.43


def parts(case_id: str) -> tuple[dict, dict, dict, dict]:
    one = CASES[case_id]
    model, _ = model_with_overrides(one.overrides)
    facility = by_id(model["facilities"], "warehouse")
    return model, facility, by_id(facility["operations"], one.operation_id), by_id(model["robots"], one.robot_id)


def test_robot_waits_at_the_station_as_long_as_in_the_shift_run():
    """75 строк в час на станции, 1,9 строки за подачу: 3600 / 75 * 1,9 = 91,2 с у станции на рейс"""
    _, _, operation, _ = parts("picking")
    assert station_service_s(operation) == pytest.approx(91.2)


def test_tasks_without_stations_do_not_wait():
    for case_id in ("pallets", "cleaning"):
        _, _, operation, _ = parts(case_id)
        assert station_service_s(operation) == 0


def test_vostok_formula_counts_the_station():
    """Руками: цикл 2 * 45,43 / 1,0 + 20 + 91,2 = 202,1 с, 3600 / 202,1 * 1,9 = 33,85 строки в час,
    с загрузкой 0,75 это 25,39. Пик 5 233 / 22 * 1,5 * 1,15 = 410,3, 410,3 / 25,39 = 16,2, вверх 17.
    Без стоянки было 3600 / 110,9 * 1,9 * 0,75 = 46,3 строки в час и 9 роботов. Прогон дает 23:
    робот еще возвращает стеллаж и едет за следующим, цикл на пределе 300-316 с, очереди у станций
    3-8% времени, 20 роботов в работе и запас 10% на ремонт"""
    model, facility, operation, robot = parts("picking")
    sizing = size(model, facility, operation, robot, None, route_m=VOSTOK_ROUTE_M)
    assert sizing.design_demand == pytest.approx(410.31, abs=0.01)
    assert sizing.robot_rate == pytest.approx(33.85, abs=0.01)
    assert sizing.effective_rate == pytest.approx(25.39, abs=0.01)
    assert sizing.fleet == 17


def test_nominal_trips_already_include_the_station():
    """Номинал Ronavi M (30 подач в час, Яндекс Роботикс) это полный цикл со станцией: стоянку не добавляем"""
    _, _, operation, _ = parts("picking")
    model, _ = model_with_overrides({})
    ronavi_m = by_id(model["robots"], "ronavi-m")
    assert robot_ops_per_hour(ronavi_m, VOSTOK_ROUTE_M, 1.9, station_service_s(operation)) == pytest.approx(57)


def test_work_share_is_cut_by_a_long_charge():
    """AK-SC80: 4 ч работы и 5 ч зарядки, работает 4 / 9 = 0,44 времени. У H1500 зарядка 0,3 ч на 6 ч
    работы, батарея загрузку 0,75 не режет"""
    model, _ = model_with_overrides({})
    assert work_share(by_id(model["robots"], "avtomakon-ak-sc80")) == pytest.approx(4 / 9)
    assert work_share(by_id(model["robots"], "ronavi-h1500")) == 0.75


def test_cleaning_formula_counts_the_charge():
    """Руками: 30 000 м2 за 24 ч = 1 250 м2/ч, с резервом 1 437,5. Робот 1 350 м2/ч * 4 / 9 = 600,
    1 437,5 / 600 = 2,4, вверх 3. С загрузкой 0,75 было 1 012,5 м2/ч и 2 робота, прогон дает 4"""
    model, facility, operation, robot = parts("cleaning")
    sizing = size(model, facility, operation, robot, None)
    assert sizing.design_demand == pytest.approx(1437.5)
    assert sizing.effective_rate == pytest.approx(600)
    assert sizing.fleet == 3
