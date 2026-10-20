"""Расчет по объекту: общие дежурные и общие затраты не должны считаться дважды.

Проверяем на настоящей конфигурации, потому что смысл тут именно в том, как складываются
несколько задач, а не в отдельной формуле.
"""

import copy

import pytest

from app.engine.economics import BASELINE, PURCHASE, RAAS, evaluate
from app.engine.economics.facility import Task, evaluate_facility, operator_posts_for_facility
from app.engine.economics.scenarios import communications
from app.engine.model_config import load_full_model
from app.settings import settings

PALLETS = Task("pallet_transport", "ronavi-h1500")
CLEANING = Task("cleaning", "clinbotics-600")
# цены и постоянные вложения в расчете без НДС 22% (docs/decisions.md, «Цены без НДС»)
VAT = 1.22


@pytest.fixture(scope="module")
def model():
    return load_full_model(settings.config_dir)[0]


@pytest.fixture(scope="module")
def both(model):
    return evaluate_facility(model, "warehouse", [PALLETS, CLEANING])


def test_one_watch_for_the_whole_site(both):
    """Присмотр один на объект: нагрузка транспортных и уборочного роботов складывается.
    Руками: (10 + 1) * 1,5 / 60 = 0,275 поста, без округления вверх."""
    assert both.operator_posts == pytest.approx(0.275)


def test_duty_operators_grow_with_the_whole_fleet(model):
    """Минимум дежурных применяется один раз, но нагрузка складывается по всем задачам."""
    facility = model["facilities"][0]
    robot = model["robots"][0]  # 1,5 минуты внимания на робота в час
    # 10 роботов дают 15 минут в час, это четверть поста: минимум дежурных по умолчанию 0
    assert operator_posts_for_facility(model, facility, {"a": (robot, 10)}) == pytest.approx(0.25)
    # 200 роботов дают 300 минут в час, это пять постов одновременно
    assert operator_posts_for_facility(model, facility, {"a": (robot, 100), "b": (robot, 100)}) == pytest.approx(5)
    # дежурный, которого объект держит всегда, задается минимумом
    held = {**facility, "min_operator_posts": 1}
    assert operator_posts_for_facility(model, held, {"a": (robot, 10)}) == 1


def test_integration_is_paid_once(both, model):
    """Интеграцию с учетной системой делают один раз, сколько бы задач ни выбрали."""
    alone = evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500")
    assert both.scenarios[PURCHASE].capex["integration"] == alone.scenarios[PURCHASE].capex["integration"]


def test_software_is_paid_once_per_vendor(model):
    """ПО управления парком одно на производителя: паллеты и отбор на роботах Ronavi платят 1,5 млн
    один раз, паллеты на Ronavi и уборка на Вейботе платят каждый свое (у Вейбота оно в цене, ноль)."""
    same = evaluate_facility(model, "warehouse", [PALLETS, Task("piece_picking", "ronavi-m")])
    assert same.feasible
    assert same.scenarios[PURCHASE].capex["software"] == pytest.approx(1_500_000 / VAT)
    assert all(c.scenarios[PURCHASE].capex["software"] == 0.0 for c in same.tasks.values())
    assert same.shared.scenarios[PURCHASE].capex["software"] == pytest.approx(1_500_000 / VAT)
    different = evaluate_facility(model, "warehouse", [PALLETS, Task("pallet_transport", "moros-amr-1500", 0.5)])
    if different.feasible:
        assert different.scenarios[PURCHASE].capex["software"] == pytest.approx(3_000_000 / VAT)
    alone = evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500")
    assert alone.scenarios[PURCHASE].capex["software"] == pytest.approx(1_500_000 / VAT)
    # при аренде ПО в плате за месяц, на старте его нет
    assert same.scenarios[RAAS].capex.get("software", 0.0) == 0.0


