import hmac
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.tokens import password_stamp, read_token
from app.db import get_session
from app.storage.models import Role, User

COOKIE_NAME = "session"


def user_by_token(session: Session, token: str | None) -> User | None:
    """Владелец токена, если токен настоящий, не просрочен и выдан при нынешнем пароле."""
    found = read_token(token) if token else None
    if found is None:
        return None
    user_id, stamp = found
    user = session.get(User, user_id)
    if user is None or not hmac.compare_digest(stamp, password_stamp(user.password_hash)):
        return None
    return user


def current_user(
    session: Annotated[Session, Depends(get_session)],
    token: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> User | None:
    """Вошедший пользователь или None для гостя. Роль читаем из базы, а не из токена:
    если у администратора забрали права, это сработает сразу, а не после конца сессии."""
    return user_by_token(session, token)


def require_user(user: Annotated[User | None, Depends(current_user)]) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Нужно войти")
    return user


def require_admin(user: Annotated[User, Depends(require_user)]) -> User:
    if user.role != Role.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Доступно только администратору")
    return user
