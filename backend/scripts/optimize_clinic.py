r"""Повторить примеры оптимизации без рабочей БД.

Из backend: .venv\Scripts\python.exe -m scripts.optimize_clinic --output ../docs/medical-optimization-examples.json
"""

import argparse
import json
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.schemas.clinic import GenerateRequest, OptimizationRequest, StressProfile
from app.services import clinic_contract, clinic_optimizer, selection
from app.services.catalog_import import seed_team_catalog
from app.storage.models import Base
from scripts.audit_clinic import LAYOUTS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--robust",
        action="store_true",
        help="Допущения: поток +25%%, рабочие характеристики −20%%, задержки и помощь +50%%",
    )
    args = parser.parse_args()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False)
    with sessions() as session:
        seed_team_catalog(session)
    original = selection.sessions
    selection.sessions = sessions
    rows = []
    try:
        for name, w, length, floors, wards, lifts in LAYOUTS:
            building = clinic_contract.generate(
                GenerateRequest(width_m=w, length_m=length, floors=floors, wards_per_floor=wards, lifts=lifts)
            )
            for objective in ("min_cost", "max_time"):
                request = OptimizationRequest(
                    operation_ids=["floor_delivery", "cleaning"],
                    building=building,
                    objective=objective,
                    time_budget_s=30,
                    stress_profiles=[
                        StressProfile(id="peak", name="Повышенная нагрузка", demand_factor=1.25, arrival_spread=0.5),
                        StressProfile(
                            id="adverse",
                            name="Нагрузка и задержки",
                            demand_factor=1.25,
                            arrival_spread=0.5,
                            speed_factor=0.8,
                            runtime_factor=0.8,
                            cleaning_factor=0.8,
                            handling_factor=1.5,
                            lift_traffic_factor=1.5,
                            door_wait_factor=1.5,
                            support_factor=1.5,
                        ),
                    ]
                    if args.robust
                    else [],
                )
                result = clinic_optimizer.optimize(request)
                rows.append(dict(layout=name, request=request.model_dump(), result=result.model_dump()))
                best = next((c for c in result.candidates if c.id == result.recommended_id), None)
                print(
                    name,
                    objective,
                    result.simulations,
                    result.configurations_checked,
                    result.fully_enumerated,
                    None
                    if best is None
                    else (
                        best.robot_name,
                        best.fleet,
                        best.cleaners,
                        round(best.incremental_cost_rub),
                        round(best.released_hours_year),
                    ),
                )
    finally:
        selection.sessions = original
        engine.dispose()
    args.output.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
