import json
import math
from dataclasses import asdict
from typing import Annotated, Literal

from fastapi import APIRouter, Form, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.schemas.dxf import DxfBuilt, DxfDrawing
from app.schemas.plan import GeneratedPlan, GenerateRequest, Measures, Plan, RackType, Template
from app.services import dxf_underlay
from app.services import plan as service

router = APIRouter(prefix="/plan", tags=["план объекта"])


@router.get(
    "/templates",
    response_model=list[Template],
    summary="Шаблоны планировки склада",
    description=(
        'Четыре схемы потока: сквозная, Г-образная, с одной стороны и робозона "товар к человеку". '
        "Норматива на планировку склада нет, это рыночная классификация и отраслевая практика, "
        "поэтому у чисел шаблонов оценки C и D, а не S."
    ),
)
def templates() -> list[Template]:
    return [_template(item) for item in service.templates()]


@router.get(
    "/rack-types",
    response_model=list[RackType],
    summary="Типы стеллажей",
    description=(
        "Фронтальный, набивной, мобильный, полочный и стеллажи, которые возит робот. Тип подставляет "
        "в зону хранения толщину ряда, проезд и шаг яруса, человек их правит. У каждого числа источник "
        "в config/layouts.yaml."
    ),
)
def rack_types() -> list[RackType]:
    return [RackType(**kind) for kind in service.rack_types()]


@router.post(
    "/generate",
    response_model=GeneratedPlan,
    summary="Построить план объекта из шаблона",
    description=(
        "Сначала генерация, потом правка: план строится из шаблона планировки и площади объекта, "
        "а человек его уже двигает. План из шаблона и план, нарисованный руками, это одна структура, "
        "поэтому пропуск шага не особый случай. Габариты можно задать свои: в датасете их нет, "
        'там только площадь. Шаблон "custom" строит план по анкете: стена с воротами, их число '
        "и направление рядов, или совсем без стеллажей, чтобы человек нарисовал свои."
    ),
)
def generate(request: GenerateRequest) -> GeneratedPlan:
    try:
        plan = service.generate(
            request.facility_id,
            request.operation_ids,
            request.template_id,
            request.overrides,
            request.width_m,
            request.length_m,
            request.custom.model_dump() if request.custom else None,
        )
    except service.UnknownTemplate as error:
        raise HTTPException(status_code=404, detail=f"Не найдено: {error}") from error
    return GeneratedPlan(plan=Plan(**service.to_dict(plan)), measures=_measures(plan))


@router.post(
    "/measure",
    response_model=GeneratedPlan,
    summary="Что план дает расчету",
    description=(
        "Считает по плану числа, которые уходят дальше: средний маршрут до буфера у ворот, места "
        "у ворот, проезды, ширину проезда и верхний ярус для подбора решений, пандусы и площадь "
        "под стеллажами. Заодно ставит зарядку, если человек не двигал ее сам: место для нее "
        "выбирает программа, поэтому план возвращается вместе с числами. Интерфейс дергает этот "
        "запрос на каждую правку чертежа: в браузере не считается ничего."
    ),
)
def measure(plan: Plan) -> GeneratedPlan:
    resolved = service.resolve(service.from_dict(plan.model_dump()))
    return GeneratedPlan(plan=Plan(**service.to_dict(resolved)), measures=_measures(resolved))


class SerpentineRequest(BaseModel):
    plan: Plan
    zone_id: str = Field(description="Зона хранения, по проездам которой кладем змейку")
    first: Literal["", "east", "west", "north", "south"] = Field(
        default="", description="Куда едут в первом проезде, пусто значит на север или на восток"
    )


@router.post(
    "/serpentine",
    response_model=GeneratedPlan,
    summary="Линия движения змейкой по зоне",
    description=(
        "Кладет на все проезды зоны хранения полосы движения в одну сторону, в соседних проездах "
        "в разные стороны, как делают на складах, чтобы навстречу никто не попадался. Прежние "
        "полосы этой зоны убирает. Возвращает план и числа: маршрут с объездами становится длиннее."
    ),
)
def serpentine(request: SerpentineRequest) -> GeneratedPlan:
    changed = service.serpentine(service.from_dict(request.plan.model_dump()), request.zone_id, request.first)
    resolved = service.resolve(changed)
    return GeneratedPlan(plan=Plan(**service.to_dict(resolved)), measures=_measures(resolved))


