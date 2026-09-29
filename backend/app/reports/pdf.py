"""Отчет PDF (ТЗ, п. 3.8). Лист как записка: сверху и снизу тонкие строки с тем, что это за отчет,
слева на полях номер и название раздела с пояснением, справа содержимое. Сначала ответ, потом
на чем он держится. Поле слева шире, чтобы отчет можно было подшить.

Для печати: линии не тоньше 0,5 pt, серый текст не светлее --ink-soft, сценарии различаются
не только цветом, но и линией и меткой, поэтому читаются и на черно-белом принтере.
Шрифты те же, что в интерфейсе: Onest для текста, JetBrains Mono для чисел.
"""

from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.graphics.shapes import Circle, Drawing, Line, PolyLine, Rect, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Flowable,
    Frame,
    Indenter,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from app.reports import names
from app.reports.content import (
    CAPEX_NAMES,
    METHOD_NAMES,
    NAMES,
    OPEX_NAMES,
    Report,
    TaskReport,
    delta,
    financed,
    grouped,
    irr_text,
    mln,
    number,
    percent,
    project_irr,
    rub,
    scenario_name,
    term,
    valued,
)

INK = colors.HexColor("#0d141b")
SOFT = colors.HexColor("#55636f")
BLUE = colors.HexColor("#0b4fa8")
LINE = colors.HexColor("#1e4f8e")
HAIR = colors.HexColor("#c9d2db")
BLUE_TINT = colors.HexColor("#eff5fd")
TONES = {"baseline": colors.HexColor("#8795a1"), "purchase": BLUE, "raas": colors.HexColor("#138a6b")}

FONTS = Path(__file__).parent / "fonts"
OWN = {
    "Text": "Onest-Regular.ttf",
    "TextMedium": "Onest-Medium.ttf",
    "TextBold": "Onest-SemiBold.ttf",
    "Mono": "JetBrainsMono-Regular.ttf",
    "MonoMedium": "JetBrainsMono-Medium.ttf",
}

# Поля листа: слева шире, под подшивку. Верхняя и нижняя строки стоят внутри полей
PAGE_W, PAGE_H = A4
FRAME = (22 * mm, 12 * mm, PAGE_W - 14 * mm, PAGE_H - 10 * mm)
PAD = 0
LABEL = 36 * mm  # колонка на полях: номер и название раздела
GAP = 6 * mm


class NoFonts(Exception):
    """Нет файла шрифта: без него PDF выйдет с квадратиками вместо букв"""


def _register() -> None:
    if "Text" in pdfmetrics.getRegisteredFontNames():
        return
    for name, file in OWN.items():
        path = FONTS / file
        if not path.exists():
            raise NoFonts(f"Не найден шрифт {file}: он должен лежать в {FONTS}")
        pdfmetrics.registerFont(TTFont(name, str(path)))


def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle("base", fontName="Text", fontSize=9.5, leading=13.5, textColor=INK)
    return {
        "base": base,
        "soft": ParagraphStyle("soft", parent=base, textColor=SOFT),
        "note": ParagraphStyle("note", parent=base, fontSize=8, leading=11, textColor=SOFT),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.5, leading=11.5),
        "cellsoft": ParagraphStyle("cellsoft", parent=base, fontSize=8, leading=11, textColor=SOFT),
        "num": ParagraphStyle("num", parent=base, fontName="MonoMedium", fontSize=8, leading=11, alignment=2),
        "label": ParagraphStyle("label", parent=base, fontName="Mono", fontSize=7.5, leading=10, textColor=SOFT),
        "title": ParagraphStyle("title", parent=base, fontName="TextBold", fontSize=21, leading=24),
        "answer": ParagraphStyle("answer", parent=base, fontSize=14, leading=20),
        "h3": ParagraphStyle("h3", parent=base, fontName="TextMedium", fontSize=10, leading=13),
        "big": ParagraphStyle("big", parent=base, fontName="MonoMedium", fontSize=22, leading=26),
    }


def _n(text: str) -> str:
    """Число внутри текста: моноширинным, единица остается обычным шрифтом"""
    return f"<font name='MonoMedium'>{text}</font>"


