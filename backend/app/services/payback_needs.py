"""Что нужно, чтобы покупка окупилась за горизонт: у задач "товар к человеку", которые не окупаются.

Отбор окупается только экономией на людях, и ответ "не окупается" ничего не говорит о том, далеко ли
до плюса. Здесь ищем по одной цифре за раз ту границу, за которой покупка окупается за горизонт:
выработку отборщика сейчас, выработку у станции, оклад и объем. Остальное не трогаем.

Парк при поиске по выработке и окладу тот же, что в ответе: от этих цифр он не зависит. При поиске
по объему растут и объем, и штат той же роли в той же пропорции: на объект с вдвое большим потоком
людей нужно вдвое больше, иначе рост объема только добавлял бы роботов без экономии.
Новый прогон смены здесь не запускаем: при объеме парк берется по кривой прогона, если она есть,
иначе по формуле (docs/calculation.md, раздел 12.5).
"""

from __future__ import annotations

import copy
import math
from collections.abc import Callable

from app.engine.economics import PURCHASE
from app.engine.economics.facility import FacilityResult
from app.schemas.economics import CalculationRequest, CalculationResult, PaybackNeed

# сколько шагов деления пополам: границы до сотой доли диапазона, этого хватает для округления до целых
STEPS = 12

Run = Callable[[dict, dict[str, int] | None], FacilityResult]


def add(
    answer: CalculationResult,
    request: CalculationRequest,
    model: dict,
    result: FacilityResult,
    run: Run,
    bounds: dict[str, dict],
) -> None:
    """Если покупка за горизонт не окупается, а среди задач есть "товар к человеку", пишем в ответ границы."""
    purchase = result.scenarios.get(PURCHASE)
    if not answer.feasible or purchase is None or purchase.payback_cumulative is not None:
        return
    facility = next(one for one in model["facilities"] if one["id"] == request.facility_id)
    fleets = {key: own.sizing.fleet for key, own in result.own.items() if own.sizing}
    # при смешанном парке задача встречается дважды, а граница у нее одна
    for operation_id in dict.fromkeys(choice.operation_id for choice in request.choices()):
        operation = next(one for one in facility["operations"] if one["id"] == operation_id)
        if not operation.get("productivity_after"):
            continue
        base = f"facilities.{request.facility_id}.operations.{operation['id']}"
        found = [
            _productivity_before(
                model, run, fleets, request.facility_id, operation, f"{base}.productivity_before", bounds
            ),
            _productivity_after(
                model, run, fleets, request.facility_id, operation, f"{base}.productivity_after", bounds
            ),
            _salary(model, run, fleets, facility, operation),
            _volume(model, run, facility, operation, f"{base}.volume_per_day", bounds),
        ]
        answer.payback_needs += [need for need in found if need is not None]


def _pays(run: Run, model: dict, fleets: dict[str, int] | None) -> bool:
    longer = run(model, fleets)
    return longer.feasible and longer.scenarios[PURCHASE].payback_cumulative is not None


def _search(pays: Callable[[float], bool], start: float, end: float) -> float | None:
    """Граница между start (не окупается) и end. Пусто: и на end не окупается.
    Окупаемость меняется с цифрой в одну сторону, поэтому хватает деления пополам."""
    if not pays(end):
        return None
    low, high = start, end
    for _ in range(STEPS):
        middle = (low + high) / 2
        if pays(middle):
            high = middle
        else:
            low = middle
    return high


def _with(model: dict, change: Callable[[dict], None]) -> dict:
    copied = copy.deepcopy(model)
    change(copied)
    return copied


def _operation_in(model: dict, facility_id: str, operation_id: str) -> dict:
    facility = next(one for one in model["facilities"] if one["id"] == facility_id)
    return next(one for one in facility["operations"] if one["id"] == operation_id)


def _productivity_before(model, run, fleets, facility_id, operation, path, bounds) -> PaybackNeed | None:
    """Выработка отборщика сейчас: чем она ниже, тем больше людей занято отбором и тем больше экономия."""
    now = operation["productivity_before"]
    # граница поля это нижняя граница датасета, а пеший отбор бывает и медленнее: медиана по WERC 35 строк
    # в час на человека. Поэтому ищем до половины нынешней выработки, даже если это ниже поля
    floor = min(bounds.get(path, {}).get("min", now), now / 2)

    def pays(value: float) -> bool:
        changed = _with(
            model, lambda m: _operation_in(m, facility_id, operation["id"]).update(productivity_before=value)
        )
        return _pays(run, changed, fleets)

    edge = _search(pays, now, floor)
    if edge is None:
        return None
    value = math.floor(edge)
    return PaybackNeed(
        path=path,
        label="Выработка отборщика сейчас",
        value=value,
        now=now,
        unit="строк/ч",
        text=f"отборщик сейчас делает не больше {value:g} {_lines(value)} в час (у вас {now:g})",
    )


