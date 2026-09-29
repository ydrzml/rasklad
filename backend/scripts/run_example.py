"""Прогон модели по config/model.yaml: три сценария для каждой операции склада."""

from app.engine.economics import BASELINE, PURCHASE, RAAS, evaluate
from app.engine.model_config import load_full_model, trust_counts, weak_values
from app.settings import settings

MLN = 1_000_000
RUNS = [
    ("Перевозка паллет, Ronavi H1500", "pallet_transport", "ronavi-h1500"),
    ("Мелкоштучный отбор, Ronavi M", "piece_picking", "ronavi-m"),
    ("Уборка полов, Клинботикс 600", "cleaning", "clinbotics-600"),
]
LABELS = {BASELINE: "Без роботов", PURCHASE: "Покупка", RAAS: "Аренда с выкупом"}


def fmt(x, digits=1, scale=1.0, suffix=""):
    return "-" if x is None else f"{x / scale:,.{digits}f}{suffix}".replace(",", " ")


def main():
    model, provenance = load_full_model(settings.config_dir)
    for title, operation, robot in RUNS:
        r = evaluate(model, "warehouse", operation, robot)
        if not r.feasible:
            print(f"\n{title}: парк не покрывает спрос {r.peak_demand:.0f} операций в час")
            continue
        s = r.sizing
        print(
            f"\n{title}: роботов {s.fleet}, высвобождается {s.released_fte:.1f} ставок, операторов {s.operators_fte:.1f}"
        )
        print(
            f"{'Сценарий':<18}{'CAPEX, млн':>12}{'Эффект 1 год':>14}{'Окупаемость':>13}{'ROI по ТЗ':>11}{'TCO, млн':>10}"
        )
        for scenario_id, scenario in r.scenarios.items():
            effect = scenario.years[0].effect if scenario_id != BASELINE else None
            print(
                f"{LABELS[scenario_id]:<18}{fmt(scenario.capex_total, scale=MLN):>12}{fmt(effect, scale=MLN):>14}"
                f"{fmt(scenario.payback_cumulative, 2, suffix=' г'):>13}{fmt(scenario.roi_tz and scenario.roi_tz * 100, 0, suffix='%'):>11}"
                f"{fmt(scenario.tco, scale=MLN):>10}"
            )

    counts = trust_counts(provenance)
    print("\nДоверие к данным: " + ", ".join(f"{level} {count}" for level, count in counts.items() if count))
    print(f"Из них без источника или со спорными источниками: {len(weak_values(provenance))} из {len(provenance)}")


if __name__ == "__main__":
    main()
