from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Response, UploadFile, status
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.db import get_session
from app.schemas.admin_catalog import (
    Change,
    FieldInfo,
    ImportResult,
    ImportRow,
    ListQuery,
    OperationInfo,
    PhotoMeta,
    SolutionCard,
    SolutionCreate,
    SolutionPage,
    SolutionUpdate,
    SpecCreate,
    SpecUpdate,
    TreeNode,
    UseSet,
)
from app.services import catalog_admin, catalog_export, catalog_import, catalog_photos
from app.storage.models import User

router = APIRouter(prefix="/admin/catalog", tags=["админка: каталог"])

SessionDep = Annotated[Session, Depends(get_session)]
AdminDep = Annotated[User, Depends(require_admin)]
NOT_FOUND = {404: {"description": "Решения или характеристики с таким номером нет"}}


def _not_found(error: catalog_admin.NotFound) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"Не найдено: {error}")


@router.get("/fields", response_model=list[FieldInfo], summary="Какие характеристики мы собираем")
def fields(_: AdminDep) -> list[FieldInfo]:
    return catalog_admin.FIELDS


@router.get(
    "/operations",
    response_model=list[OperationInfo],
    summary="Объекты и операции: где может работать решение и что делать",
)
def operations(_: AdminDep) -> list[OperationInfo]:
    return catalog_admin.operations()


@router.get("", response_model=SolutionPage, summary="Решения каталога с поиском и фильтрами")
def list_solutions(session: SessionDep, _: AdminDep, query: Annotated[ListQuery, Query()]) -> SolutionPage:
    return catalog_admin.list_solutions(session, query)


@router.post(
    "",
    response_model=SolutionCard,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить решение вручную",
    description="Например, решение для медучреждения, которого нет в выгрузке организатора.",
)
def create(body: SolutionCreate, session: SessionDep, admin: AdminDep) -> SolutionCard:
    return catalog_admin.create(session, admin, body)


@router.get(
    "/tree",
    response_model=list[TreeNode],
    summary="Каталог деревом: отрасль, тип объекта, задача, тип решения, решение",
)
def tree(session: SessionDep, _: AdminDep) -> list[TreeNode]:
    return catalog_admin.tree(session)


@router.get(
    "/export",
    summary="Выгрузить каталог в формате организатора с нашими колонками",
    description=(
        'CSV в UTF-8 с разделителем ";": сначала колонки catalog_export организатора, справа процесс склада, '
        "отметки, по каждой характеристике значение, оценка и источник, подтвержденные объекты и задачи. "
        "Файл можно дополнить и загрузить обратно через /import: пустые ячейки ничего не меняют."
    ),
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}}},
)
def export(session: SessionDep, _: AdminDep) -> Response:
    return Response(
        catalog_export.export(session),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="katalog-reshenij.csv"'},
    )


@router.get("/changes", response_model=list[Change], summary="Журнал правок каталога, свежие сверху")
def changes(session: SessionDep, _: AdminDep, limit: Annotated[int, Query(ge=1, le=500)] = 100) -> list[Change]:
    return catalog_admin.changes(session, limit)


@router.post(
    "/import",
    response_model=ImportResult,
    summary="Загрузить выгрузку каталога организатора",
    description=(
        "CSV с разделителем «;» в UTF-8, колонки как в catalog_export. Каждая строка проверяется: номер, "
        "тип, статус, УГТ, цена. Строки с ошибками пропускаются и перечисляются в ответе. Дубли с тем же "
        "номером и ценой склеиваются в одно решение, отрасли и сценарии собираются списком. Собранные командой характеристики не затираются. "
        "С dry_run=true файл только проверяется."
    ),
    responses={422: {"description": "Файл целиком не подходит: кодировка, колонки или размер"}},
)
async def import_file(
    file: UploadFile, session: SessionDep, admin: AdminDep, dry_run: Annotated[bool, Query()] = False
) -> ImportResult:
    content = await file.read(catalog_import.MAX_FILE_BYTES + 1)
    try:
        report = catalog_import.import_organizer(session, content, admin, dry_run=dry_run)
    except catalog_import.ImportRejected as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error
    note = (
        f"Строк {report.rows}: добавлено {len(report.added)}, обновлено {len(report.updated)}, "
        f"без изменений {report.unchanged}, склеено строк-дублей {report.merged}, "
        f"ручные правки сохранены в {len(report.kept)}, "
        f"привязано к объектам по нашему списку {report.confirmed}, предложено правилом {report.suggested}, "
        f"из наших колонок {report.ours}, с ошибками {len(report.errors)}"
    )
    return ImportResult(
        dry_run=dry_run,
        rows=report.rows,
        added=len(report.added),
        updated=len(report.updated),
        unchanged=report.unchanged,
        merged=report.merged,
        kept=len(report.kept),
        suggested=report.suggested,
        ours=report.ours,
        errors=[ImportRow(row=row, message=message) for row, message in report.errors],
        note=note,
    )


@router.get("/{solution_id}", response_model=SolutionCard, summary="Карточка решения", responses=NOT_FOUND)
def get(solution_id: str, session: SessionDep, _: AdminDep) -> SolutionCard:
    try:
        return catalog_admin.get(session, solution_id)
    except catalog_admin.NotFound as error:
        raise _not_found(error) from error


