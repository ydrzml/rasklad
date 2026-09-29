FROM python:3.12-slim

WORKDIR /app/backend
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY backend/pyproject.toml ./
RUN pip install --no-cache-dir .

COPY backend/ ./
COPY config/ /app/config/
COPY data/catalog/ /app/data/catalog/
COPY data/facilities/ /app/data/facilities/
COPY data/specs/specs.csv data/specs/sources.csv /app/data/specs/
COPY data/specs/saved/ /app/data/specs/saved/
# Шрифт Onest для служебных таблиц: сервер отдает его на /api/db/fonts, лицензия рядом с файлами
COPY frontend/src/assets/fonts/onest-* /app/frontend/src/assets/fonts/

ENV CONFIG_DIR=/app/config DATA_DIR=/app/data
# Сервер работает от обычного пользователя, а не от root: взлом сервера не дает прав на весь контейнер
RUN useradd --system --no-create-home app
USER app
EXPOSE 8000
# Перед стартом сервера применяем миграции и создаем демо-аккаунты. Заголовкам о https верим от nginx:
# снаружи сервер закрыт, запросы к нему приходят только через nginx
CMD ["sh", "-c", "python -m scripts.prepare_database && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --forwarded-allow-ips='*'"]
