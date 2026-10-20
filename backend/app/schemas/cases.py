from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.economics import CalculationRequest, CalculationResult, ScenarioResult
from app.schemas.plan import Measures, Plan


class DemoCase(BaseModel):
    """Готовый разбор для гостя: тот же расчет, что мастер дает на значениях по умолчанию."""

    id: str
    request: CalculationRequest = Field(description="Запрос расчета: с ним мастер и отчеты посчитают то же самое")
    plan: Plan
    measures: Measures
    result: CalculationResult = Field(description="Расчет при покупке за свои деньги, как в мастере по умолчанию")
    financing: dict[str, ScenarioResult] = Field(
        default_factory=dict,
        description="Покупка тех же роботов в кредит (loan) и в лизинг (leasing): тот же расчет с другим способом оплаты",
    )
    computed_at: datetime
