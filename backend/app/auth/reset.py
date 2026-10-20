"""Ссылка на новый пароль из письма.

Токен в ссылке подписан своим ключом, производным от ключа сессии: поэтому токен из письма нельзя
подложить вместо cookie входа, а cookie входа нельзя выдать за ссылку из письма.
В токене отпечаток нынешнего пароля, как и в сессии: как только пароль сменили, ссылка перестает
работать. Так она одноразовая без отдельной таблицы, и все прежние ссылки гаснут вместе с ней."""

import hashlib
import hmac
from datetime import UTC, datetime, timedelta

import jwt

from app.auth.tokens import ALGORITHM, password_stamp, signing_key
from app.settings import settings


def _reset_key() -> str:
    return hmac.new(signing_key().encode(), b"password-reset", hashlib.sha256).hexdigest()


def issue_reset_token(user_id: int, password_hash: str, now: datetime | None = None) -> str:
    expires = (now or datetime.now(UTC)) + timedelta(minutes=settings.reset_minutes)
    payload = {"sub": str(user_id), "pwd": password_stamp(password_hash), "exp": expires}
    return jwt.encode(payload, _reset_key(), algorithm=ALGORITHM)


def read_reset_token(token: str) -> tuple[int, str] | None:
    """Номер пользователя и отпечаток пароля или None, если ссылка подделана или устарела."""
    try:
        payload = jwt.decode(token, _reset_key(), algorithms=[ALGORITHM])
        return int(payload["sub"]), str(payload["pwd"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        return None


def reset_link(token: str) -> str:
    # Токен после #: эта часть адреса не уходит на сервер, поэтому не попадает в журналы nginx
    return f"{settings.site_url.rstrip('/')}/login/reset#{token}"
