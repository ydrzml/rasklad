"""Бюджет на старте: сколько роботов в него влезает со всеми вложениями и что они вытянут."""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.plan import Plan


class BudgetFitRequest(BaseModel):
    """Проверка решений одной задачи против бюджета до расчета: для карточек на шаге решения."""

    facility_id: str = "warehouse"
    operation_id: str = "pallet_transport"
    # Решений у одной задачи в каталоге несколько десятков. Без потолка 20 000 номеров в запросе
    # считались 40 секунд: адрес открыт гостю
    robot_ids: list[str] = Field(
        max_length=100, description="Решения, которые проверяем: у карточек с расчетными параметрами"
    )
    budget_rub: float | None = Field(
        default=None,
        gt=0,
        le=1e12,
        description="Бюджет на старте в рублях, не больше триллиона. Пусто: только парк по формуле, без подбора под бюджет",
    )
    overrides: dict[str, float] = Field(default_factory=dict, description="Правки параметров, как в расчете")
    plan: Plan | None = Field(default=None, description="План объекта: от него длина маршрута и парк по формуле")
    share: float = Field(default=1.0, gt=0, le=1, description="Доля объема задачи у решения при смешанном парке")


class BudgetFit(BaseModel):
    """Сколько роботов одного решения влезает в бюджет со всеми вложениями на старте.

    Вложения считаются как в экономике покупки: роботы, зарядки, ПО, станции, пусконаладка,
    переобучение дежурных, общее на объект (интеграция, инфраструктура) и резерв на все.
    """

    robot_id: str
    fleet_needed: int | None = Field(description="Парк по формуле под спрос задачи; пусто: не сходится")
    fleet_fits: int = Field(description="Самый большой парк, чьи вложения на старте покупкой не больше бюджета")
    investment_rub: float = Field(description="Вложения на старте покупкой при парке fleet_fits")
    investment_needed_rub: float | None = Field(description="Вложения на старте покупкой при нужном парке")
    raas_start_rub: float | None = Field(description="Вложения на старте при аренде; пусто: аренды у решения нет")
    raas_fits: bool | None = Field(description="Укладывается ли старт аренды в бюджет")


class BudgetTask(BaseModel):
    """Задача расчета под бюджетом: парк по бюджету и что он вытянет за смену по прогону."""

    operation_id: str
    operation_name: str
    robot_id: str
    share: float = 1.0
    fleet_needed: int = Field(description="Парк задачи из расчета")
    fleet_fits: int = Field(
        description="Сколько роботов этой задачи влезает в бюджет, если остальные задачи оставить как есть"
    )
    investment_rub: float = Field(description="Вложения объекта на старте покупкой при парке fleet_fits")
    done_share: float | None = Field(
        description="Какую долю спроса смены вытянет парк fleet_fits по прогону; пусто: прогона не было"
    )
    ops_per_hour: float | None = Field(description="Сколько операций в час сделал парк fleet_fits за смену")


class BudgetCheck(BaseModel):
    """Итог по бюджету в ответе расчета."""

    budget_rub: float
    purchase_fits: bool = Field(description="Покупка целиком укладывается в бюджет")
    raas_fits: bool | None = Field(description="Аренда укладывается; пусто: сценария аренды нет")
    tasks: list[BudgetTask] = Field(
        default_factory=list, description="По задачам, только когда покупка целиком не влезла"
    )
