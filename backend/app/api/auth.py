import hmac
import smtplib
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.auth import service, signup, throttle
from app.auth.dependencies import COOKIE_NAME, current_user, require_user
from app.auth.passwords import verify_password
from app.auth.reset import issue_reset_token, read_reset_token, reset_link
from app.auth.tokens import issue_token, password_stamp
from app.db import get_session
from app.schemas.auth import (
    CodeSent,
    Credentials,
    DemoLogin,
    DemoStatus,
    EmailChange,
    Me,
    PasswordChange,
    PasswordConfirm,
    PasswordReset,
    ProfileUpdate,
    Registration,
    ResetRequest,
    ResetSent,
    SignupConfirm,
)
from app.services import mail
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


EMAIL_TAKEN = "Эта почта уже зарегистрирована, войдите"
# Писем со всего сервера за 15 минут: регистрация и "Забыли пароль" вместе. Через нас нельзя завалить
# письмами чужие ящики, и почтовый сервис не заблокирует наш ящик за рассылку. Тест с людьми в одной
# комнате укладывается с запасом
LETTERS_PER_WINDOW = 30
LETTERS_KEY = "letters:all"
# Сколько кодов регистрации на одну почту за 15 минут
SIGNUP_CODES = 3


def _letters_left() -> None:
    wait = throttle.seconds_to_wait(LETTERS_KEY, limit=LETTERS_PER_WINDOW)
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Сервис сейчас отправляет слишком много писем, попробуйте через несколько минут",
            headers={"Retry-After": str(wait)},
        )
    throttle.record_failure(LETTERS_KEY)


@router.post(
    "/register",
    response_model=Me | CodeSent,
    status_code=status.HTTP_201_CREATED,
    summary="Регистрация по почте и паролю",
    description="Если на сервере настроена почта, отвечает 202 и шлет на почту код: аккаунт появится после "
    "POST /api/auth/register/confirm. Без почты аккаунт создается сразу, ответ 201 со входом.",
    responses={
        202: {"model": CodeSent, "description": "Код отправлен на почту, ждем его"},
        409: {"description": "Почта уже зарегистрирована"},
        422: {"description": "Почта с ошибкой или у ее домена нет почтового сервера, слабый пароль"},
        429: {"description": "Слишком много кодов на эту почту или писем с сервера"},
        503: {"description": "Письмо с кодом не ушло"},
    },
)
def register(body: Registration, response: Response, session: SessionDep) -> Me | CodeSent:
    if not mail.configured():
        try:
            user = service.register(session, body.email, body.password)
        except service.EmailTaken as error:
            raise HTTPException(status.HTTP_409_CONFLICT, EMAIL_TAKEN) from error
        return start_session(response, user)

    email = service.normalize(body.email)
    if service.find_by_email(session, email):
        raise HTTPException(status.HTTP_409_CONFLICT, EMAIL_TAKEN)
    if not mail.domain_accepts_mail(email):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "На такую почту письма не доходят. Проверьте адрес после @",
        )
    key = f"signup:{email}"
    wait = throttle.seconds_to_wait(key, limit=SIGNUP_CODES)
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Код на эту почту уже отправляли несколько раз. Проверьте папку Спам или попробуйте через 15 минут",
            headers={"Retry-After": str(wait)},
        )
    _letters_left()
    throttle.record_failure(key)
    code = signup.start(session, email, body.password)
    # Шлем сразу, а не в фоне: занята ли почта, регистрация и так говорит, а человеку важно знать,
    # что письмо не ушло, иначе он будет ждать код, которого нет
    try:
        mail.deliver(mail.signup_letter(email, code, signup.CODE_MINUTES))
    except (smtplib.SMTPException, OSError) as error:
        mail.log.error(
            "Письмо с кодом регистрации не ушло: %s %s", type(error).__name__, getattr(error, "smtp_code", "")
        )
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Не получилось отправить письмо. Попробуйте через пару минут"
        ) from error
    response.status_code = status.HTTP_202_ACCEPTED
    return CodeSent(email=email, minutes=signup.CODE_MINUTES)


