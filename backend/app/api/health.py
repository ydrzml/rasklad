from fastapi import APIRouter
from pydantic import BaseModel

from app.db import database_is_up

router = APIRouter(tags=["служебное"])


class Health(BaseModel):
    status: str
    database: bool


@router.get("/health", response_model=Health, summary="Проверка, что сервер и база работают")
def health() -> Health:
    return Health(status="ok", database=database_is_up())