def render(report: Report) -> bytes:
    _register()
    s = _styles()
    out = BytesIO()
    x0, y0, x1, y1 = FRAME
    inner = x1 - x0 - 2 * PAD
    body = Frame(x0, y0 + 10 * mm, inner, y1 - y0 - 22 * mm, 0, 0, 0, 0)
    doc = BaseDocTemplate(
        out,
        pagesize=A4,
        title=f"Оценка роботизации: {report.facility.name.lower()}, {report.work}",
        author="Расклад",
    )
    doc.addPageTemplates(
        [
            PageTemplate("sheet", [body], onPage=lambda c, d: _sheet(c, report)),
        ]
    )
    main = inner - LABEL - GAP
    story: list = []
    count = iter(range(1, 100))

    def no() -> str:
        return f"{next(count):02d}"

    story += _section(
        "",
        "Объект",
        None,
        [
            Paragraph(f"{_object(report)},<br/>{report.work}", s["title"]),
            Spacer(0, 6),
            Paragraph(_lineup(report), s["soft"]),
        ],
        s,
        first_block=True,
    )
    story += _section(no(), "Ответ", None, [Paragraph(_answer(report), s["answer"])], s)
    story += _section(
        no(),
        "Три сценария",
        f"Стоимость владения это вложения на старте плюс все затраты за {report.result.horizon_years} лет: "
        "люди, операторы, обслуживание, энергия, аренда.",
        [_numbers(report, s, main)],
        s,
    )
    if report.several:
        story += _section(
            no(),
            "По задачам",
            f"{NAMES[report.cheaper.id]}, как дешевле за горизонт. Общее на объект делается один раз: "
            "интеграция с учетной системой, инфраструктура, связь и дежурные операторы на весь парк.",
            [_tasks(report, main)],
            s,
        )
    story += _section(
        no(),
        "Затраты по годам",
        "Сколько всего потрачено к концу каждого года, млн ₽. Где линия с роботами уходит ниже линии "
        "без роботов, вложения окупились.",
        [_chart(report, main)],
        s,
    )
    risks = report.risks
    if risks:
        story += _section(
            no(),
            "Что может сдвинуть вывод",
            None,
            [_numbered([Paragraph(risk, s["base"]) for risk in risks], main)],
            s,
        )
    story += _section(
        no(),
        "Все показатели",
        "Окупаемость по ТЗ: вложения / эффект первого года. По потоку: когда накопленная экономия "
        "перекроет вложения, с ростом цен и выкупом, а в кредит и в лизинг еще и остаток долга.",
        [_compare(report, s, main)],
        s,
    )
    purchase = next((sc for sc in report.scenarios if sc.id == "purchase"), None)
    if purchase is not None and purchase.financing is not None:
        story += _section(
            no(),
            "Как платим и господдержка",
            "Способ оплаты меняет только покупку. От потока своих денег считаются окупаемость, NPV и IRR, "
            "проценты входят в стоимость владения. Условия мер проверяйте у оператора программы.",
            _financing(purchase, s, main),
            s,
        )
    if report.sensitivity:
        story += _section(
            no(),
            "Что будет, если",
            "Одно число сдвигаем на 10 и 20% в обе стороны, остальные оставляем. В ячейке окупаемость, "
            f"под ней стоимость владения за {report.result.horizon_years} лет, млн ₽. При сдвиге объема парк растет "
            "вместе со спросом.",
            _sensitivity(report, s, main),
            s,
        )
    story += _section(
        no(),
        "Объект и параметры",
        "Буква рядом с числом это оценка доверия: S закон или норматив, A проверено, B сходятся два "
        "источника, C один источник, D только организатор или СМИ, E источники расходятся, F наше допущение.",
        [_parameters(report, s, main)],
        s,
    )
    story += _section(no(), "План объекта", None, _plan(report, s, main), s)
    if any(task.shift for task in report.tasks):
        story += _section(
            no(),
            "Смена на плане",
            "Роботы решения едут по плану восемь часов смены с пиком спроса, с очередями и зарядкой. "
            "Прогон подтверждает расчет: парк это самый маленький, который вытянул пик."
            + (" Каждую задачу гоняем своими роботами по тому же плану." if report.several else ""),
            [part for task in report.tasks if task.shift for part in _shift(report, task, s, main)],
            s,
        )
    if report.readiness:
        story += _section(
            no(),
            "Что подготовить на складе",
            "До запуска роботов, по плану, решению и прогону смены. Раздел можно отдать инженеру склада. "
            "Стоимость стоит только там, где у цены есть источник. "
            + ", ".join(f"{READINESS[key][0].capitalize()}: {report.readiness.counts.get(key, 0)}" for key in READINESS)
            + ".",
            _readiness(report, s, main),
            s,
        )
    story += _section(
        no(),
        "Решение и оборудование",
        None,
        [part for task in report.tasks for part in _solution(report, task, s, main)],
        s,
    )
    story += _section(no(), "Из чего сложились затраты", None, [_costs(report, main)], s)
    story += _section(no(), "Штат", None, _staff(report, s, main), s)
    sources = report.result.sources
    story += _section(
        no(),
        "Откуда цифры",
        f"Значений в расчете: {len(sources)}, без подтвержденного источника: {len(report.result.weak_value_paths)}.",
        [_sources(report, s, main)],
        s,
    )
    story += [
        Spacer(0, 14),
        Indenter(left=LABEL + GAP),
        Paragraph(
            "Это предварительная оценка для решения «считать дальше или нет», а не коммерческое предложение. "
            "Для проекта нужны замеры на объекте и предложения поставщиков.",
            s["note"],
        ),
        Indenter(left=-(LABEL + GAP)),
    ]

    doc.build(story, canvasmaker=_Numbered)
    return out.getvalue()


def _object(report: Report) -> str:
    area = next((p.value for p in report.parameters if p.path.endswith("active_area_m2")), None)
    return f"{report.facility.name} {grouped(area)} м2" if area else report.facility.name


def _lineup(report: Report) -> str:
    """Что решили и сколько роботов: одной строкой, а у нескольких задач по строке на задачу"""
    sizing = report.result.sizing
    people = (
        f"Людей на операции в смену {_n(number(sizing.people_per_shift_before))} → "
        f"{_n(number(sizing.people_per_shift_after))}"
    )
    if not report.several:
        return (
            f"Решение {report.robot_name}: {_n(str(sizing.fleet))} {names.plural(sizing.fleet, 'робот', 'робота', 'роботов')} "
            f"и {_n(str(sizing.chargers))} {names.plural(sizing.chargers, 'зарядка', 'зарядки', 'зарядок')}. " + people
        )
    lines = [
        f"{task.operation.name}: {task.robot_name}, {_n(str(task.part.sizing.fleet))} "
        f"{names.plural(task.part.sizing.fleet, 'робот', 'робота', 'роботов')}"
        for task in report.tasks
    ]
    return (
        "<br/>".join(lines)
        + f"<br/>Всего {_n(str(sizing.fleet))} {names.plural(sizing.fleet, 'робот', 'робота', 'роботов')} "
        + f"и {_n(str(sizing.chargers))} {names.plural(sizing.chargers, 'зарядка', 'зарядки', 'зарядок')}, "
        + f"дежурных в смену {_n(str(sizing.operator_posts))}. "
        + people
    )


