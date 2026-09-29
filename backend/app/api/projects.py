from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile, status
from sqlalchemy.orm import Session

from app.auth.dependencies import require_user
from app.db import get_session
from app.schemas.projects import (
    CompareRequest,
    Comparison,
    FileInfo,
    Folder,
    FolderCreate,
    FolderRename,
    Project,
    ProjectCopy,
    ProjectCreate,
    ProjectSummary,
    ProjectUpdate,
    ShareCreate,
    ShareInfo,
    Version,
    VersionCreate,
)
from app.services import comparison, projects
from app.storage.models import User

router = APIRouter(prefix="/projects", tags=["проекты"])

SessionDep = Annotated[Session, Depends(get_session)]
UserDep = Annotated[User, Depends(require_user)]

NOT_FOUND = {404: {"description": "Проекта нет или он чужой: эти случаи не различаем"}}
FOLDER_NOT_FOUND = {404: {"description": "Папки нет или она чужая"}}


def _not_found(error: projects.NotFound) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"Не найдено: {error}")


@router.get("", response_model=list[ProjectSummary], summary="Мои проекты, последние измененные сверху")
def list_projects(session: SessionDep, user: UserDep) -> list[ProjectSummary]:
    return projects.list_projects(session, user)


@router.post(
    "",
    response_model=Project,
    status_code=status.HTTP_201_CREATED,
    summary="Создать проект",
    description="Если сразу передать state, расчет сохранится первой версией.",
    responses={413: {"description": "Расчет больше 2 МБ"}},
)
def create(body: ProjectCreate, session: SessionDep, user: UserDep) -> Project:
    try:
        return projects.create(session, user, body)
    except projects.TooLarge as error:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Расчет слишком большой для сохранения") from error


# Папки и сравнение стоят раньше адресов с номером проекта: иначе /folders читалось бы как номер
@router.get("/folders", response_model=list[Folder], summary="Мои папки")
def list_folders(session: SessionDep, user: UserDep) -> list[Folder]:
    return projects.list_folders(session, user)


@router.post(
    "/folders",
    response_model=Folder,
    status_code=status.HTTP_201_CREATED,
    summary="Новая папка",
    description="Можно сразу положить в нее проекты. Копия проекта сама ложится в папку оригинала.",
    responses=NOT_FOUND,
)
def create_folder(body: FolderCreate, session: SessionDep, user: UserDep) -> Folder:
    try:
        return projects.create_folder(session, user, body)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.patch("/folders/{folder_id}", response_model=Folder, summary="Переименовать папку", responses=FOLDER_NOT_FOUND)
def rename_folder(folder_id: int, body: FolderRename, session: SessionDep, user: UserDep) -> Folder:
    try:
        return projects.rename_folder(session, user, folder_id, body.name)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.delete(
    "/folders/{folder_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Убрать папку",
    description="Проекты из папки не удаляются, они возвращаются в общий список.",
    responses=FOLDER_NOT_FOUND,
)
def delete_folder(folder_id: int, session: SessionDep, user: UserDep) -> None:
    try:
        projects.delete_folder(session, user, folder_id)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.post(
    "/compare",
    response_model=Comparison,
    summary="Сравнить проекты или версии",
    description="От двух до шести сохранений рядом: что ввели и что получилось, разница отмечена. "
    "Цифры берутся из сохраненных версий, ничего не пересчитывается.",
    responses=NOT_FOUND,
)
def compare(body: CompareRequest, session: SessionDep, user: UserDep) -> Comparison:
    try:
        return comparison.compare(session, user, body.items)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.get(
    "/{project_id}",
    response_model=Project,
    summary="Проект с историей сохранений и последним расчетом",
    responses=NOT_FOUND,
)
def get(project_id: int, session: SessionDep, user: UserDep) -> Project:
    try:
        return projects.get(session, user, project_id)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.patch(
    "/{project_id}",
    response_model=Project,
    summary="Переименовать проект или переложить в папку",
    responses=NOT_FOUND,
)
def update(project_id: int, body: ProjectUpdate, session: SessionDep, user: UserDep) -> Project:
    try:
        return projects.update(session, user, project_id, body)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.delete(
    "/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить проект вместе с версиями и файлами",
    responses=NOT_FOUND,
)
def delete(project_id: int, session: SessionDep, user: UserDep) -> None:
    try:
        projects.delete(session, user, project_id)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.post(
    "/{project_id}/copy",
    response_model=Project,
    status_code=status.HTTP_201_CREATED,
    summary="Копия проекта или вариант с правкой",
    description="В копию уходят последнее сохранение и файлы, история остается у оригинала. Копия ложится "
    "в папку оригинала, а если он вне папок, для них заводится папка с его именем. С changes копия сразу "
    "пересчитывается с правкой: так смотрят, что будет, если поменять объем, смены или площадь.",
    responses={**NOT_FOUND, 422: {"description": "С такой правкой расчет не получается"}},
)
def copy(project_id: int, session: SessionDep, user: UserDep, body: ProjectCopy | None = None) -> Project:
    try:
        return projects.copy(session, user, project_id, body or ProjectCopy())
    except projects.NotFound as error:
        raise _not_found(error) from error
    except projects.CannotCalculate as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error


