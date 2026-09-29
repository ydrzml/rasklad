"""Персонал: сколько ставок занято работой, которую забирают роботы, и что с этими ставками станет.

Порядок счета здесь важнее формул. Сначала объект дает объем работы, потом роботы забирают
часть этого объема, и только потом мы смотрим на людей. Штат не влияет на то, сколько нужно
роботов: склад возит одно и то же количество паллет независимо от кадровых планов.
Штат отвечает на два других вопроса: у кого забрали ставки и сколько эти ставки стоят.

Роботы забирают работу двумя разными способами, и считаются они по-разному:

замещение   робот делает операцию целиком вместо человека (перевозка паллет, уборка).
            Ставки переводим из объема через выработку человека.
ускорение   человек остается на операции, но перестает ходить и работает быстрее
            («товар к человеку»). Ставки после = ставки до * выработка до / выработка после.

Внутри строки штата роботы сначала закрывают незанятые ставки и только потом высвобождают людей.
Незакрытая ставка денег не стоит, поэтому экономию дают только высвобожденные люди,
а закрытые вакансии идут отдельной строкой результата: работа стала делаться, найм не нужен.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

REPLACE, SPEEDUP = "replace", "speedup"


@dataclass(frozen=True)
class StaffLine:
    """Строка штата, которую ввел пользователь. Одну роль можно добавить несколько раз."""

    id: str
    role: str
    headcount: float  # ставок по штатному расписанию
    filled: float  # сколько из них занято людьми, остальное вакансии
    salary_month: float
    contractor: bool = False  # люди подрядчика: оклада и взносов нет, платим по договору

    @property
    def vacancies(self) -> float:
        return max(self.headcount - self.filled, 0.0)

    @property
    def surplus(self) -> float:
        """Перекомплект: людей больше, чем ставок в расписании."""
        return max(self.filled - self.headcount, 0.0)


@dataclass(frozen=True)
class Take:
    """Что роботы сделали с одной строкой штата на одной операции."""

    line_id: str
    role: str
    fte_occupied: float  # ставок строки занято работой, до которой дотягиваются роботы
    fte_taken: float  # сколько из них роботы забрали
    vacancies_closed: float  # из забранного приходится на незанятые ставки
    people_released: float  # из забранного приходится на живых людей
    fte_left: float  # сколько ставок остается на этой работе
    reason: str  # почему остается, для объяснения в экономике
    salary_month: float
    contractor: bool

    @property
    def people_left(self) -> float:
        """Оставшуюся работу сначала закрываем теми, кто уже работает, а не вакансиями."""
        return min(self.fte_left, self.people_released)

    @property
    def people_freed(self) -> float:
        """Живые ставки, которые действительно высвобождаются. Только они дают экономию."""
        return self.people_released - self.people_left


def employee_full_cost(salary_month: float, payroll: dict) -> float:
    """Полная годовая стоимость одной ставки: оклад, взносы, травматизм, спецодежда, подбор взамен ушедших."""
    annual = salary_month * 12
    limit = payroll["insurance_base_limit_rub"]
    insurance = (
        min(annual, limit) * payroll["insurance_rate"] + max(annual - limit, 0) * payroll["insurance_rate_above_limit"]
    )
    return (
        annual
        + insurance
        + annual * payroll["injury_insurance_rate"]
        + payroll["workwear_rub_year"]
        + payroll["turnover_rate"] * payroll["hire_cost_months"] * salary_month
    )


def contractor_full_cost(salary_month: float) -> float:
    """Люди подрядчика: в цене договора уже все есть, взносы сверху не начисляем."""
    return salary_month * 12


def line_cost(line: StaffLine, payroll: dict) -> float:
    return (
        contractor_full_cost(line.salary_month) if line.contractor else employee_full_cost(line.salary_month, payroll)
    )


def hours_per_day(schedule: dict) -> float:
    return schedule["shifts"] * schedule["shift_hours"]


def fte_per_post(facility: dict, annual_work_hours: float) -> float:
    """Сколько ставок нужно, чтобы пост был занят все часы работы объекта, с учетом отпусков и болезней."""
    schedule = facility["schedule"]
    post_hours = hours_per_day(schedule) * schedule["days_per_year"]
    return post_hours / annual_work_hours * (1 + facility["staff_loss_share"])


def volume_growth(operation: dict) -> float:
    """Во сколько раз вырастет объем операции после роботизации.

    1.0: объем тот же, роботы высвобождают людей. Больше 1: людей столько же, но объем больше,
    и выгода в том, что для этого объема не пришлось нанимать людей.
    """
    return operation.get("volume_growth", 1.0)


def mode(operation: dict) -> str:
    """Замещение или ускорение. Ускорение там, где задана выработка после роботизации."""
    return SPEEDUP if operation.get("productivity_after") else REPLACE


def robot_volume_per_day(operation: dict) -> float:
    """Объем в сутки, до которого дотягиваются роботы. От штата не зависит, только от объекта.

    Из полного объема вычитаем то, что роботу не по силам: негабарит, нестандарт, ручные исключения.
    """
    return operation["volume_per_day"] * operation["automatable_share"] * volume_growth(operation)


def normative_fte(volume_year: float, productivity: float, annual_work_hours: float, loss_share: float) -> float:
    """Сколько ставок нужно на такой объем по выработке. Это норматив, а не факт.

    Тот же счет, что в инженерном нормировании труда: объем / выработка / фонд времени,
    плюс надбавка на отпуска, болезни и текучесть.
    """
    return volume_year / (productivity * annual_work_hours) * (1 + loss_share)


def role_productivity(roles: dict, role_id: str, operation: dict) -> float | None:
    """Выработка человека на этой операции. У операции она может быть своей, иначе берем из справочника."""
    own = operation.get("productivity_before")
    if own:
        return own
    return roles.get(role_id, {}).get("productivity")


def lines_of_role(facility: dict, role_id: str) -> list[StaffLine]:
    return [line for line in staff_lines(facility) if line.role == role_id]


def staff_lines(facility: dict) -> list[StaffLine]:
    """Штат объекта как список строк. filled по умолчанию равен штатному расписанию: штат полный."""
    lines = []
    for raw in facility.get("staff", []):
        headcount = raw["headcount"]
        lines.append(
            StaffLine(
                id=raw["id"],
                role=raw["role"],
                headcount=headcount,
                filled=raw.get("filled", headcount),
                salary_month=raw["salary_month"],
                contractor=bool(raw.get("contractor", False)),
            )
        )
    return lines


def role_total_normative(facility: dict, roles: dict, role_id: str, annual_work_hours: float) -> float:
    """Норматив по всем операциям, которые выполняет роль. Нужен, чтобы разложить штат по операциям."""
    days = facility["schedule"]["days_per_year"]
    loss = facility["staff_loss_share"]
    total = 0.0
    for operation in facility["operations"]:
        if role_id not in operation.get("performed_by", []):
            continue
        productivity = role_productivity(roles, role_id, operation)
        if not productivity:
            continue
        total += normative_fte(operation["volume_per_day"] * days, productivity, annual_work_hours, loss)
    return total


def occupied_fte(facility: dict, roles: dict, operation: dict, line: StaffLine, annual_work_hours: float) -> float:
    """Сколько ставок строки штата занято этой операцией.

    Ставки роли раскладываем по ее операциям пропорционально нормативной трудоемкости.
    Так учитывается и недокомплект, и перекомплект: если людей меньше норматива, каждый делает больше,
    если больше - меньше. Норматив тут только пропорция, в ставки идет фактическая численность.
    """
    days = facility["schedule"]["days_per_year"]
    loss = facility["staff_loss_share"]
    productivity = role_productivity(roles, line.role, operation)
    if not productivity:
        return 0.0
    own = normative_fte(operation["volume_per_day"] * days, productivity, annual_work_hours, loss)
    if operation.get("people_from_volume"):
        # Людей на задаче считаем от объема по нормативу, а не долей от штата. Так для отбора товара:
        # штат отборщиков в датасете не сходится с его же объемом, и доля от штата занижала
        # работу, которую делают руками (docs/decisions.md, «Люди в отборе от объема»)
        # две строки одной роли делят эту работу пропорционально местам
        places = sum(other.headcount for other in lines_of_role(facility, line.role))
        return own * volume_growth(operation) * (line.headcount / places if places else 0.0)
    total = role_total_normative(facility, roles, line.role, annual_work_hours)
    if total <= 0:
        return 0.0
    # При росте объема это уже не факт, а сколько людей понадобилось бы, чтобы сделать
    # новый объем руками: выгода в том, что нанимать их не пришлось.
    return line.headcount * own / total * volume_growth(operation)


def take_from_line(line: StaffLine, occupied: float, wanted: float, left: float, reason: str) -> Take:
    """Забираем ставки у одной строки: сначала незанятые, потом живых людей."""
    taken = min(wanted, occupied)
    # занятых ставок может быть больше, чем мест в строке, когда люди считаются от объема:
    # вакансий при этом не больше, чем их есть в строке
    share = min(occupied / line.headcount, 1.0) if line.headcount else 0.0
    vacancies_here = line.vacancies * share
    closed = min(taken, vacancies_here)
    return Take(
        line_id=line.id,
        role=line.role,
        fte_occupied=occupied,
        fte_taken=taken,
        vacancies_closed=closed,
        people_released=taken - closed,
        fte_left=left,
        reason=reason,
        salary_month=line.salary_month,
        contractor=line.contractor,
    )


def takes_on_operation(facility: dict, roles: dict, operation: dict, annual_work_hours: float) -> list[Take]:
    """Что роботы забирают у штата на одной операции.

    Роли перебираем в том порядке, в каком их перечислила операция: сначала та, чью работу робот
    повторяет целиком, остатком занимаемся дальше. Когда у роли ставки кончились, переходим к следующей.
    """
    speedup = mode(operation) == SPEEDUP
    occupied_by_line = []
    for role_id in operation.get("performed_by", []):
        for line in lines_of_role(facility, role_id):
            occupied = occupied_fte(facility, roles, operation, line, annual_work_hours)
            if occupied > 0:
                occupied_by_line.append((line, occupied))

    # Доля объема операции, до которой дотягиваются роботы. Ставки берем от фактической
    # численности, а не от норматива: если роль укомплектована не по нормативу, люди просто
    # работают с другой интенсивностью, и высвободить можно только тех, кто есть.
    # Рост объема уже учтен в occupied_fte, здесь остается только доля, посильная роботам.
    total_occupied = sum(occupied for _, occupied in occupied_by_line)
    remaining = min(operation["automatable_share"], 1.0) * total_occupied

    takes: list[Take] = []
    for line, occupied in occupied_by_line:
        if remaining <= 0:
            break
        taken = min(remaining, occupied)
        if speedup:
            before = role_productivity(roles, line.role, operation)
            after = operation["productivity_after"]
            left = taken * before / after
            reason = f"остаются на станциях: выработка растет с {before} до {after}"
        else:
            left = 0.0
            reason = "работу делают роботы"
        takes.append(take_from_line(line, occupied, taken, left, reason))
        remaining -= taken

    return takes


def scale_takes(takes: list[Take], share: float) -> list[Take]:
    """Доля того, что роботы забирают у штата, для одной части задачи при смешанном парке.

    Что забирают роботы, считается один раз на всю задачу, и каждая часть получает свою долю
    ставок, вакансий, высвобожденных и оставшихся. Иначе каждая часть закрывала бы одни и те же
    вакансии заново и брала штат с первой строки: половина плюс половина давали бы не целое."""
    if share >= 1:
        return takes
    return [
        replace(
            take,
            fte_occupied=take.fte_occupied * share,
            fte_taken=take.fte_taken * share,
            vacancies_closed=take.vacancies_closed * share,
            people_released=take.people_released * share,
            fte_left=take.fte_left * share,
        )
        for take in takes
    ]


def normative_gap(facility: dict, roles: dict, role_id: str, annual_work_hours: float) -> float | None:
    """Во сколько раз норматив расходится с фактической численностью роли.

    Больше 1: по объему и выработке людей нужно больше, чем есть. Меньше 1: перекомплект.
    Нужно для предупреждения при вводе, в расчет не идет: мы не правим данные пользователя.
    """
    actual = sum(line.headcount for line in lines_of_role(facility, role_id))
    if not actual:
        return None
    normative = role_total_normative(facility, roles, role_id, annual_work_hours)
    return normative / actual if normative else None


# Расхождение между нормативом и численностью, с которого начинаем предупреждать.
# Граница наша: ниже нее расхождение объясняется округлением выработки и потерь времени.
NORM_TOLERANCE = 0.2


@dataclass(frozen=True)
class Mismatch:
    """Что не сходится во введенном штате. Это повод предупредить, а не повод не считать.

    Числа отдаем как есть, словами их одевает сервис: движок не знает про экран.
    """

    kind: str
    level: str  # warn расходится с данными, note просто стоит знать
    role: str | None = None
    line_id: str | None = None
    operation_id: str | None = None
    actual: float | None = None
    expected: float | None = None
    low: float | None = None
    high: float | None = None


def selected_operations(facility: dict, operation_ids: list[str]) -> list[dict]:
    return [operation for operation in facility["operations"] if operation["id"] in operation_ids]


def roles_at_work(operations: list[dict]) -> list[str]:
    """Роли, у которых выбранные задачи забирают работу, в порядке появления."""
    found: list[str] = []
    for operation in operations:
        for role_id in operation.get("performed_by", []):
            if role_id not in found:
                found.append(role_id)
    return found


def _has_productivity(roles: dict, role_id: str, operations: list[dict]) -> bool:
    """Есть ли чем перевести объем в ставки. Смотрим только на задачи, которые эта роль и делает:
    выработка, записанная у чужой задачи, к ней отношения не имеет."""
    own = [operation for operation in operations if role_id in operation.get("performed_by", [])]
    return any(role_productivity(roles, role_id, operation) for operation in own)


def _role_checks(facility: dict, roles: dict, role_id: str, operations: list[dict], hours: float) -> list[Mismatch]:
    lines = lines_of_role(facility, role_id)
    if not lines:
        return []
    if not _has_productivity(roles, role_id, operations):
        return [Mismatch(kind="no_productivity", level="warn", role=role_id, line_id=lines[0].id)]
    actual = sum(line.headcount for line in lines)
    normative = role_total_normative(facility, roles, role_id, hours)
    if not actual or not normative or abs(normative / actual - 1) <= NORM_TOLERANCE:
        return []
    return [Mismatch(kind="norm_gap", level="warn", role=role_id, actual=actual, expected=normative)]


def _line_checks(line: StaffLine, roles: dict, at_work: list[str]) -> list[Mismatch]:
    found = []
    if line.role not in at_work:
        found.append(Mismatch(kind="idle_line", level="note", role=line.role, line_id=line.id))
    if line.surplus:
        found.append(
            Mismatch(
                kind="overfilled",
                level="warn",
                role=line.role,
                line_id=line.id,
                actual=line.filled,
                expected=line.headcount,
            )
        )
    elif line.vacancies:
        found.append(
            Mismatch(
                kind="vacancies",
                level="note",
                role=line.role,
                line_id=line.id,
                actual=line.filled,
                expected=line.headcount,
            )
        )
    salary_range = roles.get(line.role, {}).get("salary_range") or []
    if len(salary_range) == 2 and not salary_range[0] <= line.salary_month <= salary_range[1]:
        found.append(
            Mismatch(
                kind="salary_out_of_range",
                level="warn",
                role=line.role,
                line_id=line.id,
                actual=line.salary_month,
                low=salary_range[0],
                high=salary_range[1],
            )
        )
    return found


def review(facility: dict, roles: dict, operation_ids: list[str], annual_work_hours: float) -> list[Mismatch]:
    """Что не сходится между объемом, численностью и выработкой. Считаем по введенному, ничего не правим."""
    operations = selected_operations(facility, operation_ids)
    at_work = roles_at_work(operations)
    found: list[Mismatch] = []
    for operation in operations:
        covered = [role_id for role_id in operation.get("performed_by", []) if lines_of_role(facility, role_id)]
        if not covered:
            found.append(Mismatch(kind="no_staff", level="warn", operation_id=operation["id"]))
    for role_id in at_work:
        found += _role_checks(facility, roles, role_id, operations, annual_work_hours)
    for line in staff_lines(facility):
        found += _line_checks(line, roles, at_work)
    return found
