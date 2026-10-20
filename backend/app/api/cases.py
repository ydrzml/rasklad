from fastapi import APIRouter, HTTPException, status

from app.schemas.cases import DemoCase
from app.services import demo_cases

router = APIRouter(prefix="/cases", tags=["расчет"])


@router.get(
    "/{case_id}",
    response_model=DemoCase,
    summary="Готовый разбор для гостя",
    description=(
        "Без входа, только чтение. Разборы: pallets, picking, cleaning. Тот же расчет, что мастер дает на "
        "значениях по умолчанию: план по типовой схеме, прогон смены, покупка за свои деньги, в кредит и в "
        "лизинг. Ответ сервер держит в памяти, пока не поменялись нормативы, каталог или модель."
    ),
    responses={404: {"description": "Такого разбора нет"}},
)
def case(case_id: str) -> DemoCase:
    try:
        return demo_cases.get(case_id)
    except demo_cases.UnknownCase as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Такого разбора нет") from error
