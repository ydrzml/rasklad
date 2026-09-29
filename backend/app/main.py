from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware

from app import admin_panel, errors
from app.api import (
    admin_catalog,
    admin_norms,
    admin_stats,
    auth,
    budget,
    calculations,
    catalog,
    catalog_updates,
    data_import,
    health,
    photos,
    plan,
    projects,
    readiness,
    reports,
    shares,
    simulation,
    staff,
)

app = FastAPI(
    title="Расклад, API",
    description=(
        "Сервис оценки роботизации склада: подбор решений из каталога ФЦ БАС, план объекта, "
        "прогон смены и экономика в трех сценариях. Все расчеты на сервере, у каждой цифры источник."
    ),
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

# Лог смены для проигрывателя весит мегабайты: на отборе больше сотни тысяч отрезков.
# Сжатие без потерь, браузер получает те же данные
app.add_middleware(GZipMiddleware, minimum_size=2000)


# Понятный ответ на любую ошибку и запись в лог: app/errors.py
errors.install(app)

app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(catalog.router, prefix="/api")
app.include_router(staff.router, prefix="/api")
app.include_router(data_import.router, prefix="/api")
app.include_router(plan.router, prefix="/api")
app.include_router(calculations.router, prefix="/api")
app.include_router(budget.router, prefix="/api")
app.include_router(simulation.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(shares.router, prefix="/api")
app.include_router(admin_catalog.router, prefix="/api")
app.include_router(admin_stats.router, prefix="/api")
app.include_router(admin_norms.router, prefix="/api")
app.include_router(catalog_updates.router, prefix="/api")
app.include_router(photos.router, prefix="/api")
app.include_router(reports.router, prefix="/api")
app.include_router(readiness.router, prefix="/api")

# Служебные таблицы для администратора: пользователи, журнал правок, каталог для просмотра
admin_panel.mount(app)
