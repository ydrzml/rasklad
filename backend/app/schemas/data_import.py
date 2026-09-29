from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.staff import MAX_STAFF_LINES, StaffLine


class TemplateRequest(BaseModel):
    facility_id: str = "warehouse"
    operation_ids: list[str] = Field(default_factory=lambda: ["pallet_transport"])
    overrides: dict[str, float] = Field(default_factory=dict, description="Правки пользователя: шаблон заполним ими")
    staff: list[StaffLine] | None = Field(
        None, max_length=MAX_STAFF_LINES, description="Штат пользователя. Если нет, подставим штат по умолчанию"
    )


class DataImportRow(BaseModel):
    sheet: str = Field(description="Лист Excel или «CSV»")
    row: int = Field(description="Номер строки в файле, как его видит человек. 0, если строки в файле нет")
    field: str = Field(description="Что в строке: параметр или роль")
    value: str = Field(description="Что стояло в ячейке")
    status: Literal["ok", "warn", "error"]
    message: str = Field("", description="Что не так и что мы сделали. Пусто, если все хорошо")


class DataImportResult(BaseModel):
    overrides: dict[str, float] = Field(description="Значения параметров, которые подставим")
    staff: list[StaffLine] | None = Field(description="Штат из файла целиком. None, если штата в файле нет")
    rows: list[DataImportRow]
    applied: int = Field(description="Сколько значений подставим, с предупреждением и без")
    warnings: int
    errors: int
