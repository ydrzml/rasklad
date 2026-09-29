from fastapi import APIRouter

from app.schemas.economics import CalculationRequest, CalculationResult, SensitivityAll, SensitivityResult
from app.services import calculation
from app.services import sensitivity as sensitivity_service

router = APIRouter(prefix="/calculations", tags=["расчет"])


@router.post(
    "/preview",
    response_model=CalculationResult,
    summary="Расчет трех сценариев без сохранения",
    description=(
        "Считает операцию объекта в трех сценариях по ТЗ: без роботизации, покупка и роботы как услуга. "
        "Любое значение модели можно поправить через overrides, правка возвращается в ответе."
    ),
)
def preview(request: CalculationRequest) -> CalculationResult:
    return calculation.calculate(request)


@router.post(
    "/sensitivity",
    response_model=SensitivityResult,
    summary="Что будет, если главные числа окажутся другими",
    description=(
        "Чувствительность по ТЗ (п. 3.5.6): зарплаты, цена робота, объем задачи, плата за аренду и внедрение "
        "по одному сдвигаются на -20, -10, +10 и +20%. Для каждого варианта окупаемость и стоимость владения "
        "покупки и аренды. Парк берется из того же прогона смены, что и расчет, и меняется во столько раз, "
        "во сколько по формуле меняется потребность в роботах."
    ),
)
def sensitivity(request: CalculationRequest) -> SensitivityResult:
    return sensitivity_service.sensitivity(request)


@router.post(
    "/sensitivity/all",
    response_model=SensitivityAll,
    summary="Что будет, если: все числа по силе влияния",
    description=(
        "Каждое число с источником, которое участвует в расчете, и штат по одному сдвигаются на -20, -10, +10 "
        "и +20%. Без проверок подходит ли робот, правил счета (горизонт, дисконт) и целых чисел вроде смен. "
        "Порядок по размаху выгоды за горизонт между -20% и +20%. Отдельно числа, которые итог не двигают, "
        "и нули, которые в процентах не сдвинуть."
    ),
)
def sensitivity_all(request: CalculationRequest) -> SensitivityAll:
    return sensitivity_service.sensitivity_all(request)
