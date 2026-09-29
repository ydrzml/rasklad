"""Что подготовить на складе до роботов: запрос и ответ."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.plan import Plan


class ReadinessRobot(BaseModel):
    robot_id: str
    fleet: int = Field(
        ge=0,
        le=250,
        description="Парк этого решения из расчета: по нему число зарядок и прогон смены. Ноль: роботы не нужны",
    )
    share: float = Field(
        default=1.0,
        gt=0,
        le=1,
        description="Доля объема задачи у этого решения в смешанном парке: прогон идет на эту долю спроса",
    )


class ReadinessTask(BaseModel):
    """Задача и решения на нее. Сейчас на задачу одно решение; когда парк станет смешанным, требования
    каждого решения попадут в список своими пунктами, и строже всех будет самый требовательный робот."""

    operation_id: str
    robots: list[ReadinessRobot] = Field(min_length=1)


class ReadinessRequest(BaseModel):
    facility_id: str = "warehouse"
    tasks: list[ReadinessTask] = Field(min_length=1)
    plan: Plan | None = Field(default=None, description="План объекта. Если его нет, берем типовой по шаблону")
    overrides: dict[str, float] = Field(default_factory=dict, description="Правки параметров, как в расчете")


class ReadinessItem(BaseModel):
    id: str
    title: str
    status: Literal["ready", "check", "redo"] = Field(description="Готово, проверить или переделать")
    why: str = Field(description="Что не так или почему готово, словами для инженера склада")
    basis: str = Field(description="По какой проверке плана или характеристике робота, с оценкой и источником")
    cost: str = Field(default="", description="Сколько стоит, если у цены есть источник")
    cost_note: str = Field(default="", description='Из чего сложилась сумма, или "нет источника"')
    trust: str = Field(default="", description="Оценка доверия характеристики, на которой держится пункт")
    link: str = Field(default="", description="Полный адрес источника основания, если он есть")
    solution: str = Field(default="", description="К какому решению пункт; пусто у пунктов про план")


class ReadinessResult(BaseModel):
    items: list[ReadinessItem]
    counts: dict[str, int] = Field(description="Сколько пунктов в каждом статусе: redo, check, ready")
    plan_edited: bool = Field(description="План рисовал человек; если нет, пункты про план по типовой планировке")
    budget_note: str = Field(
        default="", description="Что на подготовку уже заложено в экономике и насколько этому можно верить"
    )
