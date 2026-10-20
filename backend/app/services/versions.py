"""Версии модели и данных, которыми помечаем сохраненный расчет.

Версия модели берется из config/model.yaml, ее поднимаем руками, когда меняем формулы.
Версия данных - отпечаток файлов конфигурации и каталога, каталога в базе (число решений и последняя
запись журнала правок) и правок нормативов из админки: поменяли хоть одну цифру в файле или в админке,
отпечаток другой.
Так при повторном открытии проекта видно, считали ли его на тех же нормативах, что стоят сейчас."""

import hashlib
import re
from functools import cache
from pathlib import Path

import yaml

from app.settings import settings


@cache
def model_version() -> str:
    model = yaml.safe_load((settings.config_dir / "model.yaml").read_text(encoding="utf-8"))
    return str(model["meta"]["version"])


def data_note() -> str:
    """Тот же отпечаток словами, его видно на экране версии и в отчете: версия модели и файлов,
    сколько решений в каталоге и номер его правки, номер и дата последней правки нормативов"""
    from app.services import norms, selection

    count, last = selection.catalog_stamp().split(":")
    parts = [
        f"модель {model_version()}, файлы {_files_version()}",
        f"каталог: решений {count}, правка {last}",
        norms.revision() or "нормативы: как в файлах, правок в админке нет",
    ]
    return "; ".join(parts)


def readable_note(note: str) -> str:
    """Отпечаток словами без служебного: часть "модель 0.2, файлы 49326edaf0a3" человеку ничего не говорит,
    версию модели и так показываем отдельно. В базе запись остается целиком, для проверки."""
    parts = [part for part in note.split("; ") if part and not part.startswith("модель ")]
    return "; ".join(re.sub(CATALOG_PART, r"решений в каталоге \1, правка каталога \2", part) for part in parts)


# так data_note пишет каталог: "каталог: решений 190, правка 6"
CATALOG_PART = r"^каталог: решений (\d+), правка (\d+)$"


def data_version() -> str:
    """Отпечаток файлов, каталога в базе и правок нормативов: иначе расчет на других данных
    выглядел бы посчитанным на тех же."""
    from app.services import norms, selection  # подбор держит каталог из базы и знает, когда его правили

    digest = hashlib.sha256(_files_version().encode())
    digest.update(selection.catalog_stamp().encode())
    edits = norms.fingerprint()
    if edits:
        digest.update(edits.encode())
    return digest.hexdigest()[:12]


@cache
def _files_version() -> str:
    digest = hashlib.sha256()
    for folder in (settings.config_dir, settings.data_dir / "catalog"):
        for path in sorted(p for p in folder.rglob("*") if p.is_file()):
            digest.update(path.relative_to(folder).as_posix().encode())
            digest.update(_normalized(path))
    return digest.hexdigest()[:12]


def _normalized(path: Path) -> bytes:
    # Переводы строк зависят от системы, на которой вынули репозиторий: на отпечаток они влиять не должны
    return path.read_bytes().replace(b"\r\n", b"\n")
