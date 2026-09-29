"""Штат объекта: незанятые ставки, подрядчики, очередь ролей и перекомплект.

Эталонный пример со складскими данными лежит в tests/reference. Здесь проверяем поведение
модели персонала на маленьких примерах, где число можно посчитать в уме.
"""

import copy

import pytest

from app.engine.economics import BASELINE, evaluate
from app.engine.economics.staff import (
    contractor_full_cost,
    employee_full_cost,
    normative_gap,
    staff_lines,
    takes_on_operation,
)
from app.engine.model_config import load_full_model
from app.settings import settings

HOURS = 1972

ROLES = {
    "forklift_operator": {"id": "forklift_operator", "productivity": 20},
    "loader": {"id": "loader", "productivity": 10},
}


def facility(staff, automatable_share=1.0, **operation):
    return {
        "schedule": {"shifts": 2, "shift_hours": 11, "days_per_year": 365},
        "staff_loss_share": 0.25,
        "staff": staff,
        "operations": [
            {
                "id": "transport",
                "volume_per_day": 1000,
                "automatable_share": automatable_share,
                "performed_by": ["forklift_operator", "loader"],
                **operation,
            }
        ],
    }


def line(role, headcount, filled=None, salary=100_000, contractor=False):
    row = {"id": f"{role}-1", "role": role, "headcount": headcount, "salary_month": salary}
    if filled is not None:
        row["filled"] = filled
    if contractor:
        row["contractor"] = True
    return row


def takes(f):
    return takes_on_operation(f, ROLES, f["operations"][0], HOURS)


def test_full_staff_is_the_default():
    """Если пользователь не сказал, сколько ставок занято, считаем штат полным."""
    lines = staff_lines(facility([line("forklift_operator", 10)]))
    assert lines[0].filled == 10
    assert lines[0].vacancies == 0


def test_robots_close_vacancies_before_releasing_people():
    """Незанятая ставка денег не стоит, поэтому роботы забирают сначала ее."""
    result = takes(facility([line("forklift_operator", 10, filled=6)]))
    assert len(result) == 1
    take = result[0]
    assert take.fte_taken == pytest.approx(10)
    assert take.vacancies_closed == pytest.approx(4)  # 10 - 6
    assert take.people_released == pytest.approx(6)
    assert take.people_freed == pytest.approx(6)  # работу делают роботы, никто не остается


def test_closing_a_hole_saves_nothing():
    """Роботы забрали ровно столько, сколько не было занято: работа пошла, а экономии нет.

    Это важный случай для честности расчета. В роли 10 ставок, занято 5, роботам посильна
    половина объема. Все 5 забранных ставок приходятся на дыру, которую и так никто не закрывал,
    поэтому фонд оплаты труда не меняется, и продавать это как экономию нельзя.
    """
    take = takes(facility([line("forklift_operator", 10, filled=5)], automatable_share=0.5))[0]
    assert take.fte_taken == pytest.approx(5)
    assert take.vacancies_closed == pytest.approx(5)
    assert take.people_freed == 0


def test_queue_moves_to_the_next_role_when_the_first_runs_out():
    """Вариант очереди: сначала та роль, чью работу робот повторяет целиком, остаток следующей."""
    f = facility([line("forklift_operator", 4), line("loader", 10)])
    result = takes(f)
    assert [(t.role, round(t.fte_taken, 3)) for t in result] == [("forklift_operator", 4), ("loader", 10)]


def test_queue_stops_when_the_volume_runs_out():
    f = facility([line("forklift_operator", 4), line("loader", 10)], automatable_share=0.5)
    result = takes(f)
    # роботам посильна половина: 0.5 * (4 + 10) = 7, четыре берем у операторов, три у грузчиков
    assert [(t.role, round(t.fte_taken, 3)) for t in result] == [("forklift_operator", 4), ("loader", 3)]


def test_speedup_leaves_people_on_the_operation():
    """Товар к человеку: человек остается, но делает тот же объем быстрее."""
    f = facility([line("forklift_operator", 10)], productivity_before=100, productivity_after=250)
    take = takes(f)[0]
    assert take.fte_taken == pytest.approx(10)
    assert take.fte_left == pytest.approx(4)  # 10 * 100 / 250
    assert take.people_left == pytest.approx(4)
    assert take.people_freed == pytest.approx(6)


def test_overstaffed_line_is_visible_but_does_not_break_the_count():
    """Людей больше, чем ставок в расписании: вакансий нет, забираем по расписанию."""
    lines = staff_lines(facility([line("forklift_operator", 10, filled=12)]))
    assert lines[0].surplus == pytest.approx(2)
    assert lines[0].vacancies == 0


def test_contractor_costs_less_because_contributions_are_inside_the_price():
    payroll = {
        "insurance_rate": 0.3,
        "insurance_rate_above_limit": 0.151,
        "insurance_base_limit_rub": 2_979_000,
        "injury_insurance_rate": 0.006,
        "workwear_rub_year": 0,
        "turnover_rate": 0,
        "hire_cost_months": 0,
    }
    own = employee_full_cost(100_000, payroll)
    hired = contractor_full_cost(100_000)
    assert hired == pytest.approx(1_200_000)
    assert own == pytest.approx(1_200_000 * 1.306)
    assert own > hired


