from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()

# Хеш заведомо чужого пароля: сверяем с ним, когда почты нет в базе,
# чтобы по времени ответа нельзя было понять, зарегистрирован ли адрес
_UNKNOWN_USER_HASH = _hasher.hash("unknown-user")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        _hasher.verify(password_hash or _UNKNOWN_USER_HASH, password)
    except (VerificationError, InvalidHashError):
        return False
    return password_hash is not None
