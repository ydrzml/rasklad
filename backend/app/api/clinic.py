from fastapi import APIRouter

from app.schemas import clinic as schema
from app.services import clinic_contract as service
from app.services import clinic_money, clinic_optimizer, clinic_portfolio

router = APIRouter(prefix="/clinic", tags=["медучреждение"])


@router.post("/portfolio", summary="Полная, частичная роботизация или сохранение ручной работы")
def portfolio(request: schema.OptimizationRequest):
    return clinic_portfolio.compare(request)


# Доступ как у прогона склада (/simulation/runs): гость считает по своим цифрам, сохраняет
# проект под входом (корпус лежит в state проекта). Прогон тяжелый, поэтому в nginx он в зоне
# heavy, а размер корпуса и парка ограничивает схема запроса.


@router.get(
    "/template",
    response_model=schema.Building,
    summary="Типовой корпус медучреждения",
    description=(
        "Четыре этажа 60 x 24 м, два лифта (один с интеграцией), аптека и склад расходников на первом, "
        "посты отделений на 2-4, зарядки и базы уборщиков. Чертеж наш, ширина дверей по СП 158.13330, "
        "кабина лифта по паспорту больничного лифта."
    ),
)
def template() -> schema.Building:
    return service.template()


@router.post("/generate", response_model=schema.Building, summary="Построить корпус по размерам")
def generate(request: schema.GenerateRequest) -> schema.Building:
    return service.generate(request)


@router.post("/import", response_model=schema.Building, summary="Прочитать сохраненный корпус JSON")
def import_building(request: schema.Building) -> schema.Building:
    # Геометрию проверяет /check: план с исправимыми ошибками можно открыть в редакторе.
    return request


@router.get(
    "/robots",
    response_model=schema.Robots,
    summary="Доставщики и уборщики для прогона",
    description=(
        "Решения медучреждения из каталога под доставку по этажам и уборку, кроме тех, что купить нельзя. "
        "Характеристики из data/specs с оценками S-F; без нужной характеристики робот не считается."
    ),
)
def robots() -> schema.Robots:
    return service.robots()


@router.get(
    "/assumptions",
    response_model=list[schema.Assumption],
    summary="Откуда цифры модели медучреждения",
    description="Все числа config/clinic.yaml: значение, источник, дата и оценка от S до F.",
)
def assumptions() -> list[schema.Assumption]:
    return service.assumptions()


@router.post(
    "/check",
    response_model=schema.CheckResult,
    summary="Проверка плана корпуса",
    description=(
        "Ошибки (нет аптеки, постов, зарядки, помещение без двери) не дают считать смену. Предупреждения: "
        "дверь уже прохода робота, лифт без интеграции или мал для робота, пост, куда робот не доедет."
    ),
)
def check(request: schema.CheckRequest) -> schema.CheckResult:
    return service.check_plan(request)


@router.post(
    "/fit",
    response_model=schema.FitResult,
    summary="Кому из роботов корпус не подходит",
    description=(
        "Без прогона, по плану и габаритам: уборщик не выезжает с базы ни на одном этаже, доставщик не "
        'доезжает ни до одного поста. Шаг решений показывает таких как "не подходит" с причиной.'
    ),
)
def fit(request: schema.FitRequest) -> schema.FitResult:
    return service.fit(request)


@router.post("/workload", response_model=schema.WorkloadResult, summary="Объем процессов на корпус и окно прогона")
def workload(request: schema.WorkloadRequest) -> schema.WorkloadResult:
    return service.workload(request)


@router.post(
    "/runs",
    response_model=schema.RunResult,
    summary="Прогон смены в корпусе",
    description=(
        "Доставщики везут лекарства и расходники из аптеки на посты по этажам, ждут лифт и двери, "
        "заряжаются; уборщики моют коридоры своего этажа. Без парка ищем самый маленький, при котором "
        "вовремя не меньше цели на всех seed. Ответ: KPI, часы персонала, заявки, лог роботов и лифтов."
    ),
)
def run(request: schema.RunRequest) -> schema.RunResult:
    return service.run(request)


@router.post(
    "/economics",
    response_model=schema.MoneyResult,
    summary="Итог медучреждения: роботы, деньги, люди",
    description=(
        "Прогон на выбранном корпусе: без роботов, покупка, аренда и добавленный пользователем кредит. "
        "Чистое высвобождение времени отдельно от экономии бюджета; помощь роботам и сохраняющаяся "
        "зарплата учтены. assumptions задает хронометраж, реализацию эффекта и дополнительные расходы."
    ),
)
def economics(request: schema.MoneyRequest) -> schema.MoneyResult:
    return clinic_money.estimate(request)


@router.post("/offers", response_model=schema.Offers, summary="Стоимость медицинского парка на карточках решений")
def offers(request: schema.OfferRequest) -> schema.Offers:
    return clinic_money.offers(request)


@router.post(
    "/optimize",
    response_model=schema.OptimizationResult,
    summary="Сравнить медицинские парки по затратам и выполнению работы",
)
def optimize(request: schema.OptimizationRequest) -> schema.OptimizationResult:
    return clinic_optimizer.optimize(request)
