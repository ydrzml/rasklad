"""Память на несколько последних ответов тяжелых расчетов, общая для всех запросов сервера.

Шаг 5 шлет почти разом основной расчет, способы оплаты, "Что будет, если", готовность и смену на
плане. Все они заново мерили тот же план и собирали ту же схему склада, а одинаковые запросы
считались дважды. Память по ключу входа отдает готовое, а одинаковый запрос, пока первый еще
считается, ждет его ответа, а не считает второй раз рядом (docs/decisions.md, "Шаг 5 отвечает быстро")."""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable


class Memo[T]:
    def __init__(self, limit: int):
        self.limit = limit
        self._values: OrderedDict[Hashable, T] = OrderedDict()
        self._busy: dict[Hashable, threading.Lock] = {}
        self._lock = threading.Lock()

    def get(self, key: Hashable, compute: Callable[[], T]) -> T:
        with self._lock:
            if key in self._values:
                self._values.move_to_end(key)
                return self._values[key]
            busy = self._busy.setdefault(key, threading.Lock())
        with busy:
            with self._lock:
                if key in self._values:
                    return self._values[key]
            try:
                value = compute()
            finally:
                with self._lock:
                    self._busy.pop(key, None)
            with self._lock:
                self._values[key] = value
                while len(self._values) > self.limit:
                    self._values.popitem(last=False)
            return value

    def clear(self) -> None:
        with self._lock:
            self._values.clear()
