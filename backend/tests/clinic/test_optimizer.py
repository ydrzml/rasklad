"""Подбор по ограничениям, сравнению денег и отдельным проверочным потокам."""

from dataclasses import asdict, replace
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.engine.clinic.demand import Job
from app.engine.clinic.optimization import efficient_counts, failures, service, worst
from app.main import app
from app.schemas import clinic as schema
from app.services import clinic, clinic_money, clinic_optimizer
from app.services.clinic_contract import from_schema
from tests.clinic.helpers import ROBOT, house

client = TestClient(app)


def building():
    out = client.post("/api/clinic/generate", json=dict(width_m=36, length_m=20, floors=1, wards_per_floor=3, lifts=0))
    assert out.status_code == 200
    return out.json()


def request(**changes):
    return schema.OptimizationRequest.model_validate(
        dict(
            building=building(),
            operation_ids=[clinic.DELIVERY],
            delivery_ids=[clinic.DEFAULT_DELIVERY],
            max_delivery_fleet=3,
            max_cleaners_per_floor=2,
            time_budget_s=10,
        )
        | changes
    )


@pytest.mark.parametrize("tasks", [[clinic.DELIVERY], [clinic.CLEANING], [clinic.DELIVERY, clinic.CLEANING]])
def test_prepared_shift_and_public_shift_have_identical_outcomes(tasks):
    house = clinic.demo()
    prepared = clinic.Prepared(house, operation_ids=tasks)
    cached = prepared.run(3, {1: 1, 2: 1, 3: 1, 4: 1}, seed=307, record=True)
    direct = clinic.simulate(house, fleet=3, cleaners={1: 1, 2: 1, 3: 1, 4: 1}, seed=307, operation_ids=tasks)
    assert asdict(cached.kpi) == asdict(direct.kpi)
    assert cached.result.jobs == direct.result.jobs
    assert cached.result.segments == direct.result.segments
    assert cached.result.lift_segments == direct.result.lift_segments
    assert cached.result.cleaning == direct.result.cleaning
    assert cached.result.time_in == direct.result.time_in
    assert cached.result.waits == direct.result.waits


def test_reusing_a_prepared_plan_never_reuses_mutated_jobs():
    prepared = clinic.Prepared(clinic.demo(), operation_ids=[clinic.DELIVERY])
    first = prepared.run(1, seed=42)
    saved = [asdict(job) for job in first.result.jobs]
    prepared.run(10, seed=42)
    assert saved == [asdict(job) for job in first.result.jobs]
    assert saved == [asdict(job) for job in prepared.run(1, seed=42).result.jobs]


def test_staff_can_use_an_elevator_without_a_robot_integration():
    from app.engine.clinic.routes import Navigator, StaffNavigator

    building = house(lift_robots=False)
    robot = Navigator(building, ROBOT)
    staff = StaffNavigator(building, 600)
    assert robot.route(robot.spot(1, "pharmacy"), robot.spot(2, "post")) is None
    assert staff.route(staff.spot(1, "pharmacy"), staff.spot(2, "post")) is not None


def test_manual_route_does_not_change_when_the_robot_model_changes():
    from app.engine.clinic.metrics import staff_hours

    first = clinic.Prepared(house(), robot_id=clinic.DEFAULT_DELIVERY, operation_ids=[clinic.DELIVERY])
    second = clinic.Prepared(house(), robot_id="ext-keenon-w3", operation_ids=[clinic.DELIVERY])
    result = first.run(2).result
    a = staff_hours(result, first.staff_nav, first.staff, first.lift)
    b = staff_hours(result, second.staff_nav, second.staff, second.lift)
    assert a > 0 and a == b


def test_service_denominator_is_fixed_even_if_a_future_job_finishes_early():
    done = Job("done", "meds", "a", "b", 0, 100, False, done_s=50)
    late = Job("late", "meds", "a", "b", 0, 200, False)
    early = Job("early", "meds", "a", "b", 3500, 4000, False, done_s=3590)
    later = Job("later", "meds", "a", "b", 3550, 4100, False)
    out = SimpleNamespace(
        result=SimpleNamespace(hours=1, jobs=[done, late, early, later]), kpi=SimpleNamespace(cleaning=[], cleaned_m2=0)
    )
    score = service(out)
    assert score.on_time_share == score.completion_share == 0.5
    assert score.overdue_unfinished == score.carryover_jobs == 1


def test_an_average_does_not_hide_a_bad_shift():
    conditions = request()
    scores = [
        schema.ServiceScore(
            on_time_share=one, completion_share=1, cleaning_coverage=None, overdue_unfinished=0, carryover_jobs=0
        )
        for one in [1, 1, 0.8]
    ]
    assert failures(worst(scores), conditions)


def test_cleaner_dominance_keeps_a_larger_fleet_when_it_reduces_human_help():
    options = [(1, (2.0, 2.0, 2.0)), (2, (1.0, 1.0, 1.0)), (3, (3.0, 3.0, 3.0))]
    assert efficient_counts(options) == options[:2]


