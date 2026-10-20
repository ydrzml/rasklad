"""Слова о сроках, общие для экрана, отчетов и вывода расчета. Без импортов из сервисов: их берет и расчет."""


def years_word(whole: int) -> str:
    tail = whole % 100
    if 11 <= tail <= 14:
        return "лет"
    return "год" if whole % 10 == 1 else "года" if 2 <= whole % 10 <= 4 else "лет"


def about_years(value: float, horizon: int) -> str:
    """Окупаемость дольше горизонта целыми годами: 7,3 это "7 лет". Не меньше года после горизонта,
    иначе 5,2 при горизонте 5 читалось бы как "примерно 5 лет, дольше 5 лет"."""
    whole = max(int(value + 0.5), horizon + 1)
    return f"{whole} {years_word(whole)}"