def _tasks(report: Report, width: float) -> Table:
    """Разбивка по задачам в сценарии, который дешевле за горизонт. Сумму строк посчитал сервер:
    объект целиком это задачи и общее на объект, здесь только раскладываем"""
    cell = _styles()["cell"]
    scenario_id = report.cheaper.id
    whole = report.scenario(scenario_id)
    horizon = report.result.horizon_years
    # суммы в млн ₽ без единицы в каждой ячейке: шесть колонок в ширину листа иначе не встают
    rows: list[list] = [
        ["Задача и решение", "Роботов", "Старт, млн ₽", "В год, млн ₽", f"{horizon} лет, млн ₽", "Окупаемость"]
    ]
    for task in report.tasks:
        part = task.scenario(scenario_id)
        # окупаемость задачи самой по себе, без общего на объект: видно, какая задача не окупается
        rows.append(
            [
                Paragraph(f"{task.title}<br/><font size=7 color='#55636f'>{task.robot_name}</font>", cell),
                str(task.part.sizing.fleet),
                mln(part.investment_year0_rub) if part else "—",
                mln(part.opex_year1_rub) if part else "—",
                mln(part.tco_rub) if part else "—",
                term(part.payback_years) if part else "—",
            ]
        )
    shared = report.result.shared
    common = next((one for one in shared.scenarios if one.id == scenario_id), None) if shared else None
    if shared and common:
        rows.append(
            [
                Paragraph(
                    "Общее на объект<br/><font size=7 color='#55636f'>интеграция, инфраструктура, связь, "
                    f"дежурных в смену {shared.operator_posts}</font>",
                    cell,
                ),
                "",
                mln(common.investment_year0_rub),
                mln(common.opex_year1_rub),
                mln(common.tco_rub),
                "",
            ]
        )
    first = whole.years[0]
    rows.append(
        [
            "Объект целиком",
            str(report.result.sizing.fleet),
            mln(whole.investment_year0_rub),
            mln(first.opex_total_rub),
            mln(whole.tco_rub),
            term(whole.payback_cumulative_years),
        ]
    )
    table = _table(rows, [width * 0.34, width * 0.1, width * 0.13, width * 0.14, width * 0.13, width * 0.16])
    table.setStyle(TableStyle([("FONTNAME", (0, -1), (0, -1), "TextBold"), ("LINEABOVE", (0, -1), (-1, -1), 0.9, INK)]))
    return table


def _answer(report: Report) -> str:
    cheaper = report.cheaper
    baseline = report.scenario("baseline")
    text = (
        f"За {report.result.horizon_years} лет дешевле всего {NAMES[cheaper.id].lower()}: "
        f"{_n(mln(cheaper.tco_rub))} млн ₽ против {_n(mln(baseline.tco_rub))} млн ₽ без роботов."
    )
    if cheaper.payback_cumulative_years is not None:
        text += (
            f" Вложения {_n(mln(cheaper.investment_year0_rub))} млн ₽ возвращаются за "
            f"{_n(term(cheaper.payback_cumulative_years))}."
        )
    else:
        text += " Вложения за горизонт не возвращаются."
    return text


def _section(no: str, title: str, note: str | None, body: list, s: dict, first_block: bool = False) -> list:
    """Раздел записки: слева на полях номер, название и пояснение, справа содержимое.

    Короткий раздел кладем таблицей в две колонки. Длинная таблица в ячейке не переходит на другой
    лист, поэтому у раздела с таблицей подпись рисуется на полях отдельно, а сама таблица идет
    отступом и спокойно делится по листам."""
    head_text = f"<font color='#0b4fa8'>{no}</font>&nbsp;&nbsp;{title.upper()}" if no else title.upper()
    label: list = [Paragraph(head_text, s["label"])]
    if note:
        label += [Spacer(0, 5), Paragraph(note, s["note"])]
    top = [Spacer(0, 6 if first_block else 22), CondPageBreak(45 * mm)]
    if isinstance(body[0], Table):
        return [*top, _Margin(label), Indenter(left=LABEL + GAP), *body, Indenter(left=-(LABEL + GAP))]
    head = Table([[label, body[0]]], colWidths=[LABEL + GAP, None], style=_bare())
    rest: list = []
    if len(body) > 1:
        rest = [Indenter(left=LABEL + GAP), *body[1:], Indenter(left=-(LABEL + GAP))]
    return [*top, head, *rest]


class _Margin(Flowable):
    """Подпись раздела на полях: места по высоте не занимает, рисуется вниз от текущей строки"""

    def __init__(self, items: list):
        super().__init__()
        self.items = items

    def wrap(self, available_width, available_height):
        return available_width, 0

    def draw(self):
        y = 0.0
        for item in self.items:
            _, height = item.wrap(LABEL, 1000)
            item.drawOn(self.canv, 0, y - height)
            y -= height


def _bare() -> TableStyle:
    return TableStyle(
        [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), GAP),
            ("RIGHTPADDING", (1, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]
    )


