from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.schemas.plan import GeneratedPlan, GenerateRequest, Measures, Plan, RackType, Template
from app.services import plan as service

router = APIRouter(prefix="/plan", tags=["план объекта"])


@router.get(
    "/templates",
    response_model=list[Template],
    summary="Шаблоны планировки склада",
    description=(
        "Четыре схемы потока: сквозная, Г-образная, с одной стороны и робозона «товар к человеку». "
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
        "там только площадь. Шаблон «custom» строит план по анкете: стена с воротами, их число "
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
