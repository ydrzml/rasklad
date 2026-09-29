"""Подбор решений: что подходит объекту, почему, что мешает и каких данных не хватает.

Здесь только правила, без чтения файлов. Требования ТЗ, п. 3.4: показывать причины соответствия,
ограничения и недостающие данные; не рекомендовать решение, если ключевое ограничение нарушено;
при нехватке данных помечать «требует проверки»; ранжирование должно быть объяснимым.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

FITS, UNKNOWN, BLOCKS = "fits", "unknown", "blocks"
RECOMMENDED, NEEDS_CHECK, EXCLUDED = "recommended", "needs_check", "excluded"
WEAK_TRUST = {"D", "E", "F"}
# Разметка задачи с такой пометкой: решение может делать задачу, но это никто не проверял.
# Текст после пометки идет на карточку причиной (data/catalog/uses.csv)
UNVERIFIED = "Требует проверки:"


@dataclass
class Check:
    """Одно правило: что проверяли, чем закончилось и человеческое объяснение."""

    label: str
    outcome: str
    detail: str


@dataclass
class Factor:
    """Слагаемое оценки: сколько добавило к баллу и почему."""

    label: str
    contribution: float
    detail: str


@dataclass
class Match:
    solution_id: str
    product: str
    status: str
    score: float
    checks: list[Check] = field(default_factory=list)
    factors: list[Factor] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)

    @property
    def blocking(self) -> list[Check]:
        return [c for c in self.checks if c.outcome == BLOCKS]


def number(raw: str | None) -> float | None:
    """Достает число из значения вроде «до 1 500» или «0,75-1,0».

    В каталоге числа записаны так, как их пишет производитель: с пробелом между разрядами, с запятой
    и с диапазоном. Из диапазона берем нижнюю границу, так осторожнее.
    """
    if not raw:
        return None
    cleaned = raw.replace("\xa0", " ").replace(",", ".")
    found = re.search(r"\d[\d ]*(?:\.\d+)?", cleaned)
    return None if not found else float(found.group().replace(" ", ""))


def check_payload(solution: dict, load_kg: float, to_station: bool = False) -> Check:
    raw = solution.get("payload_kg") or ""
    value = number(raw)
    if value is None:
        return Check("Грузоподъемность", UNKNOWN, f"Не опубликована, а груз весит {load_kg:.0f} кг")
    if "линейка" in raw.lower():
        # в каталоге грузоподъемность всей линейки моделей: какая из них здесь, мы не знаем
        return Check(
            "Грузоподъемность",
            UNKNOWN,
            f"В каталоге линейка моделей ({raw}), а груз весит {load_kg:.0f} кг: модель уточните у производителя",
        )
    if to_station and "стационар" in solution.get("type", "").lower():
        # В задаче «товар к человеку» груз это мобильный стеллаж. Стационарная система подает
        # к станции свою тару, ящик или паллету, поэтому массу стеллажа с ней сравнивать нельзя
        return Check(
            "Грузоподъемность",
            UNKNOWN,
            f"Подает к станции свою тару, ящик или паллету до {value:.0f} кг, а не стеллаж {load_kg:.0f} кг: "
            "сверьте с массой вашей тары",
        )
    if value + 1e-9 < load_kg:
        return Check("Грузоподъемность", BLOCKS, f"Поднимает {value:.0f} кг, а груз весит {load_kg:.0f} кг")
    return Check("Грузоподъемность", FITS, f"Поднимает {value:.0f} кг при грузе {load_kg:.0f} кг")


def check_aisle(solution: dict, aisle_mm: float) -> Check:
    value = number(solution.get("min_aisle_width_mm"))
    if value is None:
        return Check("Ширина прохода", UNKNOWN, f"Не опубликована, у вас проходы {aisle_mm:.0f} мм")
    if value > aisle_mm + 1e-9:
        return Check("Ширина прохода", BLOCKS, f"Нужно {value:.0f} мм, у вас {aisle_mm:.0f} мм")
    return Check("Ширина прохода", FITS, f"Проходит: нужно {value:.0f} мм, у вас {aisle_mm:.0f} мм")


def check_lift(solution: dict, top_mm: float, stacking_mm: float) -> Check | None:
    """Достает ли штабелер до верхнего яруса стеллажей на плане.

    Правило только для тех, кто ставит груз в стеллаж. Робот, который подхватывает паллету
    с пола и везет ее между зонами, до яруса тянуться не должен, и исключать его за низкий
    подъем было бы ошибкой. Где проходит граница между подхватом и штабелированием, записано
    в config/model.yaml. Если подъем не опубликован, мы не знаем, штабелер это или нет, и молчим.
    """
    value = number(solution.get("lift_height_mm"))
    if value is None or value <= stacking_mm or top_mm <= 0:
        return None
    if value + 1e-9 < top_mm:
        return Check(
            "Высота подъема",
            UNKNOWN,
            f"Достает до {value / 1000:.1f} м, а верхний ярус у вас {top_mm / 1000:.1f} м: "
            "верхние ярусы останутся погрузчику или человеку",
        )
    return Check("Высота подъема", FITS, f"Достает до {value / 1000:.1f} м при верхнем ярусе {top_mm / 1000:.1f} м")


def check_ramp(solution: dict, ramps: int) -> Check | None:
    """На плане есть пандус, а уклон, который берет робот, в каталоге не записан ни у кого."""
    kind = solution.get("type", "").lower()
    if not ramps or not ("мобильн" in kind or "наземн" in kind):
        return None  # стационарной системе пандус не нужен
    return Check(
        "Пандус",
        UNKNOWN,
        f"На плане пандусов: {ramps}. Какой уклон берет робот, производитель не публикует, "
        "это надо спросить у поставщика",
    )


def check_racks(solution: dict, closed: int) -> Check | None:
    """На плане набивной или мобильный стеллаж: внутрь блока робот не заезжает, а берет груз с торца
    или из одного открытого прохода. Может ли так работать конкретный робот, в каталоге не записано."""
    kind = solution.get("type", "").lower()
    if not closed or not ("мобильн" in kind or "наземн" in kind):
        return None
    return Check(
        "Тип стеллажей",
        UNKNOWN,
        f"На плане набивные или мобильные стеллажи, зон: {closed}. Робот работает только с торца блока "
        "или в одном открытом проходе, это надо проверить у поставщика",
    )


def check_process(solution: dict, processes: tuple[str, ...], operation: str | None = None) -> Check:
    """Делает ли решение эту задачу.

    Сценарий организатора слишком широкий: под «Внутрискладскую логистику» попадают и паллетные
    тележки, и роботы, которые возят стеллажи к станции отбора. Поэтому, если у решения есть наша
    разметка задач (data/catalog/uses.csv), судим по ней, а сценарий остается запасным правилом.
    """
    uses = solution.get("operations")
    if operation and uses is not None:
        note = solution.get("use_notes", {}).get(operation, "")
        if operation in uses and note.startswith(UNVERIFIED):
            return Check("Процесс", UNKNOWN, note.removeprefix(UNVERIFIED).strip())
        if operation in uses:
            return Check("Процесс", FITS, f"Решение для задачи «{uses[operation]}»")
        if not uses:
            return Check("Процесс", BLOCKS, "Какую задачу склада делает решение, мы еще не разметили")
        return Check("Процесс", BLOCKS, f"Решение для другой задачи: {', '.join(uses.values()).lower()}")
    process = solution.get("process", "")
    if process in processes:
        return Check("Процесс", FITS, f"Решение для процесса «{process}»")
    return Check("Процесс", BLOCKS, f"Решение для процесса «{process}», а мы считаем другой")


def check_status(solution: dict) -> Check:
    """Зрелость решения. Пилот не делает решение «требующим проверки»: это статус в каталоге, а не
    ограничение объекта. На карточке он стоит меткой, а балл за него ниже (весом в factors)."""
    if solution.get("status") == "operation":
        return Check("Зрелость", FITS, "В промышленной эксплуатации")
    return Check("Зрелость", FITS, "Пилот по каталогу: серийную эксплуатацию уточните у производителя")


def data_quality(solution: dict, fields: tuple[str, ...]) -> tuple[float, list[str]]:
    """Доля характеристик с приличным источником и список того, чего не хватает."""
    missing = [name for name in fields if not solution.get(name)]
    trusted = [name for name in fields if solution.get(f"{name}_trust", "F") not in WEAK_TRUST]
    return len(trusted) / len(fields), missing


def evaluate(solution: dict, requirements: dict, fields: tuple[str, ...], weights: dict) -> Match:
    """Проверяет одно решение под задачу.

    У задачи может не быть груза: робот-уборщик ничего не поднимает. Тогда правило грузоподъемности
    и запас по ней не применяются, и сравнивать решения между собой это не мешает: баллы имеют смысл
    внутри одной задачи, а в ней набор правил одинаковый для всех.
    """
    load_kg = requirements.get("load_kg")
    process = check_process(solution, requirements["processes"], requirements.get("operation"))
    maturity = check_status(solution)
    checks = [process]
    if load_kg:
        checks.append(check_payload(solution, load_kg, requirements.get("to_station", False)))
    checks.append(check_aisle(solution, requirements["aisle_mm"]))
    # два правила ниже работают только когда есть план: без него высоты ярусов и пандусов мы не знаем
    lift = check_lift(solution, requirements.get("rack_top_mm", 0.0), requirements.get("stacking_lift_mm", 0.0))
    ramp = check_ramp(solution, requirements.get("ramps", 0))
    racks = check_racks(solution, requirements.get("closed_racks", 0))
    checks += [check for check in (lift, ramp, racks) if check] + [maturity]
    quality, missing = data_quality(solution, fields)

    factors = [
        Factor("Подходит процессу", weights["process"] if process.outcome == FITS else 0.0, process.detail),
        Factor(
            "Зрелость решения",
            weights["maturity"] if solution.get("status") == "operation" else weights["maturity"] / 2,
            maturity.detail,
        ),
        Factor(
            "Независимая проверка",
            _verification(solution, weights["verified"]),
            _verification_detail(solution),
        ),
        Factor(
            "Качество данных",
            weights["data"] * quality,
            f"Характеристик с подтвержденным источником: {quality:.0%}",
        ),
    ]
    if load_kg:
        factors.append(
            Factor(
                "Запас грузоподъемности",
                _headroom(solution, load_kg, weights["headroom"]),
                _headroom_detail(solution, load_kg),
            )
        )

    match = Match(
        solution_id=solution["id"],
        product=solution["product"],
        status=RECOMMENDED,
        score=sum(f.contribution for f in factors),
        checks=checks,
        factors=factors,
        missing=missing,
    )
    if match.blocking:
        match.status = EXCLUDED
    elif any(c.outcome == UNKNOWN for c in checks):
        match.status = NEEDS_CHECK
    return match


def _verification(solution: dict, weight: float) -> float:
    if solution.get("tested_fcbas") == "1":
        return weight
    if solution.get("registry_719") == "1":
        return weight / 2
    return 0.0


def _verification_detail(solution: dict) -> str:
    if solution.get("tested_fcbas") == "1":
        return "Протестировано ФЦ БАС"
    if solution.get("registry_719") == "1":
        return "В реестре российской промышленной продукции"
    return "Независимой проверки в открытых данных нет"


def _headroom(solution: dict, load_kg: float, weight: float) -> float:
    value = number(solution.get("payload_kg"))
    if value is None or load_kg <= 0:
        return 0.0
    return weight * min(value / load_kg, 2.0) / 2


def _headroom_detail(solution: dict, load_kg: float) -> str:
    value = number(solution.get("payload_kg"))
    if value is None:
        return "Грузоподъемность не опубликована"
    return f"Запас по весу: {value / load_kg:.1f} раза"


def rank(solutions: list[dict], requirements: dict, fields: tuple[str, ...], weights: dict) -> list[Match]:
    """Сначала рекомендованные, потом требующие проверки, потом исключенные. Внутри по баллу."""
    order = {RECOMMENDED: 0, NEEDS_CHECK: 1, EXCLUDED: 2}
    matches = [evaluate(solution, requirements, fields, weights) for solution in solutions]
    return sorted(matches, key=lambda m: (order[m.status], -m.score))