def test_capex_is_the_sum_of_tasks(both, model):
    """Оборудование складывается: каждая задача покупает своих роботов."""
    pallets = evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500")
    cleaning = evaluate(model, "warehouse", "cleaning", "clinbotics-600")
    expected = pallets.scenarios[PURCHASE].capex["hardware"] + cleaning.scenarios[PURCHASE].capex["hardware"]
    assert both.scenarios[PURCHASE].capex["hardware"] == pytest.approx(expected)


def test_together_beats_the_sum_of_separate_runs(both, model):
    """Вместе задачи выгоднее, чем по отдельности, ровно на общих людях и общей связи.

    По отдельности каждая задача нанимает своего дежурного и платит за связь. Вместе дежурный
    один, и стоит он средневзвешенно по парку: (10 * 1 880 640 + 1 * 720 000) / 11 = 1 775 127 ₽ в год.
    """
    pallets = evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500")
    cleaning = evaluate(model, "warehouse", "cleaning", "clinbotics-600")
    separately = pallets.scenarios[PURCHASE].years[0].effect + cleaning.scenarios[PURCHASE].years[0].effect
    together = both.scenarios[PURCHASE].years[0].effect

    shared = both.shared
    assert shared.operator_cost == pytest.approx(1_775_127.27, abs=1)
    saved_operators = (
        pallets.sizing.operators_fte * pallets.sizing.operator_cost
        + cleaning.sizing.operators_fte * cleaning.sizing.operator_cost
        - shared.operators_fte * shared.operator_cost
    )
    # связь от числа роботов: по отдельности 10 роботов платят 300 000, один уборщик ноль (меньше 3 роботов),
    # вместе 11 роботов 330 000, все без НДС. Вместе связь дороже на 30 000 / 1,22
    site = model["facilities"][0]
    saved_communications = (communications(site, 10) + communications(site, 1) - communications(site, 11)) / VAT
    assert together - separately == pytest.approx(saved_operators + saved_communications)


def test_order_of_tasks_does_not_change_the_site(model):
    """Общее считается по объекту, и порядок задач ни на что не влияет. Если считать общее
    параметрами первой задачи, уборка первой обнулит интеграцию и сделает дежурного дешевле."""
    forward = evaluate_facility(model, "warehouse", [PALLETS, CLEANING], subsidy_ids=("minpromtorg-robotics",))
    backward = evaluate_facility(model, "warehouse", [CLEANING, PALLETS], subsidy_ids=("minpromtorg-robotics",))
    for scenario_id in forward.scenarios:
        assert forward.scenarios[scenario_id].tco == pytest.approx(backward.scenarios[scenario_id].tco)
        assert forward.scenarios[scenario_id].investment_total == pytest.approx(
            backward.scenarios[scenario_id].investment_total
        )
    assert forward.shared.operator_cost == pytest.approx(backward.shared.operator_cost)
    assert forward.shared.integration == pytest.approx(5_000_000 / VAT)


def test_rent_is_skipped_when_one_task_has_no_rental_price(model):
    """Если у робота одной из задач цены аренды нет, аренды по объекту не будет, и расчет говорит почему."""
    changed = copy.deepcopy(model)
    del next(robot for robot in changed["robots"] if robot["id"] == "clinbotics-600")["raas"]
    result = evaluate_facility(changed, "warehouse", [PALLETS, CLEANING])
    assert RAAS not in result.scenarios
    assert result.notes and "cleaning" in result.notes[0]


def test_rent_is_kept_when_every_task_has_a_price(model):
    result = evaluate_facility(model, "warehouse", [PALLETS, Task("piece_picking", "ronavi-m")])
    assert RAAS in result.scenarios
    assert result.notes == []


def test_empty_selection_is_not_a_crash(model):
    result = evaluate_facility(model, "warehouse", [])
    assert not result.feasible
    assert "задач" in result.message


