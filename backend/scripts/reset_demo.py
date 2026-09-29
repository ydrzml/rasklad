"""Вернуть демо-данные в исходный вид, если эксперт что-то поменял на стенде.

Что делает:
- демо-аккаунтам возвращает роль и пароль из настроек и удаляет их проекты с версиями, файлами и ссылками;
- каталог решений собирает заново, как при первом запуске: наши 31 решение, фото и привязки к объектам.
  Каталог организатора администратор загружает заново в админке. Правки администратора пропадают,
  журнал правок очищается.

Аккаунты, которые люди завели сами, и их проекты не трогаем.

Запуск на стенде: docker compose exec backend python -m scripts.reset_demo"""

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.auth.service import ensure_demo_accounts, find_by_email
from app.db import SessionLocal
from app.services.catalog_import import seed_organizer_catalog, seed_team_catalog
from app.services.catalog_photos import seed_photos
from app.services.catalog_uses import seed_uses
from app.settings import settings
from app.storage.models import CatalogChange, Project, Role, Solution


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
    return {"projects": projects, "solutions": solutions, "photos": photos, "uses": uses}


def main() -> None:
    with SessionLocal() as session:
        done = reset(session)
    print(
        f"Демо-данные вернули: удалено демо-проектов {done['projects']}, решений в каталоге {done['solutions']}, "
        f"фото {done['photos']}, привязок к объектам {done['uses']}"
    )


if __name__ == "__main__":
    main()
