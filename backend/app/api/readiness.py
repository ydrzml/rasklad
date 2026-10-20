from fastapi import APIRouter, Request

from app.schemas.readiness import ReadinessRequest, ReadinessResult
from app.services import priority
from app.services import readiness as service

router = APIRouter(prefix="/readiness", tags=["готовность склада"])


@router.post(
    "",
    response_model=ReadinessResult,
    summary="Что подготовить на складе до роботов",
    description=(
        "Список для инженера склада по плану клиента, выбранным решениям и прогону смены тем же парком: "
        "проезды, ярусы, пандусы, пол, навигация, связь, зарядка, очереди. У пункта статус (готово, проверить, "
        "переделать), почему, по какой проверке или характеристике с оценкой и источником, и стоимость, "
        "если у нее есть источник. Парк задачи берется из расчета, запрос его несет."
    ),
)
async def readiness(request: ReadinessRequest, http: Request) -> ReadinessResult:
    # список шага 5 под карточкой: досчет, ответ на нажатие идет раньше (services/priority.py)
    return await priority.background(http, service.readiness, request)
