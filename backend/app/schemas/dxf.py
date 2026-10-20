"""Чертеж DXF для подложки: что сервер отдает экрану после разбора файла."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class DxfUnits(BaseModel):
    code: int = Field(description="Код единицы из $INSUNITS: 4 мм, 5 см, 6 м, 1 дюймы, 2 футы, 14 дм")
    name: str
    factor_m: float = Field(description="Сколько метров в одной единице чертежа")
    source: Literal["file", "guess", "unknown"] = Field(
        description="Откуда единицы: записаны в файле, угаданы по размеру здания или определить не удалось"
    )


class DxfLayer(BaseModel):
    name: str
    lines: int = Field(description="Сколько ломаных на слое")
    texts: int = Field(description="Надписей на слое: они не рисуются")
    fills: int = Field(description="Штриховок и заливок на слое: они не рисуются")
    role: Literal["", "walls", "racks", "doors", "noise"] = Field(
        description="Что за слой по имени: стены, стеллажи, ворота, размеры и штамп; пусто если неясно"
    )
    on: bool = Field(description="Включать ли слой сразу")
    off_in_file: bool = Field(description="В самом чертеже слой выключен или заморожен")
    box: list[float] = Field(description="Рамка слоя в единицах чертежа от юго-западного угла чертежа: x0, y0, x1, y1")
    d: str = Field(description="Линии слоя как путь SVG в единицах чертежа, ноль в левом верхнем углу, y вниз")


class DxfDrawing(BaseModel):
    units: DxfUnits
    width: float = Field(description="Ширина всего чертежа в единицах чертежа")
    height: float
    layers: list[DxfLayer]
    far_away: int = Field(description="Сколько ломаных далеко за пределами чертежа убрано")
    skipped: dict[str, int] = Field(description="Объекты, которые не умеем рисовать, по видам")


class DxfBuiltItem(BaseModel):
    """Вещь плана в метрах от юго-западного угла здания: экран сдвигает ее на угол здания на листе"""

    id: str
    kind: Literal["racks", "dock", "buffer"]
    x: float
    y: float
    w: float
    h: float
    rows: str = "y"
    row_m: float = 0.0
    block_rows: int = 1
    aisle_m: float = 0.0
    role: str = ""


class DxfBuilt(BaseModel):
    width_m: int = Field(description="Рамка здания по длинам, метры")
    length_m: int
    outline: list[tuple[int, int]] = Field(
        description="Контур здания точками, если он не прямоугольник; пусто значит прямоугольник"
    )
    items: list[DxfBuiltItem]
    warnings: list[str] = Field(description="Что не удалось прочитать или пришлось приблизить, словами для человека")
    counts: dict[str, int]
    turn_deg: float = Field(description="На сколько градусов чертеж развернули по стенам, ноль значит не разворачивали")
