"""У каждого числа модели медучреждения источник, дата и оценка, а у допущения объяснение."""

from __future__ import annotations

import yaml

from app.engine.model_config import find_unsourced_numbers
from app.services import clinic
from app.settings import settings

EXPLAINED = 40  # допущение без объяснения в пару слов не пройдет: правило проверки, а не данные


def raw() -> dict:
    return yaml.safe_load((settings.config_dir / "clinic.yaml").read_text(encoding="utf-8"))


def test_no_bare_numbers_outside_engine():
    assert find_unsourced_numbers(raw()) == []


def test_every_assumption_says_why():
    _, provenance = clinic.model()
    assert provenance, "в config/clinic.yaml нет значений с источником"
    for path, source in provenance.items():
        assert len(source.source) >= EXPLAINED, path
        if source.trust == "F":
            assert "допущ" in source.source.lower() or "нет источника" in source.source.lower(), path


def test_norms_are_marked_as_norms():
    _, provenance = clinic.model()
    for path in ("building.corridor_width_m", "building.ward_door_mm", "cleaning.passes_per_day"):
        assert provenance[path].trust == "S", path


def test_robot_specs_come_from_the_catalog_with_ratings():
    robots = clinic.robots(clinic.DELIVERY) + clinic.robots(clinic.CLEANING)
    assert robots
    for item in robots:
        for spec in item.specs:
            assert spec.trust in "SABCDE", (item.product, spec.field)
        if item.spec is None:
            assert item.missing, item.product


def test_only_catalog_robots_and_no_excluded_versions():
    ids = {item.id for item in clinic.robots(clinic.DELIVERY)}
    assert clinic.DEFAULT_DELIVERY in ids
    assert "ext-pudu-flashbot" not in ids  # эта версия в России не продается: справочно
    assert {item.id for item in clinic.robots(clinic.CLEANING)} >= {clinic.DEFAULT_CLEANER}
