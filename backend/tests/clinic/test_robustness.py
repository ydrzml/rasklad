"""Устойчивость к допущениям отдельно от случайных потоков и общей доли вовремя."""

from dataclasses import asdict, replace
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.engine.clinic.demand import Job
from app.engine.clinic.fleet import Quality, search
from app.engine.clinic.metrics import kpi
from app.engine.clinic.optimization import failures, service
from app.main import app
from app.schemas import clinic as schema
from app.services import clinic, clinic_conditions, clinic_money, clinic_optimizer
from app.services.clinic_contract import from_schema

client = TestClient(app)


def building(width=36, length=20):
    response = client.post(
        "/api/clinic/generate", json=dict(width_m=width, length_m=length, floors=1, wards_per_floor=3, lifts=0)
    )
    assert response.status_code == 200, response.text
    return response.json()


def profiles():
    return [
        schema.StressProfile(id="peak", name="Пик", demand_factor=1.25, arrival_spread=0.5),
        schema.StressProfile(
            id="adverse",
            name="Нагрузка и задержки",
            demand_factor=1.25,
            arrival_spread=0.5,
            speed_factor=0.8,
            runtime_factor=0.8,
            cleaning_factor=0.8,
            handling_factor=1.5,
            door_wait_factor=1.5,
            lift_traffic_factor=1.5,
            support_factor=1.5,
        ),
    ]


def request(**changes):
    return schema.OptimizationRequest.model_validate(
        {
            "building": building(),
            "operation_ids": ["floor_delivery"],
            "delivery_ids": [clinic.DEFAULT_DELIVERY],
            "max_delivery_fleet": 4,
            "time_budget_s": 15,
            "stress_profiles": profiles(),
            **changes,
        }
    )


def test_identity_conditions_preserve_jobs_kpi_and_recorded_replay():
    base = clinic.Prepared(clinic.demo())
    changed = clinic_conditions.prepare(base, schema.StressProfile(id="identity", name="Тождественное условие"))
    first, second = base.run(5, seed=7, record=True), changed.run(5, seed=7, record=True)
    assert asdict(first.kpi) == asdict(second.kpi)
    assert first.result.jobs == second.result.jobs
    assert first.result.segments == second.result.segments
    assert first.result.lift_segments == second.result.lift_segments


@pytest.mark.parametrize("mode", ["per_point", "building", "routes"])
def test_demand_conditions_apply_to_every_mode_and_keep_the_same_flow_for_different_fleets(mode):
    house = building()
    rooms = house["floors"][0]["items"]
    source = next(r["id"] for r in rooms if r["role"] == "pharmacy")
    target = next(r["id"] for r in rooms if r["role"] == "ward")
    house["scenario"] = {
        "shift_hours": 24,
        "schedule": "uniform",
        "supplies": {"enabled": False},
        "meds": {"mode": mode, "per_day": 48, "flows": [{"source": source, "target": target, "per_day": 48}]},
    }
    base = clinic.Prepared(from_schema(schema.Building.model_validate(house)), operation_ids=["floor_delivery"])
    changed = clinic_conditions.prepare(
        base, schema.StressProfile(id="peak", name="Пик", demand_factor=2, arrival_spread=0.25)
    )
    before = base.run(2, record=True)
    first, second = changed.run(1), changed.run(4)
    assert sum(first.demand_per_hour) == pytest.approx(2 * sum(before.demand_per_hour))
    assert [(j.id, j.created_s, j.source, j.target, j.urgent) for j in first.result.jobs] == [
        (j.id, j.created_s, j.source, j.target, j.urgent) for j in second.result.jobs
    ]
    assert all(job.created_s % 3600 < 900 + 1e-9 for job in first.result.jobs)
    assert base.run(2, record=True).result.jobs == before.result.jobs
    assert changed._jobs is not base._jobs


