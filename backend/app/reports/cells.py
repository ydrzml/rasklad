"""Защита книг Excel от чужих формул."""

import re

from openpyxl import Workbook

# Наши формулы только складывают, вычитают и делят ячейки, в том числе с листа "По годам".
# Все остальное, что начинается со знака "=", пришло из текста пользователя (роль в штате, название),
# и Excel не должен это выполнять: =HYPERLINK или вызов внешней программы сработали бы у того, кто открыл файл
REF = r"(?:'[^']+'!)?\$?[A-Z]{1,3}\$?\d+"
OUR_FORMULA = re.compile(rf"={REF}(?:[-+*/]{REF})*")


def defuse(book: Workbook) -> None:
    """Перед сохранением любой книги: чужие формулы становятся текстом, наши остаются формулами."""
    for sheet in book.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "f" and not OUR_FORMULA.fullmatch(str(cell.value)):
                    cell.data_type = "s"