@router.patch(
    "/{solution_id}",
    response_model=SolutionCard,
    summary="Поправить поля решения",
    description="Меняются только переданные поля. Каждая правка пишется в журнал: было и стало.",
    responses=NOT_FOUND,
)
def update(solution_id: str, body: SolutionUpdate, session: SessionDep, admin: AdminDep) -> SolutionCard:
    try:
        return catalog_admin.update(session, admin, solution_id, body)
    except catalog_admin.NotFound as error:
        raise _not_found(error) from error


@router.post(
    "/{solution_id}/reset/{field}",
    response_model=SolutionCard,
    summary="Вернуть поле к значению организатора",
    description="Снимает пометку «введено вручную»: следующая загрузка выгрузки снова обновляет это поле.",
    responses={**NOT_FOUND, 409: {"description": "Выгрузку еще не загружали, возвращать не к чему"}},
)
def reset(solution_id: str, field: str, session: SessionDep, admin: AdminDep) -> SolutionCard:
    try:
        return catalog_admin.reset(session, admin, solution_id, field)
    except catalog_admin.NotFound as error:
        raise _not_found(error) from error
    except catalog_admin.Conflict as error:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Не получится: {error}") from error


@router.delete(
    "/{solution_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить решение вместе с характеристиками",
    responses=NOT_FOUND,
)
def delete(solution_id: str, session: SessionDep, admin: AdminDep) -> None:
    try:
        catalog_admin.delete(session, admin, solution_id)
    except catalog_admin.NotFound as error:
        raise _not_found(error) from error


@router.post(
    "/{solution_id}/specs",
    response_model=SolutionCard,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить характеристику",
    responses={**NOT_FOUND, 409: {"description": "Такая характеристика у решения уже есть, ее нужно править"}},
)
def add_spec(solution_id: str, body: SpecCreate, session: SessionDep, admin: AdminDep) -> SolutionCard:
    try:
        return catalog_admin.add_spec(session, admin, solution_id, body)
    except catalog_admin.NotFound as error:
        raise _not_found(error) from error
    except catalog_admin.Conflict as error:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Характеристика {error} уже есть, поправьте ее") from error


@router.patch(
    "/{solution_id}/specs/{spec_id}",
    response_model=SolutionCard,
    summary="Поправить характеристику: значение, источник, дату, оценку",
    responses=NOT_FOUND,
)
def update_spec(solution_id: str, spec_id: int, body: SpecUpdate, session: SessionDep, admin: AdminDep) -> SolutionCard:
    try:
        return catalog_admin.update_spec(session, admin, solution_id, spec_id, body)
    except catalog_admin.NotFound as error:
        raise _not_found(error) from error


@router.delete(
    "/{solution_id}/specs/{spec_id}",
    response_model=SolutionCard,
    summary="Удалить характеристику",
    responses=NOT_FOUND,
)
def delete_spec(solution_id: str, spec_id: int, session: SessionDep, admin: AdminDep) -> SolutionCard:
    try:
        return catalog_admin.delete_spec(session, admin, solution_id, spec_id)
    except catalog_admin.NotFound as error:
        raise _not_found(error) from error


@router.put(
    "/{solution_id}/photo",
    response_model=SolutionCard,
    summary="Загрузить или заменить фото решения",
    description="JPEG, PNG или WebP до 5 МБ. Тип проверяется по содержимому файла, а не по расширению.",
    responses={**NOT_FOUND, 415: {"description": "Не картинка или больше 5 МБ"}},
)
async def put_photo(
    solution_id: str,
    file: UploadFile,
    session: SessionDep,
    admin: AdminDep,
    source_url: Annotated[str, Form(max_length=2000)] = "",
    owner: Annotated[str, Form(max_length=300)] = "",
    license: Annotated[str, Form(max_length=2000)] = "",
) -> SolutionCard:
    content = await file.read(catalog_photos.MAX_BYTES + 1)
    try:
        catalog_photos.put(session, admin, solution_id, content, source_url, owner, license)
    except catalog_photos.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Не найдено: {error}") from error
    except catalog_photos.BadImage as error:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(error)) from error
    return catalog_admin.get(session, solution_id)


@router.patch(
    "/{solution_id}/photo",
    response_model=SolutionCard,
    summary="Поправить источник и условия использования фото",
    responses=NOT_FOUND,
)
def update_photo(solution_id: str, body: PhotoMeta, session: SessionDep, admin: AdminDep) -> SolutionCard:
    try:
        catalog_photos.update_meta(session, admin, solution_id, body.source_url, body.owner, body.license)
    except catalog_photos.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Не найдено: {error}") from error
    return catalog_admin.get(session, solution_id)


@router.delete("/{solution_id}/photo", response_model=SolutionCard, summary="Удалить фото", responses=NOT_FOUND)
def delete_photo(solution_id: str, session: SessionDep, admin: AdminDep) -> SolutionCard:
    try:
        catalog_photos.delete(session, admin, solution_id)
    except catalog_photos.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Не найдено: {error}") from error
    return catalog_admin.get(session, solution_id)


@router.put(
    "/{solution_id}/uses/{facility}/{operation}",
    response_model=SolutionCard,
    summary="Подтвердить, отклонить или добавить объект и операцию решения",
    description=(
        "confirmed: решение идет в подбор этого объекта. rejected: не подходит, правило по сценарию "
        "организатора больше его не предложит. Если привязки не было, она создается."
    ),
    responses=NOT_FOUND,
)
def set_use(
    solution_id: str, facility: str, operation: str, body: UseSet, session: SessionDep, admin: AdminDep
) -> SolutionCard:
    try:
        return catalog_admin.set_use(session, admin, solution_id, facility, operation, body)
    except catalog_admin.NotFound as error:
        raise _not_found(error) from error