@router.post(
    "/register/confirm",
    response_model=Me,
    status_code=status.HTTP_201_CREATED,
    summary="Код из письма: аккаунт создан, сразу вход",
    responses={
        400: {"description": "Код неверный, устарел или по нему ошиблись 5 раз"},
        409: {"description": "Почта уже зарегистрирована"},
    },
)
def confirm_registration(body: SignupConfirm, response: Response, session: SessionDep) -> Me:
    try:
        user = signup.confirm(session, body.email, body.code)
    except signup.WrongCode as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Код не подходит, проверьте цифры в письме") from error
    except signup.CodeExpired as error:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Код устарел или введен неверно много раз. Запросите новый"
        ) from error
    except service.EmailTaken as error:
        raise HTTPException(status.HTTP_409_CONFLICT, EMAIL_TAKEN) from error
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


# Сколько писем со ссылкой на одну почту за 15 минут: хватит, если первое ушло в спам,
# но ящик не завалить письмами чужими руками
RESET_LETTERS = 3
BAD_LINK = "Ссылка устарела или по ней уже меняли пароль. Запросите новую на странице входа"


@router.post(
    "/forgot",
    response_model=ResetSent,
    summary="Забыли пароль: прислать на почту ссылку для нового",
    description="Ответ одинаковый, есть такая почта или нет. Письмо уходит в фоне. Если почта на сервере "
    'не настроена (SMTP_HOST пустой), письмо ложится в служебную таблицу "Письма без отправки".',
    responses={429: {"description": "На эту почту уже несколько раз отправляли ссылку, нужно подождать"}},
)
def forgot(body: ResetRequest, background: BackgroundTasks, session: SessionDep) -> ResetSent:
    email = service.normalize(body.email)
    key = f"forgot:{email}"
    wait = throttle.seconds_to_wait(key, limit=RESET_LETTERS)
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Ссылку на эту почту уже отправляли несколько раз. Проверьте папку Спам или попробуйте через 15 минут",
            headers={"Retry-After": str(wait)},
        )
    # Считаем любую почту, а не только зарегистрированную: иначе по лимиту было бы видно, есть ли адрес
    throttle.record_failure(key)
    _letters_left()
    user = service.find_by_email(session, email)
    # Демо-аккаунт общий, его пароль знают все: письмо со сменой пароля ему не шлем
    if user is not None and not _is_demo(user):
        link = reset_link(issue_reset_token(user.id, user.password_hash))
        if mail.configured():
            background.add_task(mail.send_reset, user.email, link)
        else:
            mail.keep_unsent(session, user.email, link)
    return ResetSent(
        detail="Если такая почта зарегистрирована, мы отправили на нее ссылку для нового пароля",
        minutes=settings.reset_minutes,
    )


@router.post(
    "/reset",
    response_model=Me,
    summary="Новый пароль по ссылке из письма, сразу со входом",
    description="Ссылка одноразовая: после смены пароля она и все прежние ссылки перестают работать, "
    "входы на других компьютерах сбрасываются.",
    responses={400: {"description": "Ссылка подделана, устарела или по ней уже меняли пароль"}},
)
def reset(body: PasswordReset, response: Response, session: SessionDep) -> Me:
    found = read_reset_token(body.token)
    user = session.get(User, found[0]) if found else None
    if user is None or not hmac.compare_digest(found[1], password_stamp(user.password_hash)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_LINK)
    service.change_password(session, user, body.new_password)
    # Забыл пароль и мог упереться в лимит неверных входов: новый пароль пускает сразу
    throttle.forget(user.email)
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
    "Включается настройкой DEMO_LOGIN=true, по умолчанию выключен и отвечает 404.",
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
