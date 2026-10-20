"""Сравнение проектов: несколько сохраненных версий рядом, что ввели и что получилось.

Цифры берем из сохраненных версий как есть и ничего не пересчитываем: сравнение показывает то,
что человек видел, когда сохранял. Если нормативы с тех пор поменялись, колонка это говорит.
Чужие проекты сравнить нельзя: версии достаем через те же проверки владельца, что и везде."""

import math
from typing import Any

from sqlalchemy.orm import Session

from app.reports.words import about_years
from app.schemas import projects as schemas
from app.services import catalog, projects
from app.services.calculation import model_with_overrides
from app.storage.models import Solution, User

# Сценарии по ТЗ в том порядке, в каком их показывает экран экономики
SCENARIOS = ("baseline", "purchase", "raas")


def compare(session: Session, user: User, items: list[schemas.CompareItem]) -> schemas.Comparison:
    loaded = [_load(session, user, item) for item in items]
    columns = [column for column, _, _ in loaded]
    states = [state for _, state, _ in loaded]
    results = [result for _, _, result in loaded]
    horizons = {result.get("horizon_years") for result in results if result}
    return schemas.Comparison(
        columns=columns,
        inputs=_inputs(session, states),
        results=_results(results),
        horizon_years=horizons.pop() if len(horizons) == 1 else None,
    )


def _load(session: Session, user: User, item: schemas.CompareItem):
    project = projects.get(session, user, item.project_id)
    number = item.version or (project.current.number if project.current else None)
    if number is None:
        raise projects.NotFound(f"сохранения в проекте {item.project_id}")
    version = projects.get_version(session, user, item.project_id, number)
    column = schemas.CompareColumn(
        project_id=project.id,
        name=project.name,
        version=version.number,
        saved_at=version.saved_at,
        note=version.note,
        same_data=version.same_data,
        calculated=bool(_scenarios(version.result or {})),
    )
    return column, version.state or {}, version.result or {}


def _row(key: str, label: str, group: str, values: list, unit: str = "", better: str | None = None):
    present = [value for value in values if value is not None]
    differs = len({_same(value) for value in values}) > 1 if present else False
    return schemas.CompareRow(
        key=key, label=label, group=group, unit=unit, values=values, differs=differs, better=better
    )


def _heads(values: list) -> list:
    return [None if value is None else math.ceil(value - 1e-9) for value in values]


def _same(value: Any) -> Any:
    # 2000 и 2000.0 одно и то же число, а дробь до сотых не разница
    return round(value, 2) if isinstance(value, int | float) else value


EXCLUDED_MARK = "(снята с расчета)"


def _tasks_text(state: dict[str, Any], names: dict[str, str]) -> str | None:
    """Задачи снимка словами. Снятая галочкой задача остается выбранной, но не считается:
    называем ее с пометкой, чтобы сравнение не выглядело так, будто обе колонки считали одно и то же."""
    excluded = set(state.get("excluded") or [])
    parts = [
        f"{names.get(task, task)} {EXCLUDED_MARK}" if task in excluded else names.get(task, task)
        for task in state.get("taskIds") or []
    ]
    return ", ".join(parts) or None


def _inputs(session: Session, states: list[dict[str, Any]]) -> list[schemas.CompareRow]:
    facilities = {facility.id: facility for facility in catalog.facilities()}
    operation_names = {op.id: op.name for facility in facilities.values() for op in facility.operations}
    robot_names = _robot_names(session)

    rows = [
        _row(
            "facility",
            "Объект",
            "Объект",
            [facilities[s["facilityId"]].name if s.get("facilityId") in facilities else None for s in states],
        ),
        _row(
            "tasks",
            "Задачи",
            "Объект",
            [_tasks_text(s, operation_names) for s in states],
        ),
    ]

    # Поля шага параметров: главные всегда, остальные, только если их кто-то поправил
    fields: dict[str, Any] = {}
    for state in states:
        for field in projects.parameters_of(state):
            fields.setdefault(field.path, field)
    for path, field in fields.items():
        values = [_parameter(state, path, fields) for state in states]
        touched = any(path in (state.get("overrides") or {}) for state in states)
        if not (field.key or touched):
            continue
        rows.append(_row(path, field.label, field.group_name, values, field.unit))

    # Решение на каждую задачу: у смешанного парка два с долями, у старого снимка одно на первую задачу
    tasks = list(dict.fromkeys(t for state in states for t in state.get("taskIds") or []))
    for task in tasks:
        values = [_solution(projects.picks_of(state).get(task) or [], robot_names) for state in states]
        rows.append(_row(f"solution.{task}", "Решение", operation_names.get(task, task), values))

    rows.append(_row("staff.people", "Людей в штате сейчас", "Штат", [_people(s) for s in states], "чел"))
    rows.append(_row("staff.payroll", "Фонд оклада в месяц", "Штат", [_payroll(s) for s in states], "₽"))
    rows.append(_row("plan", "План объекта", "План", [_plan(s) for s in states]))
    return rows


