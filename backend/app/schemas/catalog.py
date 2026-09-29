"""Справочники для интерфейса: объекты, операции, решения и поля формы."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Operation(BaseModel):
    """Задача объекта: что именно роботизируем. На первом шаге их можно выбрать несколько."""

    id: str
    name: str
    description: str = Field(default="", description="Что робот в этой задаче делает, одной строкой")
    volume_per_day: float
    volume_label: str = Field(
        default="",
        description="Что за число стоит в строке задачи, если это не объем в сутки: площадь, число операционных",
    )
    unit: str = Field(description="В чем меряем объем операции: паллет в сутки, строк в сутки")
    steady: bool = Field(
        default=False,
        description="Ровная задача без пикового часа (уборка): парк под средний час, площадь смены разложена по смене",
    )
    volume_source: str = Field(description="Откуда взят объем")
    volume_trust: str = Field(description="Оценка доверия объему, от S до F")
    processes: list[str] = Field(
        default_factory=list,
        description="Процессы каталога организатора, по которым для этой задачи подбираются решения",
    )
    performed_by: list[str] = Field(
        description="Чью работу задача занимает сейчас: названия ролей из справочника",
    )
    takeover: str = Field(
        description="Как робот забирает работу: replace вместо человека, speedup человек остается и работает быстрее",
    )
    solutions_count: int = Field(description="Сколько решений каталога делают эту задачу по нашей разметке")
    available: bool = Field(description="Можно ли выбрать задачу: под нее есть решения")
    unavailable_reason: str | None = Field(default=None, description="Почему задачу выбрать нельзя")


class CatalogMatches(BaseModel):
    """Число решений на карточке объекта и объяснение, что именно посчитано."""

    count: int
    note: str = Field(description="Что значит число: отобранные решения или позиции каталога по сценариям")
    source: str = Field(description="Откуда число, если оно посчитано не по нашему каталогу")
    trust: str = Field(default="", description="Оценка доверия числу, от S до F")


class Facility(BaseModel):
    id: str
    name: str
    status: str = Field(
        description=(
            "ready объект есть в расчетной модели, solutions есть параметры и список решений без расчета, "
            "catalog_only есть только в каталоге"
        ),
    )
    note: str = Field(description="Что доступно по этому объекту, честно и в одну строку")
    next: list[str] = Field(
        default_factory=list, description="Что делаем дальше у объекта без расчета, строками; у склада пусто"
    )
    catalog: CatalogMatches
    operations: list[Operation]
    active_area_m2: float | None = Field(default=None, description="Площадь зоны работы роботов, м2. Пусто: нет модели")
    picking_zone_share: float | None = Field(
        default=None,
        description=(
            "Часть зоны работы роботов под робозону штучного отбора по умолчанию, доля. Считана от плотности "
            "рынка: парк по формуле на 50 м2 на робота (config/model.yaml). Пусто: нет модели"
        ),
    )


class Check(BaseModel):
    label: str
    outcome: str = Field(description="fits подходит, unknown данных не хватает, blocks не подходит")
    detail: str


class Factor(BaseModel):
    label: str
    contribution: float = Field(description="Сколько этот фактор добавил к баллу")
    detail: str


class Spec(BaseModel):
    field: str
    label: str
    value: str
    trust: str
    unit: str = Field(default="", description="Единица из карточки каталога, как ее записал источник")


class Solution(BaseModel):
    id: str
    product: str
    vendor: str
    type: str
    subtype: str
    process: str
    maturity: str = Field(description="operation в эксплуатации, piloting пилот")
    tested_fcbas: bool
    registry_719: bool
    status: str = Field(description="recommended рекомендуем, needs_check требует проверки, excluded не подходит")
    score: float
    checks: list[Check]
    factors: list[Factor]
    missing: list[str] = Field(description="Каких характеристик не хватает, чтобы решение проверить целиком")
    specs: list[Spec] = Field(default_factory=list, description="Характеристики для сравнения решений")
    throughput_per_hour: float | None = Field(
        default=None,
        description=(
            "Производительность из каталога числом для сортировки: большее число из записи, если она в час "
            "(паллет/ч, м²/ч, циклов/ч). Единицы у решений разные, поэтому это порядок, а не сравнение. "
            "Пусто, если производительности нет или она не в час"
        ),
    )
    can_calculate: bool = Field(description="Есть ли в модели параметры, чтобы посчитать экономику")
    robot_id: str | None = Field(
        default=None,
        description="Идентификатор решения в расчетной модели. Его передают в расчет, когда решение выбрано",
    )
    price_rub: float | None = None
    raas_fee_rub_month: float | None = None
    calc_note: str = Field(
        default="",
        description=(
            "Почему решение не считается: у робота нет расчетных параметров в config/model.yaml. "
            "Цена для расчета берется из каталога, ее правит администратор"
        ),
    )
    summary: str = ""
    photo_url: str | None = Field(
        default=None,
        description="Адрес фото решения, /api/catalog/photos/<номер>. Пусто, если снимка нет",
    )


class Parameter(BaseModel):
    path: str
    group: str = Field(description="К чему относится поле: id объекта или id задачи")
    group_name: str = Field(description="Заголовок блока, в котором поле стоит на экране")
    key: bool = Field(
        default=False,
        description="Главное поле: стоит наверху шага крупным числом, остальные убраны в список ниже",
    )
    ours: bool = Field(
        default=False,
        description=(
            "Значение взяли на себя мы, а не спросили у клиента. Такие поля показываем не в параметрах, "
            "а в экономике списком допущений, и там их можно поправить"
        ),
    )
    yes_no: bool = Field(
        default=False,
        description="Выбор да или нет: на экране две кнопки, в данных 1 да, 0 нет",
    )
    label: str
    unit: str
    value: float
    min: float
    max: float
    hint: str
    source: str = Field(description="Откуда значение по умолчанию")
    trust: str = Field(description="Оценка доверия значению по умолчанию, от S до F")
    range_source: str = Field(description="Откуда границы")


class SourcedSpec(BaseModel):
    """Характеристика решения вместе с тем, откуда она и насколько ей верить."""

    field: str
    label: str
    value: str = Field(description="Значение с единицей. Пусто, если ни один источник его не дает")
    trust: str = Field(description="Оценка доверия от S до F, F значит данных нет")
    trust_name: str = Field(description="Оценка словами: один источник, спорно, нет данных")
    sources: str = Field(description="Типы источников: производитель, организатор, интегратор")
    date: str = Field(description="Когда значение получили, ГГГГ-ММ-ДД")
    note: str = Field(description="Почему такая оценка")


class FacilitySolution(BaseModel):
    """Решение для аэропорта или медучреждения. Экономики у них нет, поэтому нет и балла:
    только проверки по параметрам объекта и характеристики с источниками."""

    id: str = Field(description="Номер в каталоге организатора или ext-название для решений не из каталога")
    product: str
    vendor: str
    from_catalog: bool = Field(description="Есть в каталоге организатора или найдено в открытых источниках")
    source: str
    operation: str = Field(description="Какую задачу объекта решение закрывает")
    operation_name: str
    process: str = Field(description="Что именно робот делает, словами из нашего разбора")
    why: str = Field(description="Почему взяли: факт из источника")
    limits: str = Field(description="Что мешает и чего не хватает")
    availability: str = Field(description="Можно ли купить: статус из каталога или из поиска продавца")
    status: str = Field(description="recommended подходит, needs_check требует проверки, excluded не подходит")
    checks: list[Check]
    specs: list[SourcedSpec]
    missing: list[str] = Field(description="Каких характеристик для этой задачи нет ни в одном источнике")
    price_rub: float | None = None
    price_source: str = Field(description="Откуда цена и когда ее взяли, или почему ее нет")
    photo_url: str | None = None


class FacilityCondition(BaseModel):
    """Условие объекта из датасета, которое не число: СКУД, сертификация, режим работы."""

    label: str
    value: str
    source: str
    trust: str


class FacilitySolutions(BaseModel):
    solutions: list[FacilitySolution]
    conditions: list[FacilityCondition] = Field(
        description="Условия объекта словами. По ним решения мы не проверяли, показываем, чтобы не потерялись"
    )


class FacilitySolutionsRequest(BaseModel):
    facility_id: str = Field(description="airport или clinic")
    operation_ids: list[str] = Field(description="Задачи, выбранные на первом шаге")
    overrides: dict[str, float] = Field(
        default_factory=dict, description="Правки параметров второго шага: путь поля -> значение"
    )


class CatalogNews(BaseModel):
    """Что поменялось в каталоге роботов: для главной вошедшего пользователя."""

    at: datetime
    kind: Literal["new", "spec", "price", "task"] = Field(
        description="new новое решение или выгрузка, spec характеристика, price цена, task решение пошло в подбор"
    )
    title: str
    text: str
    solution_id: str | None = None
    photo_url: str | None = None
