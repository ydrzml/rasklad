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
from app.settings import settings

FACILITY = "warehouse"
PHOTOS = settings.data_dir / "catalog" / "photos"


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
    # решение, которое подбор исключает на типовом объекте (груз тяжелее, проезд уже), расчет отклоняет
    catalog_id = next(r["catalog_id"] for r in calculation.model_with_overrides({})[0]["robots"] if r["id"] == robot)
    excluded = any(
        one.id == catalog_id and one.status == "excluded" for one in selection.solutions(FACILITY, operation)
    )
    assert answer.feasible != excluded, answer.message


def test_selection_links_by_catalog_number_and_gives_photos():
    """Карточка подбора знает робота модели по номеру решения и отдает адрес фото."""
    for operation in ("pallet_transport", "piece_picking", "cleaning"):
        # кандидаты «требует проверки» по задаче в счет не идут: у AS-RS расчетных параметров нет
        fitting = [s for s in selection.solutions(FACILITY, operation) if s.status != "excluded" and confirmed(s)]
        assert fitting
        assert all(s.can_calculate and s.robot_id for s in fitting)
        # Фото каталога организатора в открытом репозитории нет: адрес фото проверяем, только если они лежат
        if not PHOTOS.is_dir():
            continue
        assert all((s.photo_url or "").startswith(f"/api/catalog/photos/{s.id}?v=") for s in fitting)


def confirmed(solution) -> bool:
    """Задача решения подтверждена, а не размечена кандидатом «требует проверки»."""
    return next(c for c in solution.checks if c.label == "Процесс").outcome == "fits"


LIFTING_ROBOTS = ["Ronavi H1500", "AMR 800", "AMR 1500", "DMR 1200", "DMR 600"]


def picking() -> dict:
    return {s.product.split(" (")[0]: s for s in selection.solutions(FACILITY, "piece_picking")}


def test_picking_offers_the_confirmed_robot_and_five_lifting_ones_on_condition():
    """Отбор товара: Ronavi M подтвержден, пять низких роботов с подъемом подходят при условии.
    Шестой, Сёмабот, остается в "требует проверки": в каталоге линейка моделей, какая из них у вас, неизвестно.
    Паллетные тележки без оговорок не предлагаем."""
    found = picking()
    fitting = [name for name, s in found.items() if s.status == "recommended"]
    assert sorted(fitting) == sorted(["Ronavi M", *LIFTING_ROBOTS])
    # Ronavi M без условия, у остальных условие стоит проверкой "Условие" и в вопросе поставщику
    assert not [c for c in found["Ronavi M"].checks if c.label == "Условие"]
    for name in LIFTING_ROBOTS:
        condition = next(c for c in found[name].checks if c.label == "Условие")
        assert "не подтвержден производителем" in condition.detail and "спросите поставщика" in condition.detail, name
        assert found[name].can_calculate and found[name].robot_id, name


def test_conditional_robots_score_below_the_confirmed_one():
    """Неподтвержденная задача стоит в баллах: Ronavi M остается первым при "сначала лучшие"."""
    found = picking()
    best = found["Ronavi M"]
    for name in LIFTING_ROBOTS:
        assert found[name].score < best.score, name
        factor = next(f for f in found[name].factors if f.label == "Подходит процессу")
        assert 0 < factor.contribution < next(f for f in best.factors if f.label == "Подходит процессу").contribution
    ordered = [s.product.split(" (")[0] for s in selection.solutions(FACILITY, "piece_picking")]
    assert ordered[0] == "Ronavi M"


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
    """Две стационарные системы AS-RS подают к станции ящик, а не стеллаж: их задача не проверена.
    Они стоят в «требует проверки» с причиной, а не в «не подходит»."""
    found = picking()
    candidates = ["AS-RS P", "AS-RS B"]
    semabot = found["Сёмабот"]
    assert semabot.status == "needs_check"
    assert "линейка моделей" in next(c for c in semabot.checks if c.label == "Грузоподъемность").detail
    assert next(c for c in semabot.checks if c.label == "Условие")
    for name in candidates:
        process = next(c for c in found[name].checks if c.label == "Процесс")
        assert found[name].status == "needs_check", name
        assert process.outcome == "unknown" and "уточните у производителя" in process.detail, name
    # остальное не для этой задачи, как и было
    kept = 1 + len(LIFTING_ROBOTS) + len(candidates) + 1
    assert sum(s.status == "excluded" for s in found.values()) == len(found) - kept


def test_supplier_gets_the_goods_to_person_question_only_for_conditional_robots():
    """Вопрос про подвоз стеллажа идет на шаг 5, в PDF и Excel, когда выбран один из условных."""

    def topics(robot: str) -> list[str]:
        answer = calculation.calculate(
            CalculationRequest(facility_id=FACILITY, operation_id="piece_picking", robot_id=robot)
        )
        return [one.topic for one in answer.supplier_questions]

    topic = 'Работа "товар к человеку"'
    assert topic in topics("moros-amr-800")
    assert topic not in topics("ronavi-m")
