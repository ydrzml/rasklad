"""Не окупается за горизонт: досчитываем до 10 лет и говорим, на каком году вернутся вложения.

Руками, склад по умолчанию, Ronavi H1500 по 10 млн, кредит 15% на 60 месяцев: за 5 лет долг с
процентами не покрыт. На 10 годах в 5-й год парк покупается заново, и вложения возвращаются
через 9,0 года, то есть на 10-м году. Ровно то же число, что при горизонте 10, выставленном руками.
"""

import pytest

from app.schemas.economics import CalculationRequest
from app.services.calculation import LATER_HORIZON_YEARS, calculate

PRICE = "robots.ronavi-h1500.price_rub"


def purchase(overrides: dict[str, float]):
    result = calculate(CalculationRequest(overrides=overrides))
    return result, next(one for one in result.scenarios if one.id == "purchase")


def test_loan_that_pays_back_later_gets_the_year_from_the_longer_horizon():
    loan = {PRICE: 10_000_000, "financing.method": 1}
    result, scenario = purchase(loan)
    assert result.horizon_years == 5
    assert scenario.payback_cumulative_years is None
    assert result.later_horizon_years == LATER_HORIZON_YEARS
    _, longer = purchase({**loan, "economics.horizon_years": LATER_HORIZON_YEARS})
    assert scenario.payback_later_years == pytest.approx(longer.payback_cumulative_years)
    assert 9 < scenario.payback_later_years < 9.1
    # главные цифры ответа остаются за 5 лет
    assert len(scenario.years) == 5


def test_nothing_is_added_when_it_never_pays_back():
    result, scenario = purchase({PRICE: 20_000_000})
    assert result.later_horizon_years == LATER_HORIZON_YEARS
    assert scenario.payback_later_years is None


def test_nothing_is_recounted_when_it_pays_back_within_the_horizon():
    result, scenario = purchase({})
    assert scenario.payback_cumulative_years is not None
    assert result.later_horizon_years is None
    assert scenario.payback_later_years is None


def test_nothing_is_recounted_when_the_horizon_is_already_ten_years():
    result, scenario = purchase({PRICE: 20_000_000, "economics.horizon_years": 10})
    assert result.later_horizon_years is None
    assert scenario.payback_later_years is None
