"""Выход на режим: первые месяцы после запуска роботы дают не весь эффект.

Маршруты и расписание настраивают по живой работе, люди привыкают к роботам. Пока так, людей
с операции отпускают не сразу, а затраты на роботов идут полностью с первого месяца. Поэтому в первый
год часть людей, которых роботы заменят, еще на зарплате: это и есть потеря от выхода на режим.

доля в месяц m = s + (1 - s) * (m - 1) / k для m <= k, дальше 1
    s  доля эффекта в первый месяц, k  через сколько месяцев выход на полный эффект
среднее за первый год = (сумма долей за 12 месяцев) / 12
люди, которые еще на операции = (люди без роботов - люди с роботами) * (1 - среднее)

Вид задачи: station, если человек остается у станции (товар к человеку): там перестраивают процесс,
выход дольше. Иначе simple: перевозка, уборка. Помесячных процентов никто не публикует, значения
в config/model.yaml с оценкой F, пользователь их правит.
"""

from __future__ import annotations

MONTHS = 12


def kind(operation: dict) -> str:
    return "station" if operation.get("productivity_after") else "simple"


def shares(first_month: float, months: float) -> list[float]:
    """Доля эффекта по месяцам первого года."""
    k = int(months)
    if k <= 0:
        return [1.0] * MONTHS
    return [first_month + (1 - first_month) * (m - 1) / k if m <= k else 1.0 for m in range(1, MONTHS + 1)]


def first_year_share(model: dict, operation: dict) -> float:
    """Какую долю эффекта роботы дают в первый год. Нет раздела ramp_up в модели: весь эффект."""
    ramp = (model.get("ramp_up") or {}).get(kind(operation))
    if not ramp:
        return 1.0
    return sum(shares(ramp["first_month_share"], ramp["months"])) / MONTHS
