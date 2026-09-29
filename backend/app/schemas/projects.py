from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200, examples=["Склад в Подольске"])
    facility_type: str = Field("warehouse", min_length=1, max_length=40, description="Тип объекта из каталога")
    state: dict[str, Any] | None = Field(
        None, description="Что ввел пользователь в мастере. Если передать, сразу сохранится первая версия"
    )
    result: dict[str, Any] | None = Field(None, description="Результат расчета на момент сохранения")
    note: str = Field("", max_length=500)


class ProjectUpdate(BaseModel):
    """Что поменять у проекта. Чего нет в запросе, то не трогаем: folder_id: null значит «вынуть из папки»."""

    name: str | None = Field(None, min_length=1, max_length=200, examples=["Склад в Подольске, второй корпус"])
    folder_id: int | None = Field(None, description="В какую папку положить. null вынимает из папки")


class ProjectCopy(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200, description='По умолчанию "<имя> (копия)"')
    changes: dict[str, float] = Field(
        default_factory=dict,
        description="Что поменять в копии: путь значения модели -> новое число, как правки в мастере. "
        "Если есть, копию сразу считаем заново, и она готова к сравнению с оригиналом",
        examples=[{"facilities.warehouse.operations.pallet_transport.volume_per_day": 3000}],
    )
    people: float | None = Field(
        None,
        ge=0,
        le=100000,
        description="Сколько людей в штате у варианта. Штат в проекте введен строками, и сам он под новый объем "
        "не растет: без этого числа сценарий без роботов остается прежним. Строки штата меняются пропорционально",
    )


class VersionCreate(BaseModel):
    state: dict[str, Any] = Field(description="Что ввел пользователь: объект, параметры, штат, решения, правки")
    result: dict[str, Any] | None = Field(None, description="Результат расчета на момент сохранения")
    note: str = Field("", max_length=500, examples=["Добавили второй штабелер"])


class VersionSummary(BaseModel):
    number: int
    note: str
    saved_at: datetime
    model_version: str
    data_version: str
    same_data: bool = Field(
        description="Версии модели и данных совпадают с текущими: расчет повторится с теми же цифрами"
    )


class Version(VersionSummary):
    state: dict[str, Any]
    result: dict[str, Any] | None


class FileInfo(BaseModel):
    id: int
    name: str
    content_type: str
    size_bytes: int
    uploaded_at: datetime


class Figures(BaseModel):
    """Главное из последнего сохранения: чтобы два похожих проекта различались уже в списке."""

    fleet: int | None = Field(None, description="Роботов в парке")
    payback_years: float | None = Field(None, description="Окупаемость покупки. Пусто, если не окупается")
    tco_rub: float | None = Field(None, description="Стоимость владения покупкой за горизонт")
    horizon_years: int | None = None


class ProjectSummary(BaseModel):
    id: int
    name: str
    facility_type: str
    folder_id: int | None = Field(None, description="Папка проекта, если он в папке")
    created_at: datetime
    updated_at: datetime
    versions: int = Field(description="Сколько раз сохраняли расчет")
    figures: Figures | None = Field(None, description="Главные цифры последнего сохранения, для строки списка")


class ShareCreate(BaseModel):
    version: int | None = Field(None, ge=1, description="Какой версией поделиться. По умолчанию последней")


class ShareInfo(BaseModel):
    token: str = Field(description="Часть адреса /share/<token>. Угадать ее нельзя")
    version: int
    created_at: datetime


class SharedCalculation(BaseModel):
    """Что видит тот, кому прислали ссылку: без почты владельца и без других версий."""

    name: str
    version: int
    saved_at: datetime
    same_data: bool = Field(description="Нормативы и каталог с тех пор не менялись")
    state: dict[str, Any]
    result: dict[str, Any] | None


class Project(ProjectSummary):
    history: list[VersionSummary] = Field(description="Все сохранения, от первого к последнему")
    current: Version | None = Field(description="Последнее сохранение целиком, его открываем в мастере")
    files: list[FileInfo]
    shares: list[ShareInfo] = Field(
        default_factory=list, description="Действующие ссылки, по которым расчет виден без входа"
    )


class Folder(BaseModel):
    id: int
    name: str
    created_at: datetime


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200, examples=["Склад в Подольске"])
    projects: list[int] = Field(default_factory=list, description="Какие проекты сразу положить в папку")


class FolderRename(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class CompareItem(BaseModel):
    project_id: int
    version: int | None = Field(None, ge=1, description="Какую версию взять. По умолчанию последнюю")


class CompareRequest(BaseModel):
    items: list[CompareItem] = Field(min_length=2, max_length=6, description="От двух до шести проектов или версий")


class CompareColumn(BaseModel):
    project_id: int
    name: str
    version: int
    saved_at: datetime
    note: str
    same_data: bool = Field(description="Нормативы и каталог с тех пор не менялись")
    calculated: bool = Field(description="В версии есть результат расчета. Без него цифр в сравнении нет")


class CompareRow(BaseModel):
    key: str
    label: str
    group: str = Field(description="Блок таблицы: объект, задача или сценарий")
    unit: str = ""
    values: list[float | str | None] = Field(description="Значение в каждой колонке, по порядку колонок")
    differs: bool = Field(description="Значения в колонках не совпадают")
    better: Literal["low", "high"] | None = Field(
        None, description="Что лучше: меньше (стоимость, окупаемость) или больше. У ввода не бывает"
    )


class Comparison(BaseModel):
    """Проекты рядом: что ввели и что получилось. Цифры берем из сохраненных версий, ничего не пересчитываем."""

    columns: list[CompareColumn]
    inputs: list[CompareRow]
    results: list[CompareRow]
    horizon_years: int | None = Field(description="Горизонт расчета, если он у всех колонок один")
