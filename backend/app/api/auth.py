from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.auth import service, throttle
from app.auth.dependencies import COOKIE_NAME, current_user, require_user
from app.auth.passwords import verify_password
from app.auth.tokens import issue_token
from app.db import get_session
from app.schemas.auth import (
    Credentials,
    DemoLogin,
    DemoStatus,
    EmailChange,
    Me,
    PasswordChange,
    PasswordConfirm,
    ProfileUpdate,
    Registration,
)
from app.settings import settings
from app.storage.models import Role, User

router = APIRouter(prefix="/auth", tags=["вход"])

SessionDep = Annotated[Session, Depends(get_session)]


def start_session(response: Response, user: User) -> Me:
    response.set_cookie(
        COOKIE_NAME,
        issue_token(user.id, user.password_hash),
        max_age=settings.session_days * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )
    return _me(user)


def _is_demo(user: User) -> bool:
    return user.email in {service.normalize(settings.demo_user_email), service.normalize(settings.demo_admin_email)}


def _me(user: User) -> Me:
    return Me(role=user.role, email=user.email, name=user.name, company=user.company, demo=_is_demo(user))


DEMO_SHARED = {403: {"description": "Демо-аккаунт общий для всех, его профиль не меняется"}}


def _not_demo(user: User) -> None:
    # Демо открыт всем одной кнопкой: смени кто-то пароль или почту, следующий эксперт не вошел бы
    if _is_demo(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Демо-аккаунт общий для всех, его профиль не меняется")


def _check_password(user: User, password: str, action: str) -> None:
    """Текущий пароль перед опасным действием. Неверный считаем как при входе: после 10 попыток ждать."""
    key = f"{action}:{user.email}"
    wait = throttle.seconds_to_wait(key)
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Слишком много неверных паролей, попробуйте через 15 минут",
            headers={"Retry-After": str(wait)},
        )
    if not verify_password(password, user.password_hash):
        throttle.record_failure(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный пароль")
    throttle.forget(key)


UserDep = Annotated[User, Depends(require_user)]


@router.get("/me", response_model=Me, summary="Кто вошел: гость, пользователь или администратор")
def me(user: Annotated[User | None, Depends(current_user)]) -> Me:
    return _me(user) if user else Me(role="guest")


@router.post(
    "/register",
    response_model=Me,
    status_code=status.HTTP_201_CREATED,
    summary="Регистрация по почте и паролю, сразу со входом",
)
def register(body: Registration, response: Response, session: SessionDep) -> Me:
    try:
        user = service.register(session, body.email, body.password)
    except service.EmailTaken as error:
        raise HTTPException(status.HTTP_409_CONFLICT, "Эта почта уже зарегистрирована, войдите") from error
    return start_session(response, user)


@router.post(
    "/login",
    response_model=Me,
    summary="Вход по почте и паролю",
    responses={429: {"description": "Слишком много неудачных попыток на эту почту, нужно подождать"}},
)
def login(body: Credentials, response: Response, session: SessionDep) -> Me:
    email = service.normalize(body.email)
    wait = throttle.seconds_to_wait(email)
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Слишком много попыток входа, попробуйте через 15 минут",
            headers={"Retry-After": str(wait)},
        )
    user = service.authenticate(session, email, body.password)
    if user is None:
        throttle.record_failure(email)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверная почта или пароль")
    throttle.forget(email)
    return start_session(response, user)


@router.get("/demo", response_model=DemoStatus, summary="Включен ли вход в демо-аккаунты без пароля")
def demo_status() -> DemoStatus:
    # Экран входа прячет кнопки демо, если здесь false
    return DemoStatus(enabled=settings.demo_login)


@router.post(
    "/demo",
    response_model=Me,
    summary="Вход в демо-аккаунт без пароля",
    description="Для экспертизы: одной кнопкой войти пользователем или администратором. "
    "На открытом сервере выключается настройкой DEMO_LOGIN=false, тогда отвечает 404.",
    responses={404: {"description": "Вход без пароля выключен на этом сервере"}},
)
def demo(response: Response, session: SessionDep, body: DemoLogin | None = None) -> Me:
    if not settings.demo_login:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Вход без пароля выключен, войдите по почте и паролю")
    role = Role(body.role) if body else Role.user
    return start_session(response, service.demo_account(session, role))


@router.patch(
    "/me",
    response_model=Me,
    summary="Имя и компания в профиле",
    responses={401: {"description": "Не вошли"}, **DEMO_SHARED},
)
def update_profile(body: ProfileUpdate, session: SessionDep, user: UserDep) -> Me:
    _not_demo(user)
    return _me(service.update_profile(session, user, body.name, body.company))


@router.post(
    "/me/password",
    response_model=Me,
    summary="Сменить пароль",
    description="Нужен текущий пароль. Вход на этом компьютере остается, на остальных сбрасывается.",
    responses={
        401: {"description": "Не вошли или текущий пароль неверный"},
        **DEMO_SHARED,
        429: {"description": "Слишком много неверных паролей, нужно подождать"},
    },
)
def change_password(body: PasswordChange, response: Response, session: SessionDep, user: UserDep) -> Me:
    _not_demo(user)
    _check_password(user, body.password, "password")
    service.change_password(session, user, body.new_password)
    # Старые cookie с прежним паролем больше не действуют, здесь выдаем новую
    return start_session(response, user)


@router.post(
    "/me/email",
    response_model=Me,
    summary="Сменить почту для входа",
    description="Нужен текущий пароль. Дальше входить по новой почте.",
    responses={
        401: {"description": "Не вошли или пароль неверный"},
        **DEMO_SHARED,
        409: {"description": "Эта почта уже у другого аккаунта"},
        429: {"description": "Слишком много неверных паролей, нужно подождать"},
    },
)
def change_email(body: EmailChange, session: SessionDep, user: UserDep) -> Me:
    _not_demo(user)
    _check_password(user, body.password, "email")
    try:
        return _me(service.change_email(session, user, body.email))
    except service.EmailTaken as error:
        raise HTTPException(status.HTTP_409_CONFLICT, "Эта почта уже занята другим аккаунтом") from error


@router.delete(
    "/me",
    response_model=Me,
    summary="Удалить свой аккаунт",
    description="Удаляет почту, пароль и все проекты с файлами без возможности восстановить. "
    "Нужно еще раз ввести пароль, чтобы аккаунт не удалили с чужого незапертого компьютера.",
    responses={
        401: {"description": "Не вошли или пароль неверный"},
        403: {"description": "Демо-аккаунт общий, его не удалить"},
        429: {"description": "Слишком много неверных паролей, нужно подождать"},
    },
)
def delete_me(
    body: PasswordConfirm, response: Response, session: SessionDep, user: Annotated[User, Depends(require_user)]
) -> Me:
    # Демо открыт всем одной кнопкой, пароль у него известный: удалив его, гость стер бы чужие проекты
    if _is_demo(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Демо-аккаунт общий для всех, удалить его нельзя")
    key = f"delete:{user.email}"
    wait = throttle.seconds_to_wait(key)
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Слишком много неверных паролей, попробуйте через 15 минут",
            headers={"Retry-After": str(wait)},
        )
    if not verify_password(body.password, user.password_hash):
        throttle.record_failure(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный пароль")
    service.delete_account(session, user)
    return logout(response)


@router.post("/logout", response_model=Me, summary="Выход")
def logout(response: Response) -> Me:
    response.delete_cookie(COOKIE_NAME, httponly=True, samesite="lax", secure=settings.cookie_secure)
    return Me(role="guest")
