"""Критерии сравнения парков: фиксированная когорта заявок и худший прогон."""

from app.schemas.clinic import OptimizationCandidate, OptimizationRequest, ServiceScore


def service(outcome) -> ServiceScore:
    until = outcome.result.hours * 3600
    due = [job for job in outcome.result.jobs if job.deadline_s <= until]
    urgent = [job for job in due if job.urgent]
    area = sum(one.area_m2 for one in outcome.kpi.cleaning)
    return ServiceScore(
        on_time_share=sum(job.on_time for job in due) / len(due) if due else None,
        urgent_on_time_share=sum(job.on_time for job in urgent) / len(urgent) if urgent else None,
        completion_share=sum(job.done_s is not None for job in due) / len(due) if due else None,
        cleaning_coverage=min(1.0, outcome.kpi.cleaned_m2 / area) if area else None,
        overdue_unfinished=sum(job.done_s is None for job in due),
        carryover_jobs=sum(job.done_s is None and job.deadline_s > until for job in outcome.result.jobs),
    )


def worst(scores: list[ServiceScore]) -> ServiceScore:
    def lowest(key):
        return min((v for score in scores if (v := getattr(score, key)) is not None), default=None)

    return ServiceScore(
        on_time_share=lowest("on_time_share"),
        urgent_on_time_share=lowest("urgent_on_time_share"),
        completion_share=lowest("completion_share"),
        cleaning_coverage=lowest("cleaning_coverage"),
        overdue_unfinished=max((s.overdue_unfinished for s in scores), default=0),
        carryover_jobs=max((s.carryover_jobs for s in scores), default=0),
    )


def failures(score: ServiceScore, request: OptimizationRequest) -> list[str]:
    reasons = []
    for key, target, label in (
        ("on_time_share", request.on_time_target, "Заявки вовремя"),
        ("urgent_on_time_share", request.urgent_on_time_target, "Срочные заявки вовремя"),
        ("completion_share", request.completion_target, "Завершение заявок со сроком внутри смены"),
        ("cleaning_coverage", request.cleaning_target, "Покрытие уборки"),
    ):
        value = getattr(score, key)
        if value is not None and value + 1e-9 < target:
            reasons.append(f"{label}: {value:.1%}, требуется {target:.1%}")
    return reasons


def rank(candidate: OptimizationCandidate, objective: str) -> tuple:
    cost = (
        candidate.incremental_npv_cost_rub
        if candidate.incremental_npv_cost_rub is not None
        else candidate.incremental_cost_rub
    )
    hours = candidate.released_hours_year
    count = candidate.fleet + sum(candidate.cleaners.values())
    return (cost, -hours, count, candidate.id) if objective == "min_cost" else (-hours, cost, count, candidate.id)


def efficient_counts(options):
    """Отсекаем только парк не дешевле и с не меньшей помощью на каждом подборочном seed."""
    return [
        one
        for one in options
        if not any(
            other[0] <= one[0]
            and all(a <= b + 1e-9 for a, b in zip(other[1], one[1], strict=True))
            and (other[0] < one[0] or any(a < b - 1e-9 for a, b in zip(other[1], one[1], strict=True)))
            for other in options
            if other is not one
        )
    ]