def _numbers(report: Report, s: dict, width: float) -> Table:
    """Три крупных числа в ряд, между ними волосяные линии. Над дешевым сценарием синяя черта."""
    horizon = report.result.horizon_years
    cheaper = report.cheaper.id
    col = width / 3
    inner = col - 18
    cells = []
    for sc in report.scenarios:
        tone = TONES.get(sc.id, SOFT).hexval()[2:]
        flag = "&nbsp;&nbsp;<font name='Mono' size=6.5 color='#0b4fa8'>ДЕШЕВЛЕ</font>" if sc.id == cheaper else ""
        if sc.id == "baseline":
            facts = [
                ("вложения", "0"),
                ("окупаемость", "—"),
                ("люди, 1 год", mln(sc.years[0].staff_cost_rub)),
            ]
        else:
            facts = [
                ("вложения", mln(sc.investment_year0_rub)),
                ("окупаемость", term(sc.payback_cumulative_years)),
                ("дешевле на", mln(sc.saving_rub or 0)),
            ]
        rows = Table(
            [[Paragraph(label, s["cellsoft"]), Paragraph(value, s["num"])] for label, value in facts],
            colWidths=[inner * 0.55, inner * 0.45],
            style=TableStyle(
                [
                    ("LINEABOVE", (0, 0), (-1, -1), 0.5, HAIR),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 3.5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
                ]
            ),
        )
        spent = f"{mln(sc.investment_year0_rub) if sc.id != 'baseline' else '0'} + {mln(sc.running_cost_rub)}"
        name = scenario_name(sc)
        cells.append(
            [
                Paragraph(f"<font name='Mono' color='#{tone}'>■</font>&nbsp;{name}{flag}", s["h3"]),
                Spacer(0, 6),
                Paragraph(f"{mln(sc.tco_rub)}<font name='Text' size=8 color='#55636f'>&nbsp;млн ₽</font>", s["big"]),
                Paragraph(f"<font name='Mono'>{spent}</font> за {horizon} лет", s["cellsoft"]),
                Spacer(0, 6),
                rows,
            ]
        )
    best = [sc.id for sc in report.scenarios].index(cheaper)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEABOVE", (0, 0), (-1, 0), 0.9, INK),
        ("LINEBEFORE", (1, 0), (-1, 0), 0.5, HAIR),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("LEFTPADDING", (1, 0), (-1, 0), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (-1, 0), (-1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("LINEABOVE", (best, 0), (best, 0), 2.2, BLUE),
    ]
    return Table([cells], colWidths=[col] * 3, style=TableStyle(style))


def _chart(report: Report, width: float) -> Drawing:
    """Накопленные затраты. На черно-белой печати сценарии различаются линией и меткой:
    без роботов пунктир, покупка квадраты, аренда круги. Подписи у концов линий."""
    height = 150
    pad_l, pad_r, pad_t, pad_b = 26, 92, 6, 18
    series = [(sc, sc.cumulative_cost_rub) for sc in report.scenarios if sc.cumulative_cost_rub]
    years = max(len(points) for _, points in series) - 1
    top = _nice(max(max(points) for _, points in series) / 1_000_000)
    drawing = Drawing(width, height)

    def x(year: float) -> float:
        return pad_l + year / years * (width - pad_l - pad_r)

    def y(value: float) -> float:
        return pad_b + value / 1_000_000 / top * (height - pad_t - pad_b)

    for tick in (0, top / 2, top):
        at = y(tick * 1e6)
        base = tick == 0
        drawing.add(
            Line(pad_l, at, width - pad_r, at, strokeColor=INK if base else HAIR, strokeWidth=0.75 if base else 0.5)
        )
        drawing.add(
            String(pad_l - 5, at - 2.5, grouped(tick), fontName="Mono", fontSize=7, fillColor=SOFT, textAnchor="end")
        )
    for year in range(years + 1):
        label = "старт" if year == 0 else f"{year} год"
        drawing.add(String(x(year), 5, label, fontName="Text", fontSize=7, fillColor=SOFT, textAnchor="middle"))

    placed: list[float] = []
    for sc, points in sorted(series, key=lambda item: item[1][-1]):
        tone = TONES.get(sc.id, SOFT)
        flat = [coord for n, value in enumerate(points) for coord in (x(n), y(value))]
        line = PolyLine(flat, strokeColor=tone, strokeWidth=1.4)
        if sc.id == "baseline":
            line.strokeDashArray = [4, 2.5]
        drawing.add(line)
        for n, value in enumerate(points):
            if sc.id == "purchase":
                drawing.add(
                    Rect(
                        x(n) - 2.2, y(value) - 2.2, 4.4, 4.4, fillColor=tone, strokeColor=colors.white, strokeWidth=0.6
                    )
                )
            elif sc.id == "raas":
                drawing.add(Circle(x(n), y(value), 2.4, fillColor=colors.white, strokeColor=tone, strokeWidth=1.1))
        end = y(points[-1])
        if placed and end - placed[-1] < 11:
            end = placed[-1] + 11
        placed.append(end)
        name = scenario_name(sc)
        drawing.add(String(width - pad_r + 8, end - 3, name, fontName="Text", fontSize=8, fillColor=INK))
        shift = pdfmetrics.stringWidth(name + " ", "Text", 8)
        drawing.add(
            String(width - pad_r + 8 + shift, end - 3, mln(points[-1]), fontName="Mono", fontSize=8, fillColor=SOFT)
        )
    return drawing


def _nice(value: float) -> float:
    power = 10 ** (len(str(int(max(value, 1)))) - 1)
    for step in (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if step * power >= value:
            return step * power
    return 10 * power


def _table(rows: list[list], widths: list[float], numbers_from: int | None = 1, head: bool = True) -> Table:
    """Таблица записки: только горизонтальные линии, шапка мелким серым, числа моноширинные справа"""
    style = [
        ("FONTNAME", (0, 0), (-1, -1), "Text"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("LEADING", (0, 0), (-1, -1), 11),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 1 if head else 0), (-1, -1), 0.5, HAIR),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (-1, 0), (-1, -1), 0),
    ]
    if numbers_from is not None:
        style += [
            ("FONTNAME", (numbers_from, 1 if head else 0), (-1, -1), "MonoMedium"),
            ("ALIGN", (numbers_from, 0), (-1, -1), "RIGHT"),
        ]
    if head:
        style += [
            ("FONTNAME", (0, 0), (-1, 0), "Text"),
            ("FONTSIZE", (0, 0), (-1, 0), 7.5),
            ("TEXTCOLOR", (0, 0), (-1, 0), SOFT),
            ("LINEBELOW", (0, 0), (-1, 0), 0.9, INK),
        ]
    return Table(rows, colWidths=widths, repeatRows=1 if head else 0, style=TableStyle(style))