def test_single_task_matches_the_plain_calculation(model):
    """Одна задача через расчет по объекту должна дать то же, что обычный расчет."""
    alone = evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500")
    via_facility = evaluate_facility(model, "warehouse", [PALLETS])
    assert via_facility.scenarios[PURCHASE].capex_total == pytest.approx(alone.scenarios[PURCHASE].capex_total)
    assert via_facility.scenarios[PURCHASE].payback_cumulative == pytest.approx(
        alone.scenarios[PURCHASE].payback_cumulative
    )


def test_operators_are_retrained_once_for_the_site(both):
    """Дежурный один, и переучивают его один раз, а не в каждой задаче.

    Руками: 0,275 поста * 5,09 ставки на пост (22 ч, 365 дней) * 10 000 ₽ за курс = 13 997,53 ₽.
    Уборка не платит за тот же присмотр еще раз.
    Резерв 10% от всех статей, цены без НДС 22%, курсы без НДС:
    ((29,31 + 1,35 + 1,5 + 5 + 3 + 2,85015) / 1,22 + 0,014) * 0,1 = 3,526822 млн ₽.
    """
    capex = both.scenarios[PURCHASE].capex
    assert capex["retraining"] == pytest.approx(13_997.53, abs=1)
    assert both.tasks[CLEANING.key].scenarios[PURCHASE].capex["retraining"] == 0
    assert capex["reserve"] == pytest.approx(3_526_822, abs=1)


def test_tasks_plus_shared_make_the_site(both):
    """Задача считается без общих затрат, общее лежит отдельным блоком, сумма дает объект.

    Общее при покупке: ПО Ronavi 1,5 млн (у Вейбота в цене), интеграция 5 млн, инфраструктура 3 млн,
    все без НДС, на 11 роботов целиком; переобучение 13 997,53 ₽ и резерв 10% от них:
    (9,5 / 1,22 + 0,014) * 1,1 = 8,580971 млн ₽. Связь на 11 роботов 11 * 30 000 / 1,22 = 270 492 ₽
    и присмотр 0,275 * 5,09 * 1 775 127 = 2,485 млн в первый год.
    """
    shared = both.shared.scenarios[PURCHASE]
    assert shared.capex_total == pytest.approx(8_580_971, abs=1)
    assert shared.years[0].opex["communications"] == pytest.approx(11 * 30_000 / VAT)
    assert shared.years[0].opex["operators"] == pytest.approx(2_484_739, abs=100)
    own = both.tasks[PALLETS.key].scenarios[PURCHASE]
    assert own.years[0].opex["operators"] == 0
    assert own.years[0].opex["communications"] == 0
    parts = [c.scenarios[PURCHASE].capex_total for c in both.tasks.values()] + [shared.capex_total]
    assert sum(parts) == pytest.approx(both.scenarios[PURCHASE].capex_total)


