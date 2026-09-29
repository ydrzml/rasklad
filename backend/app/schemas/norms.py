from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.data_import import DataImportRow

Trust = Literal["S", "A", "B", "C", "D", "E", "F"]


class NormSource(BaseModel):
    value: float
    source: str
    date: str | None = Field(description="Дата источника: ГГГГ-ММ или ГГГГ-ММ-ДД")
    trust: Trust


class NormEdited(BaseModel):
    by: str = Field(description="Почта администратора")
    at: datetime


class Norm(BaseModel):
    code: str = Field(description="Путь к значению в config/model.yaml, например economics.discount_rate")
    name: str
    group: str = Field(description="Раздел: payroll, time, money, reserves, facility, tasks, implementation")
    group_name: str
    unit: str
    value: float = Field(description="Значение, которое сейчас берет расчет")
    source: str
    date: str | None
    trust: Trust
    effect: str = Field(description="Что поменяется в расчете, одной фразой")
    min: float = Field(description="Жесткая нижняя граница: меньше не принимаем")
    max: float
    typical_min: float | None = Field(description="Диапазон отраслевого датасета: за ним только предупреждаем")
    typical_max: float | None
    whole: bool = Field(description="Только целое число")
    file: NormSource = Field(description="Значение по умолчанию из config/model.yaml")
    edited: NormEdited | None = Field(description="Кто и когда поправил. None, если значение из файла")


class NormGroup(BaseModel):
    id: str
    name: str


class NormList(BaseModel):
    groups: list[NormGroup]
    items: list[Norm]


class NormEdit(BaseModel):
    value: float
    source: str = Field(min_length=1, max_length=2000, description="Откуда значение: документ, ссылка, расчет")
    date: str | None = Field(None, description="Дата источника, ГГГГ-ММ или ГГГГ-ММ-ДД. Можно не ставить только при F")
    trust: Trust


class NormChange(BaseModel):
    id: int
    at: datetime
    user_email: str
    action: Literal["edit", "reset", "import"]
    path: str
    name: str
    changes: dict[str, Any] = Field(description="Поле: [было, стало]")
    note: str


class NormImportResult(BaseModel):
    dry_run: bool
    rows: list[DataImportRow]
    applied: int = Field(description="Сколько нормативов поменяется (с предупреждением и без)")
    unchanged: int
    warnings: int
    errors: int
