from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

Kind = Literal["brs", "bas", "software", ""]
Status = Literal["operation", "piloting", "rnd", ""]
Rating = Literal["S", "A", "B", "C", "D", "E", "F"]


class FieldInfo(BaseModel):
    id: str
    label: str
    unit: str


class OperationInfo(BaseModel):
    facility: str
    facility_label: str
    id: str
    label: str
    needs: list[str] = Field(description="Характеристики, без которых решение для этой операции не проверить")


class UseInfo(BaseModel):
    facility: str
    facility_label: str
    operation: str
    label: str
    status: Literal["confirmed", "suggested", "rejected"] = Field(
        description="confirmed проверено и идет в подбор, suggested предложило правило, rejected отклонено"
    )
    source: str = Field(description="team из data/catalog/uses.csv, rule по сценарию организатора, admin вручную")
    note: str


class UseSet(BaseModel):
    status: Literal["confirmed", "rejected"]
    note: str = Field("", max_length=2000, description="Почему: кейс, источник, чем не подходит")


class ListQuery(BaseModel):
    search: str = ""
    kind: Kind = ""
    status: Status = ""
    origin: Literal["organizer", "team", ""] = ""
    with_specs: bool = Field(False, description="Только решения, у которых есть хоть одна характеристика")
    facility: Literal["warehouse", "airport", "clinic", "none", ""] = Field(
        "", description="Решения объекта (подтвержденные и предложенные) или none: не привязанные ни к одному"
    )
    to_check: bool = Field(False, description="Только решения с предложениями правила, которые ждут администратора")
    incomplete: bool = Field(False, description="Только решения, которым не хватает характеристик для своих операций")
    sort: Literal["name", "updated", "price"] = "name"
    offset: int = Field(0, ge=0)
    limit: int = Field(50, ge=1, le=300)


class SolutionBasics(BaseModel):
    id: str
    organizer_id: str | None = Field(
        description="Номер в выгрузке организатора. У второй комплектации с другой ценой свой id, а номер тот же"
    )
    name: str
    company: str
    kind: str
    status: str
    type: str
    subtype: str
    trl: int | None
    region: str
    industry: str
    price_rub: Decimal | None
    process: str = Field(description="Процесс склада, под который мы взяли решение в расчет")
    tested_fcbas: bool
    registry_719: bool
    origin: str = Field(description="organizer: из выгрузки организатора, team: добавила команда")
    photo_url: str | None = Field(description="Адрес главного фото, None если фото нет")
    manual_fields: list[str] = Field(
        description="Поля организатора, поправленные администратором руками. Повторная загрузка их не трогает"
    )
    facilities: list[str] = Field(description="Объекты с подтвержденной операцией: туда решение идет в подбор")
    tasks: list[str] = Field(description='Подтвержденные задачи словами: "Склад: Перевозка паллет"')
    to_check: int = Field(description="Предложений правила, которые ждут администратора")
    needs_total: int = Field(description="Сколько характеристик нужно решению для его операций")
    needs_filled: int = Field(description="Из них заполнено")
    updated_at: datetime


class SolutionRow(SolutionBasics):
    specs_filled: int = Field(description="Характеристик со значением")
    specs_total: int
    specs_confirmed: int = Field(description="Из них с оценкой S, A или B")


class SolutionPage(BaseModel):
    total: int
    items: list[SolutionRow]
    facets: dict[str, int] = Field(
        description="Сколько решений во всем каталоге: warehouse, airport, clinic, none, to_check, incomplete"
    )


class CatalogSpec(BaseModel):
    id: int
    field: str
    label: str
    value: str
    unit: str
    rating: str
    confirmed: bool = Field(description="Оценка S, A или B: значение подтверждено")
    source: str
    source_type: str
    quote: str
    retrieved: date | None
    note: str


class Change(BaseModel):
    id: int
    at: datetime
    user_email: str
    action: str = Field(description="seed, import, create, update, reset, delete, spec_add, spec_edit, spec_delete")
    solution_id: str | None
    solution_name: str
    changes: dict[str, Any] = Field(description="Поле: [было, стало]")
    note: str


