from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Настройки берутся из переменных окружения, значения по умолчанию подходят для локального запуска."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://unicorn:unicorn@localhost:5432/unicorn"
    config_dir: Path = REPO_ROOT / "config"
    data_dir: Path = REPO_ROOT / "data"

    # Вход. Если ключ не задан, сервер придумывает случайный сам (см. app/auth/tokens.py)
    session_secret: str = ""
    session_days: int = 7
    cookie_secure: bool = False

    # Демо-аккаунты создаются при запуске, чтобы проект можно было посмотреть без регистрации.
    # demo_login включает вход в них без пароля одной кнопкой. На открытом сервере выключаем
    demo_login: bool = True
    demo_user_email: str = "demo@example.com"
    demo_user_password: str = "demo12345"
    demo_admin_email: str = "admin@example.com"
    demo_admin_password: str = "admin12345"


settings = Settings()
