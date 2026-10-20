from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from app.reports import clinic, content, excel, pdf
from app.schemas.clinic import MoneyRequest
from app.schemas.economics import CalculationRequest
from app.services import demo_cases

router = APIRouter(prefix="/reports", tags=["отчеты"])

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
FILE_RESPONSES = {200: {"content": {"application/pdf": {}, XLSX: {}}}}

Kind = Literal["pdf", "xlsx"]


def send(report: content.Report | clinic.ClinicReport, kind: Kind) -> Response:
    """Готовый отчет файлом: PDF или таблицы Excel. Общий для расчета, кабинета и ссылки, склада и медучреждения"""
    medical = isinstance(report, clinic.ClinicReport)
    if kind == "xlsx":
        body = clinic.render_xlsx(report) if medical else excel.render(report)
        return _file(body, f"{report.file_stem}.xlsx", XLSX)
    try:
        body = clinic.render_pdf(report) if medical else pdf.render(report)
    except pdf.NoFonts as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    return _file(body, f"{report.file_stem}.pdf", "application/pdf")


# готовый разбор со страницы /cases: свое имя файла и без пунктов про план, которого гость не чертил
CaseQuery = Query(None, description="Готовый разбор, из которого собран запрос: pallets, picking или cleaning")


def _build(request: CalculationRequest, case: str | None = None) -> content.Report:
    if case is not None and case not in demo_cases.CASES:
        raise HTTPException(status_code=404, detail="Такого разбора нет")
    try:
        return content.build(request, case_id=case)
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
        '"предварительная оценка" стоят на каждой странице. Сохранять ничего не нужно: отчет доступен и гостю.'
    ),
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
)
def report_pdf(request: CalculationRequest, case: str | None = CaseQuery) -> Response:
    return send(_build(request, case), "pdf")


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
def report_xlsx(request: CalculationRequest, case: str | None = CaseQuery) -> Response:
    return send(_build(request, case), "xlsx")


@router.post(
    "/clinic/pdf",
    summary="Отчет PDF медучреждения",
    description=(
        "Тот же итог, что /api/clinic/economics: ответ, три сценария, затраты по годам, парк и смена на корпусе, "
        "что с людьми, что может сдвинуть вывод и все значения с источником и оценкой. Доступен и гостю."
    ),
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
)
def clinic_pdf(request: MoneyRequest) -> Response:
    return send(clinic.build(request), "pdf")


@router.post(
    "/clinic/xlsx",
    summary="Расчетные таблицы Excel медучреждения",
    description="Тот же итог таблицами: итог, по годам с формулами, парк и смена, люди, ограничения, источники.",
    response_class=Response,
    responses={200: {"content": {XLSX: {}}}},
)
def clinic_xlsx(request: MoneyRequest) -> Response:
    return send(clinic.build(request), "xlsx")