def _productivity_after(model, run, fleets, facility_id, operation, path, bounds) -> PaybackNeed | None:
    """Выработка у станции: чем она выше, тем меньше людей остается после роботов."""
    now = operation["productivity_after"]
    ceiling = bounds.get(path, {}).get("max", now * 2)

    def pays(value: float) -> bool:
        changed = _with(
            model, lambda m: _operation_in(m, facility_id, operation["id"]).update(productivity_after=value)
        )
        return _pays(run, changed, fleets)

    edge = _search(pays, now, ceiling)
    if edge is None:
        return None
    value = math.ceil(edge)
    return PaybackNeed(
        path=path,
        label="Выработка на станции",
        value=value,
        now=now,
        unit="строк/ч",
        text=f"человек у станции делает от {value:g} {_lines(value)} в час (у нас {now:g})",
    )


def _salary(model, run, fleets, facility, operation) -> PaybackNeed | None:
    """Оклад людей на задаче: робот окупается их зарплатой. Меняем оклад всех строк ролей задачи разом."""
    roles = operation.get("performed_by", [])
    facility_id = facility["id"]
    lines = [line for line in facility.get("staff", []) if line["role"] in roles]
    if not lines:
        return None
    now = lines[0]["salary_month"]
    role = model.get("roles", {}).get(lines[0]["role"], {})
    salary_range = role.get("salary_range") or [now, now * 2]
    ceiling = max(salary_range[1], now)

    def pays(value: float) -> bool:
        def change(m: dict) -> None:
            facility_copy = next(one for one in m["facilities"] if one["id"] == facility_id)
            for line in facility_copy.get("staff", []):
                if line["role"] in roles:
                    line["salary_month"] = value

        return _pays(run, _with(model, change), fleets)

    edge = _search(pays, now, ceiling)
    if edge is None:
        return None
    value = math.ceil(edge / 1000) * 1000
    return PaybackNeed(
        path=f"facilities.{facility_id}.staff.{lines[0]['id']}.salary_month",
        label="Оклад",
        value=value,
        now=now,
        unit="₽/мес",
        text=f"оклад от {_rub(value)} рублей в месяц (у вас {_rub(now)})",
    )


def _volume(model, run, facility, operation, path, bounds) -> PaybackNeed | None:
    """Объем: растет вместе со штатом той же роли, парк пересчитывается. Вложения на объект делятся
    на больший поток, поэтому объем помогает, но слабо."""
    now = operation["volume_per_day"]
    ceiling = bounds.get(path, {}).get("max", now * 10)
    if ceiling <= now:
        return None
    roles = operation.get("performed_by", [])
    facility_id = facility["id"]

    def pays(value: float) -> bool:
        factor = value / now

        def change(m: dict) -> None:
            facility_copy = next(one for one in m["facilities"] if one["id"] == facility_id)
            next(one for one in facility_copy["operations"] if one["id"] == operation["id"])["volume_per_day"] = value
            for line in facility_copy.get("staff", []):
                if line["role"] in roles:
                    line["headcount"] *= factor
                    if "filled" in line:
                        line["filled"] *= factor

        return _pays(run, _with(model, change), None)

    edge = _search(pays, now, ceiling)
    if edge is None:
        return None
    value = math.ceil(edge / 1000) * 1000
    return PaybackNeed(
        path=path,
        label="Объем",
        value=value,
        now=now,
        unit="строк/сут",
        text=f"объем от {_rub(value)} {_lines(value)} в сутки и штат под него (у вас {_rub(now)})",
    )


def _rub(value: float) -> str:
    return f"{value:,.0f}".replace(",", " ")


def _lines(value: float) -> str:
    """Родительный падеж после "от" и "не больше": от 121 строки, от 250 строк."""
    whole = int(value)
    return "строки" if whole % 10 == 1 and whole % 100 != 11 else "строк"
