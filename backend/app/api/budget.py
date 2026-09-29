from fastapi import APIRouter

from app.schemas.budget import BudgetFit, BudgetFitRequest
from app.services import budget

router = APIRouter(prefix="/budget", tags=["расчет"])


@router.post(
    "/fit",
    response_model=list[BudgetFit],
    summary="Сколько роботов влезает в бюджет на старте",
    description=(
        "Для решений одной задачи: парк по формуле под спрос и самый большой парк, чьи вложения на старте "
        "покупкой не больше бюджета. Вложения считаются как в экономике: роботы, зарядки, ПО, станции, "
        "пусконаладка, переобучение, общее на объект и резерв. Для карточек на шаге решения, до прогона смены."
    ),
)
def fit(request: BudgetFitRequest) -> list[BudgetFit]:
    return budget.fit(request)