def _compare(report: Report, s: dict, width: float) -> Table:
    scenarios = report.scenarios

    def dash(sc, text: str) -> str:
        return "—" if sc.id == "baseline" else text

    rows = [
        ["Показатель", *[scenario_name(sc) for sc in scenarios]],
        ["Вложения на старте", *[rub(sc.investment_year0_rub) for sc in scenarios]],
        ["Годовой эффект, первый год", *[dash(sc, rub(sc.annual_effect_year1_rub)) for sc in scenarios]],
        ["Окупаемость по ТЗ", *[dash(sc, term(sc.payback_simple_years)) for sc in scenarios]],
        ["Окупаемость по потоку", *[dash(sc, term(sc.payback_cumulative_years)) for sc in scenarios]],
        ["ROI по ТЗ", *[dash(sc, percent(sc.roi_tz)) for sc in scenarios]],
        ["Чистый ROI", *[dash(sc, percent(sc.roi_net)) for sc in scenarios]],
        [f"Стоимость владения за {report.result.horizon_years} лет", *[rub(sc.tco_rub) for sc in scenarios]],
        ["NPV, чистая приведенная стоимость", *[rub(sc.npv_rub) for sc in scenarios]],
        ["IRR проекта, ставка, при которой NPV = 0", *[dash(sc, irr_text(*project_irr(sc))) for sc in scenarios]],
    ]
    if any(financed(sc) for sc in scenarios):
        rows.append(
            [
                "IRR своих денег, от первого взноса",
                *[
                    dash(sc, irr_text(sc.irr, sc.npv_rub, sc.investment_year0_rub) if financed(sc) else "без долга")
                    for sc in scenarios
                ],
            ]
        )
    rows = [[Paragraph(row[0], s["cell"]) if i else row[0], *row[1:]] for i, row in enumerate(rows)]
    first = width * 0.37
    return _table(rows, [first] + [(width - first) / 3] * 3)


def _financing(purchase, s: dict, width: float) -> list:
    plan = purchase.financing
    rows: list[list] = [["", "Значение"]]
    rows.append(["Способ оплаты", METHOD_NAMES.get(plan.method, plan.method)])
    if plan.method != "own":
        rows.append(["Ставка в год", f"{plan.rate * 100:.1f}%".replace(".", ",")])
        rows.append(["Срок", f"{plan.term_months} мес."])
        rows.append(["Вложения на старте", rub(purchase.capex_after_grant_rub)])
        rows.append(["Берем в долг" if plan.method == "loan" else "Берет лизинговая компания", rub(plan.principal_rub)])
        if plan.advance_loan_rub:
            rows.append(["Заем ФРП на аванс", rub(plan.advance_loan_rub)])
        rows.append(["Свои деньги на старте", rub(purchase.investment_year0_rub)])
        rows.append(["Платежи по годам", ", ".join(mln(value) for value in plan.payments_rub) + " млн ₽"])
        rows.append(["Проценты" if plan.method == "loan" else "Удорожание сверх цены", rub(plan.interest_rub)])
        insured = sum(year.insurance_rub for year in purchase.years)
        if insured:
            rows.append(["Страховка залога или предмета лизинга", f"{rub(insured)}, 0,7% цены роботов в год"])
        if plan.markup_year is not None:
            rows.append(["Удорожание в год", f"{plan.markup_year * 100:.1f}%".replace(".", ",")])
    rows.append(
        [
            "Окупаемость с учетом долга" if plan.method != "own" else "Окупаемость по потоку",
            f"{term(plan.plain_payback_years)} за свои без мер, {term(purchase.payback_cumulative_years)} так",
        ]
    )
    if plan.method != "own":
        rows.append(["Свои деньги вернутся за", f"{term(purchase.payback_own_years)}, только первый взнос"])
    for year in plan.weak_cover_years:
        rows.append(
            [
                "Покрытие долга",
                f"в год {year} экономия покрывает платежи банку меньше чем в "
                f"{str(plan.debt_cover_min).replace('.', ',')} раза, банк может не дать кредит",
            ]
        )
    rows.append(["NPV", f"{rub(plan.plain_npv_rub)} за свои без мер, {rub(purchase.npv_rub)} так"])
    table = _table(
        [
            [Paragraph(row[0], s["cell"]) if i else row[0], Paragraph(row[1], s["cell"]) if i else row[1]]
            for i, row in enumerate(rows)
        ],
        [width * 0.4, width * 0.6],
        numbers_from=None,
    )
    measures: list[list] = [["Мера", "Условия", "Итог"]]
    for one in plan.supports:
        if one.blocked:
            measures.append(
                [
                    Paragraph(one.name, s["cell"]),
                    Paragraph(f"для склада в Москве недоступна: {one.blocked}", s["cell"]),
                    Paragraph("недоступна", s["cell"]),
                ]
            )
            continue
        if one.applied:
            what = {"loan_rate": "экономия на процентах", "capex_refund": "вернет через год"}.get(one.kind, "заем")
            result = f"сработала: {what} {mln(one.rub)} млн ₽"
        elif one.chosen:
            result = f"не сработала: {one.reason}" if one.reason else "не сработала"
        else:
            result = "не отмечена"
        measures.append(
            [Paragraph(one.name, s["cell"]), Paragraph(one.conditions, s["cell"]), Paragraph(result, s["cell"])]
        )
    return [
        table,
        Spacer(0, 8),
        _table(measures, [width * 0.28, width * 0.47, width * 0.25], numbers_from=None),
        Spacer(0, 6),
        Paragraph(
            "Налоговые льготы (коэффициент 2 к расходам на российских роботов, ускоренная амортизация в лизинге) "
            "не считаем: налог на прибыль в модели не участвует.",
            s["soft"],
        ),
    ]


