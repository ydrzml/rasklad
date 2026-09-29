"""Показатели по денежному потоку на маленьких примерах, посчитанных руками."""

import pytest

from app.engine.economics import metrics
from app.reports.content import irr_text


def test_simple_payback_is_investment_over_first_year_effect():
    assert metrics.simple_payback(100, 40) == pytest.approx(2.5)
    assert metrics.simple_payback(0, 40) == 0
    # эффект нулевой или отрицательный: не окупается
    assert metrics.simple_payback(100, 0) is None
    assert metrics.simple_payback(100, -5) is None


def test_cumulative_payback_counts_a_share_of_the_year():
    # -100, потом по 40: после двух лет не хватает 20, за третий год добираем 20 из 40
    assert metrics.cumulative_payback([-100, 40, 40, 40]) == pytest.approx(2.5)
    # окупились ровно за год
    assert metrics.cumulative_payback([-100, 100]) == pytest.approx(1.0)
    assert metrics.cumulative_payback([-100, 150]) == pytest.approx(100 / 150)


def test_cumulative_payback_survives_a_bad_year_in_the_middle():
    # год 2 с выкупом ушел в минус: -100 + 60 = -40, -40 - 10 = -50, в году 3 добираем 50 из 60
    assert metrics.cumulative_payback([-100, 60, -10, 60]) == pytest.approx(2 + 50 / 60)


def test_cumulative_payback_none_when_horizon_is_too_short_and_zero_without_investment():
    assert metrics.cumulative_payback([-100, 10, 10]) is None
    assert metrics.cumulative_payback([-100, -10, -10]) is None
    assert metrics.cumulative_payback([0, 5]) == 0.0
    assert metrics.cumulative_payback([10, 5]) == 0.0


def test_npv_by_hand():
    assert metrics.npv(0.1, [-100, 110]) == pytest.approx(0)
    assert metrics.npv(0, [-100, 30, 30]) == pytest.approx(-40)
    # 50 / 1.1 + 50 / 1.21 = 45.4545 + 41.3223 = 86.7769
    assert metrics.npv(0.1, [-80, 50, 50]) == pytest.approx(6.7769, abs=1e-4)


def test_irr_by_hand():
    assert metrics.irr([-100, 150]) == pytest.approx(0.5, abs=1e-6)
    # 60/(1+r) + 60/(1+r)^2 = 100: x = 1/(1+r) = (-60 + sqrt(3600 + 24000)) / 120 = 0.884430, r = 0.130662
    assert metrics.irr([-100, 60, 60]) == pytest.approx(0.130662, abs=1e-5)
    assert metrics.npv(metrics.irr([-100, 60, 60]), [-100, 60, 60]) == pytest.approx(0, abs=1e-4)


def test_irr_is_none_without_a_sign_change():
    assert metrics.irr([100, 50]) is None  # вложений нет
    assert metrics.irr([-100, -50]) is None  # одни убытки


@pytest.mark.parametrize(
    "payback, band",
    [
        (None, "не окупается"),
        (0.0, "до 3 лет"),
        (2.99, "до 3 лет"),
        (3.0, "3-5 лет"),
        (5.0, "3-5 лет"),
        (5.01, "более 5 лет"),
        (40, "более 5 лет"),
    ],
)
def test_payback_band_boundaries(payback, band):
    assert metrics.payback_band(payback, [3, 5]) == band


@pytest.mark.parametrize(
    "irr, npv, investment, text",
    [
        (0.8115, 84.9e6, 40.6e6, "81%"),  # покупка на эталоне по плану
        (2.0873, 87.7e6, 11.5e6, "больше 100%"),  # аренда: вложения малы, возвращаются за полгода
        (1.0, 1.0, 1.0, "100%"),
        (None, 1.0, 1.0, "больше 100%"),  # выше 1000% ставку не ищем
        (None, -1.0, 1.0, "не окупается"),
        (None, 1.0, 0.0, "вложений нет"),  # господдержка закрыла все вложения
    ],
)
def test_irr_text(irr, npv, investment, text):
    assert irr_text(irr, npv, investment) == text
