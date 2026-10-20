"""Шаг 5 отвечает быстро: тяжелое считается один раз, досчеты ждут ответа на нажатие,
отмененный досчет не считается (docs/decisions.md, "Шаг 5 отвечает быстро")."""

import asyncio
import threading
import time

from app.services import priority
from app.services.memo import Memo


class FakeRequest:
    """Запрос с заголовками и признаком, что страница его отменила."""

    def __init__(self, gone: bool = False, background: bool = True):
        self.gone = gone
        self.headers = {priority.BACKGROUND_HEADER: priority.BACKGROUND} if background else {}

    async def is_disconnected(self) -> bool:
        return self.gone


def test_same_key_is_computed_once_even_when_asked_together():
    memo: Memo[int] = Memo(limit=4)
    calls = []

    def slow() -> int:
        calls.append(1)
        time.sleep(0.2)
        return 42

    answers = []
    threads = [threading.Thread(target=lambda: answers.append(memo.get("key", slow))) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert answers == [42, 42, 42, 42]
    assert len(calls) == 1


def test_memo_forgets_oldest_and_keeps_no_failed_answer():
    memo: Memo[int] = Memo(limit=2)
    for number in range(3):
        memo.get(number, lambda number=number: number)
    calls = []
    assert memo.get(0, lambda: calls.append(1) or 0) == 0
    assert calls == [1]

    def broken() -> int:
        raise ValueError("не посчиталось")

    try:
        memo.get("bad", broken)
    except ValueError:
        pass
    assert memo.get("bad", lambda: 7) == 7


def test_background_waits_for_answer_to_click():
    order = []

    async def scenario():
        async def click():
            await priority.foreground(lambda: (time.sleep(0.3), order.append("нажатие")))

        async def summary():
            await asyncio.sleep(0.05)  # досчет пришел, когда нажатие уже считается
            await priority.background(FakeRequest(), lambda: order.append("досчет"))

        await asyncio.gather(click(), summary())

    asyncio.run(scenario())
    assert order == ["нажатие", "досчет"]


def test_background_runs_one_at_a_time():
    running, most = [0], [0]
    lock = threading.Lock()

    def work():
        with lock:
            running[0] += 1
            most[0] = max(most[0], running[0])
        time.sleep(0.1)
        with lock:
            running[0] -= 1

    async def scenario():
        await asyncio.gather(*(priority.background(FakeRequest(), work) for _ in range(3)))

    asyncio.run(scenario())
    assert most[0] == 1


def test_cancelled_background_is_not_computed():
    calls = []

    async def scenario():
        return await priority.background(FakeRequest(gone=True), lambda: calls.append(1))

    answer = asyncio.run(scenario())
    assert calls == []
    assert answer.status_code == priority.GONE


def test_preview_without_header_is_answer_to_click():
    async def scenario():
        return await priority.by_header(FakeRequest(gone=True, background=False), lambda: "цифры")

    assert asyncio.run(scenario()) == "цифры"
