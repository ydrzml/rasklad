"""Проекты пользователя: создать, переименовать, скопировать, удалить, сохранить новую версию расчета.

Чужой проект для пользователя не существует: на любой запрос к нему отвечаем «не найден»,
чтобы по ответу нельзя было понять, есть ли проект с таким номером. Администратор чужих
проектов тоже не видит, почему - записано в docs/decisions.md."""

import json
import secrets
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.schemas import projects as schemas
from app.schemas.economics import CalculationRequest
from app.services import calculation, catalog
from app.services.versions import data_version, model_version
from app.storage.models import Folder, Project, ProjectFile, ProjectVersion, Share, User

MAX_STATE_BYTES = 2 * 1024 * 1024
# Потолки на одного человека: обычной работе хватает с запасом, а забить базу сервера одним аккаунтом нельзя
MAX_PROJECTS = 100
MAX_FOLDERS = 100
MAX_VERSIONS = 1000
MAX_FILES_TOTAL_BYTES = 100 * 1024 * 1024
MAX_FILE_BYTES = 10 * 1024 * 1024
ALLOWED_FILES = (".csv", ".xlsx", ".xls")
# Тип файла берем по расширению, а не из запроса: загрузивший мог бы выдать файл за страницу
MEDIA_TYPES = {
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
}


def media_type(name: str) -> str:
    return next(
        (value for suffix, value in MEDIA_TYPES.items() if name.lower().endswith(suffix)), "application/octet-stream"
    )


class NotFound(Exception):
    pass


class TooLarge(Exception):
    pass


class WrongFileType(Exception):
    pass


class LimitReached(Exception):
    """Человек дошел до потолка: сообщение показываем ему как есть."""


def _check_limits(session: Session, user: User, projects: int = 0, folders: int = 0, versions: int = 0, files: int = 0):
    """Сколько добавится: проекты, папки, версии, байты файлов. Отказ до того, как что-то запишем."""
    owned = select(Project.id).where(Project.owner_id == user.id)
    if projects and session.scalar(select(func.count()).select_from(owned.subquery())) + projects > MAX_PROJECTS:
        raise LimitReached(f"Проектов уже {MAX_PROJECTS}, это предел. Удалите ненужные и попробуйте снова")
    count_folders = select(func.count()).select_from(Folder).where(Folder.owner_id == user.id)
    if folders and session.scalar(count_folders) + folders > MAX_FOLDERS:
        raise LimitReached(f"Папок уже {MAX_FOLDERS}, это предел. Удалите ненужные и попробуйте снова")
    count_versions = select(func.count()).select_from(ProjectVersion).where(ProjectVersion.project_id.in_(owned))
    if versions and session.scalar(count_versions) + versions > MAX_VERSIONS:
        raise LimitReached(f"Сохранений во всех проектах уже {MAX_VERSIONS}, это предел. Удалите старые проекты")
    used = select(func.coalesce(func.sum(ProjectFile.size_bytes), 0)).where(ProjectFile.project_id.in_(owned))
    if files and session.scalar(used) + files > MAX_FILES_TOTAL_BYTES:
        raise LimitReached("Файлы в проектах заняли 100 МБ, это предел. Удалите ненужные файлы и попробуйте снова")


class CannotCalculate(Exception):
    """Вариант с правкой не посчитался: смена длиннее суток, неизвестное значение и тому подобное."""


def list_projects(session: Session, user: User) -> list[schemas.ProjectSummary]:
    counts = (
        select(ProjectVersion.project_id, func.count().label("versions")).group_by(ProjectVersion.project_id).subquery()
    )
    rows = session.execute(
        select(Project, func.coalesce(counts.c.versions, 0))
        .outerjoin(counts, counts.c.project_id == Project.id)
        .where(Project.owner_id == user.id)
        .order_by(Project.updated_at.desc(), Project.id.desc())
    ).all()
    # Результат последнего сохранения читаем одним запросом: из него в строку идут парк, окупаемость и стоимость
    last = (
        select(ProjectVersion.project_id, func.max(ProjectVersion.number).label("number"))
        .join(Project, Project.id == ProjectVersion.project_id)
        .where(Project.owner_id == user.id)
        .group_by(ProjectVersion.project_id)
        .subquery()
    )
    results = dict(
        session.execute(
            select(ProjectVersion.project_id, ProjectVersion.result).join(
                last, (last.c.project_id == ProjectVersion.project_id) & (last.c.number == ProjectVersion.number)
            )
        ).all()
    )
    return [_summary(project, versions, _figures(results.get(project.id))) for project, versions in rows]


