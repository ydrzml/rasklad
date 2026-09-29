"""Штат объекта: справочник ролей, строки по умолчанию и проверки введенного.

Пользователь набирает роли сам, поэтому наружу нужны три вещи: из чего выбирать,
что подставлено по умолчанию и что в введенном не сходится. Кого заберут роботы,
здесь нет: это ответ расчета, а не вопрос к пользователю.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Role(BaseModel):
    """Роль справочника. Роли, которые появляются после роботизации, наружу не отдаем: их не вводят."""

    id: str
    name: str
    what: str
    group: str = Field(description="floor люди на полу, support учет и обслуживание")
    group_name: str
    salary_month: float
    salary_source: str
    salary_trust: str
    salary_min: float | None = None
    salary_max: float | None = None
    productivity: float | None = Field(default=None, description="Выработка человека в час, если она известна")
    productivity_unit: str = ""
    productivity_source: str = ""
    productivity_trust: str = ""
    no_productivity_note: str = Field(
        default="",
        description="Почему выработки нет и что это значит: объем в ставки по такой роли не переводится",
    )


# Строк штата в одном запросе. В справочнике около 30 ролей, у настоящего склада строк меньше сотни.
# Потолок нужен анализу чувствительности: он пересчитывает расчет по каждой строке, и время растет
# как квадрат числа строк. 300 строк считались 10 секунд, 20 000 заняли сервер на десятки минут
MAX_STAFF_LINES = 100


class StaffLine(BaseModel):
    """Строка штата: одна роль с одной ставкой. Одну роль можно добавить несколько раз."""

    id: str
    role: str
    # Границы против опечаток и чисел вроде 1e308: на одной строке не больше 100 000 ставок,
    # оклад или цена человека не больше 100 млн руб. в месяц
    headcount: float = Field(ge=0, le=100_000, description="Ставок по штатному расписанию")
    filled: float = Field(ge=0, le=100_000, description="Сколько из них занято людьми, остальное вакансии")
    salary_month: float = Field(
        ge=0, le=100_000_000, description="Оклад до вычета НДФЛ, у подрядчика цена человека по договору"
    )
    contractor: bool = Field(default=False, description="Люди подрядчика: оклада и взносов нет, есть цена договора")


class DefaultStaffLine(StaffLine):
    """Строка, которую подставили мы. Источник нужен, чтобы пользователь видел, откуда цифра."""

    role_name: str
    source: str
    trust: str


class StaffFormRequest(BaseModel):
    facility_id: str = "warehouse"
    operation_ids: list[str] = Field(default_factory=list, description="Задачи, выбранные на первом шаге")
    overrides: dict[str, float] = Field(
        default_factory=dict,
        description="Поправленные поля объекта: если объем задачи или рабочие дни поменяли, штат по умолчанию "
        "пересчитывается под них пропорционально",
    )


class StaffForm(BaseModel):
    roles: list[Role]
    lines: list[DefaultStaffLine] = Field(description="Штат по умолчанию: роли, у которых задачи забирают работу")
    note: str = Field(
        default="",
        description="Откуда штат по умолчанию: численность склада из данных организатора под его объем, "
        "и пересчитан ли он под объем клиента",
    )


class StaffReviewRequest(BaseModel):
    facility_id: str = "warehouse"
    operation_ids: list[str] = Field(default_factory=list, description="Задачи, выбранные на первом шаге")
    overrides: dict[str, float] = Field(
        default_factory=dict,
        description="Поправленные поля объекта и задач: объем и выработка участвуют в проверке",
    )
    staff: list[StaffLine] = Field(default_factory=list, max_length=MAX_STAFF_LINES)
    staff_basis: dict[str, float] = Field(
        default_factory=dict,
        description=(
            "Под какой объем штат вводили руками: путь значения (объем задачи в сутки, рабочих дней в году) "
            "и число на тот момент. Если объем с тех пор поменялся, в ответе предложение пересчитать штат. "
            "Пусто: штат не трогали или снимок старый, предложения не будет"
        ),
    )


class StaffRescale(BaseModel):
    """Объем поменялся после ввода штата, а штат прежний: предложение пересчитать его пропорционально.

    Ничего не меняем сами: строки ниже подставляются только по кнопке."""

    text: str
    headcount_before: float = Field(description="Мест в штате у ролей, которых касается объем")
    headcount_after: float = Field(description="Сколько их станет, если пересчитать")
    lines: list[StaffLine] = Field(description="Штат, пересчитанный пропорционально объему: роли и оклады те же")


class StaffNote(BaseModel):
    kind: str = Field(description="Что именно не сходится, одно из значений движка")
    level: str = Field(description="warn расходится с данными, note просто стоит знать")
    line_id: str | None = None
    role: str | None = None
    operation_id: str | None = None
    text: str


class RoleSummary(BaseModel):
    """Что мы посчитали по роли из объема и выработки. Показываем рядом со строкой."""

    role: str
    role_name: str
    headcount: float
    normative_fte: float | None = Field(default=None, description="Сколько ставок нужно по объему и выработке")


class StaffReview(BaseModel):
    notes: list[StaffNote]
    roles: list[RoleSummary]
    headcount_total: float
    filled_total: float
    payroll_rub_year: float = Field(description="Фонд оплаты в год со взносами, у подрядчика цена договора")
    rescale: StaffRescale | None = Field(
        default=None, description="Объем ушел от того, под который вводили штат: предложение пересчитать"
    )
