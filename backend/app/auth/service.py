from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.passwords import hash_password, verify_password
from app.settings import settings
from app.storage.models import Role, User


class EmailTaken(Exception):
    pass


def normalize(email: str) -> str:
    return email.strip().lower()


def find_by_email(session: Session, email: str) -> User | None:
    return session.scalar(select(User).where(User.email == normalize(email)))


def register(session: Session, email: str, password: str) -> User:
    if find_by_email(session, email):
        raise EmailTaken(email)
    user = User(email=normalize(email), password_hash=hash_password(password), role=Role.user)
    session.add(user)
    session.commit()
    return user


def authenticate(session: Session, email: str, password: str) -> User | None:
    user = find_by_email(session, email)
    if not verify_password(password, user.password_hash if user else None):
        return None
    return user


def update_profile(session: Session, user: User, name: str, company: str) -> User:
    user.name = name.strip()
    user.company = company.strip()
    session.commit()
    return user


def change_password(session: Session, user: User, new_password: str) -> None:
    user.password_hash = hash_password(new_password)
    session.commit()


def change_email(session: Session, user: User, email: str) -> User:
    taken = find_by_email(session, email)
    if taken is not None and taken.id != user.id:
        raise EmailTaken(email)
    user.email = normalize(email)
    session.commit()
    return user


def delete_account(session: Session, user: User) -> None:
    """Удаляет человека. Его проекты с версиями и файлами база удаляет следом (ondelete=CASCADE)."""
    session.delete(user)
    session.commit()


def ensure_demo_accounts(session: Session) -> None:
    """Создает демо-пользователя и демо-администратора, если их еще нет. Если пароль в настройках
    сменили, меняет его и у готового аккаунта: иначе на сервере остался бы пароль по умолчанию."""
    accounts = [
        (settings.demo_user_email, settings.demo_user_password, Role.user),
        (settings.demo_admin_email, settings.demo_admin_password, Role.admin),
    ]
    for email, password, role in accounts:
        user = find_by_email(session, email)
        if user is None:
            session.add(User(email=normalize(email), password_hash=hash_password(password), role=role))
        elif not verify_password(password, user.password_hash):
            user.password_hash = hash_password(password)
    session.commit()


def demo_account(session: Session, role: Role) -> User:
    ensure_demo_accounts(session)
    email = settings.demo_admin_email if role == Role.admin else settings.demo_user_email
    user = find_by_email(session, email)
    if user is None:
        raise LookupError(email)
    return user