def test_mixed_fleet_splits_the_task_by_share(model):
    """Смешанный парк: два решения на одну задачу с долями объема. Часть считается как задача
    с долей работы, посильной роботам, умноженной на долю: спрос, парк и люди делятся в той же доле.

    Руками: паллеты целиком на Ronavi H1500 это спрос с запасом 148,98 в час, 10 роботов, 25 * 0,74 = 18,5
    ставки. Половина: 74,49 в час, 74,49 / 15,88 = 4,69, вверх 5 роботов, 9,25 ставки. Две половины
    на разных роботах: 5 + 5 = 10, люди 18,5, как у одного решения.
    """
    half = [Task("pallet_transport", "ronavi-h1500", 0.5), Task("pallet_transport", "moros-amr-1500", 0.5)]
    mixed = evaluate_facility(model, "warehouse", half)
    first = mixed.tasks[half[0].key].sizing
    assert first.design_demand == pytest.approx(148.98 / 2, abs=0.01)
    assert first.fleet == 5
    assert first.fte_before == pytest.approx(18.5 / 2)
    assert sum(mixed.tasks[task.key].sizing.fleet for task in half) == 10
    assert sum(mixed.tasks[task.key].sizing.fte_before for task in half) == pytest.approx(18.5)
    # интеграция и присмотр на объект один раз, как и у двух разных задач: 10 * 1,5 / 60 = 0,25 поста
    assert mixed.scenarios[PURCHASE].capex["integration"] == pytest.approx(5_000_000 / VAT)
    assert mixed.operator_posts == pytest.approx(0.25)

    # что забирают роботы, считается один раз на задачу, части делят его: вакансии не закрываются
    # дважды, а высвобожденные и оставшиеся складываются в целое
    whole = evaluate_facility(model, "warehouse", [PALLETS]).tasks[PALLETS.key].sizing
    parts = [mixed.tasks[task.key].sizing for task in half]
    assert sum(s.vacancies_closed_fte for s in parts) == pytest.approx(whole.vacancies_closed_fte)
    assert sum(s.people_freed_fte for s in parts) == pytest.approx(whole.people_freed_fte)
    assert sum(s.released_fte for s in parts) == pytest.approx(whole.released_fte)
    assert mixed.scenarios[BASELINE].tco == pytest.approx(
        evaluate_facility(model, "warehouse", [PALLETS]).scenarios[BASELINE].tco
    )


def test_split_does_not_move_the_baseline_or_close_vacancies_twice(model):
    """Пример из проверки: строка водителей погрузчиков, 25 мест, занято 15. Ronavi забирает
    25 * 0,74 = 18,5 ставки: закрывает 10 вакансий и высвобождает 8,5. У половин по 5 вакансий и 4,25
    ставки, вместе как у целого, а не 20 вакансий (есть только 10). "Без роботов" за 5 лет
    от деления не зависит."""
    changed = copy.deepcopy(model)
    facility = changed["facilities"][0]
    facility["staff"] = [
        {
            "id": "f",
            "role": "forklift_operator",
            "headcount": 25,
            "filled": 15,
            "salary_month": 120000,
            "contractor": False,
        }
    ]
    whole = evaluate_facility(changed, "warehouse", [PALLETS])
    w = whole.tasks[PALLETS.key].sizing
    assert w.vacancies_closed_fte == pytest.approx(10, abs=0.01)
    assert w.people_freed_fte == pytest.approx(8.5, abs=0.01)
    half = [Task("pallet_transport", "ronavi-h1500", 0.5), Task("pallet_transport", "moros-amr-1500", 0.5)]
    mixed = evaluate_facility(changed, "warehouse", half)
    parts = [mixed.tasks[task.key].sizing for task in half]
    assert [round(s.vacancies_closed_fte, 2) for s in parts] == [5.0, 5.0]
    assert sum(s.people_freed_fte for s in parts) == pytest.approx(8.5, abs=0.01)
    assert [round(s.people_freed_fte, 3) for s in parts] == [4.25, 4.25]

    assert mixed.shared.operators_short_fte == pytest.approx(whole.shared.operators_short_fte)

    # две строки одной роли с разным окладом: «без роботов» одинаково при любом делении
    facility["staff"] = [
        {
            "id": "a",
            "role": "forklift_operator",
            "headcount": 15,
            "filled": 15,
            "salary_month": 60000,
            "contractor": False,
        },
        {
            "id": "b",
            "role": "forklift_operator",
            "headcount": 10,
            "filled": 10,
            "salary_month": 150000,
            "contractor": True,
        },
    ]
    baselines = []
    for share in (1.0, 0.5, 0.9):
        tasks = (
            [PALLETS]
            if share == 1.0
            else [
                Task("pallet_transport", "ronavi-h1500", share),
                Task("pallet_transport", "moros-amr-1500", round(1 - share, 2)),
            ]
        )
        baselines.append(evaluate_facility(changed, "warehouse", tasks).scenarios[BASELINE].tco)
    assert baselines[1] == pytest.approx(baselines[0])
    assert baselines[2] == pytest.approx(baselines[0])
