"""Ошибки, которые сервер отдает человеку, и общий обработчик для них.

Если каждый адрес ловит KeyError сам и отвечает 404 "Не найдено", опечатка в ключе конфига
или ошибка в формуле тоже выглядит как "не найдено", и в логе ее нет. Поэтому "не найдено"
это только NotFound, который сервисы бросают, когда не нашли то, что попросил человек. Все
остальное падает в общий обработчик: 500 с понятным текстом и запись в лог с трассировкой.
"""

import logging
import re

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = logging.getLogger("app")
# uvicorn настраивает только свои журналы. Без своего вывода ошибка ушла бы в запасной
# вывод Python без времени, а в журнале контейнера нужно видеть, когда она случилась
if not log.handlers:
    _out = logging.StreamHandler()
    _out.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(_out)
    log.setLevel(logging.INFO)

SERVER_FAILED = (
    "На сервере что-то сломалось, мы записали ошибку и разберемся. Введенное не потерялось: повторите через минуту"
)


class NotFound(LookupError):
    """Человек попросил то, чего у нас нет: объект, задачу, решение, шаблон плана.

    Не KeyError: у него текст приходит в кавычках, и его же бросает любая опечатка в коде.
    """


# Тексты проверки полей по-русски. Pydantic пишет "Input should be greater than 0",
# а ТЗ просит говорить понятным языком и со способом исправления (п. 4.5.4)
FIELD_ERRORS = {
    "missing": "нужно заполнить",
    "greater_than": "должно быть больше {gt}",
    "greater_than_equal": "должно быть не меньше {ge}",
    "less_than": "должно быть меньше {lt}",
    "less_than_equal": "должно быть не больше {le}",
    "int_parsing": "нужно целое число",
    "int_from_float": "нужно целое число",
    "float_parsing": "нужно число",
    "finite_number": "нужно обычное число",
    "bool_parsing": "нужно да или нет",
    "string_too_short": "слишком короткое, нужно хотя бы {min_length} символов",
    "string_too_long": "слишком длинное, не больше {max_length} символов",
    "too_short": "слишком мало значений, нужно хотя бы {min_length}",
    "too_long": "слишком много значений, не больше {max_length}",
    "literal_error": "можно только {expected}",
    "enum": "можно только {expected}",
    "json_invalid": "запрос не читается как JSON",
    "model_attributes_type": "нужен объект с полями",
    "dict_type": "нужен объект с полями",
    "list_type": "нужен список",
    "string_type": "нужен текст",
}


def field_message(error: dict, plan_body: bool = False) -> str:
    """Одно сообщение о поле. Свое, по-русски, как в форме входа, оставляем как есть,
    английское от pydantic заменяем по типу ошибки и называем поле. plan_body: тело запроса
    это сам план, как у замера плана на шаге плана."""
    own = str(error.get("msg", "")).removeprefix("Value error, ")
    if re.search("[а-яА-Я]", own):
        return own
    template = FIELD_ERRORS.get(error.get("type", ""), "неверное значение")
    try:
        text = template.format(**(error.get("ctx") or {}))
    except (KeyError, IndexError):
        text = template
    loc = tuple(error.get("loc", ()))
    return _plan_field(loc, text, plan_body) or f"{_field(loc)}: {text}"


# Поля объекта на плане так, как их видит человек в окне справа от чертежа
PLAN_ITEM_FIELDS = {
    "block_rows": "рядов вплотную",
    "tiers": "ярусов",
    "tier_m": "шаг яруса",
    "aisle_m": "проезд между рядами",
    "row_m": "толщина ряда",
    "x": "место на листе",
    "y": "место на листе",
    "w": "размер",
    "h": "размер",
}


def _plan_field(loc: tuple, text: str, plan_body: bool = False) -> str:
    """Ошибка в плане: "plan.items.11.block_rows" человеку ничего не скажет, а план правят на шаге
    плана. Поэтому называем объект и поле словами из окна чертежа и говорим, где поправить. Текст
    начинается с "План": по нему шаг экономики ведет кнопкой на шаг плана (frontend/src/app/flow.ts)."""
    parts = [part for part in loc if part not in ("body", "query", "path")]
    if plan_body and "body" in loc:
        parts = ["plan", *parts]
    if not parts or parts[0] != "plan":
        return ""
    if len(parts) >= 4 and parts[1] == "items" and isinstance(parts[2], int):
        name = PLAN_ITEM_FIELDS.get(str(parts[3]), str(parts[3]))
        return f"План не принят: объект {parts[2] + 1} на чертеже, {name}: {text}. Поправьте его на шаге плана"
    if len(parts) >= 2 and parts[1] == "items":
        return f"План не принят: объектов на чертеже {text}. Уберите лишние на шаге плана"
    where = ".".join(str(part) for part in parts[1:]) or "план"
    return f"План не принят: {where}: {text}. Поправьте его на шаге плана"


def _field(loc: tuple) -> str:
    # ("body", "overrides", "x") -> "overrides.x": body и query человеку ничего не говорят
    parts = [str(part) for part in loc if part not in ("body", "query", "path")]
    return ".".join(parts) or "запрос"


def install(app: FastAPI) -> None:
    # расчет сам бросает NotFound через движок, поэтому его ошибки берем здесь, а не наверху файла
    from app.engine.plan import TooBig
    from app.services import projects
    from app.services.calculation import Impossible, UnknownPath

    @app.exception_handler(NotFound)
    def not_found(_: Request, error: NotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(error)})

    # Пока человек вводит числа, параметры бывают временно невозможны: 5 смен по 11 ч.
    # Любой адрес отвечает на это понятным отказом, а не ошибкой сервера
    @app.exception_handler(Impossible)
    def impossible(_: Request, error: Impossible) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(error)})

    # Потолок проектов, папок, сохранений или файлов у одного человека: понятная строка, что сделать
    @app.exception_handler(projects.LimitReached)
    def limit_reached(_: Request, error: projects.LimitReached) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(error)})

    # Здание длиннее километра: план не строим и говорим, что проверить
    @app.exception_handler(TooBig)
    def too_big(_: Request, error: TooBig) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(error)})

    @app.exception_handler(UnknownPath)
    def unknown_path(_: Request, error: UnknownPath) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": f"В модели нет значения {error}"})

    # Формат списка тот же, что у FastAPI: loc и msg у каждого поля, фронт его уже читает.
    # Того, что ввели, в ответе нет: иначе пароль вернулся бы в ответе и мог осесть в журналах
    @app.exception_handler(RequestValidationError)
    def invalid(request: Request, error: RequestValidationError) -> JSONResponse:
        plan_body = request.url.path == "/api/plan/measure"
        detail = [{"loc": list(item.get("loc", ())), "msg": field_message(item, plan_body)} for item in error.errors()]
        return JSONResponse(status_code=422, content={"detail": detail})

    @app.exception_handler(Exception)
    def failed(request: Request, error: Exception) -> JSONResponse:
        log.error("Ошибка на %s %s", request.method, request.url.path, exc_info=error)
        return JSONResponse(status_code=500, content={"detail": SERVER_FAILED})