def test_profile_changes_do_not_mutate_the_catalog_building_or_base_times():
    base = clinic.Prepared(clinic.demo())
    original = (asdict(base.building), asdict(base.robot), asdict(base.cleaner), asdict(base.run_times))
    changed = clinic_conditions.prepare(base, profiles()[1])
    assert changed.robot.spec.speed_m_s == pytest.approx(base.robot.spec.speed_m_s * 0.8)
    assert changed.cleaner.spec.throughput_m2_h == pytest.approx(base.cleaner.spec.throughput_m2_h * 0.8)
    assert changed.run_times.handover_s == base.run_times.handover_s * 1.5
    assert changed.building.lifts[0].people_calls_per_hour == base.building.lifts[0].people_calls_per_hour * 1.5
    changed.run(4, seed=307)
    assert original == (asdict(base.building), asdict(base.robot), asdict(base.cleaner), asdict(base.run_times))


def test_more_assistance_changes_actual_labour_and_cost_without_changing_the_manual_reference():
    conditions = request(stress_profiles=[])
    base = clinic.Prepared(from_schema(conditions.building), operation_ids=["floor_delivery"])
    out = base.run(3)
    plain = clinic_money.estimate(conditions, outcome=out, include_sources=False)
    adjusted = clinic_conditions.accounts(conditions, schema.StressProfile(id="help", name="Помощь", support_factor=2))
    more = clinic_money.estimate(adjusted, outcome=out, include_sources=False)
    assert more.people.manual_hours_per_shift == plain.people.manual_hours_per_shift
    assert more.people.support_hours_per_shift > plain.people.support_hours_per_shift
    assert more.people.cash_saving_year_rub <= plain.people.cash_saving_year_rub
    assert -more.scenarios[1].saving_rub >= -plain.scenarios[1].saving_rub
    assert not conditions.assumptions.model_fields_set


def test_good_total_percentage_does_not_hide_failed_urgent_deliveries():
    jobs = [Job(str(i), "meds", "a", "b", 0, 100, False, done_s=50) for i in range(98)]
    jobs += [Job(f"urgent-{i}", "meds", "a", "b", 0, 100, True, done_s=200) for i in range(2)]
    score = service(
        SimpleNamespace(result=SimpleNamespace(hours=1, jobs=jobs), kpi=SimpleNamespace(cleaning=[], cleaned_m2=0))
    )
    assert score.on_time_share == 0.98 and score.urgent_on_time_share == 0
    assert any("Срочные" in reason for reason in failures(score, request()))


def test_replay_and_economics_use_the_same_fixed_cohort_as_the_optimizer():
    base = clinic.Prepared(clinic.demo(), operation_ids=["floor_delivery"])
    result = base.run(4).result
    result.jobs = [
        Job("due", "meds", "a", "b", 0, 100, False, done_s=50),
        Job("late", "meds", "a", "b", 0, 100, False),
        Job("early", "meds", "a", "b", 3500, 4000, False, done_s=3590),
    ]
    result.hours = 1
    summary = kpi(result, None, base.staff, base.lift)
    assert summary.on_time_share == 0.5 and summary.due == 2
    assert service(SimpleNamespace(result=result, kpi=summary)).on_time_share == 0.5


def test_automatic_sizing_checks_urgent_and_completion_conditions_without_falsifying_the_curve():
    out = search(lambda fleet, seed: Quality(0.99, fleet >= 2), (42, 7), 0.95, 3)
    assert out.needed == 2 and out.curve == [(1, 0.99), (2, 0.99)]


def test_same_fleet_passes_every_case_and_its_ranges_include_all_checked_cases():
    out = clinic_optimizer.optimize(request())
    assert out.recommended_id
    candidate = next(c for c in out.candidates if c.id == out.recommended_id)
    assert len(candidate.assessments) == 3
    assert all(a.validation is not None and a.runs == 6 for a in candidate.assessments)
    assert candidate.incremental_cost_range_rub == (
        min(a.incremental_cost_range_rub[0] for a in candidate.assessments),
        max(a.incremental_cost_range_rub[1] for a in candidate.assessments),
    )
    assert candidate.incremental_cost_rub == candidate.incremental_cost_range_rub[1]
    assert candidate.released_hours_year == min(a.labour_balance_range_hours[0] for a in candidate.assessments)


