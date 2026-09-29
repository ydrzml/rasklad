from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.reports import content, excel, pdf
from app.schemas.economics import CalculationRequest

router = APIRouter(prefix="/reports", tags=["отчеты"])

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _build(request: CalculationRequest) -> content.Report:
    try:
        return content.build(request)
    except content.NotFeasible as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except StopIteration as error:
        raise HTTPException(status_code=404, detail=f"Не найдено: {error}") from error


def _file(body: bytes, name: str, media_type: str) -> Response:
    # Имя файла латиницей для старых браузеров и то же имя в filename* для остальных
    return Response(
        content=body,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename=\"{name}\"; filename*=UTF-8''{quote(name)}"},
    )


@router.post(
    "/pdf",
    summary="Отчет PDF по расчету",
    description=(
        "Считает тот же расчет, что /api/calculations/preview, и собирает отчет: вывод по трем сценариям, "
        "график затрат, параметры объекта, план, решение и состав оборудования, затраты по статьям, штат, "
        "риски и все значения с источником и оценкой доверия. Дата, версия модели и пометка "
        "«предварительная оценка» стоят на каждой странице. Сохранять ничего не нужно: отчет доступен и гостю."
    ),
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
)
def report_pdf(request: CalculationRequest) -> Response:
    report = _build(request)
    try:
        body = pdf.render(report)
    except pdf.NoFonts as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    return _file(body, f"{report.file_stem}.pdf", "application/pdf")


@router.post(
    "/xlsx",
    summary="Расчетные таблицы Excel",
    description=(
        "Тот же расчет таблицами: итог по сценариям, сценарии по годам, затраты по статьям, парк и штат, "
        "параметры объекта и все значения с источником. Числа лежат числами, их можно пересчитать у себя."
    ),
    response_class=Response,
    responses={200: {"content": {XLSX: {}}}},
)
def report_xlsx(request: CalculationRequest) -> Response:
    report = _build(request)
    return _file(excel.render(report), f"{report.file_stem}.xlsx", XLSX)
