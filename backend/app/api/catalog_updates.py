from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.db import get_session
from app.schemas.catalog_updates import UpdateAccept, UpdateItem, UpdateRun, Updates
from app.services import catalog_admin
from app.services import catalog_updates as service
from app.storage.models import Solution, SpecCheck, User

router = APIRouter(prefix="/admin/updates", tags=["админка: обновление характеристик"])

SessionDep = Annotated[Session, Depends(get_session)]
AdminDep = Annotated[User, Depends(require_admin)]
LABELS = {f.id: f.label for f in catalog_admin.FIELDS}


@router.get(
    "",
    response_model=Updates,
    summary="Ход проверки и что нашли на страницах производителей",
    description="Предложения правки, совпавшие значения, страницы для ручной проверки и закрытые для сбора сайты.",
)
def updates(session: SessionDep, _: AdminDep) -> Updates:
    return Updates(
        run=_run(), items=[_item(row, solution.name if solution else "") for row, solution in service.items(session)]
    )


@router.post(
    "/run",
    response_model=UpdateRun,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Проверить обновления",
    description=(
        "Обход идет в фоне, ход видно в GET /api/admin/updates. Одновременно идет одна проверка: "
        "пока она не кончилась, новая не запускается. source=saved проверяет сохраненные страницы "
        "из data/specs/saved, для работы без интернета."
    ),
    responses={409: {"description": "Проверка уже идет"}},
)
def run(
    background: BackgroundTasks,
    _: AdminDep,
    source: Annotated[Literal["web", "saved"], Query()] = "web",
) -> UpdateRun:
    if not service.start(source):
        state = service.state
        raise HTTPException(status.HTTP_409_CONFLICT, f"Проверка уже идет: проверено {state.done} из {state.total}")
    background.add_task(service.run, source)
    return _run()


@router.post("/{check_id}/accept", response_model=UpdateItem, summary="Принять предложение правки")
def accept(check_id: int, body: UpdateAccept, session: SessionDep, admin: AdminDep) -> UpdateItem:
    try:
        row = service.accept(session, admin, check_id, body.value.strip(), body.rating)
    except service.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Не найдено: {error}") from error
    return _item(row, _name(session, row))


@router.post("/{check_id}/reject", response_model=UpdateItem, summary="Отклонить предложение правки")
def reject(check_id: int, session: SessionDep, admin: AdminDep) -> UpdateItem:
    try:
        row = service.reject(session, admin, check_id)
    except service.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Не найдено: {error}") from error
    return _item(row, _name(session, row))


def _run() -> UpdateRun:
    state = service.state
    return UpdateRun(
        running=state.running,
        source=state.source,
        total=state.total,
        done=state.done,
        started_at=state.started_at,
        finished_at=state.finished_at,
        offline=state.offline,
        message=state.message,
        counts=state.counts,
        saved_pages=len(service.saved_pages()),
    )


def _name(session: Session, row: SpecCheck) -> str:
    solution = session.get(Solution, row.solution_id)
    return solution.name if solution else ""


def _item(row: SpecCheck, name: str) -> UpdateItem:
    return UpdateItem(
        id=row.id,
        solution_id=row.solution_id,
        solution_name=name,
        field=row.field,
        label=LABELS.get(row.field, row.field),
        **{
            key: getattr(row, key)
            for key in (
                "url quote outcome found_text current proposed note source checked_at status decided_by decided_at"
            ).split()
        },
    )
