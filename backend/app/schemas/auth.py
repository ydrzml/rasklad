from typing import Literal

from email_validator import EmailNotValidError, validate_email
from pydantic import BaseModel, Field, field_validator
from pydantic_core import PydanticCustomError


def _checked_email(value: str) -> str:
    try:
        return validate_email(value, check_deliverability=False).normalized
    except EmailNotValidError as error:
        raise PydanticCustomError("email", "Почта записана с ошибкой, проверьте ее") from error


def _checked_password(value: str) -> str:
    if len(value) < 8:
        raise PydanticCustomError("password_short", "Пароль нужен не короче 8 символов")
    if len(value) > 128:
        raise PydanticCustomError("password_long", "Пароль нужен не длиннее 128 символов")
    return value


# Самые частые пароли из открытых утечек длиной от 8 символов: их подбирают первыми
COMMON_PASSWORDS = {
    "password",
    "password1",
    "password123",
    "qwerty123",
    "qwertyuiop",
    "qwerty12345",
    "1q2w3e4r",
    "1q2w3e4r5t",
    "iloveyou",
    "sunshine",
    "princess",
    "football",
    "baseball",
    "welcome1",
    "admin123",
    "administrator",
    "abc12345",
    "abcd1234",
    "aa123456",
    "zaq12wsx",
    "asdfghjkl",
    "11111111",
    "qazwsxedc",
    "passw0rd",
    "letmein1",
    "trustno1",
    "1qaz2wsx",
    "q1w2e3r4",
    "q1w2e3r4t5",
    "йцукенгш",
    "пароль123",
}


def _checked_new_password(value: str) -> str:
    """Новый пароль при регистрации и смене. На входе не проверяем: старый пароль должен пускать."""
    value = _checked_password(value)
    if value.isdigit():
        raise PydanticCustomError("password_digits", "Пароль из одних цифр подбирается быстро, добавьте буквы")
    if value.lower() in COMMON_PASSWORDS or len(set(value)) < 4:
        raise PydanticCustomError("password_common", "Такой пароль подбирают первым, придумайте другой")
    return value


# Проверки свои, а не из pydantic: его сообщения английские, а форма входа показывает их человеку
class Credentials(BaseModel):
    email: str = Field(examples=["ivan@example.com"], description="Почта")
    password: str = Field(description="Не короче 8 и не длиннее 128 символов")

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        return _checked_email(value)

    @field_validator("password")
    @classmethod
    def _password(cls, value: str) -> str:
        return _checked_password(value)


class Registration(Credentials):
    @field_validator("password")
    @classmethod
    def _new_password(cls, value: str) -> str:
        return _checked_new_password(value)


class PasswordConfirm(BaseModel):
    password: str = Field(max_length=128, description="Текущий пароль, чтобы подтвердить действие")


class ProfileUpdate(BaseModel):
    """Имя и компания. Пустая строка стирает значение."""

    name: str = Field("", max_length=120, examples=["Иван Петров"])
    company: str = Field("", max_length=200, examples=["ООО Склад-Сервис"])


class PasswordChange(BaseModel):
    password: str = Field(max_length=128, description="Текущий пароль")
    new_password: str = Field(description="Новый пароль, не короче 8 и не длиннее 128 символов")

    @field_validator("new_password")
    @classmethod
    def _new_password(cls, value: str) -> str:
        return _checked_new_password(value)


class EmailChange(BaseModel):
    email: str = Field(examples=["ivan@example.com"], description="Новая почта для входа")
    password: str = Field(max_length=128, description="Текущий пароль, чтобы подтвердить")

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        return _checked_email(value)


class DemoLogin(BaseModel):
    role: Literal["user", "admin"] = "user"


class DemoStatus(BaseModel):
    enabled: bool = Field(description="Работает ли вход в демо-аккаунты без пароля. На открытом стенде выключен")


class Me(BaseModel):
    """Кто сейчас работает с сервисом. Гость тоже получает ответ, просто без почты."""

    role: Literal["guest", "user", "admin"]
    email: str | None = None
    name: str = Field(default="", description="Как человек себя назвал в профиле")
    company: str = ""
    demo: bool = Field(default=False, description="Общий демо-аккаунт: удалить его нельзя")