def test_normative_gap_shows_when_the_dataset_does_not_add_up():
    """Предупреждение при вводе: по объему и выработке людей нужно больше, чем указано."""
    f = facility([line("forklift_operator", 10)])
    # 1000 * 365 / (20 * 1972) * 1.25 = 11.57 ставки по нормативу против 10 указанных
    assert normative_gap(f, ROLES, "forklift_operator", HOURS) == pytest.approx(1.1568, abs=1e-4)


def test_role_without_productivity_is_not_touched():
    """Роль, для которой выработки нет, в расчет высвобождения не попадает."""
    roles = copy.deepcopy(ROLES)
    del roles["loader"]["productivity"]
    f = facility([line("loader", 10)])
    assert takes_on_operation(f, roles, f["operations"][0], HOURS) == []


def picking(headcount, lines=1, **operation):
    """Отбор «товар к человеку»: люди остаются на станциях и работают быстрее."""
    roles = {"picker": {"id": "picker", "productivity": 80}}
    staff = [{**line("picker", headcount / lines), "id": f"picker-{i}"} for i in range(lines)]
    f = {
        "schedule": {"shifts": 2, "shift_hours": 11, "days_per_year": 365},
        "staff_loss_share": 0.25,
        "staff": staff,
        "operations": [
            {
                "id": "piece_picking",
                "volume_per_day": 100_000,
                "automatable_share": 0.3,
                "performed_by": ["picker"],
                "productivity_before": 80,
                "productivity_after": 250,
                **operation,
            }
        ],
    }
    return takes_on_operation(f, roles, f["operations"][0], HOURS)


def test_picking_people_come_from_volume_not_from_staff():
    """Руками: 30 000 штучных строк в сутки * 365 / (80 строк/ч * 1972 ч) * 1,25 = 86,8 ставки.
    Это работа, которую делают люди при таком объеме, и от того, сколько отборщиков в штате, она не зависит."""
    need = 100_000 * 0.3 * 365 / (80 * HOURS) * 1.25
    for headcount in (25, 100, 300):
        result = picking(headcount, people_from_volume=1)
        assert sum(t.fte_taken for t in result) == pytest.approx(need)
        # после: те же люди на станциях при выработке 250 вместо 80
        assert sum(t.fte_left for t in result) == pytest.approx(need * 80 / 250)


def test_picking_from_volume_splits_between_lines_of_one_role():
    """Две строки отборщиков делят работу, а не считают ее каждая заново."""
    one = picking(100, people_from_volume=1)
    two = picking(100, lines=2, people_from_volume=1)
    assert sum(t.fte_taken for t in two) == pytest.approx(sum(t.fte_taken for t in one))


def test_without_the_flag_people_are_a_share_of_staff():
    """Остальные задачи считаются по-старому: доля от штата, 100 * 30% = 30 ставок."""
    result = picking(100)
    assert sum(t.fte_taken for t in result) == pytest.approx(30)


def test_vacancies_are_not_closed_beyond_the_line():
    """Работы по объему больше, чем мест в строке: вакансий закрывается не больше, чем их есть."""
    roles = {"picker": {"id": "picker", "productivity": 80}}
    f = {
        "schedule": {"shifts": 2, "shift_hours": 11, "days_per_year": 365},
        "staff_loss_share": 0.25,
        "staff": [line("picker", 25, filled=20)],
        "operations": [
            {
                "id": "piece_picking",
                "volume_per_day": 100_000,
                "automatable_share": 0.3,
                "performed_by": ["picker"],
                "productivity_before": 80,
                "productivity_after": 250,
                "people_from_volume": 1,
            }
        ],
    }
    take = takes_on_operation(f, roles, f["operations"][0], HOURS)[0]
    assert take.vacancies_closed == pytest.approx(5)


def test_closed_vacancies_are_not_money():
    """Пример из docs/calculation.md, раздел 2. Паллеты, операторов погрузчиков 25 ставок, заняты 20.

    Роботы забирают 25 * 0,95 = 23,75 ставки: 5 вакансий и 18,75 живых. Работу на вакансиях
    роботы делают, но за нее никто не получал зарплату, поэтому "без роботов" 18,75 ставки,
    18,75 * 1 880 640 = 35 262 000 рублей в год, а не 23,75 ставки и 44 665 200.
    """
    model = copy.deepcopy(load_full_model(settings.config_dir)[0])
    model["facilities"][0]["staff"][0]["filled"] = 20
    result = evaluate(model, "warehouse", "pallet_transport", "ronavi-h1500")
    s = result.sizing
    assert sum(t.fte_taken for t in s.takes) == pytest.approx(23.75)  # работу роботы делают всю
    assert s.vacancies_closed_fte == pytest.approx(5)
    assert s.fte_before == pytest.approx(18.75)
    assert s.released_fte == pytest.approx(s.people_freed_fte)
    assert s.worker_cost == pytest.approx(1_880_640)
    assert result.scenarios[BASELINE].years[0].staff_cost == pytest.approx(35_262_000)
