"""Загрузка конфигурации модели.

В конфигурации каждое значение записано вместе с источником:
    price_rub: {v: 3000000, src: "коммерческое предложение производителя", date: "2026-09", trust: C}

Оценка доверия одна на весь проект, она описана в docs/data-sources.md, раздел «Оценка достоверности»:
от S (закон или норматив) до F (источника нет, наше допущение).

Загрузчик отдает расчету просто значения, а источники собирает отдельно по пути к значению.
По ним интерфейс сможет показать, откуда взялась цифра.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from pathlib import Path

import yaml

SOURCED_KEYS = {"v", "src", "date", "trust"}
TRUST_LEVELS = "SABCDEF"
WEAK_TRUST = {"E", "F"}  # источники расходятся или источника нет
# Разделы, где голые числа допустимы: служебные настройки, а не данные модели.
UNSOURCED_SECTIONS = {"meta", "engine"}


@dataclass(frozen=True)
class Provenance:
    source: str
    date: str | None
    trust: str

    @property
    def is_weak(self) -> bool:
        return self.trust in WEAK_TRUST


def load_model(path: str | Path) -> tuple[dict, dict[str, Provenance]]:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    provenance: dict[str, Provenance] = {}
    return _unwrap(raw, "", provenance), provenance


def load_full_model(config_dir: str | Path) -> tuple[dict, dict[str, Provenance]]:
    """Модель объекта вместе со справочником ролей.

    Расчету нужны выработки и названия ролей, а сами файлы движок читать не должен, поэтому
    склейка живет здесь, в загрузчике. Все, кто считает (API, скрипты, тесты), берут модель отсюда,
    иначе легко получить расчет без справочника: он не падает, а молча дает ноль высвобожденных ставок.
    """
    config_dir = Path(config_dir)
    model, provenance = load_model(config_dir / "model.yaml")
    roles, role_provenance = load_model(config_dir / "roles.yaml")
    model["roles"] = {role["id"]: role for role in roles["roles"]}
    return model, provenance | {f"roles.{path}": prov for path, prov in role_provenance.items()}


def overlay(
    model: dict, provenance: dict[str, Provenance], changes: dict[str, tuple[float, Provenance]]
) -> tuple[dict, dict[str, Provenance]]:
    """Модель с правками поверх файла: значение и его источник по пути. Исходную модель не трогаем.

    Так работают нормативы из админки: файл остается базой по умолчанию со своими источниками,
    а правка администратора подменяет число и то, что показывается в "Откуда цифры".
    Путь, которого в модели нет, пропускаем: значение могли убрать из файла, пока правка лежала в базе.
    """
    if not changes:
        return model, provenance
    changed, sources = copy.deepcopy(model), dict(provenance)
    for path, (value, source) in changes.items():
        if path in provenance and set_by_path(changed, path, value):
            sources[path] = source
    return changed, sources


def value_by_path(model: dict, path: str):
    """Значение по пути вида facilities.warehouse.staff.pickers.salary_month. Нет такого пути: None."""
    node = model
    for key in path.split("."):
        node = _step(node, key)
        if node is None:
            return None
    return node


def set_by_path(model: dict, path: str, value) -> bool:
    *parents, last = path.split(".")
    node = model
    for key in parents:
        node = _step(node, key)
        if node is None:
            return False
    if not isinstance(node, dict) or last not in node:
        return False
    node[last] = value
    return True


def _step(node, key: str):
    if isinstance(node, dict):
        return node.get(key)
    if isinstance(node, list):
        return next((item for item in node if isinstance(item, dict) and item.get("id") == key), None)
    return None


def find_unsourced_numbers(raw: dict) -> list[str]:
    """Пути к числам, записанным без источника. Для CI: у каждой цифры должен быть источник."""
    found: list[str] = []
    for section, node in raw.items():
        if section not in UNSOURCED_SECTIONS:
            _collect_bare(node, section, found)
    return found


def weak_values(provenance: dict[str, Provenance]) -> list[str]:
    """Значения, на которые нельзя опираться: источника нет или источники расходятся."""
    return sorted(path for path, prov in provenance.items() if prov.is_weak)


def trust_counts(provenance: dict[str, Provenance]) -> dict[str, int]:
    """Сколько значений на каждой оценке доверия, от S до F."""
    counts = {level: 0 for level in TRUST_LEVELS}
    for prov in provenance.values():
        counts[prov.trust] += 1
    return counts


def _is_sourced(node) -> bool:
    return isinstance(node, dict) and "v" in node and set(node) <= SOURCED_KEYS


def _child_path(path: str, key) -> str:
    return f"{path}.{key}" if path else str(key)


def _item_key(item, index: int):
    return item["id"] if isinstance(item, dict) and "id" in item else index


def _unwrap(node, path: str, provenance: dict[str, Provenance]):
    if _is_sourced(node):
        trust = node.get("trust")
        if trust not in set(TRUST_LEVELS):
            raise ValueError(f"{path}: оценка доверия должна быть одной из {TRUST_LEVELS}, а не {trust!r}")
        if not node.get("src"):
            raise ValueError(f"{path}: у значения должен быть источник или объяснение допущения")
        if trust != "F" and not node.get("date"):
            raise ValueError(f"{path}: у значения с оценкой {trust} должна быть дата")
        date = node.get("date")
        provenance[path] = Provenance(node["src"], None if date is None else str(date), trust)
        return node["v"]
    if isinstance(node, dict):
        return {k: _unwrap(v, _child_path(path, k), provenance) for k, v in node.items()}
    if isinstance(node, list):
        return [_unwrap(item, _child_path(path, _item_key(item, i)), provenance) for i, item in enumerate(node)]
    return node


def _collect_bare(node, path: str, found: list[str]) -> None:
    if _is_sourced(node):
        return
    if isinstance(node, bool):
        return
    if isinstance(node, (int, float)):
        found.append(path)
    elif isinstance(node, dict):
        for k, v in node.items():
            _collect_bare(v, _child_path(path, k), found)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            _collect_bare(item, _child_path(path, _item_key(item, i)), found)
