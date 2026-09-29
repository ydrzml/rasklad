from typing import Annotated

from fastapi import APIRouter, Query

from app.schemas.staff import StaffForm, StaffFormRequest, StaffReview, StaffReviewRequest
from app.services import staff as service

Tasks = Annotated[list[str] | None, Query(description="Задачи, выбранные на первом шаге")]

router = APIRouter(prefix="/staff", tags=["штат"])


@router.get(
    "",
    response_model=StaffForm,
    summary="Справочник ролей и штат объекта по умолчанию",
    description=(
        "Из чего пользователь набирает штат и что мы подставили сами. По умолчанию подставлены "
        "строки тех ролей, у которых выбранные задачи забирают работу, и только те, для которых "
        "у нас есть данные. Роли, которые появляются после роботизации, в справочник не входят: "
        "их считает модель, а не вводит пользователь."
    ),
)
def form(facility: str = "warehouse", operations: Tasks = None) -> StaffForm:
    return service.form(facility, _ids(operations))


@router.post(
    "/form",
    response_model=StaffForm,
    summary="Штат объекта по умолчанию под объем клиента",
    description=(
        "То же, что GET /api/staff, но с правками параметров: если объем задачи или рабочие дни поменяли, "
        "численность склада из данных организатора пересчитывается под этот объем пропорционально. "
        "Так подставляем, пока человек не трогал штат сам."
    ),
)
def form_for(request: StaffFormRequest) -> StaffForm:
    return service.form(request.facility_id, _ids(request.operation_ids), request.overrides)


@router.post(
    "/check",
    response_model=StaffReview,
    summary="Что не сходится во введенном штате",
    description=(
        "Сверяет объем задач, численность и выработку между собой и возвращает предупреждения "
        "вместе с нормативом по каждой роли. Ничего не запрещает и ничего не правит: считаем "
        "по числам пользователя, но говорим, где они спорят с данными (ТЗ, п. 3.2.4)."
    ),
)
def check(request: StaffReviewRequest) -> StaffReview:
    return service.review(request)


def _ids(values: list[str] | None) -> list[str]:
    """Задачи приходят и списком, и через запятую: адрес с одной задачей должен читаться глазами."""
    return [item for value in values or [] for item in value.split(",") if item]
