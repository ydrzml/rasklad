"""Правила подбора: что подходит, что мешает, чего не хватает и как считается балл (ТЗ, п. 3.4)."""

import pytest
from fastapi.testclient import TestClient

from app.engine import selection
from app.main import app

client = TestClient(app)
WEIGHTS = {"process": 0.3, "maturity": 0.2, "verified": 0.15, "data": 0.2, "headroom": 0.15}
FIELDS = ("payload_kg", "min_aisle_width_mm")
PROCESSES = ("Внутрискладская логистика",)


def solution(**overrides) -> dict:
    base = {
        "id": "test",
        "product": "Робот для теста",
        "process": "Внутрискладская логистика",
        "status": "operation",
        "tested_fcbas": "0",
        "registry_719": "0",
        "payload_kg": "1500",
        "payload_kg_trust": "B",
        "min_aisle_width_mm": "1200",
        "min_aisle_width_mm_trust": "C",
    }
    return base | overrides


def match(**overrides) -> selection.Match:
    requirements = {"processes": PROCESSES, "load_kg": 800, "aisle_mm": 2800}
    return selection.evaluate(solution(**overrides), requirements, FIELDS, WEIGHTS)


@pytest.mark.parametrize(
    "raw,expected",
    [("1500", 1500), ("до 1 500", 1500), ("0,75-1,0", 0.75), ("до 80–100", 80), ("", None), ("нет", None)],
)
def test_number_reads_values_as_written_in_catalog(raw, expected):
    assert selection.number(raw) == expected


def test_fitting_solution_is_recommended():
    result = match()
    assert result.status == selection.RECOMMENDED
    assert [check.outcome for check in result.checks] == [selection.FITS] * 4
    assert result.score == pytest.approx(0.3 + 0.2 + 0.2 + 0.15 * (1500 / 800) / 2)


def test_too_weak_robot_is_excluded():
    result = match(payload_kg="500")
    assert result.status == selection.EXCLUDED
    assert "Поднимает 500 кг, а груз весит 800 кг" in result.blocking[0].detail


def test_robot_that_does_not_fit_the_aisle_is_excluded():
    result = match(min_aisle_width_mm="3200")
    assert result.status == selection.EXCLUDED
    assert result.blocking[0].label == "Ширина прохода"


def test_other_process_is_excluded():
    result = match(process="Уборка помещений")
    assert result.status == selection.EXCLUDED


def test_missing_data_means_needs_check_not_exclusion():
    result = match(payload_kg="", payload_kg_trust="F")
    assert result.status == selection.NEEDS_CHECK
    assert "payload_kg" in result.missing
    assert result.checks[1].outcome == selection.UNKNOWN


def test_pilot_is_recommended_but_scores_lower():
    """Пилот это статус в каталоге, а не ограничение объекта: решение остается в "подходят",
    метка стоит на карточке, балл ниже. Иначе единственный робот для отбора уходил бы в "требуют
    проверки", и список выглядел бы пустым."""
    pilot = match(status="piloting")
    assert pilot.status == selection.RECOMMENDED
    assert pilot.score < match().score


def test_independent_check_adds_to_score():
    tested = match(tested_fcbas="1")
    registry = match(registry_719="1")
    assert tested.score > registry.score > match().score
    assert "Протестировано ФЦ БАС" in [factor.detail for factor in tested.factors]


def test_factors_explain_the_whole_score():
    result = match(tested_fcbas="1")
    assert sum(factor.contribution for factor in result.factors) == pytest.approx(result.score)


def test_rank_puts_recommended_first():
    requirements = {"processes": PROCESSES, "load_kg": 800, "aisle_mm": 2800}
    items = [solution(id="слабый", payload_kg="100"), solution(id="без данных", payload_kg=""), solution(id="годный")]
    order = [m.solution_id for m in selection.rank(items, requirements, FIELDS, WEIGHTS)]
    assert order == ["годный", "без данных", "слабый"]


def test_api_returns_catalog_with_explanation():
    solutions = client.get("/api/catalog/solutions", params={"operation": "pallet_transport"}).json()
    assert len(solutions) == 31
    assert {s["status"] for s in solutions} <= {"recommended", "needs_check", "excluded"}
    h1500 = next(s for s in solutions if "H1500" in s["product"])
    assert h1500["status"] == "recommended"
    assert h1500["can_calculate"] and h1500["price_rub"] == 2_700_000
    assert all(check["detail"] for check in h1500["checks"])
    # решения других процессов в рекомендованных не появляются
    cleaning = next(s for s in solutions if s["process"] == "Уборка помещений")
    assert cleaning["status"] == "excluded"


