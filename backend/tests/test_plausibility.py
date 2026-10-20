"""Проверка правдоподобия на шаге 5: итог против диапазонов опубликованных внедрений (аудит Б2)."""

from app.schemas.economics import CalculationRequest
from app.services import calculation, plausibility

PICKING = {"operation_id": "piece_picking", "robot_id": "ronavi-m", "share": 1}
PALLETS = {"operation_id": "pallet_transport", "robot_id": "ronavi-h1500", "share": 1}


def test_every_band_has_two_numbers_and_a_source():
    model, provenance = calculation.model_with_overrides({})
    bands = model["economics"]["plausibility"]
    assert set(bands) == {"payback_years", "staff_cut_share"}
    assert bands["payback_years"] == [2, 3]
    for key, (low, high) in bands.items():
        meta = provenance[f"economics.plausibility.{key}"]
        assert 0 < low < high
        assert meta.date and meta.trust in "SABCD"
        assert len(meta.source) > 100, key


def test_pallets_show_only_purchase_payback():
    """Кейсы людей собраны по отбору, а окупаемость только у покупки: у одних паллет одна строка."""
    result = calculation.calculate(CalculationRequest(tasks=[PALLETS]))
    checks = {(one.id, one.scenario_id): one for one in result.plausibility}
    assert set(checks) == {("payback_years", "purchase")}
    purchase = next(s for s in result.scenarios if s.id == "purchase")
    assert checks["payback_years", "purchase"].value == purchase.payback_cumulative_years
    low, high = checks["payback_years", "purchase"].low, checks["payback_years", "purchase"].high
    expected = (
        "below"
        if purchase.payback_cumulative_years < low
        else "above"
        if purchase.payback_cumulative_years > high
        else "inside"
    )
    assert checks["payback_years", "purchase"].status == expected


def test_picking_adds_staff_cut_of_the_picking_part():
    result = calculation.calculate(CalculationRequest(tasks=[PALLETS, PICKING]))
    [cut] = [one for one in result.plausibility if one.id == "staff_cut_share"]
    [part] = [one for one in result.tasks if one.operation_id == "piece_picking"]
    assert cut.value == 1 - part.sizing.people_per_shift_after / part.sizing.people_per_shift_before


def test_status_follows_the_band():
    result = calculation.calculate(CalculationRequest(tasks=[PALLETS]))
    model, provenance = calculation.model_with_overrides({})
    purchase = next(s for s in result.scenarios if s.id == "purchase")
    for value, status in ((1.0, "below"), (2.5, "inside"), (4.0, "above"), (None, "above")):
        purchase.payback_cumulative_years = value
        [check] = [one for one in plausibility.check(result, model, provenance) if one.scenario_id == "purchase"]
        assert check.status == status, value
