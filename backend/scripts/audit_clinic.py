r"""Воспроизводимый аудит медучреждений, без рабочей БД и без записи в пользовательские проекты.

Из backend: .venv\Scripts\python.exe -m scripts.audit_clinic --output ../docs/medical-audit-after.json
Каталог загружается из файлов проекта в SQLite в памяти.
"""

from __future__ import annotations

import argparse
import json
from itertools import product
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.schemas.clinic import GenerateRequest, MoneyRequest
from app.services import clinic, clinic_contract, clinic_money, selection
from app.services.catalog_import import seed_team_catalog
from app.storage.models import Base

LAYOUTS = [("one", 36, 20, 1, 3, 0), ("two", 48, 24, 2, 3, 1), ("four", 60, 28, 4, 4, 2)]
TASKS = [["floor_delivery"], ["cleaning"], ["floor_delivery", "cleaning"]]


def collect() -> list[dict]:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False)
    with sessions() as session:
        seed_team_catalog(session)
    original = selection.sessions
    selection.sessions = sessions
    try:
        rows = []
        for (name, w, length, floors, wards, lifts), tasks in product(LAYOUTS, TASKS):
            building = clinic_contract.generate(
                GenerateRequest(width_m=w, length_m=length, floors=floors, wards_per_floor=wards, lifts=lifts)
            )
            request = MoneyRequest(operation_ids=tasks, building=building)
            out = clinic_money.estimate(request).model_dump()
            full_cash = clinic_money.estimate(
                request.model_copy(
                    update={"assumptions": request.assumptions.model_copy(update={"cash_realization_share": 1})}
                )
            ).model_dump()
            row = dict(
                layout=name,
                tasks=tasks,
                people=out["people"],
                shift=out["shift"],
                scenarios=out["scenarios"],
                assumptions=out["assumptions"],
                warnings=out["warnings"],
                full_cash_scenarios=full_cash["scenarios"],
            )
            row["manual_minutes_per_delivery"] = (
                (
                    out["people"]["manual_hours_per_shift"]
                    - out["shift"]["cleaned_m2"] / clinic.config()["money"]["cleaning_m2_per_hour"]
                )
                * 60
                / out["shift"]["done"]
                if out["shift"]["done"]
                else None
            )
            rows.append(row)
        return rows
    finally:
        selection.sessions = original
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows = collect()
    args.output.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for row in rows:
        print(
            json.dumps(
                dict(
                    layout=row["layout"],
                    tasks=row["tasks"],
                    jobs=row["shift"]["jobs"],
                    done=row["shift"]["done"],
                    minutes=row["shift"]["avg_delivery_min"],
                    people=row["people"],
                    full_cash_purchase=next(s for s in row["full_cash_scenarios"] if s["id"] == "purchase"),
                ),
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    main()
