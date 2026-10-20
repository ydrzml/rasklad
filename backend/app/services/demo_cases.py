"""Готовые разборы для гостя. Каждый повторяет опубликованное внедрение: площадь, режим, объем и штат
берем из кейса, чего в кейсе нет, из датасета организатора (docs/decisions.md, "Разборы по реальным
кейсам"). Считаются теми же запросами, что мастер: план по типовой схеме задачи, расчет с прогоном
смены, покупка за свои деньги, в кредит и в лизинг.

Прогон смены идет секунды, а разбор от человека не зависит, поэтому ответ держим в памяти, пока не
поменялись нормативы, каталог или файлы модели (versions.model_version и data_version)."""

import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.api.plan import generate
from app.schemas.cases import DemoCase
from app.schemas.economics import CalculationRequest, TaskChoice
from app.schemas.plan import GenerateRequest
from app.schemas.staff import StaffLine
from app.services import calculation, staff, versions


@dataclass(frozen=True)
class CaseInput:
    operation_id: str
    robot_id: str
    # схема плана, которую мастер ставит задаче сам (frontend/src/app/steps/peak.ts, defaultTemplate)
    template_id: str
    # значения из кейса, путь как у правки в мастере; чего тут нет, считается по датасету
    overrides: dict[str, float] = field(default_factory=dict)
    # штат кейса до роботов; None: штат датасета под объем кейса, как его ставит форма штата мастера
    staff: tuple[StaffLine, ...] | None = None


def staff_of(one: CaseInput) -> list[StaffLine] | None:
    """Штат разбора. Своего в кейсе нет: строки формы штата под объем кейса, ту же численность мастер
    ставит сам, когда человек меняет объем (services/staff.py, form). Без правок штат из конфига."""
    if one.staff is not None:
        return list(one.staff)
    if not one.overrides:
        return None
    lines = staff.form("warehouse", [one.operation_id], one.overrides).lines
    return [StaffLine(**line.model_dump(include=set(StaffLine.model_fields))) for line in lines]


W = "facilities.warehouse."
PALLETS = W + "operations.pallet_transport."
PICKING = W + "operations.piece_picking."
CLEANING = W + "operations.cleaning."

# Каждый разбор повторяет опубликованное внедрение. Источник у каждого значения, остальное из датасета
# организатора: режим 2 смены по 11 ч 365 дней, оклады, нормативы (docs/decisions.md, "Разборы по
# реальным кейсам"). Входы не подбирали под срок окупаемости: какой вышел, такой и показываем
CASES: dict[str, CaseInput] = {
    # РЦ ВкусВилла, автономные погрузчики Автомакон AK-2000 (Хабр, блог Автомакона, 11.02.2025): РЦ 110 000 м2,
    # 7 000 паллет в сутки на приемке и отгрузке, роботы везут 29% поступивших товаров. Долю работы водителя
    # считаем, как в config/model.yaml: 0,78 на каждую паллету робота, 0,29 * 0,78 = 0,226. Штат водителей
    # не опубликован: штат датасета под объем, как в мастере. В каталоге модель AK-2000-2
    "pallets": CaseInput(
        "pallet_transport",
        "avtomakon-ak-2000-2",
        "one_side",
        {
            W + "active_area_m2": 110_000,
            PALLETS + "volume_per_day": 7000,
            PALLETS + "automatable_share": 0.29,
            PALLETS + "labor_share": 0.226,
        },
    ),
    # Восток-Сервис, 48 Ronavi H1500 "товар к человеку" (retail.ru, 28.06.2024; кейс Ronavi): зона 7 000 м2,
    # 157 тыс. задач в месяц (5 233 в сутки), весь отбор в робозоне, 80 комплектовщиков. Выработку
    # 30 -> 75 строк в час не публикуют, это наша оценка по их данным (docs/calculation.md, 13.1);
    # ускорение в 2,5 раза то же, что у интегратора. Оклад и режим из датасета: у них "четыре смены"
    "picking": CaseInput(
        "piece_picking",
        "ronavi-h1500",
        "robot_zone",
        {
            W + "active_area_m2": 7000,
            W + "picking_zone_share": 1.0,
            PICKING + "volume_per_day": 5233,
            PICKING + "automatable_share": 1.0,
            PICKING + "productivity_before": 30,
            PICKING + "productivity_after": 75,
        },
        (StaffLine(id="pickers", role="picker", headcount=80, filled=80, salary_month=100_000),),
    ),
    # РЦ ВкусВилла "Вешки", 2 робота-уборщика Автомакон AK-SC80 на 30 000 м2 в смену (Хабр, блог
    # Автомакона, 11.02.2025). Моют раз в сутки, сейчас моют машиной с оператором подрядчика, как в датасете
    "cleaning": CaseInput(
        "cleaning",
        "avtomakon-ak-sc80",
        "one_side",
        {W + "active_area_m2": 30_000, CLEANING + "volume_per_day": 30_000},
    ),
}

# способ оплаты покупки, financing.method в config/model.yaml: 1 кредит, 2 лизинг
FINANCING = {"loan": 1, "leasing": 2}


class UnknownCase(Exception):
    pass


_cache: dict[str, tuple[tuple[str, str], DemoCase]] = {}
_locks = {case_id: threading.Lock() for case_id in CASES}


def build(case_id: str) -> DemoCase:
    """Разбор целиком, без кеша. Запрос тот же, что собирает мастер (frontend/src/app/saving.ts, requestFrom)."""
    if case_id not in CASES:
        raise UnknownCase(case_id)
    one = CASES[case_id]
    built = generate(
        GenerateRequest(operation_ids=[one.operation_id], template_id=one.template_id, overrides=one.overrides)
    )
    request = CalculationRequest(
        operation_id=one.operation_id,
        robot_id=one.robot_id,
        tasks=[TaskChoice(operation_id=one.operation_id, robot_id=one.robot_id, share=1)],
        overrides=dict(one.overrides),
        staff=staff_of(one),
        plan=built.plan,
        use_simulation=True,
    )
    result = calculation.calculate(request)
    financing = {}
    if result.feasible:
        for name, method in FINANCING.items():
            overrides = {**request.overrides, "financing.method": method}
            other = calculation.calculate(request.model_copy(update={"overrides": overrides}))
            purchase = next((scenario for scenario in other.scenarios if scenario.id == "purchase"), None)
            if purchase:
                financing[name] = purchase
    return DemoCase(
        id=case_id,
        request=request,
        plan=built.plan,
        measures=built.measures,
        result=result,
        financing=financing,
        computed_at=datetime.now(UTC),
    )


def get(case_id: str) -> DemoCase:
    """Разбор из памяти. Если данные поменялись, считаем заново; один разбор считается один раз,
    даже когда его просят сразу несколько гостей."""
    if case_id not in CASES:
        raise UnknownCase(case_id)
    stamp = (versions.model_version(), versions.data_version())
    with _locks[case_id]:
        cached = _cache.get(case_id)
        if cached and cached[0] == stamp:
            return cached[1]
        fresh = build(case_id)
        _cache[case_id] = (stamp, fresh)
        return fresh


def forget() -> None:
    _cache.clear()