def _figures(result: dict[str, Any] | None) -> schemas.Figures | None:
    # сохранение пишет экран, поэтому форму не принимаем на веру: без списка сценариев цифр нет
    scenarios = result.get("scenarios") if isinstance(result, dict) else None
    if not isinstance(scenarios, list):
        return None
    purchase = next((s for s in scenarios if isinstance(s, dict) and s.get("id") == "purchase"), {})
    return schemas.Figures(
        fleet=(result.get("sizing") or {}).get("fleet"),
        payback_years=purchase.get("payback_cumulative_years"),
        tco_rub=purchase.get("tco_rub"),
        horizon_years=result.get("horizon_years"),
    )


def create(session: Session, user: User, body: schemas.ProjectCreate) -> schemas.Project:
    _check_limits(session, user, projects=1, versions=1 if body.state is not None else 0)
    project = Project(owner_id=user.id, name=body.name.strip(), facility_type=body.facility_type)
    session.add(project)
    if body.state is not None:
        _add_version(project, body.state, body.result, body.note)
    session.commit()
    return get(session, user, project.id)


def get(session: Session, user: User, project_id: int) -> schemas.Project:
    project = _own(session, user, project_id)
    current = project.versions[-1] if project.versions else None
    return schemas.Project(
        **_summary(project, len(project.versions)).model_dump(),
        history=[_version_summary(version) for version in project.versions],
        current=_version(session, current) if current else None,
        files=[_file_info(file) for file in project.files],
        shares=[_share_info(share) for share in project.shares],
    )


def get_version(session: Session, user: User, project_id: int, number: int) -> schemas.Version:
    project = _own(session, user, project_id)
    version = next((v for v in project.versions if v.number == number), None)
    if version is None:
        raise NotFound(f"версия {number}")
    return _version(session, version)


def update(session: Session, user: User, project_id: int, body: schemas.ProjectUpdate) -> schemas.Project:
    """Переименовать или переложить в другую папку. Поле, которого нет в запросе, не трогаем."""
    project = _own(session, user, project_id)
    if body.name is not None:
        project.name = body.name.strip()
        _touch(project)
    if "folder_id" in body.model_fields_set:
        project.folder_id = _own_folder(session, user, body.folder_id).id if body.folder_id else None
    session.commit()
    return get(session, user, project_id)


def list_folders(session: Session, user: User) -> list[schemas.Folder]:
    found = session.scalars(select(Folder).where(Folder.owner_id == user.id).order_by(Folder.name, Folder.id))
    return [_folder(folder) for folder in found]


def create_folder(session: Session, user: User, body: schemas.FolderCreate) -> schemas.Folder:
    _check_limits(session, user, folders=1)
    folder = Folder(owner_id=user.id, name=body.name.strip())
    session.add(folder)
    session.flush()
    for project_id in body.projects:
        _own(session, user, project_id).folder_id = folder.id
    session.commit()
    return _folder(folder)


def rename_folder(session: Session, user: User, folder_id: int, name: str) -> schemas.Folder:
    folder = _own_folder(session, user, folder_id)
    folder.name = name.strip()
    session.commit()
    return _folder(folder)


def delete_folder(session: Session, user: User, folder_id: int) -> None:
    """Папка уходит, проекты из нее возвращаются в общий список."""
    folder = _own_folder(session, user, folder_id)
    for project in session.scalars(select(Project).where(Project.folder_id == folder.id)):
        project.folder_id = None
    session.delete(folder)
    session.commit()


def save_version(session: Session, user: User, project_id: int, body: schemas.VersionCreate) -> schemas.Version:
    project = _own(session, user, project_id)
    _check_limits(session, user, versions=1)
    version = _add_version(project, body.state, body.result, body.note)
    session.commit()
    return _version(session, version)


