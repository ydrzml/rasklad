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
    # demo_login включает вход в них без пароля запросом POST /api/auth/demo. Кнопок на экране нет,
    # поэтому по умолчанию выключен: иначе любой запуск пускал бы администратором без пароля
    demo_login: bool = False
    demo_user_email: str = "demo@example.com"
    demo_user_password: str = "demo12345"
    demo_admin_email: str = "admin@example.com"
    demo_admin_password: str = "admin12345"

    # Почта для писем со ссылкой на новый пароль (app/services/mail.py). Без smtp_host письма не уходят:
    # ссылку видно в служебной таблице "Письма без отправки", администратор передает ее сам
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = ""
    # От кого письмо. Пусто - от smtp_user: Яндекс и Mail.ru отправляют только от имени своего ящика
    mail_from: str = ""
    # Адрес сайта для ссылки в письме. Берем из настроек, а не из запроса: заголовок Host подделывается,
    # и письмо с настоящего ящика повело бы на чужой сайт
    site_url: str = "http://localhost:3000"
    reset_minutes: int = 30


settings = Settings()
