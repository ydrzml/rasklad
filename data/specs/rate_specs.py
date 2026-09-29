"""Считает оценку достоверности для каждой характеристики каждого решения.

Берет все найденные значения из sources.csv, сравнивает источники и пишет итог в specs.csv:
оценку (S, A-F), значение для расчета и все варианты, которые нашли.
Значения с пометкой «устарело» в колонке current показываются, но не сравниваются.
Значения с пометкой «аналог» взяты у похожей модели: они тоже не сравниваются и идут в расчет,
только если у самого решения значения нет, с оценкой D.
Правила оценки описаны в docs/data-sources.md.

Запуск: python data/specs/rate_specs.py
"""
from __future__ import annotations

import csv
import re
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent

# Для каждой характеристики: какое значение хуже для окупаемости.
# min - хуже меньшее (скорость, время работы), max - хуже большее (габариты, время зарядки).
FIELDS = {
    "payload_kg": "min",
    "max_speed_m_s": "min",
    "throughput": "min",
    "runtime_h": "min",
    "charge_time_h": "max",
    "dimensions_mm": "max",
    "min_aisle_width_mm": "max",
    "positioning_accuracy_mm": "max",
    "lift_height_mm": "min",
    "robot_mass_kg": "max",
    "navigation_type": None,
}

RATING_NAMES = {
    "S": "Эталон",
    "A": "Проверено",
    "B": "Подтверждено",
    "C": "Один источник",
    "D": "Слабо",
    "E": "Спорно",
    "F": "Нет данных",
}

TOLERANCE = 0.10
EMPTY = {"", "не найдено", "н/п"}
OLD, ANALOG = "устарело", "аналог"
INDEPENDENT = {"независимая проверка", "эксплуатант"}