def copy(session: Session, user: User, project_id: int, body: schemas.ProjectCopy) -> schemas.Project:
    """Копия берет последнее сохранение и файлы. История остается у оригинала: копия - новый проект.

    Копию делают, чтобы посмотреть другой вариант того же склада, поэтому она ложится в папку оригинала.
    Если оригинал лежал вне папок, заводим папку с его именем и кладем туда обоих. С правкой (changes)
    копию сразу считаем заново: иначе в ней лежали бы новые вводные со старыми цифрами."""
    source = _own(session, user, project_id)
    _check_limits(
        session,
        user,
        projects=1,
        folders=1 if source.folder_id is None else 0,
        versions=1 if source.versions else 0,
        files=sum(file.size_bytes for file in source.files),
    )
    last = _loaded(session, source.versions[-1]) if source.versions else None
    version = None
    if last is not None and (body.changes or body.people is not None):
        state = {**last.state, "overrides": {**(last.state.get("overrides") or {}), **body.changes}}
        if body.people is not None:
            state["staff"] = _scaled_staff(last.state.get("staff"), body.people)
            state["staffTouched"] = True
        state.pop("savedAs", None)
        version = ProjectVersion(
            number=1,
            note=_variant_note(source, last, body.changes, body.people),
            state=state,
            result=_recalculate(state),
            model_version=model_version(),
            data_version=data_version(),
        )
    elif last is not None:
        version = ProjectVersion(
            number=1,
            note=f"Копия проекта «{source.name}», версия {last.number}",
            state=last.state,
            result=last.result,
            model_version=last.model_version,
            data_version=last.data_version,
        )
    if source.folder_id is None:
        folder = Folder(owner_id=user.id, name=source.name)
        session.add(folder)
        session.flush()
        source.folder_id = folder.id
    duplicate = Project(
        owner_id=user.id,
        name=(body.name or f"{source.name} (копия)").strip()[:200],
        facility_type=source.facility_type,
        folder_id=source.folder_id,
    )
    session.add(duplicate)
    if version is not None:
        duplicate.versions.append(version)
    for file in source.files:
        session.refresh(file, ["content"])
        duplicate.files.append(
            ProjectFile(
                name=file.name, content_type=file.content_type, size_bytes=file.size_bytes, content=file.content
            )
        )
    session.commit()
    return get(session, user, duplicate.id)


def delete(session: Session, user: User, project_id: int) -> None:
    """Удаляем проект вместе со всеми версиями и загруженными файлами (ТЗ, п. 3.1.5)."""
    session.delete(_own(session, user, project_id))
    session.commit()


def add_file(session: Session, user: User, project_id: int, name: str, content: bytes) -> schemas.FileInfo:
    project = _own(session, user, project_id)
    if not name.lower().endswith(ALLOWED_FILES):
        raise WrongFileType(name)
    if len(content) > MAX_FILE_BYTES:
        raise TooLarge(name)
    _check_limits(session, user, files=len(content))
    file = ProjectFile(
        name=name[:255],
        content_type=media_type(name),
        size_bytes=len(content),
        content=content,
    )
    project.files.append(file)
    _touch(project)
    session.commit()
    return _file_info(file)


def get_file(session: Session, user: User, project_id: int, file_id: int) -> ProjectFile:
    file = _own_file(session, user, project_id, file_id)
    session.refresh(file, ["content"])
    return file


def delete_file(session: Session, user: User, project_id: int, file_id: int) -> None:
    file = _own_file(session, user, project_id, file_id)
    _touch(file.project)
    session.delete(file)
    session.commit()


def share(session: Session, user: User, project_id: int, version: int | None) -> schemas.ShareInfo:
    """Ссылка на версию. Если на эту версию ссылка уже есть, отдаем ее, а не плодим новые."""
    project = _own(session, user, project_id)
    if not project.versions:
        raise NotFound("сохранений в проекте")
    number = version or project.versions[-1].number
    if not any(v.number == number for v in project.versions):
        raise NotFound(f"версия {number}")
    existing = next((s for s in project.shares if s.version_number == number), None)
    if existing:
        return _share_info(existing)
    created = Share(token=secrets.token_urlsafe(24), version_number=number)
    project.shares.append(created)
    session.commit()
    return _share_info(created)


def revoke(session: Session, user: User, project_id: int, token: str) -> None:
    project = _own(session, user, project_id)
    found = next((s for s in project.shares if s.token == token), None)
    if found is None:
        raise NotFound("ссылка")
    project.shares.remove(found)
    session.commit()