def _parameter(state: dict[str, Any], path: str, fields: dict[str, Any]) -> float | None:
    overrides = state.get("overrides") or {}
    if path in overrides:
        return overrides[path]
    # поле другой задачи или другого объекта к этой колонке не относится
    own = {field.path for field in projects.parameters_of(state)}
    return fields[path].value if path in own else None


def _solution(picks: list[dict[str, Any]], robot_names: dict[str, str]) -> str | None:
    named = [
        (robot_names.get(pick["robotId"], pick["robotId"]), pick.get("share", 1))
        for pick in picks
        if pick.get("robotId")
    ]
    if not named:
        return None
    if len(named) == 1:
        return named[0][0]
    return " + ".join(f"{name} {round(share * 100)}%" for name, share in named)


def _people(state: dict[str, Any]) -> float | None:
    return projects.people_of(state.get("staff"))


def _payroll(state: dict[str, Any]) -> float | None:
    staff = state.get("staff")
    if not isinstance(staff, list):
        return None
    return sum(
        float(line.get("filled") or 0) * float(line.get("salary_month") or 0)
        for line in staff
        if isinstance(line, dict)
    )


def _plan(state: dict[str, Any]) -> str | None:
    plan = state.get("plan")
    if not isinstance(plan, dict) or not plan.get("width_m"):
        return "по размеру из параметров"
    size = f"{projects.number(plan['width_m'])} × {projects.number(plan.get('length_m') or 0)} м"
    return f"{size}, правили руками" if plan.get("edited") else size


def _robot_names(session: Session) -> dict[str, str]:
    """Робот расчетной модели -> название решения в каталоге. Нет в каталоге: остается номер."""
    model, _ = model_with_overrides({})
    names = {}
    for robot in model.get("robots", []):
        solution = session.get(Solution, robot.get("catalog_id")) if robot.get("catalog_id") else None
        names[robot["id"]] = solution.name if solution else robot["id"]
    return names


def _scenarios(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Сценарии из сохраненного результата. Сохранение пишет экран, форму проверяем, а не верим ей."""
    found = result.get("scenarios") if isinstance(result, dict) else None
    if not isinstance(found, list):
        return []
    return [s for s in found if isinstance(s, dict) and "id" in s and "name" in s]


def _results(results: list[dict[str, Any]]) -> list[schemas.CompareRow]:
    def sizing(key: str) -> list:
        return [(result.get("sizing") or {}).get(key) if result else None for result in results]

    rows = [
        _row("fleet", "Роботов в парке", "Парк и люди", sizing("fleet"), "шт"),
        # людей целыми, вверх: 7,5 ставки в смену это 8 человек на смене
        _row("people_before", "Людей в смену сейчас", "Парк и люди", _heads(sizing("people_per_shift_before")), "чел"),
        _row(
            "people_after",
            "Людей в смену с роботами",
            "Парк и люди",
            _heads(sizing("people_per_shift_after")),
            "чел",
            "low",
        ),
    ]
    names: dict[str, str] = {}
    for result in results:
        for scenario in _scenarios(result):
            names.setdefault(scenario["id"], scenario["name"])

    def pick(scenario_id: str, key: str) -> list:
        out = []
        for result in results:
            found = next((s for s in _scenarios(result) if s["id"] == scenario_id), None)
            out.append(found.get(key) if found else None)
        return out

    for scenario_id in [s for s in SCENARIOS if s in names] + [s for s in names if s not in SCENARIOS]:
        group = names[scenario_id]
        if scenario_id != "baseline":
            rows.append(
                _row(
                    f"{scenario_id}.investment",
                    "Вложения на старте",
                    group,
                    # деньги в год 0: все вложения за горизонт (выкуп, обновление, платежи по долгу) другое число
                    pick(scenario_id, "investment_year0_rub"),
                    "₽",
                    "low",
                )
            )
        # у сценария без роботов дешевле значит меньше склад, а не лучше решение: метку "лучше" не ставим
        better = None if scenario_id == "baseline" else "low"
        rows.append(_row(f"{scenario_id}.tco", "Стоимость владения", group, pick(scenario_id, "tco_rub"), "₽", better))
        if scenario_id != "baseline":
            payback = pick(scenario_id, "payback_cumulative_years")
            calculated = pick(scenario_id, "tco_rub")
            later = pick(scenario_id, "payback_later_years")
            horizons = [result.get("horizon_years") or 5 for result in results]
            # окупаемости нет, а расчет есть: окупится дольше горизонта или не окупается (как в отчетах)
            payback = [
                p if p is not None or c is None else _later_words(more, horizon)
                for p, c, more, horizon in zip(payback, calculated, later, horizons, strict=True)
            ]
            rows.append(_row(f"{scenario_id}.payback", "Окупаемость", group, payback, "лет", "low"))
    return rows


def _later_words(later: float | None, horizon: int) -> str:
    """Окупаемости за горизонт нет: окупится дольше горизонта (досчет до economics.later_payback_years)
    или не окупается. Те же слова, что в PDF и Excel (reports/content.py, payback_words)."""
    if later is None:
        return "не окупается"
    return f"примерно {about_years(later, horizon)}, дольше горизонта расчета в {horizon} лет"
