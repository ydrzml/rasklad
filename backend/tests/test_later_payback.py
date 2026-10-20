"""Не окупается за горизонт: досчитываем до 10 лет и говорим, на каком году вернутся вложения.

Руками, склад по умолчанию, Ronavi H1500 по 12 млн, кредит 15% на 60 месяцев: за 5 лет долг с
процентами не покрыт. На 10 годах парк покупается заново по сроку службы, в 7-й год, а не в 5-й по
сроку амортизации, и вложения возвращаются через 9,03 года. Ровно то же число, что при горизонте 10,
выставленном руками. До 20.10.2026 парк меняли по сроку амортизации, в 5-й год, и выходило 8,8 года:
к 9-му году в обоих случаях оплачен один новый парк, но в 7-й год он дороже на два года инфляции,
а АКБ меняется в 6-й год, а не в 8-й.
С 19.10.2026 склад по умолчанию снова работает 365 дней по 22 часа (режим датасета), экономия больше,
и при 6 млн за робота кредит окупается уже за 2,9 года, а при 10 млн за 4,96, поэтому пример взят дороже.
"""

from types import SimpleNamespace

import pytest

from app.reports.content import payback_words
from app.reports.words import about_years
from app.schemas.economics import CalculationRequest
from app.services.calculation import calculate

# economics.later_payback_years в config/model.yaml
LATER_HORIZON_YEARS = 10

PRICE = "robots.ronavi-h1500.price_rub"


def purchase(overrides: dict[str, float]):
    result = calculate(CalculationRequest(overrides=overrides))
    return result, next(one for one in result.scenarios if one.id == "purchase")


def test_loan_that_pays_back_later_gets_the_year_from_the_longer_horizon():
    loan = {PRICE: 12_000_000, "financing.method": 1}
    result, scenario = purchase(loan)
    assert result.horizon_years == 5
    assert scenario.payback_cumulative_years is None
    assert result.later_horizon_years == LATER_HORIZON_YEARS
    _, longer = purchase({**loan, "economics.horizon_years": LATER_HORIZON_YEARS})
    assert scenario.payback_later_years == pytest.approx(longer.payback_cumulative_years)
    assert 9.0 < scenario.payback_later_years < 9.1

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


def test_paying_back_after_the_horizon_is_named_the_same_way_everywhere():
    """Дольше горизонта: интервал по ТЗ "более 5 лет", а в выводе и в отчетах примерно целыми годами"""
    _, scenario = purchase({PRICE: 12_000_000, "financing.method": 1})
    assert scenario.verdict.band == "более 5 лет"
    assert "окупится примерно за 9 лет, дольше горизонта расчета в 5 лет" in scenario.verdict.text
    assert payback_words(scenario, 5) == "примерно 9 лет, дольше горизонта расчета в 5 лет"


def test_payback_words_for_each_case():
    def one(within, later):
        return SimpleNamespace(payback_cumulative_years=within, payback_later_years=later)

    assert payback_words(one(2.94, None), 5) == "2,9 года"
    assert payback_words(one(None, 7.3), 5) == "примерно 7 лет, дольше горизонта расчета в 5 лет"
    # 5,2 года при горизонте 5 не "примерно 5 лет": не меньше года после горизонта
    assert payback_words(one(None, 5.2), 5) == "примерно 6 лет, дольше горизонта расчета в 5 лет"
    assert payback_words(one(None, None), 5) == "не окупается"
    assert about_years(10.0, 5) == "10 лет"
    assert about_years(1.2, 0) == "1 год"
