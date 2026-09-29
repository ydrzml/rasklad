"""Служебные таблицы для администратора на SQLAdmin: пользователи и роли, журнал правок каталога.
Главный экран админки, каталог решений, сделан в нашем интерфейсе на /admin. Здесь каталог только
для просмотра: правка в обход нашего экрана не попала бы в журнал (журнал решений, «Админка
смешанная: каталог свой, служебные таблицы на SQLAdmin»).

Входа своего у SQLAdmin нет: пускаем по той же cookie, что и весь сервис, и только администратора.
Оформление свое поверх стилей SQLAdmin (журнал решений, «Служебные таблицы открываются каталогом, в наших цветах»):
шаблон и стили в admin_look, шрифт Onest берем из frontend/src/assets/fonts."""

from datetime import UTC, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from sqladmin import Admin, ModelView
from sqladmin.authentication import AuthenticationBackend, login_required
from sqladmin.i18n import I18nConfig
from starlette.requests import Request
from starlette.responses import RedirectResponse, Response
from starlette.staticfiles import StaticFiles

from app.auth.dependencies import COOKIE_NAME, user_by_token
from app.auth.tokens import signing_key
from app.db import SessionLocal, engine
from app.storage.models import CatalogChange, NormChange, Role, Solution, User

BASE_URL = "/api/db"
LOOK = Path(__file__).parent / "admin_look"
# В образе сервера шрифты лежат по тому же пути от корня проекта, их кладет туда Dockerfile
FONTS = Path(__file__).parents[2] / "frontend" / "src" / "assets" / "fonts"

ACTIONS = {
    "seed": "первый запуск",
    "import": "загрузил выгрузку",
    "create": "добавил решение",
    "update": "поправил решение",
    "reset": "вернул значение организатора",
    "delete": "удалил решение",
    "spec_add": "добавил характеристику",
    "spec_edit": "поправил характеристику",
    "spec_delete": "удалил характеристику",
    "photo_set": "загрузил фото",
    "photo_edit": "поправил источник фото",
    "photo_delete": "удалил фото",
    "photo_seed": "фото из data/",
    "uses_seed": "объекты и операции из data/",
    "updates_check": "проверка страниц производителей",
    "file_edit": "наши колонки из загруженного файла",
    "update_accept": "принято обновление с сайта производителя",
    "update_reject": "отклонено обновление с сайта производителя",
    "use_set": "поправил объект и операцию",
}

ORIGINS = {"organizer": "выгрузка организатора", "team": "команда"}


# Москва без перехода на летнее время, поэтому хватает постоянного сдвига и не нужна база часовых поясов
MOSCOW = timezone(timedelta(hours=3))


def _when(model: Any, attribute: str) -> str:
    value = getattr(model, attribute)
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(MOSCOW).strftime("%d.%m.%Y %H:%M мск")


class SameCookie(AuthenticationBackend):
    async def login(self, request: Request) -> Response | bool:
        return RedirectResponse("/login")

    async def logout(self, request: Request) -> Response | bool:
        return RedirectResponse("/projects")

    async def authenticate(self, request: Request) -> Response | bool:
        with SessionLocal() as session:
            user = user_by_token(session, request.cookies.get(COOKIE_NAME))
            if user is None:
                return RedirectResponse("/login")
            if user.role != Role.admin:
                return Response("Доступно только администратору", status_code=403, media_type="text/plain")
        return True


class UserView(ModelView, model=User):
    name = "Пользователь"
    name_plural = "Пользователи"
    icon = "fa-solid fa-user"
    column_list = [User.id, User.email, User.role, User.created_at]
    column_labels = {User.email: "Почта", User.role: "Роль", User.created_at: "Зарегистрирован"}
    column_searchable_list = [User.email]
    column_sortable_list = [User.email, User.created_at]
    column_formatters: dict[Any, Any] = {
        User.created_at: _when,
        User.role: lambda model, _: "администратор" if model.role == "admin" else "пользователь",
    }
    # Пароль не показываем и не правим: здесь можно только сменить роль
    form_columns = [User.role]
    form_choices: dict[str, Any] = {"role": [("user", "пользователь"), ("admin", "администратор")]}
    can_create = False
    # Удалить человека здесь нельзя: удаление мимо нашей проверки стерло бы и общий демо-аккаунт, а на стенде
    # администратор общий для экспертов. Аккаунт удаляет сам человек в профиле, с паролем
    can_delete = False
    column_details_exclude_list = [User.password_hash]


