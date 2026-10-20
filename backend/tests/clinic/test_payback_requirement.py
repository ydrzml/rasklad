"""Плюс и окупаемость сообщаются достоверно, но не ограничивают выбор варианта."""

from types import SimpleNamespace

import pytest

from app.engine.clinic.optimization import failures, service
from app.schemas.clinic import GenerateRequest, MoneyRequest, OptimizationRequest, StressProfile
from app.services import clinic, clinic_conditions, clinic_contract, clinic_money, clinic_optimizer


def conditions(**changes):
    # Синтетические условия положительного примера, не измерения учреждения и не новые defaults.
    return OptimizationRequest(
        **{
            "operation_ids": ["cleaning"],
            "building": clinic_contract.generate(
                GenerateRequest(width_m=120, length_m=120, floors=1, wards_per_floor=3, lifts=0)
            ),
            "cleaner_ids": [clinic.DEFAULT_CLEANER],
            "time_budget_s": 20,
            "assumptions": {
                "cash_realization_share": 1,
                "cleaning_time_saving_share": 0.75,
                "cleaner_hour_rub": 1000,
                "integration_rub": 100_000,
                "extra_annual_rub": 30_000,
            },
            "stress_profiles": [
                StressProfile(id="peak", name="Пик", demand_factor=1.25),
                StressProfile(id="adverse", name="Задержки", cleaning_factor=0.8, support_factor=1.5),
            ],
            **changes,
        }
    )


@pytest.mark.parametrize("objective", ["min_cost", "max_time"])
@pytest.mark.parametrize("payment", ["purchase", "raas"])
def test_recommendation_pays_back_in_every_case_and_preserves_entered_finances(objective, payment):
    request = conditions(objective=objective, payment_ids=[payment])
    before = request.model_dump()
    result = clinic_optimizer.optimize(request)
    assert request.model_dump() == before
    candidate = next(c for c in result.candidates if c.id == result.recommended_id)
    assert candidate.validated and candidate.payback_met and not candidate.payback_why_not
    assert candidate.incremental_cost_rub < 0
    assert 0 <= candidate.payback_years <= result.horizon_years
    assert all(a.payback_met and a.runs == 6 for a in candidate.assessments)
    assert candidate.payback_years == max(a.payback_years for a in candidate.assessments)

    runner = clinic.Prepared(
        clinic_contract.from_schema(request.building), cleaner_id=candidate.cleaner_id, operation_ids=["cleaning"]
    )
    reference_costs, reference_terms = [], []
    account_request = MoneyRequest(
        operation_ids=["cleaning"],
        building=request.building,
        cleaner_id=candidate.cleaner_id,
        assumptions=request.assumptions,
    )
    for profile in [StressProfile(id="nominal", name="База"), *request.stress_profiles]:
        prepared = clinic_conditions.prepare(runner, profile)
        for seed in [*result.training_seeds, *result.validation_seeds]:
            out = prepared.run(0, candidate.cleaners, seed)
            assert not failures(service(out), request)
            account = clinic_money.estimate(
                clinic_conditions.accounts(account_request, profile), outcome=out, include_sources=False
            )
            scenario = next(s for s in account.scenarios if s.id == payment)
            assert scenario.saving_rub > 0
            assert scenario.payback_years is not None and scenario.payback_years <= account.horizon_years
            reference_costs.append(-scenario.saving_rub)
            reference_terms.append(scenario.payback_years)
    assert candidate.incremental_cost_rub == pytest.approx(max(reference_costs))
    assert candidate.payback_years == pytest.approx(max(reference_terms))


def test_preserving_payroll_reports_a_loss_without_blocking_the_best_technical_option():
    request = conditions()
    request.assumptions.cash_realization_share = 0
    result = clinic_optimizer.optimize(request)
    assert result.recommended_id and result.fully_enumerated
    assert result.candidates and all(c.validated and not c.payback_met for c in result.candidates)
    assert all(c.incremental_cost_rub > 0 and c.payback_why_not for c in result.candidates)


@pytest.mark.parametrize("stage", ["training", "validation"])
def test_a_loss_in_one_condition_remains_visible_without_blocking_the_fleet(monkeypatch, stage):
    original = clinic_optimizer.Search.accounts

    def accounts(self, d, c, outcomes, profile=None):
        group = original(self, d, c, outcomes, profile)
        validation = self.deadline == self.start + self.request.time_budget_s
        if profile and profile.id == "adverse" and validation == (stage == "validation"):
            for account in group:
                for scenario in account.scenarios:
                    if scenario.id != "baseline":
                        scenario.saving_rub = -1
                        scenario.payback_years = None
        return group

    monkeypatch.setattr(clinic_optimizer.Search, "accounts", accounts)
    result = clinic_optimizer.optimize(conditions())
    assert result.recommended_id and result.candidates
    for candidate in result.candidates:
        assert candidate.validated and not candidate.payback_met
        assert candidate.payback_years is None
        assert candidate.incremental_cost_range_rub[0] < 0 < candidate.incremental_cost_range_rub[1]
        assert any("Задержки" in reason for reason in candidate.payback_why_not)


@pytest.mark.parametrize("gain,term", [(0, 7), (-1, None), (100, None), (100, 8)])
def test_zero_profit_missing_or_late_payback_is_not_a_profitable_result(gain, term):
    account = SimpleNamespace(
        horizon_years=7, scenarios=[SimpleNamespace(id="purchase", saving_rub=gain, payback_years=term)]
    )
    _, reasons = clinic_optimizer.payback([account], "purchase")
    assert reasons