def test_robust_minimum_cost_matches_an_independent_enumeration():
    settings = request(delivery_ids=[clinic.DEFAULT_DELIVERY, "ext-keenon-w3"])
    out = clinic_optimizer.optimize(settings)
    reference = []
    for robot_id in settings.delivery_ids:
        base = clinic.Prepared(
            from_schema(settings.building), robot_id=robot_id, cleaner_id=None, operation_ids=["floor_delivery"]
        )
        account_request = schema.MoneyRequest(
            building=settings.building, robot_id=robot_id, operation_ids=["floor_delivery"]
        )
        for count in range(1, settings.max_delivery_fleet + 1):
            feasible, costs = True, []
            for profile in [schema.StressProfile(id="nominal", name="База"), *settings.stress_profiles]:
                prepared = clinic_conditions.prepare(base, profile)
                for seed in [*out.training_seeds, *out.validation_seeds]:
                    result = prepared.run(count, {}, seed)
                    feasible &= not failures(service(result), settings)
                    account = clinic_money.estimate(
                        clinic_conditions.accounts(account_request, profile), outcome=result, include_sources=False
                    )
                    costs.append(-next(s for s in account.scenarios if s.id == "purchase").saving_rub)
            if feasible:
                reference.append(max(costs))
    assert reference and out.recommended_id
    recommended = next(c for c in out.candidates if c.id == out.recommended_id)
    assert recommended.incremental_cost_rub == pytest.approx(min(reference))


def test_stress_only_failure_on_new_flows_never_becomes_a_recommendation(monkeypatch):
    original = clinic_optimizer.Search.run

    def failed(self, component, seed):
        out = original(self, component, seed)
        if component.runner.condition_id == "adverse" and seed in self.validation:
            return replace(out, result=replace(out.result, jobs=[replace(job, done_s=None) for job in out.result.jobs]))
        return out

    monkeypatch.setattr(clinic_optimizer.Search, "run", failed)
    out = clinic_optimizer.optimize(request())
    assert out.candidates and out.recommended_id is None
    assert all(not c.validated and any("Нагрузка и задержки" in reason for reason in c.why_not) for c in out.candidates)


def test_time_limit_in_last_case_does_not_publish_partial_validation(monkeypatch):
    original = clinic_optimizer.Search.accounts

    def stopped(self, d, c, outcomes, profile=None):
        if profile and profile.id == "adverse" and self.deadline == self.start + self.request.time_budget_s:
            self.complete = False
            raise clinic_optimizer.BudgetReached
        return original(self, d, c, outcomes, profile)

    monkeypatch.setattr(clinic_optimizer.Search, "accounts", stopped)
    out = clinic_optimizer.optimize(request())
    assert out.candidates and out.recommended_id is None and not out.fully_enumerated
    assert all(
        c.validation is None and not c.validated and all(a.validation is None for a in c.assessments)
        for c in out.candidates
    )


def test_cleaner_pruning_considers_degraded_conditions_and_keeps_the_required_larger_fleet():
    house = building(120, 120)
    house["scenario"] = {"shift_hours": 4, "cleaning_passes": 1}
    settings = dict(
        building=house,
        operation_ids=["cleaning"],
        cleaner_ids=[clinic.DEFAULT_CLEANER],
        max_cleaners_per_floor=4,
        time_budget_s=15,
    )
    nominal = clinic_optimizer.optimize(request(stress_profiles=[], **settings))
    robust = clinic_optimizer.optimize(
        request(
            stress_profiles=[schema.StressProfile(id="slow", name="Медленная уборка", cleaning_factor=0.5)], **settings
        )
    )
    a = next(c for c in nominal.candidates if c.id == nominal.recommended_id)
    b = next(c for c in robust.candidates if c.id == robust.recommended_id)
    assert sum(b.cleaners.values()) > sum(a.cleaners.values())
    assert all(a.validation.cleaning_coverage == pytest.approx(1) for a in b.assessments)


@pytest.mark.parametrize(
    "profile",
    [
        {"id": "nominal", "name": "Занятое имя"},
        {"id": "bad", "name": "Нагрузка", "demand_factor": 0.9},
        {"id": "bad", "name": "Скорость", "speed_factor": 0},
        {"id": "bad", "name": "Профиль", "arrival_spread": 0},
    ],
)
def test_invalid_conditions_are_rejected(profile):
    with pytest.raises(ValueError):
        request(stress_profiles=[profile])
