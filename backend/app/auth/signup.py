"""Регистрация с кодом из письма. Включается, когда на сервере настроена почта (SMTP_HOST):
без почты код не дошел бы, и зарегистрироваться не смог бы никто.

Человек вводит почту и пароль, мы запоминаем заявку и шлем 6 цифр. Аккаунт появляется, только когда
он введет код: так в базе нет аккаунтов на чужие и несуществующие почты. Код живет 15 минут,
после 5 неверных попыток заявка удаляется и нужен новый код."""

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.passwords import hash_password
from app.auth.service import EmailTaken, find_by_email, normalize
from app.auth.tokens import signing_key
from app.storage.models import PendingSignup, Role, User

CODE_MINUTES = 15
CODE_DIGITS = 6
MAX_ATTEMPTS = 5


class CodeExpired(Exception):
    """Заявки нет, она устарела или по ней слишком много раз ошиблись."""


class WrongCode(Exception):
    pass


def _code_hash(email: str, code: str) -> str:
    # Отпечаток с ключом подписи: по строке в базе 6 цифр не перебрать без ключа
    return hmac.new(signing_key().encode(), f"{email}:{code}".encode(), hashlib.sha256).hexdigest()


def _aware(moment: datetime) -> datetime:
    # SQLite в тестах возвращает время без пояса, Postgres с поясом
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def start(session: Session, email: str, password: str, now: datetime | None = None) -> str:
    """Новая заявка или новый код к прежней. Возвращает код, чтобы отправить его письмом."""
    email = normalize(email)
    if find_by_email(session, email):
        raise EmailTaken(email)
    code = f"{secrets.randbelow(10**CODE_DIGITS):0{CODE_DIGITS}d}"
    pending = session.scalar(select(PendingSignup).where(PendingSignup.email == email))
    if pending is None:
        pending = PendingSignup(email=email)
        session.add(pending)
    pending.password_hash = hash_password(password)
    pending.code_hash = _code_hash(email, code)
    pending.expires_at = (now or datetime.now(UTC)) + timedelta(minutes=CODE_MINUTES)
    pending.attempts = 0
    session.commit()
    return code


def confirm(session: Session, email: str, code: str, now: datetime | None = None) -> User:
    email = normalize(email)
    pending = session.scalar(select(PendingSignup).where(PendingSignup.email == email))
    if pending is None:
        raise CodeExpired(email)
    if _aware(pending.expires_at) < (now or datetime.now(UTC)) or pending.attempts >= MAX_ATTEMPTS:
        session.delete(pending)
        session.commit()
        raise CodeExpired(email)
    if not hmac.compare_digest(pending.code_hash, _code_hash(email, code.strip())):
        pending.attempts += 1
        session.commit()
        raise WrongCode(email)
    if find_by_email(session, email):
        session.delete(pending)
        session.commit()
        raise EmailTaken(email)
    user = User(email=email, password_hash=pending.password_hash, role=Role.user)
    session.add(user)
    session.delete(pending)
    session.commit()
    return user
