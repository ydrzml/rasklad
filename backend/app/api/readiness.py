from fastapi import APIRouter

from app.schemas.readiness import ReadinessRequest, ReadinessResult
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
def readiness(request: ReadinessRequest) -> ReadinessResult:
    return service.readiness(request)
