"""Показатели по денежному потоку: окупаемость, ROI, NPV, IRR."""

from __future__ import annotations


def simple_payback(investment: float, annual_effect: float) -> float | None:
    """Простой срок окупаемости по ТЗ: вложения / годовой эффект первого года. None, если эффект не положительный."""
    if annual_effect <= 0:
        return None
    return max(investment, 0.0) / annual_effect


def cumulative_payback(cash_flows: list[float]) -> float | None:
    """Год, когда накопленный денежный поток выходит в ноль, с долей года.

    cash_flows[0] это вложения в год 0 (со знаком минус), дальше годы 1..H.
    Учитывает рост цен, замену АКБ, выкуп и обновление парка. None: не окупается на горизонте.
    """
    cumulative = cash_flows[0]
    if cumulative >= 0:
        return 0.0
    for t, cf in enumerate(cash_flows[1:], 1):
        if cumulative + cf >= 0 and cf > 0:
            return t - 1 + -cumulative / cf
        cumulative += cf
    return None


def payback_with_debt(cash_flows: list[float], debt: list[float]) -> float | None:
    """Окупаемость с учетом долга: когда накопленный поток своих денег покрыл и остаток долга.

    debt[0] это долг на старте, дальше остаток на конец каждого года. Без долга совпадает с
    cumulative_payback. Проценты в ней учтены: чистая позиция растет на экономию минус проценты.
    """
    position = cash_flows[0] - debt[0]
    if position >= 0:
        return 0.0
    cumulative = cash_flows[0]
    for t, cf in enumerate(cash_flows[1:], 1):
        cumulative += cf
        after = cumulative - debt[t]
        if after >= 0 and after > position:
            return t - 1 + -position / (after - position)
        position = after
    return None


def npv(rate: float, cash_flows: list[float]) -> float:
    return sum(cf / (1 + rate) ** t for t, cf in enumerate(cash_flows))


def irr(cash_flows: list[float], lo: float = -0.99, hi: float = 10.0) -> float | None:
    """Ставка, при которой NPV = 0. None, если на отрезке нет смены знака (например, вложений нет)."""
    f_lo = npv(lo, cash_flows)
    if f_lo * npv(hi, cash_flows) > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid, cash_flows)
        if f_lo * f_mid <= 0:
            hi = mid
        else:
            lo, f_lo = mid, f_mid
        if hi - lo < 1e-9:
            break
    return (lo + hi) / 2


def payback_band(payback: float | None, bands: list[float]) -> str:
    """Интервал окупаемости для вывода: до 3 лет, 3-5 лет, более 5 лет, не окупается."""
    if payback is None:
        return "не окупается"
    fast, slow = bands
    if payback < fast:
        return f"до {fast:g} лет"
    if payback <= slow:
        return f"{fast:g}-{slow:g} лет"
    return f"более {slow:g} лет"
