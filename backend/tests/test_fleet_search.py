"""Поиск парка по прогону смены: самый маленький парк, который вытянул спрос на всех seed.

Потолок смены здесь рисуем сами, чтобы проверить сам поиск, а не движок: прямая до полки,
seed сдвигают ее на свой шум. Настоящие склады гоняет стенд scripts/fleet_search_bench.py.
"""

from __future__ import annotations

import math

from fastapi.testclient import TestClient

from app.engine.economics.fleet import required_fleet
from app.engine.simulation import search_curve, search_fleet
from app.main import app

SEEDS = (42, 7, 2026)


def ceiling(per_robot: float, shelf: float, noise: dict[int, float] | None = None):
    """Потолок смены: per_robot операций в час на исправного робота, но не выше полки."""
    noise = noise or {}
    calls: list[int] = []

    def measure(jobs: list[tuple[int, int]]) -> dict[tuple[int, int], float]:
        calls.append(len(jobs))
        return {(w, seed): min(shelf, w * per_robot) + noise.get(seed, 0.0) for w, seed in jobs}

    return measure, calls


def test_finds_the_smallest_fleet_that_covers_demand():
    measure, calls = ceiling(per_robot=16.0, shelf=10_000)
    found = search_fleet(measure, demand=149, top=225, guess=9, seeds=SEEDS)
    assert found.working == math.ceil(149 / 16)  # 10: 9 роботов дают 144
    assert found.worst(10) >= 149 > found.worst(9)
    assert sum(calls) < 25  # подряд до спроса было бы десять замеров на каждый seed


def test_answer_holds_on_every_seed_not_on_average():
    # seed 7 чуть хуже: там парку из 10 не хватает, а на остальных хватает
    measure, _ = ceiling(per_robot=16.0, shelf=10_000, noise={7: -12.0})
    found = search_fleet(measure, demand=149, top=225, guess=9, seeds=SEEDS)
    assert found.working == 11


def test_bad_guess_still_lands_on_the_answer():
    # формула промахнулась вдвое, как на отборе: 105 вместо 185
    measure, _ = ceiling(per_robot=12.7, shelf=10_000)
    found = search_fleet(measure, demand=2352, top=225, guess=95, seeds=SEEDS)
    assert found.working == math.ceil(2352 / 12.7)


def test_shelf_below_demand_means_no_fleet():
    measure, calls = ceiling(per_robot=20.0, shelf=2390)
    found = search_fleet(measure, demand=4000, top=225, guess=180, seeds=SEEDS)
    assert found.working is None
    assert sum(calls) <= 10  # полку видно сразу, всю кривую не гоняем


def test_curve_from_search_gives_exactly_the_found_fleet():
    """Расчет экономики берет парк по кривой: он должен совпасть с найденным, а не выйти на
    робота меньше из-за того, что между замерами кривая дотянулась бы до спроса на бумаге."""
    measure, _ = ceiling(per_robot=16.0, shelf=10_000)
    found = search_fleet(measure, demand=149, top=225, guess=9, seeds=SEEDS)
    curve = search_curve(found, availability=0.9, max_fleet=250)
    assert required_fleet(149, curve) == math.ceil(found.working / 0.9)  # 10 исправных из 12


def test_api_returns_the_fleet_the_shift_needs_and_points_for_the_chart():
    body = TestClient(app).post("/api/simulation/runs", json={"fleet": 12, "with_events": False}).json()
    assert body["fleet_needed"] >= 1
    points = body["curve_points"]
    # на графике только замеры: ноль роботов никто не мерил
    assert points and points[0][0] > 0
    # парк целым числом роботов: дробный парк на графике читался как «7,8 робота»
    assert all(float(point[0]).is_integer() for point in points)
    assert all(later[0] > earlier[0] for earlier, later in zip(points, points[1:], strict=False))
    # парк, который нужен смене, вытянул спрос в худшем из seed, а на робота меньше нет
    curve = body["curve_ops_per_hour"]
    assert curve[body["fleet_needed"]] >= body["design_demand"]
    assert curve[body["fleet_needed"] - 1] < body["design_demand"]
