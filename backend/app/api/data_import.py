import json
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Form, HTTPException, Response, UploadFile, status

from app.schemas.data_import import DataImportResult, TemplateRequest
from app.services import data_import as service

router = APIRouter(prefix="/import", tags=["импорт данных"])

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.post(
    "/template",
    summary="Шаблон Excel для данных объекта",
    description=(
        "Листы «Объект» (параметры с единицей и допустимым диапазоном), «Штат» и «Роли». "
        "Заполнен тем, что пользователь уже ввел, или значениями по умолчанию."
    ),
    response_class=Response,
    responses={200: {"content": {XLSX: {}}}},
)
def template(request: TemplateRequest) -> Response:
    content = service.template(request)
    name = "shablon-dannyh-obekta.xlsx"
    return Response(
        content,
        media_type=XLSX,
        headers={"Content-Disposition": f"attachment; filename=\"{name}\"; filename*=UTF-8''{quote(name)}"},
    )


@router.post(
    "",
    response_model=DataImportResult,
    summary="Разобрать файл с данными объекта",
    description=(
        "Excel (.xlsx) или CSV до 2 МБ. Проверяет каждую строку: известный ли параметр, число ли, "
        "та ли единица, в диапазоне ли датасета, есть ли такая роль. Ничего не сохраняет: "
        "что подставить, решает пользователь по отчету."
    ),
    responses={413: {"description": "Файл больше 2 МБ"}, 415: {"description": "Не Excel и не CSV"}},
)
async def parse(
    file: UploadFile,
    facility_id: Annotated[str, Form()] = "warehouse",
    operation_ids: Annotated[str, Form(description="Задачи через запятую")] = "pallet_transport",
    overrides: Annotated[str, Form(description="Что уже введено руками, JSON: смены из файла проверяем с ними")] = "{}",
) -> DataImportResult:
    content = await file.read()
    try:
        current = {str(path): float(value) for path, value in json.loads(overrides).items()}
    except (ValueError, TypeError, AttributeError) as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "overrides: нужен JSON вида {путь: число}"
        ) from error
    tasks = [op for op in operation_ids.split(",") if op]
    try:
        return service.parse(content, file.filename or "", facility_id, tasks, current)
    except service.TooLarge as error:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Файл больше 2 МБ") from error
    except service.WrongFile as error:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(error)) from error
