from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.dependencies import require_user
from app.db import get_session
from app.schemas.catalog import (
    CatalogNews,
    Facility,
    FacilitySolutions,
    FacilitySolutionsRequest,
    Operation,
    Parameter,
    Solution,
)
from app.services import catalog as service
from app.services import catalog_news, facility_catalog
from app.services import selection as selection_service

Tasks = Annotated[list[str] | None, Query(description="Задачи, выбранные на первом шаге")]

router = APIRouter(prefix="/catalog", tags=["каталог"])


@router.get(
    "/facilities",
    response_model=list[Facility],
    summary="Типы объектов и их задачи",
    description=(
        "Первый шаг мастера: типы объектов с числом решений каталога и задачи, которые можно "
        "роботизировать. У объекта, которого нет в расчетной модели, задач нет, и статус говорит об этом прямо."
    ),
)
def facilities() -> list[Facility]:
    return service.facilities()


@router.get(
    "/solutions",
    response_model=list[Solution],
    summary="Подбор решений под объект и операцию",
    description=(
        "Возвращает решения каталога с объяснением: что подошло, что мешает, каких данных не хватает "
        "и из чего сложился балл. Не подходящие по ключевому ограничению помечены excluded, "
        "их можно добавить в сравнение вручную с предупреждением (ТЗ, п. 3.4)."
    ),
)
def solutions(
    facility: str = "warehouse",
    operation: str = "pallet_transport",
    aisle_mm: Annotated[float | None, Query(description="Ширина проезда с плана объекта, мм")] = None,
    rack_top_mm: Annotated[float | None, Query(description="Верхний ярус стеллажей с плана, мм")] = None,
    ramps: Annotated[int, Query(description="Сколько пандусов на плане")] = 0,
    closed_racks: Annotated[int, Query(description="Сколько зон набивных и мобильных стеллажей на плане")] = 0,
    load_kg: Annotated[
        float | None, Query(gt=0, le=100000, description="Масса груза с шага параметров, кг. Без нее берем из датасета")
    ] = None,
) -> list[Solution]:
    # Числа приходят из ответа /api/plan/measure: их посчитал сервер, интерфейс только передает дальше
    plan = (
        {"aisle_mm": aisle_mm, "rack_top_mm": rack_top_mm or 0.0, "ramps": ramps, "closed_racks": closed_racks}
        if aisle_mm
        else None
    )
    return selection_service.solutions(facility, operation, plan, load_kg)


@router.post(
    "/facility-solutions",
    response_model=FacilitySolutions,
    summary="Решения для аэропорта и медучреждения с объяснением",
    description=(
        "Расчетной модели у этих объектов нет, поэтому путь кончается списком решений. У решения видно, "
        "почему оно подходит, что мешает, каких данных нет, и у каждой характеристики источник, дата и оценка. "
        "Проверки читают параметры второго шага вместе с правками."
    ),
)
def facility_solutions(body: FacilitySolutionsRequest) -> FacilitySolutions:
    return facility_catalog.solutions(body.facility_id, body.operation_ids, body.overrides)


@router.get(
    "/parameters",
    response_model=list[Parameter],
    summary="Поля формы: значение, единица, границы из датасета и источник",
    description=(
        "Поля второго шага по объекту и по каждой выбранной задаче. Задач может быть несколько, "
        "и у каждого поля видно, к какому блоку оно относится. Штата здесь нет: он вводится строками, "
        "и для него есть свои методы в разделе «штат»."
    ),
)
def parameters(facility: str = "warehouse", operations: Tasks = None) -> list[Parameter]:
    return service.parameters(facility, _ids(operations))


@router.get(
    "/robot-parameters",
    response_model=list[Parameter],
    summary="Допущения по выбранным роботам: цена, обслуживание, срок службы",
    description=(
        "Поля для списка допущений на шаге экономики. Цена по умолчанию из каталога, источник рядом. "
        "Правка уходит в расчет так же, как правка параметров объекта: путь поля и новое значение."
    ),
)
def robot_parameters(
    robots: Annotated[list[str] | None, Query(description="Роботы расчетной модели, выбранные на шаге решений")] = None,
) -> list[Parameter]:
    return service.robot_parameters(_ids(robots))


@router.get("/operations", response_model=list[Operation], summary="Задачи объекта")
def operations(facility: str = "warehouse") -> list[Operation]:
    return service.operations(facility)


def _ids(values: list[str] | None) -> list[str]:
    """Задачи приходят и списком, и через запятую: адрес с одной задачей должен читаться глазами."""
    return [item for value in values or [] for item in value.split(",") if item]


@router.get(
    "/news",
    response_model=list[CatalogNews],
    summary="Что нового в каталоге роботов",
    description=(
        "Для главной вошедшего пользователя: новые решения, загрузка выгрузки, новая цена, обновленные "
        "характеристики и решения, которые пошли в подбор на новой задаче. Из журнала правок, без почт."
    ),
)
def news(
    session: Annotated[Session, Depends(get_session)],
    _: Annotated[object, Depends(require_user)],
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
) -> list[CatalogNews]:
    return [CatalogNews(**vars(item)) for item in catalog_news.news(session, limit)]
