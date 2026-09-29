"""Помощник прогона смены на Windows стартует отдельным процессом (spawn) и начинает импорт
с app.services.simulation. Цепочка simulation -> plan -> calculation -> norms -> data_import ->
catalog -> facility_catalog -> selection -> calculation не должна замыкаться, иначе помощник падает
с ImportError: расчет все равно доходит до ответа, но в логе лежит трассировка. Проверяем в чистом интерпретаторе."""

import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("module", ["app.services.simulation", "app.services.plan", "app.services.selection"])
def test_module_imports_first_in_a_fresh_interpreter(module):
    done = subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr[-1500:]
