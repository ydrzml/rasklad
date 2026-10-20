"""Чертеж DXF как подложка под план склада: проверка файла и запуск разбора.

Файл чужой, поэтому разбираем его не в сервере, а в отдельном процессе со сроком. Завис,
съел память или упал парсер: сервер отвечает ошибкой и живет дальше. Файл нигде не
сохраняется, ответ это линии по слоям, из которых экран собирает картинку.
"""

from __future__ import annotations

import multiprocessing
import threading

from app.services import dxf_worker

# Настоящий чертеж цеха из AutoCAD весит 60 МБ: 160 тысяч объектов, 2,4 миллиона точек. Его разбор
# идет около минуты и берет до 1,3 ГБ памяти. 80 МБ это такой чертеж с запасом; больше уже не план склада,
# а весь проект с разрезами и узлами, его проще сохранить без лишних слоев
MAX_MB = 80
MAX_BYTES = MAX_MB * 1024 * 1024
BIG_BYTES = 16 * 1024 * 1024  # с этого размера разбор идет дольше полминуты и берет за гигабайт памяти
TIMEOUT_S = 25.0  # срок для обычного чертежа: склад на тридцать тысяч объектов разбирается за секунды
S_PER_MB = 2.0  # большой чертеж: сколько секунд добавлять на мегабайт файла
MAX_TIMEOUT_S = 170.0  # не дольше, чем nginx ждет ответа сервера (180 с)
MAX_AT_ONCE = 2  # разборов одновременно: каждый это отдельный процесс

_slots = threading.BoundedSemaphore(MAX_AT_ONCE)
# большой чертеж разбирается один: два сразу заняли бы почти всю память сервера (4 ГБ)
_big = threading.BoundedSemaphore(1)

ADVICE = dxf_worker.ADVICE
TOO_LARGE = f"Чертеж больше {MAX_MB} МБ. {ADVICE}"

DWG = (
    'Это файл DWG, а нужен DXF. В AutoCAD откройте чертеж, выберите "Файл", "Сохранить как" '
    "и тип файла DXF, потом загрузите его"
)


class TooLarge(Exception):
    pass


class WrongFile(Exception):
    """Не DXF: текст для человека"""


class Busy(Exception):
    pass


class Failed(Exception):
    """Разбор не удался: текст для человека"""


def check(content: bytes, name: str) -> None:
    """Дешевая проверка до запуска процесса: размер и что это вообще текстовый DXF"""
    if len(content) > MAX_BYTES:
        raise TooLarge(name)
    head = content[:64]
    if head[:2] == b"AC" and head[2:6].isdigit():  # AC1027: подпись DWG
        raise WrongFile(DWG)
    if head.startswith(b"AutoCAD Binary DXF"):
        raise WrongFile("Это двоичный DXF. Сохраните чертеж как обычный DXF (текстовый) и загрузите снова")
    if name.lower().endswith(".dwg"):
        raise WrongFile(DWG)
    if not name.lower().endswith(".dxf"):
        raise WrongFile("Нужен файл DXF. Если чертеж в DWG или PDF, сохраните его в AutoCAD как DXF")
    text = content[:4096].decode("utf-8", errors="ignore").lstrip("﻿ \t\r\n")
    # в начале текстового DXF стоит пара «0» и «SECTION» (или комментарий «999»)
    if not (text.startswith("0") or text.startswith("999")) or "SECTION" not in text.upper():
        raise WrongFile("Это не похоже на DXF. Нужен чертеж, сохраненный в AutoCAD как DXF")


def read(content: bytes, name: str) -> dict:
    return _guarded(content, name, "read", ())


def build(content: bytes, name: str, roles: dict[str, str], factor: float, buffer_depth_m: int) -> dict:
    """План по слоям: roles это имя слоя и его роль (walls, racks, doors), factor метров в единице чертежа"""
    return _guarded(content, name, "build", (roles, factor, buffer_depth_m))


def timeout_s(size: int) -> float:
    """Срок разбора по размеру файла: чтение DXF идет примерно секунду на мегабайт, столько же разбор линий"""
    if size < BIG_BYTES:
        return TIMEOUT_S
    return min(MAX_TIMEOUT_S, TIMEOUT_S + S_PER_MB * size / 1024 / 1024)


def _guarded(content: bytes, name: str, task: str, args: tuple) -> dict:
    check(content, name)
    big = len(content) >= BIG_BYTES
    if not _slots.acquire(blocking=False):
        raise Busy
    try:
        if big and not _big.acquire(blocking=False):
            raise Busy
        try:
            return _run(content, task, args, timeout_s(len(content)))
        finally:
            if big:
                _big.release()
    finally:
        _slots.release()


def _run(content: bytes, task: str, args: tuple, timeout: float) -> dict:
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=dxf_worker.run, args=(content, sender, task, args), daemon=True)
    process.start()
    sender.close()
    try:
        if not receiver.poll(timeout):
            raise Failed(f"Чертеж разбирался слишком долго и был остановлен. {ADVICE}")
        try:
            status, payload = receiver.recv()
        except EOFError as error:
            raise Failed(f"Чертеж слишком тяжелый для разбора. {ADVICE}") from error
    finally:
        receiver.close()
        if process.is_alive():
            process.kill()
        process.join(timeout=5)
    if status != "ok":
        raise Failed(str(payload))
    size = sum(len(layer["d"]) for layer in payload.get("layers", []))
    if size > dxf_worker.MAX_PATH_BYTES:
        raise Failed(f"Чертеж слишком подробный для подложки. {ADVICE}")
    return payload