def shared(session: Session, token: str) -> schemas.SharedCalculation:
    """Расчет по ссылке, без входа. Отозванная или неизвестная ссылка для всех одинаково «не найдена»."""
    found = session.scalar(select(Share).where(Share.token == token))
    if found is None:
        raise NotFound("ссылка")
    version = next((v for v in found.project.versions if v.number == found.version_number), None)
    if version is None:
        raise NotFound("ссылка")
    loaded = _loaded(session, version)
    summary = _version_summary(loaded)
    return schemas.SharedCalculation(
        name=found.project.name,
        version=loaded.number,
        saved_at=loaded.saved_at,
        same_data=summary.same_data,
        state=loaded.state,
        result=loaded.result,
    )


def request_from(state: dict[str, Any]) -> CalculationRequest:
    """Запрос расчета из сохраненного ввода, как его собирает мастер (frontend/src/app/saving.ts, requestFrom).
    Решения задач лежат в picks (у смешанного парка по два с долей), у снимков постарше в choices,
    у самых старых одно решение robotId, оно принадлежит первой задаче."""
    task_ids = list(state.get("taskIds") or [])
    # задачи, снятые с расчета галочкой на шаге экономики: остаются выбранными, но не считаются
    excluded = {task for task in (state.get("excluded") or []) if isinstance(task, str)}
    picks = state.get("picks")
    if not isinstance(picks, dict):
        choices = state.get("choices") or ({task_ids[0]: state["robotId"]} if task_ids and state.get("robotId") else {})
        picks = {task: [{"robotId": robot, "share": 1}] for task, robot in choices.items() if robot}
    tasks = [
        {"operation_id": task, "robot_id": pick["robotId"], "share": pick.get("share", 1)}
        for task in task_ids
        if task not in excluded
        for pick in picks.get(task) or []
        if isinstance(pick, dict) and pick.get("robotId")
    ]
    return CalculationRequest(
        facility_id=state.get("facilityId") or "warehouse",
        operation_id=tasks[0]["operation_id"] if tasks else (task_ids[0] if task_ids else "pallet_transport"),
        robot_id=tasks[0]["robot_id"] if tasks else (state.get("robotId") or "ronavi-h1500"),
        tasks=tasks,
        overrides=state.get("overrides") or {},
        staff=state.get("staff"),
        plan=state.get("plan"),
        raas_buyout=True,
        use_simulation=True,
    )


def _recalculate(state: dict[str, Any]) -> dict[str, Any]:
    try:
        result = calculation.calculate(request_from(state))
    except calculation.Impossible as error:
        raise CannotCalculate(str(error)) from error
    except calculation.UnknownPath as error:
        raise CannotCalculate(f"В модели нет значения {error}") from error
    except (ValidationError, KeyError, ValueError) as error:
        raise CannotCalculate("Этот расчет не получается пересчитать с правкой, откройте его в мастере") from error
    if not result.feasible:
        raise CannotCalculate(result.message or "С такой правкой задача не решается этим решением")
    return result.model_dump(mode="json")


def people_of(staff: Any) -> float | None:
    """Сколько людей работает сейчас по строкам штата: занятые ставки, без вакансий."""
    if not isinstance(staff, list):
        return None
    return sum(float(line.get("filled") or 0) for line in staff if isinstance(line, dict))


def _scaled_staff(staff: Any, people: float) -> list[dict[str, Any]]:
    """Штат варианта: те же роли и оклады, людей в каждой строке пропорционально новому итогу.
    Так соотношение ролей остается, а меняется только число людей."""
    before = people_of(staff)
    if not before:
        raise CannotCalculate("В проекте нет штата, менять число людей не из чего. Откройте его в мастере")
    share = people / before
    return [
        {
            **line,
            "filled": round(float(line.get("filled") or 0) * share, 1),
            "headcount": round(max(float(line.get("headcount") or 0), float(line.get("filled") or 0)) * share, 1),
        }
        for line in staff
        if isinstance(line, dict)
    ]


