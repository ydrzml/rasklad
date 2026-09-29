"""Каждое решение каталога, которое по нашей разметке делает задачу склада, считается целиком.

Проверяем на настоящей конфигурации, что у каждого подходящего
решения есть робот в модели, экономика считается во всех сценариях, а прогон смены проходит без ошибок.
"""

import math

import pytest

from app.engine.economics import PURCHASE, evaluate
from app.engine.selection import UNVERIFIED
from app.schemas.economics import CalculationRequest
from app.schemas.simulation import SimulationRequest
from app.services import calculation, selection
from app.services import simulation as simulation_service

FACILITY = "warehouse"


def pairs() -> list[tuple[str, str]]:
    """Пары (задача, робот): все решения, которые мы разметили под задачи склада из модели."""
    model, _ = calculation.model_with_overrides({})
    operations = [op["id"] for op in next(f for f in model["facilities"] if f["id"] == FACILITY)["operations"]]
    robots = selection.robots_by_catalog_id()
    found = []
    for item in selection.catalog():
        for operation, note in item["uses"].items():
            # «требует проверки»: задачу решению мы не подтверждали, только показываем кандидатом
            if operation in operations and not note.startswith(UNVERIFIED):
                found.append((operation, robots.get(item["id"], f"нет в модели: {item['product']}")))
    return sorted(found)


PAIRS = pairs()


def test_every_marked_solution_has_a_robot_in_the_model():
    missing = [robot for _, robot in PAIRS if robot.startswith("нет в модели")]
    assert not missing
    # на каждую задачу склада есть хотя бы одно решение
    assert {operation for operation, _ in PAIRS} == {"pallet_transport", "piece_picking", "cleaning"}


def test_catalog_id_points_to_a_real_catalog_row():
    model, _ = calculation.model_with_overrides({})
    ids = {item["id"] for item in selection.catalog()}
    assert all(robot["catalog_id"] in ids for robot in model["robots"])


@pytest.mark.parametrize(("operation", "robot"), PAIRS)
def test_economics_counts_for_every_solution(operation, robot):
    model, _ = calculation.model_with_overrides({})
    result = evaluate(model, FACILITY, operation, robot)
    assert result.feasible, f"{robot} не покрывает спрос задачи {operation}"
    purchase = result.scenarios[PURCHASE]
    assert result.sizing.fleet >= 1
    assert math.isfinite(purchase.tco) and purchase.tco > 0


@pytest.mark.parametrize(("operation", "robot"), PAIRS)
def test_shift_runs_for_every_solution(operation, robot):
    """Прогон смены на типовом плане и расчет с парком по прогону, как их зовет интерфейс."""
    shift = simulation_service.to_schema(
        SimulationRequest(facility_id=FACILITY, operation_id=operation, robot_id=robot, fleet=5, with_events=False)
    )
    assert shift.kpi.done > 0
    assert shift.fleet_needed is not None, f"{robot}: прогон не нашел парк под спрос задачи {operation}"

    answer = calculation.calculate(
        CalculationRequest(facility_id=FACILITY, operation_id=operation, robot_id=robot, use_simulation=True)
    )
    assert answer.feasible, answer.message


def test_selection_links_by_catalog_number_and_gives_photos():
    """Карточка подбора знает робота модели по номеру решения и отдает адрес фото.

    Фото решений сделаны из каталога организатора хакатона и лежат только в закрытом репозитории
    (data/catalog/photos). В этой копии их нет, поэтому проверку адреса фото пропускаем."""
    from app.settings import settings

    if not (settings.data_dir / "catalog" / "photos").is_dir():
        pytest.skip("фото каталога организатора нет в этой копии (data/catalog/photos)")
    for operation in ("pallet_transport", "piece_picking", "cleaning"):
        # кандидаты «требует проверки» по задаче в счет не идут: у AS-RS расчетных параметров нет
        fitting = [s for s in selection.solutions(FACILITY, operation) if s.status != "excluded" and confirmed(s)]
        assert fitting
        assert all(s.can_calculate and s.robot_id for s in fitting)
        assert all((s.photo_url or "").startswith(f"/api/catalog/photos/{s.id}?v=") for s in fitting)


def confirmed(solution) -> bool:
    """Задача решения подтверждена, а не размечена кандидатом «требует проверки»."""
    return next(c for c in solution.checks if c.label == "Процесс").outcome == "fits"


def test_picking_offers_only_robots_that_bring_racks_to_the_picker():
    """Паллетные тележки под отбор без оговорок не предлагаем: по разметке отбор делает только тот,
    кто возит стеллажи. Остальные низкие роботы стоят кандидатами «требует проверки»."""
    fitting = [s.product for s in selection.solutions(FACILITY, "piece_picking") if confirmed(s)]
    assert fitting == ["Ronavi M (грузоподъемность до 1200 кг)"]


def test_cleaner_wash_and_refill_add_up():
    """У уборщика handling_s это мойка участка и слив с наливом на базе. Прогон ставит мойку
    к месту, а на базу только refill_s, поэтому мойка должна сходиться с участком и выработкой."""
    model, _ = calculation.model_with_overrides({})
    cleaners = [robot for robot in model["robots"] if robot["type"] == "cleaning"]
    assert cleaners
    for robot in cleaners:
        wash_s = robot["area_per_trip_m2"] / robot["nominal_trips_per_hour"] * 3600
        assert 0 < robot["refill_s"] <= 600, robot["id"]  # не больше 10 минут на полный бак
        assert robot["handling_s"] - robot["refill_s"] == pytest.approx(wash_s, abs=1), robot["id"]


def test_picking_shows_candidates_to_check_instead_of_excluding_them():
    """Для отбора товара размечен один робот, еще восемь могут подойти, но это никто не проверял.
    Они стоят в «требует проверки» с причиной, а не в «не подходит»."""
    found = {s.product.split(" (")[0]: s for s in selection.solutions(FACILITY, "piece_picking")}
    assert found["Ronavi M"].status != "excluded"
    candidates = ["Ronavi H1500", "AMR 800", "AMR 1500", "DMR 1200", "DMR 600", "Сёмабот", "AS-RS P", "AS-RS B"]
    for name in candidates:
        process = next(c for c in found[name].checks if c.label == "Процесс")
        assert found[name].status == "needs_check", name
        assert process.outcome == "unknown" and "уточните у производителя" in process.detail, name
    # остальное не для этой задачи, как и было
    assert sum(s.status == "excluded" for s in found.values()) == len(found) - 1 - len(candidates)