@router.post(
    "/dxf",
    response_model=DxfDrawing,
    summary="Разобрать чертеж DXF для подложки",
    description=(
        "Чертеж из AutoCAD, сохраненный как DXF, до 80 МБ. Сервер находит единицы и габарит и отдает линии "
        "по слоям: экран сам включает и выключает слои и кладет чертеж под план в точном масштабе. "
        "Разбор идет в отдельном процессе со сроком 25 секунд, у файла от 16 МБ до 170 секунд. Ничего из "
        "файла не исполняется и не сохраняется. DWG не читаем: сохраните его в AutoCAD как DXF."
    ),
    responses={
        413: {"description": "Файл больше 80 МБ"},
        415: {"description": "Не DXF"},
        422: {"description": "Чертеж не удалось разобрать"},
        429: {"description": "Сервер занят другими чертежами"},
    },
)
async def dxf(file: UploadFile) -> DxfDrawing:
    # читаем с запасом в один байт: больше лимита значит отказ, не читая файл до конца
    content = await file.read(dxf_underlay.MAX_BYTES + 1)
    try:
        found = await run_in_threadpool(dxf_underlay.read, content, file.filename or "")
    except dxf_underlay.TooLarge as error:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, dxf_underlay.TOO_LARGE) from error
    except dxf_underlay.WrongFile as error:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(error)) from error
    except dxf_underlay.Busy as error:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, "Сервер сейчас разбирает другие чертежи, повторите через минуту"
        ) from error
    except dxf_underlay.Failed as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error
    return DxfDrawing(**found)


ROLES = ("walls", "racks", "doors")
MAX_ROLES = 500


def _roles(text: str) -> dict[str, str]:
    """Роли слоев из формы: {имя слоя: walls, racks или doors}. Лишнее и чужое отклоняем"""
    try:
        roles = json.loads(text)
    except ValueError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "roles: нужен JSON вида {слой: роль}") from error
    ok = isinstance(roles, dict) and len(roles) <= MAX_ROLES
    if not ok or any(not isinstance(k, str) or len(k) > 255 or v not in ROLES for k, v in roles.items()):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "roles: слоев не больше 500, роль walls, racks или doors"
        )
    return roles


@router.post(
    "/dxf/build",
    response_model=DxfBuilt,
    summary="Построить план по слоям чертежа DXF",
    description=(
        "Файл DXF и роли слоев: какой слой стены, какой стеллажи, какой ворота. Сервер берет самый большой "
        "контур на слоях стен как здание, прямоугольники на слоях стеллажей как ряды (соседние секции склеивает, "
        "косые заменяет прямоугольниками вдоль оси) и значки на слоях ворот как ворота у ближайшей стены. "
        "Чертеж, повернутый целиком, разворачивается по стенам. Края встают на сетку в метр. Координаты в метрах от "
        "юго-западного угла здания. Что не прочиталось, названо в предупреждениях. Ничего не сохраняется."
    ),
    responses={
        413: {"description": "Файл больше 80 МБ"},
        415: {"description": "Не DXF"},
        422: {"description": "План по чертежу не построить"},
        429: {"description": "Сервер занят другими чертежами"},
    },
)
async def dxf_build(
    file: UploadFile,
    roles: Annotated[str, Form(description="JSON вида {имя слоя: walls, racks или doors}")],
    unit_m: Annotated[float, Form(gt=0.0001, le=1000, description="Метров в одной единице чертежа")],
) -> DxfBuilt:
    chosen = _roles(roles)
    content = await file.read(dxf_underlay.MAX_BYTES + 1)
    constants = service.constants()
    depth = max(1, math.floor(constants["dock_zone_depth_m"] - constants["aisle_main_m"] - 1))
    try:
        found = await run_in_threadpool(dxf_underlay.build, content, file.filename or "", chosen, unit_m, depth)
    except dxf_underlay.TooLarge as error:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, dxf_underlay.TOO_LARGE) from error
    except dxf_underlay.WrongFile as error:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(error)) from error
    except dxf_underlay.Busy as error:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, "Сервер сейчас разбирает другие чертежи, повторите через минуту"
        ) from error
    except dxf_underlay.Failed as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error
    return DxfBuilt(**found)


def _template(item: dict) -> Template:
    return Template(
        id=item["id"],
        name=item["name"],
        about=item["about"],
        fits=item["fits"],
        aspect=item["aspect"],
        aisle_m=service.constants()[item["aisle"]],
    )


def _measures(plan) -> Measures:
    return Measures(**asdict(service.measure(plan)))
