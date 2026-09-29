"""Экономический расчет: парк, персонал, CAPEX, OPEX и показатели трех сценариев по ТЗ."""

from app.engine.economics.scenarios import BASELINE, PURCHASE, RAAS, Comparison, Scenario, evaluate

__all__ = ["BASELINE", "PURCHASE", "RAAS", "Comparison", "Scenario", "evaluate"]
