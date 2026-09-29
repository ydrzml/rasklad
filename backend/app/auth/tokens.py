import hashlib
import hmac
import secrets
import tempfile
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path

import jwt

from app.settings import settings

ALGORITHM = "HS256"

# Куда кладем придуманный ключ, если его не задали. Файл переживает перезапуск сервера при разработке,
# поэтому вход не слетает после каждой правки кода. Пересоздали контейнер - все просто войдут заново
GENERATED_SECRET_FILE = Path(tempfile.gettempdir()) / "unicorn-session-secret"


@cache
def signing_key() -> str:
    """Ключ подписи сессии. Ключа по умолчанию в коде нет: известный всем ключ позволил бы подделать вход."""
    if settings.session_secret:
        return settings.session_secret
    if GENERATED_SECRET_FILE.exists():
        return GENERATED_SECRET_FILE.read_text(encoding="utf-8").strip()
    key = secrets.token_urlsafe(48)
    GENERATED_SECRET_FILE.write_text(key, encoding="utf-8")
    GENERATED_SECRET_FILE.chmod(0o600)
    return key


def password_stamp(password_hash: str) -> str:
    """Отпечаток пароля в токене. Сменили пароль - отпечаток другой, и все старые входы на других
    компьютерах перестают работать. По отпечатку пароль не узнать: он считается с ключом подписи."""
    return hmac.new(signing_key().encode(), password_hash.encode(), hashlib.sha256).hexdigest()[:16]


def issue_token(user_id: int, password_hash: str) -> str:
    expires = datetime.now(UTC) + timedelta(days=settings.session_days)
    payload = {"sub": str(user_id), "pwd": password_stamp(password_hash), "exp": expires}
    return jwt.encode(payload, signing_key(), algorithm=ALGORITHM)


def read_token(token: str) -> tuple[int, str] | None:
    """Номер пользователя и отпечаток пароля из токена или None, если токен подделан или просрочен."""
    try:
        payload = jwt.decode(token, signing_key(), algorithms=[ALGORITHM])
        return int(payload["sub"]), str(payload["pwd"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        return None