@pytest.mark.parametrize("tasks", [[clinic.DELIVERY], [clinic.CLEANING], [clinic.DELIVERY, clinic.CLEANING]])
def test_recommended_fleet_is_replayable_even_without_payback(tasks):
    conditions = request(operation_ids=tasks)
    out = clinic_optimizer.optimize(conditions)
    assert out.recommended_id
    assert set(out.training_seeds).isdisjoint(out.validation_seeds)
    chosen = next(c for c in out.candidates if c.id == out.recommended_id)
    assert chosen.validated and not chosen.why_not
    assert not chosen.payback_met and chosen.payback_why_not
    body = dict(
        building=conditions.building.model_dump(),
        operation_ids=tasks,
        robot_id=chosen.robot_id,
        cleaner_id=chosen.cleaner_id,
        fleet=chosen.fleet,
        cleaners=chosen.cleaners,
    )
    money = client.post("/api/clinic/economics", json=body)
    run = client.post("/api/clinic/runs", json=body | {"with_events": False})
    assert money.status_code == run.status_code == 200
    assert money.json()["shift"]["fleet"] == run.json()["fleet"] == chosen.fleet
    assert (
        money.json()["shift"]["cleaners"] == run.json()["cleaners"] == {str(k): v for k, v in chosen.cleaners.items()}
    )
    assert money.json()["shift"]["jobs"] == run.json()["kpi"]["created"]
    assert money.json()["shift"]["cleaned_m2"] == run.json()["kpi"]["cleaned_m2"]


def test_cost_choice_matches_an_independent_exhaustive_run_of_the_bounded_grid():
    conditions = request(delivery_ids=[clinic.DEFAULT_DELIVERY, "ext-keenon-w3"])
    out = clinic_optimizer.optimize(conditions)
    reference = []
    for robot_id in conditions.delivery_ids:
        for count in range(1, conditions.max_delivery_fleet + 1):
            costs = []
            feasible = True
            for seed in [*out.training_seeds, *out.validation_seeds]:
                shift = clinic.simulate(
                    from_schema(conditions.building),
                    robot_id,
                    fleet=count,
                    cleaner_id=None,
                    seed=seed,
                    operation_ids=[clinic.DELIVERY],
                    record=False,
                )
                feasible &= not failures(service(shift), conditions)
                calculation = clinic_money.estimate(
                    schema.MoneyRequest(
                        operation_ids=[clinic.DELIVERY], robot_id=robot_id, building=conditions.building, fleet=count
                    ),
                    outcome=shift,
                    include_sources=False,
                )
                costs.append(-next(s.saving_rub for s in calculation.scenarios if s.id == "purchase"))
            if feasible:
                reference.append(max(costs))
    assert reference
    chosen = next(c for c in out.candidates if c.id == out.recommended_id)
    assert chosen.incremental_cost_rub == pytest.approx(min(reference))


def test_composed_components_have_the_same_labour_and_money_as_a_joint_simulation():
    house = clinic.demo()
    delivery = clinic.Prepared(house, cleaner_id=None, operation_ids=[clinic.DELIVERY])
    cleaning = clinic.Prepared(house, operation_ids=[clinic.CLEANING])
    counts = {1: 2, 2: 1, 3: 1, 4: 1}
    for seed in [42, 307]:
        combined = clinic_optimizer.merge(delivery.run(4, seed=seed), cleaning.run(0, counts, seed))
        direct = clinic.simulate(house, fleet=4, cleaners=counts, seed=seed, record=False)
        body = schema.MoneyRequest(operation_ids=[clinic.DELIVERY, clinic.CLEANING])
        merged = clinic_money.estimate(body, outcome=combined, include_sources=False)
        original = clinic_money.estimate(body, outcome=direct, include_sources=False)
        assert merged.people == original.people
        assert merged.scenarios == original.scenarios


def test_validation_failure_never_returns_a_recommended_configuration(monkeypatch):
    original = clinic_optimizer.Search.run

    def failing(self, component, seed):
        out = original(self, component, seed)
        if seed in self.validation:
            return replace(out, result=replace(out.result, jobs=[replace(job, done_s=None) for job in out.result.jobs]))
        return out

    monkeypatch.setattr(clinic_optimizer.Search, "run", failing)
    out = clinic_optimizer.optimize(request())
    assert out.candidates and out.recommended_id is None
    assert all(not c.validated and c.why_not for c in out.candidates)


def test_upfront_budget_is_a_constraint_not_a_posthoc_note():
    out = clinic_optimizer.optimize(request(max_upfront_rub=0))
    assert out.recommended_id is None and not out.candidates


def test_budget_exhaustion_is_not_described_as_an_exhaustive_optimum(monkeypatch):
    def exhausted(self):
        self.complete = False
        raise clinic_optimizer.BudgetReached

    monkeypatch.setattr(clinic_optimizer.Search, "budget", exhausted)
    out = clinic_optimizer.optimize(request())
    assert not out.fully_enumerated and out.recommended_id is None


@pytest.mark.parametrize(
    "changes",
    [
        {"max_delivery_fleet": 31},
        {"max_cleaners_per_floor": 5},
        {"on_time_target": 0.4},
        {"cleaning_target": 0.5},
        {"completion_target": 0.8},
        {"max_upfront_rub": -1},
        {"time_budget_s": 31},
    ],
)
def test_optimizer_bounds_are_enforced(changes):
    response = client.post("/api/clinic/optimize", json={"operation_ids": [clinic.DELIVERY], **changes})
    assert response.status_code == 422
