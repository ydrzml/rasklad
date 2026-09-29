from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import Response

from app.schemas.simulation import SimulationRequest, SimulationResult
from app.services import shift_log
from app.services import simulation as service

router = APIRouter(prefix="/simulation", tags=["симуляция"])


@router.post(
    "/runs",
    response_model=SimulationResult,
    summary="Прогон смены на объекте",
    description=(
        "Моделирует смену: роботы возят грузы, стоят в очередях в проходах и у ворот, заряжаются. "
        "Возвращает KPI, узкое место, лог отрезками для проигрывателя и самый маленький парк, который "
        "вытянул спрос на всех seed, с замерами поиска для графика. Тот же парк берет расчет экономики "
        "с use_simulation."
    ),
)
def run(request: SimulationRequest) -> SimulationResult:
    return service.to_schema(request)


@router.post(
    "/log.csv",
    summary="Журнал событий смены в CSV",
    description=(
        "Тот же прогон, что /simulation/runs с теми же планом, парком и правками, строками: робот, начало и "
        "конец отрезка в секундах и часах смены, действие, координаты начала и конца в метрах плана и длина "
        "пути. Разделитель точка с запятой, десятичная запятая, UTF-8 с меткой: открывается в Excel."
    ),
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}}},
)
def log_csv(request: SimulationRequest) -> Response:
    body = shift_log.csv_log(request)
    name = f"zhurnal-smeny-{request.robot_id}-{request.fleet}.csv"
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=\"{name}\"; filename*=UTF-8''{quote(name)}"},
    )
