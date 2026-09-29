from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, UploadFile, status
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.db import get_session
from app.schemas.norms import Norm, NormChange, NormEdit, NormImportResult, NormList
from app.services import data_import
from app.services import norms as service
from app.storage.models import User

router = APIRouter(prefix="/admin/norms", tags=["админка: нормативы"])

SessionDep = Annotated[Session, Depends(get_session)]
AdminDep = Annotated[User, Depends(require_admin)]
NOT_FOUND = {404: {"description": "Такого норматива нет или он не открыт для правки"}}
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _one(session: Session, path: str) -> Norm:
    return next(norm for norm in service.listing(session).items if norm.code == path)


@router.get(
    "",
    response_model=NormList,
    summary="Нормативы: значение, единица, источник, дата, оценка и что меняют в расчете",
    description=(
        "Открытые администратору значения config/model.yaml по разделам config/norms.yaml. "
        "Если значение поправил администратор, в file лежит значение из файла модели."
    ),
)
def list_norms(session: SessionDep, _: AdminDep) -> NormList:
    return service.listing(session)


@router.get("/changes", response_model=list[NormChange], summary="Журнал правок нормативов, свежие сверху")
def changes(
    session: SessionDep,
    _: AdminDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    path: Annotated[str | None, Query(description="Только правки одного норматива")] = None,
) -> list[NormChange]:
    return service.changes(session, limit, path)


@router.get(
    "/export",
    summary="Выгрузить нормативы файлом",
    description=(
        'CSV в UTF-8 с разделителем ";" или Excel. Колонки: код, название, значение, единица, источник, дата, '
        "оценка. Тот же файл загружается обратно через /import, строки без правок ничего не меняют."
    ),
    response_class=Response,
    responses={200: {"content": {"text/csv": {}, XLSX: {}}}},
)
def export(session: SessionDep, _: AdminDep, format: Literal["csv", "xlsx"] = "csv") -> Response:
    if format == "xlsx":
        content, media, name = service.export_xlsx(session), XLSX, "normativy.xlsx"
    else:
        content, media, name = service.export_csv(session), "text/csv; charset=utf-8", "normativy.csv"
    return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post(
    "/import",
    response_model=NormImportResult,
    summary="Загрузить нормативы файлом",
    description=(
        "CSV или Excel в формате выгрузки, до 2 МБ. Каждая строка проверяется отдельно: известный ли код, "
        "число ли значение, целое ли там, где нужно, та ли единица (для доли можно проценты), в жестких "
        "границах ли, возможен ли объект с таким значением, есть ли источник и дата. За диапазоном "
        "датасета только предупреждение. Строка, совпавшая с файлом модели, снимает правку. "
        "С dry_run ничего не записывается."
    ),
    responses={413: {"description": "Файл больше 2 МБ"}, 415: {"description": "Не Excel и не CSV"}},
)
async def import_file(
    session: SessionDep, admin: AdminDep, file: UploadFile, dry_run: bool = False
) -> NormImportResult:
    content = await file.read()
    try:
        return service.import_file(session, admin, content, file.filename or "", dry_run)
    except data_import.TooLarge as error:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Файл больше 2 МБ") from error
    except data_import.WrongFile as error:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(error)) from error


@router.put(
    "/{path}",
    response_model=Norm,
    summary="Поправить норматив",
    description=(
        "Значение, источник, дата источника и оценка S-F. Расчет берет новое значение сразу, "
        'в "Откуда цифры" видно, кто и когда поправил. Значение и источник как в файле модели снимают правку.'
    ),
    responses={**NOT_FOUND, 422: {"description": "Значение не подходит: за границами, не целое, невозможный режим"}},
)
def edit(path: str, body: NormEdit, session: SessionDep, admin: AdminDep) -> Norm:
    try:
        service.save(session, admin, path, body)
    except service.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Норматива {path} нет") from error
    except service.Invalid as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, service.sentence(str(error))) from error
    session.commit()
    return _one(session, path)


@router.delete("/{path}", response_model=Norm, summary="Вернуть значение из файла модели", responses=NOT_FOUND)
def reset(path: str, session: SessionDep, admin: AdminDep) -> Norm:
    try:
        service.reset(session, admin, path)
    except service.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Норматива {path} нет") from error
    session.commit()
    return _one(session, path)
