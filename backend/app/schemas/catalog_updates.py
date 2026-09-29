from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.admin_catalog import Rating


class UpdateRun(BaseModel):
    running: bool
    source: str = Field(description="web: сайты производителей, saved: сохраненные строки страниц")
    total: int = Field(description="Сколько страниц проверить")
    done: int = Field(description="Сколько уже проверено")
    started_at: datetime | None
    finished_at: datetime | None
    offline: bool = Field(description="Интернета нет: можно проверить по сохраненным страницам")
    message: str
    counts: dict[str, int]
    saved_pages: int = Field(description="Сколько страниц сохранено для проверки без интернета")


class UpdateItem(BaseModel):
    id: int
    solution_id: str
    solution_name: str
    field: str
    label: str
    url: str
    quote: str = Field(description="Что было на странице, когда собирали данные")
    outcome: Literal["same", "differs", "manual", "blocked"]
    found_text: str = Field(description="Что стоит на странице сейчас")
    current: str = Field(description="Значение в каталоге на момент проверки")
    proposed: str
    note: str
    source: str
    checked_at: datetime
    status: str = Field(description="У предложений: new ждет решения, accepted принято, rejected отклонено")
    decided_by: str
    decided_at: datetime | None


class Updates(BaseModel):
    run: UpdateRun
    items: list[UpdateItem]


class UpdateAccept(BaseModel):
    value: str = Field(min_length=1, max_length=500, description="Значение в единицах каталога, можно поправить")
    rating: Rating = "C"