class ChangeView(ModelView, model=CatalogChange):
    name = "Правка каталога"
    name_plural = "Журнал правок каталога"
    icon = "fa-solid fa-clock-rotate-left"
    column_list = [
        CatalogChange.at,
        CatalogChange.user_email,
        CatalogChange.action,
        CatalogChange.solution_name,
        CatalogChange.note,
    ]
    column_labels = {
        CatalogChange.at: "Когда",
        CatalogChange.user_email: "Кто",
        CatalogChange.action: "Что сделал",
        CatalogChange.solution_name: "Решение",
        CatalogChange.note: "Пояснение",
        CatalogChange.changes: "Было и стало",
    }
    column_formatters: dict[Any, Any] = {
        CatalogChange.at: _when,
        CatalogChange.action: lambda model, _: ACTIONS.get(model.action, model.action),
        CatalogChange.user_email: lambda model, _: model.user_email or "система",
    }
    column_formatters_detail = column_formatters
    column_default_sort = [(CatalogChange.at, True)]
    column_searchable_list = [CatalogChange.solution_name, CatalogChange.user_email]
    can_create = False
    can_edit = False
    can_delete = False


NORM_ACTIONS = {"edit": "поправил норматив", "reset": "вернул значение из файла", "import": "загрузил из файла"}


class NormChangeView(ModelView, model=NormChange):
    name = "Правка норматива"
    name_plural = "Журнал правок нормативов"
    icon = "fa-solid fa-scale-balanced"
    column_list = [NormChange.at, NormChange.user_email, NormChange.action, NormChange.name, NormChange.note]
    column_labels = {
        NormChange.at: "Когда",
        NormChange.user_email: "Кто",
        NormChange.action: "Что сделал",
        NormChange.name: "Норматив",
        NormChange.path: "Код",
        NormChange.note: "Пояснение",
        NormChange.changes: "Было и стало",
    }
    column_formatters: dict[Any, Any] = {
        NormChange.at: _when,
        NormChange.action: lambda model, _: NORM_ACTIONS.get(model.action, model.action),
        NormChange.user_email: lambda model, _: model.user_email or "система",
    }
    column_formatters_detail = column_formatters
    column_default_sort = [(NormChange.at, True)]
    column_searchable_list = [NormChange.name, NormChange.path, NormChange.user_email]
    can_create = False
    can_edit = False
    can_delete = False


class SolutionView(ModelView, model=Solution):
    name = "Решение"
    name_plural = "Каталог (только просмотр)"
    icon = "fa-solid fa-robot"
    column_list = [Solution.name, Solution.company, Solution.kind, Solution.status, Solution.price_rub, Solution.origin]
    column_labels = {
        Solution.name: "Название",
        Solution.company: "Компания",
        Solution.kind: "Тип",
        Solution.status: "Статус",
        Solution.price_rub: "Цена, руб.",
        Solution.origin: "Откуда",
    }
    column_formatters: dict[Any, Any] = {
        Solution.origin: lambda model, _: ORIGINS.get(model.origin, model.origin),
    }
    column_formatters_detail = column_formatters
    column_searchable_list = [Solution.name, Solution.company]
    can_create = False
    can_edit = False
    can_delete = False


class Tables(Admin):
    # Главная SQLAdmin пустая, только меню слева. Сразу открываем каталог: за ним сюда и приходят
    @login_required
    async def index(self, request: Request) -> Response:
        return RedirectResponse(f"{BASE_URL}/{SolutionView.identity}/list", status_code=302)


def mount(app: FastAPI) -> Admin:
    admin = Tables(
        app,
        engine,
        base_url=BASE_URL,
        title="Служебные таблицы",
        # Своей сессией SQLAdmin не пользуется, но ключ ей нужен настоящий: пустой ключ подписи подделывается
        authentication_backend=SameCookie(secret_key=signing_key()),
        i18n_config=I18nConfig(default_locale="ru", language_header_name=None),
        templates_dir=str(LOOK),
    )
    admin.admin.mount("/look", StaticFiles(directory=LOOK / "static"), name="look")
    admin.admin.mount("/fonts", StaticFiles(directory=FONTS, check_dir=False), name="fonts")
    for view in (SolutionView, UserView, ChangeView, NormChangeView):
        admin.add_view(view)
    return admin
