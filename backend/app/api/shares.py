from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db import get_session
from app.schemas.projects import SharedCalculation
from app.services import projects

router = APIRouter(prefix="/share", tags=["проекты"])


@router.get(
    "/{token}",
    response_model=SharedCalculation,
    summary="Расчет по публичной ссылке",
    description="Без входа. Отдает одну версию: название проекта, что ввели и что получилось. Почты владельца нет.",
    responses={404: {"description": "Ссылки нет или ее отозвали"}},
)
def shared(token: str, session: Annotated[Session, Depends(get_session)]) -> SharedCalculation:
    try:
        return projects.shared(session, token)
    except projects.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ссылка не работает: ее отозвали или в ней ошибка") from error
