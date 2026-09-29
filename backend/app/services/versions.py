"""Версии модели и данных, которыми помечаем сохраненный расчет.

Версия модели берется из config/model.yaml, ее поднимаем руками, когда меняем формулы.
Версия данных - отпечаток файлов конфигурации и каталога, каталога в базе (число решений и последняя
запись журнала правок) и правок нормативов из админки: поменяли хоть одну цифру в файле или в админке,
отпечаток другой.
Так при повторном открытии проекта видно, считали ли его на тех же нормативах, что стоят сейчас."""

import hashlib
from functools import cache
from pathlib import Path

import yaml

from app.settings import settings


@cache
def model_version() -> str:
    model = yaml.safe_load((settings.config_dir / "model.yaml").read_text(encoding="utf-8"))
    return str(model["meta"]["version"])


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