def _numbered(items: list, width: float) -> Table:
    """Нумерованный список строками таблицы: номер синим моноширинным на полях строки"""
    table = _table([[str(i), item] for i, item in enumerate(items, 1)], [6 * mm, width - 6 * mm], None, head=False)
    table.setStyle(TableStyle([("FONTNAME", (0, 0), (0, -1), "MonoMedium"), ("TEXTCOLOR", (0, 0), (0, -1), BLUE)]))
    return table


def _value(value: float, unit: str) -> str:
    # Поле-переключатель хранится числом 1 или 0, в отчете пишем словом
    if unit.startswith("1 да"):
        return "да" if value else "нет"
    return f"{number(value, 2)} {unit}"


def _parameters(report: Report, s: dict, width: float) -> Table:
    rows: list[list] = [["Параметр", "Значение", "", "Источник"]]
    for one in report.parameters:
        edited = (
            "<br/><font color='#0b4fa8' size=7.5>поправлено вами</font>" if one.path in report.request.overrides else ""
        )
        rows.append(
            [
                Paragraph(one.label + edited, s["cell"]),
                _value(one.value, one.unit),
                one.trust,
                Paragraph(one.source, s["cellsoft"]),
            ]
        )
    table = _table(rows, [width * 0.28, width * 0.23, width * 0.05, width * 0.44])
    table.setStyle(TableStyle([("ALIGN", (2, 0), (3, -1), "LEFT"), ("TEXTCOLOR", (2, 1), (2, -1), BLUE)]))
    return table


def _plan(report: Report, s: dict, width: float) -> list:
    m = report.measures
    if m is None:
        return [
            Paragraph(
                "План объекта не начерчен: мы взяли типовую планировку по площади. Где на объекте ворота и зоны "
                "хранения, нам неизвестно, поэтому маршрут и парк роботов посчитаны грубее.",
                s["base"],
            )
        ]
    rows = [
        ["Здание", f"{number(m.width_m)} x {number(m.length_m)} м"],
        ["Средний маршрут до буфера у ворот", f"{number(m.route_m)} м"],
        ["Мест у ворот", str(m.docks)],
        ["Проездов между рядами", str(m.aisles)],
        ["Самый узкий проезд", f"{number(m.aisle_m, 2)} м"],
        ["Верхний ярус", f"{number(m.rack_top_m, 2)} м"],
        ["Пандусов", str(m.ramps)],
    ]
    out: list = [_table(rows, [width * 0.6, width * 0.4], head=False)]
    if not (report.request.plan and report.request.plan.edited):
        out += [
            Spacer(0, 4),
            Paragraph("План построен по шаблону и не правился: где на объекте ворота, мы не знаем.", s["note"]),
        ]
    return out


def _solution(report: Report, task: TaskReport, s: dict, width: float) -> list:
    sizing = task.part.sizing
    robot = task.robot
    steady = task.operation.steady
    purchase = task.scenario("purchase")
    capex = purchase.capex_rub if purchase else {}
    out: list = []
    if report.several:
        out += [Paragraph(f"<font name='TextMedium'>{task.title}</font>", s["base"]), Spacer(0, 3)]
    if robot:
        text = f"<font name='TextMedium'>{robot.product}</font>, {robot.vendor}."
        if robot.price_rub:
            text += f" Цена из каталога {_n(mln(robot.price_rub))} млн ₽ с НДС, без пусконаладки."
        if robot.calc_note:
            text += f" {robot.calc_note}."
        out.append(Paragraph(text, s["base"]))
        passed = [c.label.lower() for c in robot.checks if c.outcome == "fits"]
        unknown = [f"{c.label.lower()} ({c.detail})" for c in robot.checks if c.outcome != "fits"]
        if passed:
            out += [Spacer(0, 3), Paragraph("Подошло: " + "; ".join(passed) + ".", s["soft"])]
        if unknown:
            out += [Spacer(0, 3), Paragraph("Проверить: " + "; ".join(unknown) + ".", s["soft"])]
        out.append(Spacer(0, 8))
    rows = [
        ["Что входит", "Сколько", "Покупка, разово"],
        ["Роботы", str(sizing.fleet), rub(capex.get("hardware"))],
        ["Зарядные станции", str(sizing.chargers), rub(capex.get("chargers"))],
        ["Станции комплектации", str(sizing.stations), rub(capex.get("stations"))],
        ["ПО управления парком", "1", rub(capex.get("software"))],
    ]
    out += [
        _table(rows, [width * 0.5, width * 0.18, width * 0.32]),
        Spacer(0, 4),
        Paragraph(
            f"Парк посчитан: {sizing.fleet_source}. "
            f"Спрос {'в час с резервом' if steady else 'в пиковый час'} {_n(number(sizing.design_demand_ops_per_hour or 0, 0))} "
            f"операций, один робот делает {_n(number(sizing.robot_ops_per_hour or 0))} в час при маршруте "
            f"{_n(number(sizing.route_m or 0))} м.",
            s["note"],
        ),
    ]
    if report.several:
        out.append(Spacer(0, 10))
    return out