def _variant_note(source: Project, last: ProjectVersion, changes: dict[str, float], people: float | None = None) -> str:
    """Что поменяли, словами: «Вариант проекта «Склад», версия 2: перемещений паллет в сутки 3000 вместо 2000»."""
    fields = {field.path: field for field in parameters_of(last.state)}
    before = last.state.get("overrides") or {}
    parts = []
    for path, value in changes.items():
        field = fields.get(path)
        old = before.get(path, field.value if field else None)
        label = field.label.lower() if field else path
        was = f" вместо {number(old)}" if isinstance(old, int | float) else ""
        parts.append(f"{label} {number(value)}{was}")
    if people is not None:
        before_people = people_of(last.state.get("staff"))
        was = f" вместо {number(before_people)}" if before_people is not None else ""
        parts.append(f"людей в штате {number(people)}{was}")
    return f"Вариант проекта «{source.name}», версия {last.number}: {', '.join(parts)}"[:500]


def parameters_of(state: dict[str, Any]) -> list:
    """Поля шага параметров для сохраненного ввода: подписи, единицы и значения по умолчанию."""
    try:
        return catalog.parameters(state.get("facilityId") or "warehouse", list(state.get("taskIds") or []))
    except (KeyError, LookupError, TypeError):
        return []


def number(value: float) -> str:
    return f"{value:g}".replace(".", ",")


def _folder(folder: Folder) -> schemas.Folder:
    return schemas.Folder(id=folder.id, name=folder.name, created_at=folder.created_at)


def _own_folder(session: Session, user: User, folder_id: int) -> Folder:
    folder = session.get(Folder, folder_id)
    if folder is None or folder.owner_id != user.id:
        raise NotFound(f"папка {folder_id}")
    return folder


def _share_info(item: Share) -> schemas.ShareInfo:
    return schemas.ShareInfo(token=item.token, version=item.version_number, created_at=item.created_at)


def _own(session: Session, user: User, project_id: int) -> Project:
    project = session.get(Project, project_id)
    if project is None or project.owner_id != user.id:
        raise NotFound(f"проект {project_id}")
    return project


def _own_file(session: Session, user: User, project_id: int, file_id: int) -> ProjectFile:
    project = _own(session, user, project_id)
    file = next((f for f in project.files if f.id == file_id), None)
    if file is None:
        raise NotFound(f"файл {file_id}")
    return file


def _add_version(project: Project, state: dict[str, Any], result: dict[str, Any] | None, note: str) -> ProjectVersion:
    size = len(json.dumps({"state": state, "result": result}, ensure_ascii=False).encode())
    if size > MAX_STATE_BYTES:
        raise TooLarge("расчет")
    version = ProjectVersion(
        number=max((v.number for v in project.versions), default=0) + 1,
        note=note.strip(),
        state=state,
        result=result,
        model_version=model_version(),
        data_version=data_version(),
    )
    project.versions.append(version)
    _touch(project)
    return version


def _touch(project: Project) -> None:
    project.updated_at = datetime.now(UTC)


def _loaded(session: Session, version: ProjectVersion) -> ProjectVersion:
    # Ввод и результат читаем из базы только когда они нужны: в списке версий они не нужны, а весят много
    session.refresh(version, ["state", "result"])
    return version


def _summary(project: Project, versions: int, figures: schemas.Figures | None = None) -> schemas.ProjectSummary:
    return schemas.ProjectSummary(
        id=project.id,
        name=project.name,
        facility_type=project.facility_type,
        folder_id=project.folder_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
        versions=versions,
        figures=figures,
    )


def _version_summary(version: ProjectVersion) -> schemas.VersionSummary:
    return schemas.VersionSummary(
        number=version.number,
        note=version.note,
        saved_at=version.saved_at,
        model_version=version.model_version,
        data_version=version.data_version,
        same_data=version.model_version == model_version() and version.data_version == data_version(),
    )


def _version(session: Session, version: ProjectVersion) -> schemas.Version:
    loaded = _loaded(session, version)
    return schemas.Version(**_version_summary(loaded).model_dump(), state=loaded.state, result=loaded.result)


def _file_info(file: ProjectFile) -> schemas.FileInfo:
    return schemas.FileInfo(
        id=file.id,
        name=file.name,
        content_type=file.content_type,
        size_bytes=file.size_bytes,
        uploaded_at=file.uploaded_at,
    )
