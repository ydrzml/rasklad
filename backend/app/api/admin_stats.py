from datetime import UTC, date, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.db import get_session
from app.storage.models import CatalogChange, Project, ProjectVersion, User

router = APIRouter(prefix="/admin", tags=["админка: главная"])

DAYS = 14
MOSCOW = ZoneInfo("Europe/Moscow")


class Day(BaseModel):
    day: date
    saves: int = Field(description="Сохранений расчетов за день")
    users: int = Field(description="Новых аккаунтов за день")
    edits: int = Field(description="Записей в журнале правок каталога за день")


class Stats(BaseModel):
    users: int = Field(description="Аккаунтов, вместе с демо")
    projects: int
    versions: int = Field(description="Сохранений расчетов во всех проектах")
    days: list[Day] = Field(description="Последние 14 дней по московскому времени, старые первыми")


@router.get("/stats", response_model=Stats, summary="Сколько людей и расчетов в сервисе и что было по дням")
def stats(session: Annotated[Session, Depends(get_session)], _: Annotated[User, Depends(require_admin)]) -> Stats:
    def count(model: type) -> int:
        return session.scalar(select(func.count()).select_from(model)) or 0

    today = datetime.now(MOSCOW).date()
    first = today - timedelta(days=DAYS - 1)

    def per_day(column) -> dict[date, int]:
        found: dict[date, int] = {}
        # записей немного, считаем в Python: так одинаково в Postgres и в SQLite тестов, где время без пояса
        for at in session.scalars(select(column)):
            moment = at if at.tzinfo else at.replace(tzinfo=UTC)
            day = moment.astimezone(MOSCOW).date()
            if day >= first:
                found[day] = found.get(day, 0) + 1
        return found

    saves, users, edits = per_day(ProjectVersion.saved_at), per_day(User.created_at), per_day(CatalogChange.at)
    days = [first + timedelta(days=i) for i in range(DAYS)]
    return Stats(
        users=count(User),
        projects=count(Project),
        versions=count(ProjectVersion),
        days=[Day(day=d, saves=saves.get(d, 0), users=users.get(d, 0), edits=edits.get(d, 0)) for d in days],
    )