def _costs(report: Report, width: float) -> Table:
    purchase, raas = report.scenario("purchase"), report.scenario("raas")
    rows = [["Статья", "", NAMES["purchase"], NAMES["raas"]]]
    for item in purchase.capex_rub:
        rows.append(
            [CAPEX_NAMES.get(item, item), "разово", rub(purchase.capex_rub[item]), rub(raas.capex_rub.get(item, 0))]
        )
    for item in {**purchase.years[0].opex_rub, **raas.years[0].opex_rub}:
        rows.append(
            [
                OPEX_NAMES.get(item, item),
                "1 год",
                rub(purchase.years[0].opex_rub.get(item, 0)),
                rub(raas.years[0].opex_rub.get(item, 0)),
            ]
        )
    table = _table(rows, [width * 0.42, width * 0.12, width * 0.23, width * 0.23], numbers_from=2)
    table.setStyle(TableStyle([("TEXTCOLOR", (1, 1), (1, -1), SOFT), ("FONTSIZE", (1, 1), (1, -1), 7.5)]))
    return table


def _staff(report: Report, s: dict, width: float) -> list:
    sizing = report.result.sizing
    rows = [["Роль", "Мест", "Работает", "Оклад в месяц"]]
    rows += [[line.role, number(line.headcount), number(line.filled), rub(line.salary_month)] for line in report.staff]
    return [
        _table(rows, [width * 0.46, width * 0.14, width * 0.14, width * 0.26]),
        Spacer(0, 4),
        Paragraph(
            f"Людей на операции в смену: было {_n(number(sizing.people_per_shift_before))}, станет "
            f"{_n(number(sizing.people_per_shift_after))}. Высвобождается ставок {_n(number(sizing.released_fte))}, "
            f"из них {_n(number(sizing.retrained_fte))} переучиваем в операторов роботов.",
            s["note"],
        ),
    ]


def _sensitivity(report: Report, s: dict, width: float) -> list:
    """Что будет, если: таблица на каждый сценарий с роботами, строка на параметр"""
    data = report.sensitivity
    out: list = []
    for scenario_id in ("purchase", "raas"):
        rows: list[list] = [[NAMES[scenario_id], *[delta(d) for d in data.deltas]]]
        for param in data.params:
            if scenario_id == "purchase" and param.id == "raas_fee":
                continue
            cells = []
            for cell in param.cells:
                outcome = next((o for o in cell.outcomes if o.scenario_id == scenario_id), None)
                if outcome is None:
                    cells.append("—")
                    continue
                cells.append(
                    Paragraph(
                        f"{term(outcome.payback_years)}<br/><font size=7 color='#55636f'>{mln(outcome.tco_rub)}</font>",
                        s["num"],
                    )
                )
            rows.append(
                [Paragraph(f"{param.name}<br/><font size=7 color='#55636f'>{param.base}</font>", s["cell"]), *cells]
            )
        first = width * 0.28
        table = _table(rows, [first] + [(width - first) / len(data.deltas)] * len(data.deltas))
        table.setStyle(TableStyle([("BACKGROUND", (3, 1), (3, -1), BLUE_TINT)]))
        out += [table, Spacer(0, 8)]
    notes = [f"{param.name}: {param.what[0].lower()}{param.what[1:]}." for param in data.params]
    out.append(Paragraph(" ".join(notes), s["note"]))
    return out


def _shift(report: Report, task: TaskReport, s: dict, width: float) -> list:
    shift = task.shift
    rows = [
        ["Роботов в прогоне", str(shift.fleet)],
        [f"Пик спроса с запасом, {task.unit} в час", number(shift.design_demand, 0)],
        [f"Сделано за {number(shift.hours, 0)} часов смены, {task.unit}", number(shift.done, 0)],
        [f"В среднем за смену, {task.unit} в час", number(shift.ops_per_hour, 0)],
        ["Роботы в работе, % времени", number(shift.busy_share * 100, 0)],
        ["Ждут в очереди, % времени", number(shift.waiting_share * 100, 1)],
        ["На зарядке, % времени", number(shift.charging_share * 100, 1)],
        ["Средний рейс, секунд", number(shift.avg_cycle_s, 0)],
    ]
    out: list = []
    if report.several:
        out += [Paragraph(f"<font name='TextMedium'>{task.operation.name}, {task.robot_name}</font>", s["base"])]
        out.append(Spacer(0, 3))
    out += [
        _table(rows, [width * 0.7, width * 0.3], head=False),
        Spacer(0, 4),
        Paragraph(f"Узкое место: {shift.bottleneck}.", s["base"]),
    ]
    if not shift.plan_known:
        out += [Spacer(0, 3), Paragraph("План типовой: где на объекте ворота, мы не знаем.", s["note"])]
    if report.several:
        out.append(Spacer(0, 10))
    return out


def _sources(report: Report, s: dict, width: float) -> Table:
    """Все значения расчета по группам: решение, деньги, объект, допущения модели"""
    rows: list[list] = [["", "Значение", "Число", "Источник"]]
    heads: list[int] = []
    order = list(names.GROUPS.values())
    sources = sorted(
        report.result.sources,
        key=lambda one: order.index(names.group(one.path)) if names.group(one.path) in order else 99,
    )
    current = None
    for source in sources:
        if names.group(source.path) != current:
            current = names.group(source.path)
            heads.append(len(rows))
            rows.append(["", Paragraph(current, s["h3"]), "", ""])
        rows.append(
            [
                source.trust,
                Paragraph(report.source_name(source.path), s["cell"]),
                Paragraph(valued(source.value, source.unit), s["num"]),
                Paragraph(source.source + (f", {source.date}" if source.date else ""), s["cellsoft"]),
            ]
        )
    table = _table(rows, [width * 0.05, width * 0.29, width * 0.20, width * 0.46], numbers_from=2)
    style = [
        ("ALIGN", (3, 0), (3, -1), "LEFT"),
        ("FONTNAME", (0, 1), (0, -1), "MonoMedium"),
        ("TEXTCOLOR", (0, 1), (0, -1), BLUE),
        ("FONTSIZE", (2, 1), (2, -1), 8),
    ]
    for row in heads:
        style += [("SPAN", (1, row), (3, row)), ("TOPPADDING", (0, row), (-1, row), 10)]
    table.setStyle(TableStyle(style))
    return table