def test_solution_carries_the_id_used_by_the_calculation():
    """В расчет уходит идентификатор модели, а не id позиции каталога: это разные вещи."""
    solutions = client.get("/api/catalog/solutions", params={"operation": "pallet_transport"}).json()
    calculable = [s for s in solutions if s["can_calculate"]]
    assert calculable, "хотя бы одно решение должно считаться"
    assert all(s["robot_id"] and s["robot_id"] != s["id"] for s in calculable)
    assert all(s["robot_id"] is None for s in solutions if not s["can_calculate"])

    robot = calculable[0]["robot_id"]
    answer = client.post(
        "/api/calculations/preview",
        json={"facility_id": "warehouse", "operation_id": "pallet_transport", "robot_id": robot, "overrides": {}},
    )
    assert answer.status_code == 200


def plan_match(top_mm: float = 8000, ramps: int = 0, closed: int = 0, **overrides) -> selection.Match:
    """Подбор, когда у нас есть план объекта: верхний ярус и пандусы берутся с него."""
    requirements = {
        "processes": PROCESSES,
        "load_kg": 800,
        "aisle_mm": 2800,
        "rack_top_mm": top_mm,
        "stacking_lift_mm": 1000,
        "ramps": ramps,
        "closed_racks": closed,
    }
    return selection.evaluate(solution(**overrides), requirements, FIELDS, WEIGHTS)


def test_stacker_that_does_not_reach_the_top_needs_a_check():
    low = plan_match(lift_height_mm="7000")
    assert low.status == selection.NEEDS_CHECK
    assert "верхний ярус у вас 8.0 м" in next(c.detail for c in low.checks if c.label == "Высота подъема")
    assert plan_match(lift_height_mm="12000").status == selection.RECOMMENDED


def test_floor_level_robot_is_not_judged_by_rack_height():
    """Робот, который подхватывает паллету с пола, до яруса тянуться не должен."""
    amr = plan_match(lift_height_mm="60")
    assert amr.status == selection.RECOMMENDED
    assert not any(c.label == "Высота подъема" for c in amr.checks)


def test_ramp_on_the_plan_asks_to_check_mobile_robots_only():
    mobile = plan_match(ramps=1, type="Мобильные роботы")
    fixed = plan_match(ramps=1, type="Стационарные роботизированные системы")
    assert mobile.status == selection.NEEDS_CHECK
    assert any(c.label == "Пандус" for c in mobile.checks)
    assert fixed.status == selection.RECOMMENDED


def test_drive_in_or_mobile_racks_ask_to_check_mobile_robots():
    """В блок набивного или мобильного стеллажа робот не заезжает: это вопрос к поставщику, а не запрет."""
    mobile = plan_match(closed=1, type="Мобильные роботы")
    fixed = plan_match(closed=1, type="Стационарные роботизированные системы")
    assert mobile.status == selection.NEEDS_CHECK
    assert any(c.label == "Тип стеллажей" for c in mobile.checks)
    assert fixed.status == selection.RECOMMENDED


def test_aisle_from_the_plan_reaches_the_selection():
    """Ширина проезда с плана заменяет датасет. Штабелеру RoboCV нужно 2,9 м: в 2,8 м из датасета
    он не проходит, а в погрузчичьи 3,5 м с плана проходит, и дальше решает уже высота яруса."""
    by_dataset = client.get("/api/catalog/solutions", params={"operation": "pallet_transport"}).json()
    by_plan = client.get(
        "/api/catalog/solutions", params={"operation": "pallet_transport", "aisle_mm": 3500, "rack_top_mm": 8000}
    ).json()
    before = {item["product"]: item for item in by_dataset}["Робот-штабелёр RoboCV"]
    after = {item["product"]: item for item in by_plan}["Робот-штабелёр RoboCV"]
    assert before["status"] == "excluded"
    assert after["status"] == "needs_check"  # проход подошел, а до яруса 8 м с подъемом 7 м не достает
    assert any(check["label"] == "Высота подъема" for check in after["checks"])


def test_throughput_per_hour_for_sorting_only_from_hourly_records():
    """Сортировка "по производительности" берет число из записи каталога как есть: большее число,
    если запись в час. Месячную не переводим, иначе появилось бы число, которого нет в источнике."""
    from app.services.selection import per_hour

    assert per_hour("80–100", "паллет/ч") == 100
    assert per_hour("от 12 600", "ячеек/ч") == 12600
    assert per_hour("5,2 паллеты/ч на робота", "паллет/ч") == 5.2
    assert per_hour("около 2500 паллет в месяц на робота", "") is None
    assert per_hour("200", "") is None


def test_solution_specs_carry_units_from_catalog():
    body = client.get("/api/catalog/solutions", params={"operation": "pallet_transport"}).json()
    h1500 = next(one for one in body if one["product"].startswith("Ronavi H1500"))
    specs = {spec["field"]: spec for spec in h1500["specs"]}
    assert specs["max_speed_m_s"]["unit"] == "м/с"
    assert specs["throughput"]["unit"] == "паллет/ч"
    assert h1500["throughput_per_hour"] == 100
