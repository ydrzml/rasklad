"""Очередь тяжелых расчетов: ответ на нажатие человека первым, досчеты шага 5 после него.

Сервер один процесс, расчеты идут на чистом Python и делят одно ядро. Шаг 5 сразу после ответа
расчета шлет еще четыре тяжелых запроса: покупку в кредит и в лизинг для строки способов оплаты,
"Что будет, если", готовность склада и смену на плане. Щелчок "Кредит" в это время вставал пятым
в общую кучу и шел впятеро медленнее, 20-70 секунд вместо трех. Досчеты, которые страница уже
отменила, сервер при этом все равно считал до конца.

Поэтому основной расчет идет сразу, а досчеты по одному и только когда основного нет. Пока досчет
ждет очереди, проверяем, нужен ли он еще: страница отменяет запрос, когда цифры поменялись, и такой
досчет снимаем, не начав (docs/decisions.md, "Шаг 5 отвечает быстро")."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from fastapi import Request, Response
from starlette.concurrency import run_in_threadpool

# Заголовок, которым страница помечает досчет. Основной расчет и прямой вызов API идут без него
BACKGROUND_HEADER = "x-priority"
BACKGROUND = "background"
# как часто досчет в очереди смотрит, не освободилось ли место и нужен ли он еще, секунды
POLL_S = 0.05
# Ответ на запрос, который страница уже отменила: так его зовет nginx, тела нет, читать его некому
GONE = 499

_foreground = 0
# идет ли досчет. Флаг, а не замок: ждем мы опросом, а все проверки и смены идут в одном цикле событий
_busy = False


def is_background(request: Request) -> bool:
    return request.headers.get(BACKGROUND_HEADER, "").lower() == BACKGROUND


async def foreground[T](work: Callable[..., T], *args) -> T:
    """Ответ на нажатие: считаем сразу, а досчеты, что ждут очереди, пока не начинаются."""
    global _foreground
    _foreground += 1
    try:
        return await run_in_threadpool(work, *args)
    finally:
        _foreground -= 1


async def background[T](request: Request, work: Callable[..., T], *args) -> T | Response:
    """Досчет: по одному и после основного расчета. Если страница его отменила, пока он ждал, не считаем."""
    global _busy
    while True:
        if await request.is_disconnected():
            return Response(status_code=GONE)
        # проверка и захват без ожидания между ними: в одном цикле событий их никто не разорвет
        if _foreground == 0 and not _busy:
            break
        await asyncio.sleep(POLL_S)
    _busy = True
    try:
        return await run_in_threadpool(work, *args)
    finally:
        _busy = False


async def by_header[T](request: Request, work: Callable[..., T], *args) -> T | Response:
    """Расчет, который страница зовет и по нажатию, и досчетом: очередь по заголовку."""
    if is_background(request):
        return await background(request, work, *args)
    return await foreground(work, *args)