class SolutionCard(SolutionBasics):
    description: str
    scenario: str
    cases: str
    market_potential: str
    photo: "PhotoInfo | None" = Field(description="Главное фото с источником и условиями использования")
    organizer_values: dict[str, Any] = Field(
        description="Что стоит у организатора в последней загруженной выгрузке: для сравнения с ручной правкой"
    )
    specs: list[CatalogSpec]
    uses: list[UseInfo] = Field(description="Где работает и что делает, включая отклоненные предложения")
    missing: list[str] = Field(description="Характеристики, которых не хватает для операций решения")
    history: list[Change] = Field(description="Последние правки этого решения, свежие сверху")


class SolutionEditable(BaseModel):
    company: str = Field("", max_length=300)
    kind: Kind = ""
    status: Status = ""
    description: str = Field("", max_length=5000)
    type: str = Field("", max_length=200)
    subtype: str = Field("", max_length=200)
    scenario: str = Field("", max_length=2000)
    cases: str = Field("", max_length=5000)
    trl: int | None = Field(None, ge=1, le=9)
    market_potential: str = Field("", max_length=2000)
    region: str = Field("", max_length=200)
    industry: str = Field("", max_length=2000)
    price_rub: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    process: str = Field("", max_length=200)
    tested_fcbas: bool = False
    registry_719: bool = False


class SolutionCreate(SolutionEditable):
    name: str = Field(min_length=1, max_length=300, examples=["PuduBot 2"])


class SolutionUpdate(SolutionEditable):
    """Приходят только поля, которые меняли: остальные остаются как были."""

    name: str | None = Field(None, min_length=1, max_length=300)


class SpecEditable(BaseModel):
    value: str = Field("", max_length=500)
    unit: str = Field("", max_length=100)
    rating: Rating = "F"
    source: str = Field("", max_length=2000, description="Ссылка или название документа")
    source_type: str = Field("", max_length=200, examples=["производитель"])
    quote: str = Field("", max_length=2000, description="Цитата из источника, откуда взято значение")
    retrieved: date | None = Field(None, description="Когда нашли значение")
    note: str = Field("", max_length=2000)


class SpecCreate(SpecEditable):
    field: str = Field(min_length=1, max_length=60, examples=["payload_kg"])


class SpecUpdate(SpecEditable):
    pass


class ImportRow(BaseModel):
    row: int = Field(description="Номер строки в файле, считая заголовок первой")
    message: str


class ImportResult(BaseModel):
    dry_run: bool = Field(description="Только проверка: в базу ничего не записано")
    rows: int
    added: int
    updated: int
    unchanged: int
    merged: int = Field(description="Строк-дублей с тем же номером и ценой, склеены с соседними")
    kept: int = Field(description="Решений, где загрузка не тронула поля, поправленные руками")
    suggested: int = Field(0, description="Новых предложений правила: объект и операция по сценарию организатора")
    ours: int = Field(0, description="Значений из наших колонок: характеристики, отметки, объекты и задачи")
    errors: list[ImportRow]
    note: str


class PhotoMeta(BaseModel):
    source_url: str = Field("", max_length=2000, description="Откуда фото: страница или пресс-кит")
    owner: str = Field("", max_length=300, description="Чье фото")
    license: str = Field("", max_length=2000, description="Условия использования или разрешение")


class PhotoInfo(PhotoMeta):
    url: str
    content_type: str
    size_bytes: int
    uploaded_by: str
    uploaded_at: datetime


SolutionCard.model_rebuild()


class TreeNode(BaseModel):
    """Ветка дерева каталога: отрасль, тип объекта, задача, тип решения. У листа есть номер решения."""

    name: str
    count: int = Field(description="Сколько решений в ветке")
    solution_id: str | None = None
    children: list["TreeNode"] = Field(default_factory=list)