def parse_numbers(field: str, value: str):
    nums = [float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", value)]
    if not nums:
        return None
    if field == "dimensions_mm":
        return tuple(sorted(nums[:3], reverse=True)) if len(nums) >= 3 else None
    return (min(nums[:2]), max(nums[:2]))


def close_enough(field: str, a, b) -> bool:
    if field == "dimensions_mm":
        return all(abs(x - y) <= TOLERANCE * max(x, y) for x, y in zip(a, b))
    tol = TOLERANCE * max(a[1], b[1])
    return a[0] <= b[1] + tol and b[0] <= a[1] + tol


def worst_value(field: str, rows: list[dict]) -> dict:
    if field == "dimensions_mm":
        return max(rows, key=lambda r: max(r["_nums"]))
    if FIELDS[field] == "min":
        return min(rows, key=lambda r: r["_nums"][0])
    return max(rows, key=lambda r: r["_nums"][1])


def is_worse(field: str, a: dict, b: dict) -> bool:
    """Значение a хуже для окупаемости, чем b, больше чем на допуск."""
    if field == "dimensions_mm":
        return max(a["_nums"]) > max(b["_nums"]) * (1 + TOLERANCE)
    if FIELDS[field] == "min":
        return a["_nums"][0] < b["_nums"][0] * (1 - TOLERANCE)
    return a["_nums"][1] > b["_nums"][1] * (1 + TOLERANCE)


def pick_value(field: str, active: list[dict], conflict: bool) -> tuple[dict, str]:
    """Какое значение идет в расчет.

    По ответам организатора приоритет у его данных. Исключение: актуальная страница
    производителя дает значение хуже, тогда берем его, за худшую цифру отвечаем мы.
    Если у организатора значения нет, берем производителя, а при расхождении худшее.
    """
    numeric = [r for r in active if r.get("_nums")]
    org = [r for r in active if r["source_type"] == "организатор"]
    if org:
        org_num = [r for r in org if r.get("_nums")]
        if FIELDS[field] and org_num:
            base = worst_value(field, org_num)
            fresh = [r for r in numeric if r["source_type"] == "производитель" and r.get("current") == "да"]
            if fresh:
                w = worst_value(field, fresh)
                if is_worse(field, w, base):
                    return w, "актуальная страница производителя хуже данных организатора"
            return base, "данные организатора"
        return org[0], "данные организатора"
    if conflict and numeric:
        return worst_value(field, numeric), "значение хуже для окупаемости"
    return next((r for r in active if r["source_type"] == "производитель"), active[0]), ""


def label(row: dict) -> str:
    return {OLD: ", устарело", ANALOG: ", аналог"}.get(row.get("current", ""), "")


def rate(field: str, rows: list[dict], tested: bool) -> dict:
    found = [r for r in rows if r["value"].strip().lower() not in EMPTY]
    if not found:
        return {"rating": "F", "value": "", "unit": "", "types": "", "all": "", "reason": "значение не опубликовано"}

    all_values = "; ".join(
        f'{r["value"]} {r["unit"]} ({r["source_type"]}{label(r)})'.replace("  ", " ")
        for r in found)

    # Устаревшие значения и значения похожих моделей показываем, но не сравниваем.
    active = [r for r in found if r.get("current") not in (OLD, ANALOG)]
    analogs = [r for r in found if r.get("current") == ANALOG]
    if not active and analogs:
        numeric = [dict(r, _nums=parse_numbers(field, r["value"])) for r in analogs]
        numeric = [r for r in numeric if r["_nums"]] if FIELDS[field] else []
        chosen = worst_value(field, numeric) if numeric else analogs[0]
        return {"rating": "D", "value": chosen["value"], "unit": chosen["unit"], "types": "аналог",
                "all": all_values, "reason": f"у решения значение не опубликовано, берем у похожей модели: {chosen['note']}"}
    if not active:
        return {"rating": "F", "value": "", "unit": "", "types": "", "all": all_values,
                "reason": "есть только устаревшие значения"}

    # СМИ учитываем, только если других источников нет.
    if any(r["source_type"] != "СМИ" for r in active):
        active = [r for r in active if r["source_type"] != "СМИ"]
    types = {r["source_type"] for r in active}

    conflict = False
    if FIELDS[field]:
        active = [dict(r, _nums=parse_numbers(field, r["value"])) for r in active]
        numeric = [r for r in active if r["_nums"]]
        conflict = any(not close_enough(field, a["_nums"], b["_nums"])
                       for i, a in enumerate(numeric) for b in numeric[i + 1:])

    chosen, why = pick_value(field, active, conflict)
    fcbas = "; решение испытано ФЦ БАС, это подтверждает работоспособность, но не цифры" if tested else ""

    if conflict:
        rating, reason = "E", f"источники расходятся больше чем на 10%, в расчете: {why}"
    elif {"организатор", "производитель"} <= types and types & INDEPENDENT:
        rating, reason = "S", "сходятся организатор, производитель и независимый источник"
    elif {"производитель"} | INDEPENDENT <= types:
        rating, reason = "S", "сходятся производитель, независимая проверка и эксплуатант"
    elif {"организатор", "производитель"} <= types:
        rating, reason = "A", "сходятся организатор и производитель"
    elif "производитель" in types and types & INDEPENDENT:
        rating, reason = "A", "производитель и независимый источник"
    elif len(types) >= 2:
        rating, reason = "B", f"сходятся источники: {', '.join(sorted(types))}"
    elif types & {"производитель", "интегратор"}:
        rating, reason = "C", f"только {next(iter(types))}"
    else:
        rating, reason = "D", f"только {next(iter(types))}"

    return {"rating": rating, "value": chosen["value"], "unit": chosen["unit"], "types": ", ".join(sorted(types)),
            "all": all_values, "reason": reason + fcbas}


def main() -> None:
    with (HERE / "sources.csv").open(encoding="utf-8-sig", newline="") as f:
        sources = list(csv.DictReader(f, delimiter=";"))
    with (HERE / "catalog_marks.csv").open(encoding="utf-8-sig", newline="") as f:
        tested_ids = {m["catalog_id"] for m in csv.DictReader(f, delimiter=";") if m["tested_fcbas"] == "1"}

    # Группируем по номеру решения: одно и то же решение в разных источниках названо по-разному.
    grouped = defaultdict(list)
    for r in sources:
        if r["field"] in FIELDS:
            grouped[(r["catalog_id"], r["field"])].append(r)

    result = []
    for (catalog_id, field), rows in grouped.items():
        product = rows[0]["product"]
        if all(r["value"].strip().lower() == "н/п" for r in rows):
            continue
        x = rate(field, rows, tested=catalog_id in tested_ids)
        result.append({"catalog_id": catalog_id, "product": product, "field": field, "rating": x["rating"],
                       "rating_name": RATING_NAMES[x["rating"]], "value": x["value"], "unit": x["unit"],
                       "source_types": x["types"], "all_values": x["all"], "reason": x["reason"]})

    with (HERE / "specs.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(result[0]), delimiter=";")
        writer.writeheader()
        writer.writerows(result)

    changed = sync_catalog(result)
    counts = Counter(r["rating"] for r in result)
    print(f"решений: {len({r['catalog_id'] for r in result})}, характеристик: {len(result)}")
    for k in RATING_NAMES:
        print(f"  {k} {RATING_NAMES[k]}: {counts.get(k, 0)}")
    print(f"в каталоге склада обновлено значений: {changed}")


def sync_catalog(result: list[dict]) -> int:
    """Переносит значения и оценки в data/catalog/warehouse.csv: по нему работает подбор."""
    path = HERE.parent / "catalog" / "warehouse.csv"
    with path.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f, delimiter=";"))
    rated = {(r["catalog_id"], r["field"]): r for r in result}
    changed = 0
    for row in rows:
        for field in FIELDS:
            spec = rated.get((row["id"], field))
            if spec is None or field not in row:
                continue
            if (row[field], row[f"{field}_trust"]) != (spec["value"], spec["rating"]):
                row[field], row[f"{field}_trust"] = spec["value"], spec["rating"]
                changed += 1
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter=";", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    return changed


if __name__ == "__main__":
    main()