@router.post(
    "/{project_id}/versions",
    response_model=Version,
    status_code=status.HTTP_201_CREATED,
    summary="Сохранить расчет новой версией",
    description="Старые версии не меняются. К версии записываются версии модели и данных, чтобы расчет можно было повторить.",
    responses={**NOT_FOUND, 413: {"description": "Расчет больше 2 МБ"}},
)
def save_version(project_id: int, body: VersionCreate, session: SessionDep, user: UserDep) -> Version:
    try:
        return projects.save_version(session, user, project_id, body)
    except projects.NotFound as error:
        raise _not_found(error) from error
    except projects.TooLarge as error:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Расчет слишком большой для сохранения") from error


@router.get(
    "/{project_id}/versions/{number}",
    response_model=Version,
    summary="Открыть старое сохранение",
    responses=NOT_FOUND,
)
def get_version(project_id: int, number: int, session: SessionDep, user: UserDep) -> Version:
    try:
        return projects.get_version(session, user, project_id, number)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.post(
    "/{project_id}/files",
    response_model=FileInfo,
    status_code=status.HTTP_201_CREATED,
    summary="Загрузить файл в проект",
    description="Excel или CSV до 10 МБ. Файлы удаляются вместе с проектом.",
    responses={**NOT_FOUND, 413: {"description": "Файл больше 10 МБ"}, 415: {"description": "Не Excel и не CSV"}},
)
async def add_file(project_id: int, file: UploadFile, session: SessionDep, user: UserDep) -> FileInfo:
    content = await file.read(projects.MAX_FILE_BYTES + 1)
    try:
        return projects.add_file(session, user, project_id, file.filename or "файл", content)
    except projects.NotFound as error:
        raise _not_found(error) from error
    except projects.WrongFileType as error:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Можно загрузить только .xlsx, .xls или .csv"
        ) from error
    except projects.TooLarge as error:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Файл больше 10 МБ") from error


@router.get(
    "/{project_id}/files/{file_id}",
    response_class=Response,
    summary="Скачать загруженный файл",
    responses={**NOT_FOUND, 200: {"content": {"application/octet-stream": {}}}},
)
def get_file(project_id: int, file_id: int, session: SessionDep, user: UserDep) -> Response:
    try:
        file = projects.get_file(session, user, project_id, file_id)
    except projects.NotFound as error:
        raise _not_found(error) from error
    return Response(
        file.content,
        # По имени, а не по сохраненному типу: файлы, загруженные раньше, тоже отдаем безопасно
        media_type=projects.media_type(file.name),
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(file.name)}"},
    )


@router.delete(
    "/{project_id}/files/{file_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить файл из проекта",
    responses=NOT_FOUND,
)
def delete_file(project_id: int, file_id: int, session: SessionDep, user: UserDep) -> None:
    try:
        projects.delete_file(session, user, project_id, file_id)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.post(
    "/{project_id}/shares",
    response_model=ShareInfo,
    status_code=status.HTTP_201_CREATED,
    summary="Поделиться версией расчета",
    description="Дает ссылку /share/<token>, по которой версию видно без входа. На одну версию одна ссылка.",
    responses=NOT_FOUND,
)
def share(project_id: int, session: SessionDep, user: UserDep, body: ShareCreate | None = None) -> ShareInfo:
    try:
        return projects.share(session, user, project_id, body.version if body else None)
    except projects.NotFound as error:
        raise _not_found(error) from error


@router.delete(
    "/{project_id}/shares/{share_token}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Отозвать ссылку",
    description="После этого по ссылке расчет не открывается.",
    responses=NOT_FOUND,
)
def revoke(project_id: int, share_token: str, session: SessionDep, user: UserDep) -> None:
    try:
        projects.revoke(session, user, project_id, share_token)
    except projects.NotFound as error:
        raise _not_found(error) from error