class _Numbered(Canvas):
    """Холст, который знает число листов: в нижней строке «2 / 9». Листы копим и дорисовываем в конце."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._pages: list[dict] = []

    def showPage(self):  # noqa: N802 - имя метода задает reportlab
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for page in self._pages:
            self.__dict__.update(page)
            _footer(self, self._sheet_report, total)
            super().showPage()
        super().save()


def _sheet(canvas: Canvas, report: Report) -> None:
    """Верхняя строка листа: что за отчет и пометка «предварительная оценка»"""
    x0, _, x1, y1 = FRAME
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(x0, y1 - 2.5 * mm, x1, y1 - 2.5 * mm)
    _caps(canvas, f"ОЦЕНКА РОБОТИЗАЦИИ · {report.facility.name.upper()}", x0, y1, 7, SOFT)
    right = "ПРЕДВАРИТЕЛЬНАЯ ОЦЕНКА"
    _caps(canvas, right, x1 - _caps_width(right, 7), y1, 7, BLUE)
    canvas.restoreState()
    canvas._sheet_report = report


def _footer(canvas: Canvas, report: Report, total: int) -> None:
    """Нижняя строка листа: объект, решение, когда и какой моделью посчитано, номер листа"""
    x0, y0, x1, _ = FRAME
    canvas.saveState()
    canvas.setStrokeColor(HAIR)
    canvas.setLineWidth(0.5)
    canvas.line(x0, y0 + 4 * mm, x1, y0 + 4 * mm)
    sheet = f"{canvas.getPageNumber()} / {total}"
    right = x1 - pdfmetrics.stringWidth(sheet, "Mono", 7.5)
    left = f"{_object(report)} · {report.robot_name} · {report.created:%d.%m.%Y %H:%M} мск · модель {report.result.model_version}"
    canvas.setFont("Text", 7.5)
    canvas.setFillColor(SOFT)
    canvas.drawString(x0, y0, _fit(left, "Text", 7.5, right - x0 - 8 * mm))
    canvas.setFont("Mono", 7.5)
    canvas.setFillColor(INK)
    canvas.drawString(right, y0, sheet)
    canvas.restoreState()


def _fit(text: str, font: str, size: float, room: float) -> str:
    """Обрезаем строку штампа многоточием, если она не влезает в ячейку"""
    if pdfmetrics.stringWidth(text, font, size) <= room:
        return text
    while text and pdfmetrics.stringWidth(text + "…", font, size) > room:
        text = text[:-1]
    return text.rstrip(" ,") + "…"


TRACKING = 0.1  # разрядка подписей капсом, доля кегля


def _caps(canvas: Canvas, text: str, x: float, y: float, size: float, color) -> None:
    obj = canvas.beginText(x, y)
    obj.setFont("Mono", size)
    obj.setCharSpace(size * TRACKING)
    obj.setFillColor(color)
    obj.textOut(text)
    # разрядка остается в состоянии холста, поэтому сбрасываем: иначе ее подхватит обычный текст штампа
    obj.setCharSpace(0)
    canvas.drawText(obj)


def _caps_width(text: str, size: float) -> float:
    return pdfmetrics.stringWidth(text, "Mono", size) + size * TRACKING * len(text)


READINESS = {"redo": ("переделать", "#c0392b"), "check": ("проверить", "#0b4fa8"), "ready": ("готово", "#1f7a4d")}


def _readiness(report: Report, s: dict, width: float) -> list:
    """Что подготовить на складе: строка на пункт, состояние словом и цветом, почему, основание
    с оценкой и стоимость, если у нее есть источник. Сначала то, что переделать."""
    found = report.readiness
    rows: list[list] = [["Состояние", "Что и почему", "Стоимость"]]
    for item in found.items:
        word, color = READINESS[item.status]
        tag = f"<font size=7 color='#55636f'>&nbsp;&nbsp;{escape(item.solution)}</font>" if item.solution else ""
        rows.append(
            [
                Paragraph(f"<font name='Mono' color='{color}'>{word.upper()}</font>", s["cellsoft"]),
                [
                    Paragraph(f"<font name='TextMedium'>{escape(item.title)}</font>{tag}", s["cell"]),
                    Paragraph(escape(item.why).replace("\n", "<br/>"), s["cell"]),
                    Paragraph(_linked(item.basis, item.link), s["cellsoft"]),
                ],
                [
                    Paragraph(escape(item.cost), s["num"]),
                    Paragraph(escape(item.cost_note), ParagraphStyle("costnote", parent=s["cellsoft"], alignment=2)),
                ],
            ]
        )
    return [
        _table(rows, [22 * mm, width - 22 * mm - 34 * mm, 34 * mm], None),
        Spacer(0, 4),
        Paragraph(escape(found.budget_note), s["note"]),
        *(
            []
            if found.plan_edited
            else [Paragraph("План типовой: пункты про проезды, стеллажи и пандусы посчитаны по нему.", s["note"])]
        ),
    ]


def _linked(text: str, link: str) -> str:
    """Основание пункта: сайт источника ссылкой, а не длинный адрес файла"""
    from app.services.readiness import site

    name = site(link) if link else ""
    if not name or name not in text:
        return escape(text)
    before, _, after = text.partition(name)
    return f"{escape(before)}<a href='{escape(link)}' color='#0b4fa8'>{escape(name)}</a>{escape(after)}"
