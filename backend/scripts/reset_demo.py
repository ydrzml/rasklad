"""Вернуть демо-данные в исходный вид, если эксперт что-то поменял на стенде.

Что делает:
- демо-аккаунтам возвращает роль и пароль из настроек и удаляет их проекты с версиями, файлами и ссылками;
- демо-пользователю кладет три примера с разными названиями: готовые разборы паллет, отбора и уборки,
  те же цифры, что на /cases. Иначе в кабинете демо копились проекты с одним названием;
- каталог решений собирает заново, как при первом запуске: наши 31 решение, фото и привязки к объектам,
  затем выгрузка организатора из data/organizer, если она есть. Правки администратора пропадают,
  журнал правок очищается.

Аккаунты, которые люди завели сами, и их проекты не трогаем.

Запуск на стенде: docker compose exec backend python -m scripts.reset_demo"""

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.auth.service import ensure_demo_accounts, find_by_email
from app.db import SessionLocal
from app.schemas.projects import ProjectCreate
from app.services import demo_cases
from app.services import projects as project_service
from app.services.catalog_import import seed_organizer_catalog, seed_team_catalog
from app.services.catalog_photos import seed_photos
from app.services.catalog_uses import seed_uses
from app.settings import settings
from app.storage.models import CatalogChange, Project, Role, Solution

# примеры в кабинете демо-пользователя: разбор и понятное название
EXAMPLES = {
    "pallets": "Пример: перевозка паллет, склад 10 000 м²",
    "picking": "Пример: штучный отбор, склад 10 000 м²",
    "cleaning": "Пример: уборка, склад 10 000 м²",
}


def reset(session: Session) -> dict[str, int]:
    ensure_demo_accounts(session)
    projects = 0
    for email, role in ((settings.demo_user_email, Role.user), (settings.demo_admin_email, Role.admin)):
        user = find_by_email(session, email)
        if user is None:
            continue
        user.role = role
        for project in session.scalars(select(Project).where(Project.owner_id == user.id)):
            # Через ORM, а не одним delete: так следом уходят версии, файлы и ссылки и в SQLite
            session.delete(project)
            projects += 1
    session.commit()

    for solution in session.scalars(select(Solution)):
        session.delete(solution)
    session.execute(delete(CatalogChange))
    session.commit()
    solutions = seed_team_catalog(session)
    photos = seed_photos(session)
    uses = seed_uses(session)
    solutions += seed_organizer_catalog(session)
    examples = seed_examples(session)
    return {"projects": projects, "solutions": solutions, "photos": photos, "uses": uses, "examples": examples}


def example_state(case: demo_cases.DemoCase) -> dict:
    """Ввод мастера по разбору, тот же вид, что "Начать с этого разбора" (frontend/src/features/cases/start.ts)"""
    request = case.request
    tasks = request.tasks or []
    return {
        "facilityId": request.facility_id,
        "taskIds": [task.operation_id for task in tasks],
        "picks": {task.operation_id: [{"robotId": task.robot_id, "share": task.share}] for task in tasks},
        "robotId": tasks[0].robot_id if tasks else request.robot_id,
        "overrides": dict(request.overrides or {}),
        "staff": [],
        "staffTouched": False,
        "plan": case.plan.model_dump(mode="json"),
        "answers": None,
        "planChosen": False,
        "reached": 4,
        "calcStarted": True,
    }


def seed_examples(session: Session) -> int:
    """Три примера демо-пользователю, если у него пусто. Разборы сервер считает сам, как для /cases"""
    user = find_by_email(session, settings.demo_user_email)
    if user is None or session.scalar(select(Project.id).where(Project.owner_id == user.id)) is not None:
        return 0
    for case_id, name in EXAMPLES.items():
        case = demo_cases.get(case_id)
        project_service.create(
            session,
            user,
            ProjectCreate(
                name=name,
                state=example_state(case),
                result=case.result.model_dump(mode="json"),
                note="Готовый разбор со страницы /cases",
            ),
        )
    return len(EXAMPLES)


def main() -> None:
    with SessionLocal() as session:
        done = reset(session)
    print(
        f"Демо-данные вернули: удалено демо-проектов {done['projects']}, решений в каталоге {done['solutions']}, "
        f"фото {done['photos']}, привязок к объектам {done['uses']}, примеров в кабинете демо {done['examples']}"
    )


if __name__ == "__main__":
    main()
