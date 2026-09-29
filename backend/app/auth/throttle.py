"""Защита от подбора пароля: после нескольких неудачных попыток на одну почту просим подождать.

Считаем в памяти сервера: он у нас один, а после перезапуска начать счет заново не страшно.
Считаем по почте, а не по адресу посетителя: за nginx все запросы приходят с одного адреса."""

import time
from collections import defaultdict

MAX_FAILURES = 10
WINDOW_SECONDS = 15 * 60

_failures: dict[str, list[float]] = defaultdict(list)


def seconds_to_wait(email: str, now: float | None = None) -> int:
    """Сколько секунд ждать до следующей попытки, 0 - можно пробовать."""
    now = time.monotonic() if now is None else now
    recent = [moment for moment in _failures.get(email, []) if now - moment < WINDOW_SECONDS]
    if recent:
        _failures[email] = recent
    else:
        _failures.pop(email, None)
    if len(recent) < MAX_FAILURES:
        return 0
    return int(WINDOW_SECONDS - (now - recent[0])) + 1


def record_failure(email: str, now: float | None = None) -> None:
    _failures[email].append(time.monotonic() if now is None else now)


def forget(email: str) -> None:
    """Удачный вход обнуляет счет."""
    _failures.pop(email, None)


def clear() -> None:
    _failures.clear()
