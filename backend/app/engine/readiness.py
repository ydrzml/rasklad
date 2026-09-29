"""Что подготовить на складе до роботов: список по плану клиента, выбранному роботу и прогону смены.

Здесь только правила, без чтения файлов. Каждый пункт говорит, что с ним сейчас (готово,
проверить, переделать), почему и по какой проверке или характеристике робота, и сколько это
стоит, если у цены есть источник. Нет источника, так и пишем, своих цен не придумываем.

Про склад клиента мы знаем только то, что он нарисовал на плане. Покрытия Wi-Fi, ровности
пола и температуры мы не знаем, поэтому такие пункты не бывают "готово": мы пишем, что нужно
роботу, и просим проверить.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from app.engine import plan as plan_engine

READY, CHECK, REDO = "ready", "check", "redo"
ORDER = {REDO: 0, CHECK: 1, READY: 2}

# Очередь в прогоне считаем узким местом с той же границы, что и подпись узкого места в итогах
# смены (engine/simulation.py, bottleneck): больше пятой части времени роботы ждут.
QUEUE_SHARE = 0.2
NO_PRICE = "нет источника"


@dataclass
class Ramp:
    """Пандус на плане: сколько метров он идет и на сколько поднимает пол."""

    length_m: float
    drop_m: float

    @property
    def slope(self) -> float:
        """Уклон в процентах: подъем на сто метров пути"""
        return self.drop_m / self.length_m * 100 if self.length_m else 0.0


@dataclass
class PlanFacts:
    """Что мы знаем о складе из плана. Числа те же, что под чертежом на шаге плана."""

    aisle_m: float  # самый узкий проезд между рядами, ноль если рядов нет
    rack_top_m: float
    closed_racks: int
    ramps: list[Ramp] = field(default_factory=list)
    checks: list[plan_engine.Check] = field(default_factory=list)
    edited: bool = True  # план рисовал человек, а не взят типовой


@dataclass
class Spec:
    """Характеристика робота как текст из источника: значение, оценка и откуда оно"""

    value: str
    trust: str = "F"
    source: str = ""  # коротко: тип источника и сайт, без длинного адреса
    url: str = ""  # полный адрес источника: на экране и в PDF он ссылкой


@dataclass
class RobotFacts:
    """Выбранное на задачу решение и то, что о нем известно из каталога и источников."""

    name: str
    task: str  # название задачи, пусто если задача одна: тогда решение и так понятно
    mobile: bool  # ездит по складу, а не стоит на месте
    fleet: int
    chargers: int
    charger_price_rub: float
    charger_price: Spec  # источник цены места зарядки
    aisle_mm: Spec | None = None
    lift_mm: Spec | None = None
    stacking_mm: float = 1000.0  # выше этого подъема робот ставит груз в стеллаж
    navigation: Spec | None = None
    connectivity: Spec | None = None
    conditions: list[Spec] = field(default_factory=list)  # условия работы: пол, уклон, температура
    charging: Spec | None = None  # как устроена зарядка у производителя
    max_incline_deg: Spec | None = None
    waits: dict[str, float] = field(default_factory=dict)  # доля времени смены в очереди по месту
    waiting_share: float = 0.0
    operation: str = ""  # номер задачи: решения одной задачи сводятся в общие пункты


@dataclass
class Item:
    """Пункт списка. solution пусто у пунктов про план, они общие для всех задач."""

    id: str
    title: str
    status: str
    why: str
    basis: str  # по какой проверке или характеристике, с источником и оценкой
    cost: str = ""  # сумма, если у цены есть источник
    cost_note: str = ""  # из чего сумма или почему ее нет
    cost_rub: float = 0.0  # та же сумма числом: у смешанного парка зарядки складываются
    trust: str = ""
    link: str = ""  # адрес источника основания, если он есть
    solution: str = ""


@dataclass
class Readiness:
    items: list[Item]
    counts: dict[str, int]


def number(raw: str | None) -> float | None:
    """Число из значения каталога: "до 1 500", "0,75-1,0". Из диапазона нижняя граница."""
    if not raw:
        return None
    cleaned = raw.replace("\xa0", " ").replace(",", ".")
    found = re.search(r"\d[\d ]*(?:\.\d+)?", cleaned)
    return None if not found else float(found.group().replace(" ", ""))


def incline(robot: RobotFacts) -> tuple[float, Spec] | None:
    """Допустимый уклон в процентах и откуда он. Производители пишут и в процентах, и в градусах."""
    if robot.max_incline_deg and number(robot.max_incline_deg.value) is not None:
        return _percent(number(robot.max_incline_deg.value) or 0.0), robot.max_incline_deg
    for spec in robot.conditions:
        found = re.search(r"уклон\D{0,12}(\d+(?:[.,]\d+)?)\s*(%|°)", spec.value)
        if found:
            value = float(found.group(1).replace(",", "."))
            return (value if found.group(2) == "%" else _percent(value)), spec
    return None


def _percent(degrees: float) -> float:
    return math.tan(math.radians(degrees)) * 100


FLOOR_WORDS = ("пол", "перепад", "ступень", "впадин", "зазор", "проходимость", "покрыти")


def _parts(robot: RobotFacts, keep) -> list[Spec]:
    """Куски условий работы через точку с запятой: у производителя в одной строке и пол, и температура."""
    found = []
    for spec in robot.conditions:
        parts = [part.strip() for part in spec.value.split(";") if keep(part.lower())]
        if parts:
            found.append(Spec("; ".join(parts), spec.trust, spec.source, spec.url))
    return found


def floor_needs(robot: RobotFacts) -> list[Spec]:
    """Что производитель пишет о поле: ровность, перепады, щели. Уклон идет отдельным пунктом."""
    return _parts(robot, lambda text: any(word in text for word in FLOOR_WORDS) and "уклон" not in text)


def temperature(robot: RobotFacts) -> Spec | None:
    found = _parts(robot, lambda text: "°c" in text)
    return found[0] if found else None


def money(rub: float) -> str:
    if rub >= 1_000_000:
        return f"{rub / 1_000_000:.2f}".replace(".", ",") + " млн ₽"
    return f"{rub / 1000:.0f} тыс. ₽"


def _m(value: float) -> str:
    return f"{value:.1f}".replace(".", ",")


def _basis(what: str, spec: Spec) -> str:
    source = f", {spec.source}" if spec.source else ""
    return f"{what}: {spec.value}, оценка {spec.trust}{source}"


# --- пункты про план: общие для всех задач ---------------------------------------------------


def plan_items(plan: PlanFacts) -> list[Item]:
    """Проверки плана, которые требуют работы на складе. Проверки самого чертежа (есть ли ворота,
    в наружной ли они стене) сюда не идут: это правка плана, а не подготовка помещения."""
    found = []
    by_label: dict[str, list[plan_engine.Check]] = {}
    for check in plan.checks:
        by_label.setdefault(check.label, []).append(check)

    reach = by_label.get("Все места у стеллажей доступны", [])
    if reach:
        bad = [check.detail for check in reach if not check.ok]
        found.append(
            Item(
                "reach",
                "Все места у стеллажей доступны роботу",
                REDO if bad else READY,
                " ".join(bad) if bad else "До каждого места у стеллажей есть путь от ворот",
                "Проверка плана: путь от буфера у ворот до каждого места",
            )
        )
    tall = by_label.get("Стеллажи ниже потолка", [])
    if tall:
        bad = [check.detail for check in tall if not check.ok]
        found.append(
            Item(
                "ceiling",
                "Стеллажи ниже потолка",
                REDO if bad else READY,
                "; ".join(dict.fromkeys(bad)) if bad else f"Верхний ярус {_m(plan.rack_top_m)} м, потолок выше",
                "Проверка плана: верхний ярус против потолка секции",
            )
        )
    forklift = by_label.get("Погрузчик проходит в проезды", [])
    if forklift:
        check = forklift[0]
        found.append(
            Item(
                "forklift",
                "Проезды для погрузчиков, пока в зоне работают люди",
                READY if check.ok else CHECK,
                "Погрузчик проходит во все проезды, где работают люди"
                if check.ok
                else check.detail + ". Если погрузчики в зоне останутся, проезд надо расширить",
                "Проверка плана: ширина проезда против проезда погрузчика (config/layouts.yaml)",
            )
        )
    return found


# --- пункты про решение ---------------------------------------------------------------------


def aisle_item(plan: PlanFacts, robot: RobotFacts) -> Item | None:
    if not robot.mobile or plan.aisle_m <= 0:
        return None
    have = plan.aisle_m * 1000
    need = number(robot.aisle_mm.value) if robot.aisle_mm else None
    if need is None:
        return Item(
            "aisle",
            "Ширина проездов под робота",
            CHECK,
            f"Самый узкий проезд {have:.0f} мм, а сколько нужно роботу, производитель не публикует",
            "Характеристика робота: минимальная ширина проезда не опубликована",
            trust="F",
        )
    ok = need <= have + 1e-9
    return Item(
        "aisle",
        "Ширина проездов под робота",
        READY if ok else REDO,
        f"Нужно {need:.0f} мм, самый узкий проезд {have:.0f} мм"
        + ("" if ok else ": проезд расширить или робота туда не пускать"),
        _basis("Минимальная ширина проезда", robot.aisle_mm),
        trust=robot.aisle_mm.trust,
        link=robot.aisle_mm.url,
    )


def lift_item(plan: PlanFacts, robot: RobotFacts) -> Item | None:
    """Только у тех, кто ставит груз в стеллаж: подхват с пола до яруса не тянется."""
    value = number(robot.lift_mm.value) if robot.lift_mm else None
    top = plan.rack_top_m * 1000
    if value is None or value <= robot.stacking_mm or top <= 0:
        return None
    ok = value + 1e-9 >= top
    return Item(
        "lift",
        "Высота ярусов под штабелер",
        READY if ok else CHECK,
        f"Достает до {_m(value / 1000)} м, верхний ярус {_m(top / 1000)} м"
        + ("" if ok else ": верхние ярусы останутся погрузчику или человеку"),
        _basis("Высота подъема", robot.lift_mm),
        trust=robot.lift_mm.trust,
        link=robot.lift_mm.url,
    )


def closed_item(plan: PlanFacts, robot: RobotFacts) -> Item | None:
    if not plan.closed_racks or not robot.mobile:
        return None
    return Item(
        "closed",
        "Набивные и мобильные стеллажи",
        CHECK,
        f"Зон с такими стеллажами: {plan.closed_racks}. Внутрь блока робот не заезжает, берет груз "
        "с торца или из одного открытого прохода. Может ли так этот робот, спросите поставщика",
        "Проверка плана: тип стеллажа; в каталоге такой характеристики нет",
        trust="F",
    )


def ramp_items(plan: PlanFacts, robot: RobotFacts) -> list[Item]:
    if not plan.ramps or not robot.mobile:
        return []
    limit = incline(robot)
    found = []
    for number_, ramp in enumerate(plan.ramps, start=1):
        name = "Пандус" if len(plan.ramps) == 1 else f"Пандус {number_}"
        if ramp.drop_m <= 0:
            found.append(
                Item(
                    f"ramp-{number_}",
                    name,
                    REDO,
                    "Пандус никуда не ведет: с обоих концов пол на одной отметке",
                    "Проверка плана: отметки пола у концов пандуса",
                )
            )
            continue
        slope = f"уклон {ramp.slope:.0f}%: подъем {_m(ramp.drop_m)} м на {_m(ramp.length_m)} м"
        if limit is None:
            found.append(
                Item(
                    f"ramp-{number_}",
                    name,
                    CHECK,
                    f"На плане {slope}. Какой уклон берет робот, производитель не публикует, спросите поставщика",
                    "План: перепад отметок пола вдоль пандуса; характеристика робота не опубликована",
                    trust="F",
                )
            )
            continue
        allowed, spec = limit
        ok = ramp.slope <= allowed + 1e-9
        found.append(
            Item(
                f"ramp-{number_}",
                name,
                READY if ok else REDO,
                f"На плане {slope}, робот берет до {allowed:.0f}%"
                + ("" if ok else f". Пандус нужен длиннее: не короче {_m(ramp.drop_m / allowed * 100)} м"),
                _basis("Допустимый уклон", spec),
                trust=spec.trust,
                link=spec.url,
            )
        )
    return found


def floor_item(robot: RobotFacts) -> Item | None:
    if not robot.mobile:
        return None
    needs = floor_needs(robot)
    if not needs:
        return Item(
            "floor",
            "Ровность пола",
            CHECK,
            "Требований к полу производитель не публикует. Ровность вашего пола мы не знаем, спросите "
            "поставщика и замерьте перепады и щели на маршрутах",
            "Характеристика робота не опубликована",
            trust="F",
        )
    spec = needs[0]
    return Item(
        "floor",
        "Ровность пола",
        CHECK,
        f"Роботу нужно: {spec.value}. Ровность вашего пола мы не знаем, замерьте перепады, щели и "
        "стыки плит на маршрутах",
        _basis("Условия работы", spec),
        trust=spec.trust,
        link=spec.url,
    )


def temperature_item(robot: RobotFacts) -> Item | None:
    spec = temperature(robot)
    if spec is None:
        return None
    return Item(
        "temperature",
        "Температура в зоне работы",
        CHECK,
        f"У производителя: {spec.value}. Температуру на складе мы не знаем: проверьте зимой у ворот "
        "и в неотапливаемых зонах",
        _basis("Условия работы", spec),
        trust=spec.trust,
        link=spec.url,
    )


def navigation_item(robot: RobotFacts) -> Item | None:
    if not robot.mobile:
        return None
    spec = robot.navigation
    if spec is None or not spec.value:
        return Item(
            "navigation",
            "Разметка для навигации",
            CHECK,
            "Как робот находит дорогу, производитель не публикует: спросите, нужны ли метки на полу или маяки",
            "Характеристика робота не опубликована",
            trust="F",
        )
    text = spec.value.lower()
    if "qr" in text or "data-matrix" in text or "метки" in text and "потол" not in text:
        what = "наклеить QR-метки на пол по маршрутам и в местах погрузки"
        if "slam" in text:
            what += " (робот ездит и по карте, метки нужны там, где он встает точно)"
        return Item(
            "navigation",
            "Разметка для навигации",
            CHECK,
            f"Навигация: {spec.value}. До запуска {what}. Сколько меток и что это стоит, производитель не публикует",
            _basis("Навигация", spec),
            cost_note=NO_PRICE,
            trust=spec.trust,
            link=spec.url,
        )
    if "потол" in text:
        return Item(
            "navigation",
            "Разметка для навигации",
            CHECK,
            f"Навигация: {spec.value}. До запуска поставить метки на потолке над маршрутами",
            _basis("Навигация", spec),
            cost_note=NO_PRICE,
            trust=spec.trust,
            link=spec.url,
        )
    if "rtls" in text or "анкер" in text or "маяк" in text:
        return Item(
            "navigation",
            "Разметка для навигации",
            CHECK,
            f"Навигация: {spec.value}. До запуска поставить радиомаяки с питанием от розетки, "
            "их число поставщик считает по плану помещения",
            _basis("Навигация", spec),
            cost_note=NO_PRICE,
            trust=spec.trust,
            link=spec.url,
        )
    return Item(
        "navigation",
        "Разметка для навигации",
        READY,
        f"Навигация: {spec.value}. Меток не нужно: карту склада снимают при запуске",
        _basis("Навигация", spec),
        trust=spec.trust,
        link=spec.url,
    )


def network_item(robot: RobotFacts, communications_rub_year: float, communications: Spec) -> Item | None:
    if not robot.mobile:
        return None
    cost = f"{money(communications_rub_year)} в год" if communications_rub_year else ""
    note = f"столько связь стоит в расчете, оценка {communications.trust}" if communications_rub_year else ""
    if robot.connectivity is None:
        return Item(
            "network",
            "Связь на маршрутах",
            CHECK,
            "Какая связь нужна роботу, производитель не публикует. Спросите поставщика и проверьте "
            "покрытие сети по всем маршрутам",
            "Характеристика робота не опубликована",
            cost=cost,
            cost_note=note,
            trust="F",
        )
    return Item(
        "network",
        "Связь на маршрутах",
        CHECK,
        f"Роботу нужен {robot.connectivity.value}. Покрытие вашей сети мы не знаем: проверьте сигнал "
        "по всем маршрутам, у ворот и в дальних проездах",
        _basis("Связь", robot.connectivity),
        cost=cost,
        cost_note=note,
        trust=robot.connectivity.trust,
        link=robot.connectivity.url,
    )


def charge_item(robot: RobotFacts) -> Item | None:
    if robot.chargers <= 0:
        return None
    places = f"{robot.chargers} " + _places(robot.chargers)
    how = f" У производителя: {robot.charging.value}." if robot.charging else ""
    if (
        robot.charging
        and "комплект" in robot.charging.value.lower()
        and robot.charger_price_rub > 0
        and robot.charger_price.source.startswith("аналог")
    ):
        # в экономике зарядка стоит по цене похожей модели, а поставщик пишет, что она в комплекте
        how += " А в расчете место зарядки стоит по цене похожей модели: уточните у поставщика, эта сумма может уйти"
    if robot.charger_price_rub > 0:
        rub = robot.chargers * robot.charger_price_rub
        cost = money(rub)
        note = f"{places} по {money(robot.charger_price_rub)}, оценка {robot.charger_price.trust}"
    else:
        rub, cost = 0.0, ""
        note = "в комплекте с роботом" if "комплект" in robot.charger_price.source.lower() else NO_PRICE
    return Item(
        "charge",
        "Зарядка",
        CHECK,
        f"Нужно {places} на {robot.fleet} "
        + _robots(robot.fleet)
        + f". Место на плане выбрала программа: у стены рядом с буфером у ворот. Туда нужно питание.{how}",
        f"Цена места зарядки, оценка {robot.charger_price.trust}: {robot.charger_price.source or 'не опубликована'}",
        cost=cost,
        cost_note=note,
        cost_rub=rub,
        trust=robot.charger_price.trust,
        link=robot.charger_price.url,
    )


QUEUE_PLACES = {
    "ворота": ("у ворот", "Еще одни ворота или буфер шире"),
    "проезд": ("в проездах между рядами", "Проезды шире или змейка по проездам"),
    "станция": ("у станций комплектации", "Еще одна станция"),
    "зарядка": ("у зарядки", "Еще одно место зарядки"),
    "пандус": ("перед пандусом", "Второй пандус или пандус шире"),
}


def queue_item(robot: RobotFacts) -> Item | None:
    if not robot.waits:
        return None
    place, share = max(robot.waits.items(), key=lambda pair: pair[1])
    if robot.waiting_share <= QUEUE_SHARE or share <= 0:
        return Item(
            "queues",
            "Очереди в смене",
            READY,
            f"В очередях роботы стоят {robot.waiting_share:.0%} времени смены, узкого места нет",
            "Прогон смены тем же парком по вашему плану",
        )
    where, fix = QUEUE_PLACES.get(place, (place, "Разгрузить это место"))
    return Item(
        "queues",
        "Очереди в смене",
        CHECK,
        f"В очередях роботы стоят {robot.waiting_share:.0%} времени смены, больше всего {where}. "
        f"{fix} сократит очередь и может уменьшить парк. Парк уже подобран с учетом очередей, склад работает и так",
        "Прогон смены тем же парком по вашему плану",
    )


def _places(count: int) -> str:
    return _plural(count, "место", "места", "мест")


def _robots(count: int) -> str:
    return _plural(count, "робота", "робота", "роботов")


def _plural(count: int, one: str, few: str, many: str) -> str:
    if count % 10 == 1 and count % 100 != 11:
        return one
    if 2 <= count % 10 <= 4 and not 12 <= count % 100 <= 14:
        return few
    return many


def robot_items(plan: PlanFacts, robot: RobotFacts, communications_rub_year: float, communications: Spec) -> list[Item]:
    found = [
        aisle_item(plan, robot),
        lift_item(plan, robot),
        closed_item(plan, robot),
        *ramp_items(plan, robot),
        floor_item(robot),
        temperature_item(robot),
        navigation_item(robot),
        network_item(robot, communications_rub_year, communications),
        charge_item(robot),
        queue_item(robot),
    ]
    items = [item for item in found if item]
    for item in items:
        item.solution = f"{robot.name}, {robot.task.lower()}" if robot.task else robot.name
    return items


def collect(
    plan: PlanFacts, robots: list[RobotFacts], communications_rub_year: float, communications: Spec
) -> Readiness:
    """Весь список: сначала то, что переделать, потом что проверить, потом готовое.

    Пункты плана общие для всех задач и идут один раз. Если на складе несколько задач,
    у пунктов стоит решение и задача: требования у паллетного робота и уборщика разные.
    Если на одну задачу несколько решений (смешанный парк), их пункты сводятся в один:
    состояние по самому строгому роботу, в пункте названы оба, зарядки складываются.
    """
    items = plan_items(plan)
    groups: dict[str, list[RobotFacts]] = {}
    for robot in robots:
        groups.setdefault(robot.operation or robot.name, []).append(robot)
    for group in groups.values():
        parts = [(robot, robot_items(plan, robot, communications_rub_year, communications)) for robot in group]
        if len(parts) == 1:
            items += parts[0][1]
            continue
        order: list[str] = []
        by_id: dict[str, list[tuple[RobotFacts, Item]]] = {}
        for robot, found in parts:
            for item in found:
                if item.id not in by_id:
                    order.append(item.id)
                by_id.setdefault(item.id, []).append((robot, item))
        items += [merge(by_id[key]) for key in order]
    items.sort(key=lambda item: ORDER[item.status])
    counts = {status: sum(1 for item in items if item.status == status) for status in (REDO, CHECK, READY)}
    return Readiness(items, counts)


def short(name: str) -> str:
    """Название решения без скобок: "DMR 1200", а не "DMR 1200 (грузоподъемность до 1 200 кг)" """
    return name.split(" (")[0]


def merge(parts: list[tuple[RobotFacts, Item]]) -> Item:
    """Один пункт из пунктов нескольких решений задачи. Если он есть только у одного, он как был.
    Слова каждого робота идут своей строкой: экран и PDF переносят их по переводу строки."""
    if len(parts) == 1:
        return parts[0][1]
    worst = min(ORDER[item.status] for _, item in parts)
    strict = [(robot, item) for robot, item in parts if ORDER[item.status] == worst]
    first = strict[0][1]
    task = parts[0][0].task
    names = ", ".join(short(robot.name) for robot, _ in parts)
    merged = Item(**vars(first))
    merged.solution = f"{names}, {task.lower()}" if task else names
    if first.id == "charge":
        # зарядки у разных роботов свои: места и деньги складываем
        merged.why = "\n".join(f"{short(robot.name)}: {item.why}" for robot, item in parts)
        merged.cost_rub = sum(item.cost_rub for _, item in parts)
        merged.cost = money(merged.cost_rub) if merged.cost_rub else ""
        merged.cost_note = "; ".join(f"{short(robot.name)}: {item.cost_note}" for robot, item in parts)
        return merged
    # показываем требование самого строгого: у кого пункт хуже, того и слова
    merged.why = "\n".join(f"{short(robot.name)}: {item.why}" for robot, item in strict)
    return merged


def ramps_of(plan: plan_engine.Plan, grid: plan_engine.Grid) -> list[Ramp]:
    """Пандусы с плана клиента: длина вдоль той стороны, по которой меняется отметка пола.

    Направления у пандуса на плане нет, есть прямоугольник и пол вокруг. Пандус идет с запада
    на восток, если за западным краем пол на одной отметке, за восточным на другой. Так же
    с юга на север. Если по краям не понять, берем длинную сторону и весь перепад вокруг.
    """
    found = []
    for item in plan.of(plan_engine.RAMP):
        west, east = _heights(grid, item, "west"), _heights(grid, item, "east")
        south, north = _heights(grid, item, "south"), _heights(grid, item, "north")
        if _ends(west, east):
            found.append(Ramp(item.w, abs(west.pop() - east.pop())))
        elif _ends(south, north):
            found.append(Ramp(item.h, abs(south.pop() - north.pop())))
        else:
            around = west | east | south | north
            found.append(Ramp(max(item.w, item.h), max(around) - min(around) if around else 0.0))
    return found


def _ends(one: set[float], other: set[float]) -> bool:
    """Два края пандуса это его концы, если за каждым пол ровный, а отметки разные."""
    return len(one) == 1 and len(other) == 1 and one != other


def _heights(grid: plan_engine.Grid, item: plan_engine.Item, side: str) -> set[float]:
    """Отметки пола за краем пандуса: полоса клеток сразу за стороной."""
    left, bottom = int(round(item.x / grid.step_m)), int(round(item.y / grid.step_m))
    right = int(round((item.x + item.w) / grid.step_m)) - 1
    top = int(round((item.y + item.h) / grid.step_m)) - 1
    if side == "west":
        cells = [(left - 1, row) for row in range(bottom, top + 1)]
    elif side == "east":
        cells = [(right + 1, row) for row in range(bottom, top + 1)]
    elif side == "south":
        cells = [(col, bottom - 1) for col in range(left, right + 1)]
    else:
        cells = [(col, top + 1) for col in range(left, right + 1)]
    return {grid.height(row * grid.cols + col) for col, row in cells if grid.floor(col, row)}
