from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Role(StrEnum):
    """Гость в базе не хранится: это любой, кто не вошел."""

    user = "user"
    admin = "admin"


class User(Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("role in ('user', 'admin')", name="users_role_known"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(16), default=Role.user)
    # Как человек себя назвал и где работает. Не обязательны: входят по почте, а имя видно в шапке и отчетах
    name: Mapped[str] = mapped_column(String(120), default="", server_default="")
    company: Mapped[str] = mapped_column(String(200), default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Folder(Base):
    """Папка в кабинете: проекты одного склада и их варианты лежат рядом, их удобно сравнивать.
    Удалить папку значит разложить ее проекты обратно в общий список, сами проекты остаются."""

    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Project(Base):
    """Проект пользователя. Сам расчет лежит в версиях: каждое сохранение добавляет новую, старые не трогаем."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    facility_type: Mapped[str] = mapped_column(String(40))
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id", ondelete="SET NULL"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    versions: Mapped[list["ProjectVersion"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="ProjectVersion.number"
    )
    files: Mapped[list["ProjectFile"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="ProjectFile.id"
    )
    shares: Mapped[list["Share"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="Share.id"
    )


class Share(Base):
    """Публичная ссылка на одну версию расчета. Версии не меняются, поэтому по ссылке всегда видно
    то, чем поделились, даже если потом сохранили новые. Отозвать значит удалить строку."""

    __tablename__ = "shares"

    id: Mapped[int] = mapped_column(primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version_number: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="shares")


class ProjectVersion(Base):
    """Сохраненный расчет. Что ввел пользователь и что получилось храним целиком, как пришло с экрана:
    мастер еще меняется, и проектам не нужно знать его устройство. Версии данных и модели нужны,
    чтобы при повторном открытии сказать, те же ли нормативы и каталог стоят сейчас (ТЗ, п. 3.1.5)."""

    __tablename__ = "project_versions"
    __table_args__ = (UniqueConstraint("project_id", "number", name="project_versions_number_unique"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(String(500), default="")
    state: Mapped[dict[str, Any]] = mapped_column(JSON, deferred=True)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, deferred=True)
    model_version: Mapped[str] = mapped_column(String(40))
    data_version: Mapped[str] = mapped_column(String(40))
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="versions")


class ProjectFile(Base):
    """Файл, загруженный в проект. Лежит в базе, а не на диске: удаляется вместе с проектом
    и не теряется при пересборке контейнера."""

    __tablename__ = "project_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    content: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="files")


class Solution(Base):
    """Решение каталога. Поля организатора хранятся как в его выгрузке, чтобы повторная загрузка
    файла обновляла их без потерь. Строки выгрузки с тем же номером и ценой склеены в одно решение,
    отрасли и сценарии собраны списком. Технические характеристики лежат отдельно, у каждой свой источник."""

    __tablename__ = "solutions"
    __table_args__ = (
        CheckConstraint("origin in ('organizer', 'team')", name="solutions_origin_known"),
        CheckConstraint("trl is null or trl between 1 and 9", name="solutions_trl_range"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # Номер в выгрузке организатора. Обычно совпадает с id, но у одного номера бывает несколько
    # комплектаций с разной ценой, и тогда у второй свой id (журнал решений, «Дубли каталога...»)
    organizer_id: Mapped[str | None] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(300))
    company: Mapped[str] = mapped_column(String(300), default="")
    kind: Mapped[str] = mapped_column(String(20), default="")
    status: Mapped[str] = mapped_column(String(20), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[str] = mapped_column(String(200), default="")
    subtype: Mapped[str] = mapped_column(String(200), default="")
    scenario: Mapped[str] = mapped_column(Text, default="")
    cases: Mapped[str] = mapped_column(Text, default="")
    trl: Mapped[int | None] = mapped_column(Integer)
    market_potential: Mapped[str] = mapped_column(Text, default="")
    region: Mapped[str] = mapped_column(String(200), default="")
    industry: Mapped[str] = mapped_column(Text, default="")
    price_rub: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    process: Mapped[str] = mapped_column(String(200), default="")
    tested_fcbas: Mapped[bool] = mapped_column(Boolean, default=False)
    registry_719: Mapped[bool] = mapped_column(Boolean, default=False)
    origin: Mapped[str] = mapped_column(String(20), default="organizer")
    # Поля организатора, которые администратор поправил руками. Повторная загрузка выгрузки их не трогает,
    # а что сейчас стоит у организатора, лежит рядом: правку можно сравнить и вернуть одной кнопкой
    manual_fields: Mapped[list[str]] = mapped_column(JSON, default=list)
    organizer_values: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    specs: Mapped[list["SolutionSpec"]] = relationship(
        back_populates="solution", cascade="all, delete-orphan", order_by="SolutionSpec.id"
    )
    photo: Mapped["SolutionPhoto | None"] = relationship(
        back_populates="solution", cascade="all, delete-orphan", uselist=False
    )
    uses: Mapped[list["SolutionUse"]] = relationship(
        back_populates="solution", cascade="all, delete-orphan", order_by="SolutionUse.id"
    )


class SolutionSpec(Base):
    """Характеристика решения: значение с единицей, источником, датой и оценкой доверия S, A–F
    (шкала в docs/data-sources.md). Пустое значение с оценкой F значит «данных нет», и это тоже
    показываем: ТЗ требует видеть, чего не хватает."""

    __tablename__ = "solution_specs"
    __table_args__ = (
        UniqueConstraint("solution_id", "field", name="solution_specs_field_unique"),
        CheckConstraint("rating in ('S', 'A', 'B', 'C', 'D', 'E', 'F')", name="solution_specs_rating_known"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    solution_id: Mapped[str] = mapped_column(ForeignKey("solutions.id", ondelete="CASCADE"), index=True)
    field: Mapped[str] = mapped_column(String(60))
    value: Mapped[str] = mapped_column(String(500), default="")
    unit: Mapped[str] = mapped_column(String(100), default="")
    rating: Mapped[str] = mapped_column(String(1), default="F")
    source: Mapped[str] = mapped_column(Text, default="")
    source_type: Mapped[str] = mapped_column(String(200), default="")
    quote: Mapped[str] = mapped_column(Text, default="")
    retrieved: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str] = mapped_column(Text, default="")

    solution: Mapped[Solution] = relationship(back_populates="specs")


class SolutionUse(Base):
    """Где работает решение и что делает: объект и операция из app/services/catalog_uses.py.
    confirmed: проверено, решение идет в подбор объекта; suggested: предложило правило по сценарию
    организатора, ждет администратора; rejected: администратор отклонил, правило его больше не предложит."""

    __tablename__ = "solution_uses"
    __table_args__ = (
        UniqueConstraint("solution_id", "facility", "operation", name="solution_uses_unique"),
        CheckConstraint("status in ('confirmed', 'suggested', 'rejected')", name="solution_uses_status_known"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    solution_id: Mapped[str] = mapped_column(ForeignKey("solutions.id", ondelete="CASCADE"), index=True)
    facility: Mapped[str] = mapped_column(String(30))
    operation: Mapped[str] = mapped_column(String(60))
    status: Mapped[str] = mapped_column(String(20))
    source: Mapped[str] = mapped_column(String(20), default="admin")  # team, rule или admin
    note: Mapped[str] = mapped_column(Text, default="")

    solution: Mapped[Solution] = relationship(back_populates="uses")


class CatalogChange(Base):
    """Журнал правок каталога: кто, когда и что поменял. Пишем старое и новое значение каждого поля,
    чтобы правку можно было проверить и откатить руками (ТЗ: изменение фиксируется)."""

    __tablename__ = "catalog_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    user_email: Mapped[str] = mapped_column(String(254), default="")
    action: Mapped[str] = mapped_column(String(20))
    solution_id: Mapped[str | None] = mapped_column(String(36), index=True)
    solution_name: Mapped[str] = mapped_column(String(300), default="")
    changes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    note: Mapped[str] = mapped_column(Text, default="")


class SolutionPhoto(Base):
    """Главное фото решения. Хранится в базе, как файлы проектов: не пропадает при пересборке контейнера.
    У каждого снимка источник и условия использования: без разрешения фото не публикуем."""

    __tablename__ = "solution_photos"

    id: Mapped[int] = mapped_column(primary_key=True)
    solution_id: Mapped[str] = mapped_column(ForeignKey("solutions.id", ondelete="CASCADE"), unique=True)
    content: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    content_type: Mapped[str] = mapped_column(String(30))
    size_bytes: Mapped[int] = mapped_column(Integer)
    source_url: Mapped[str] = mapped_column(Text, default="")
    owner: Mapped[str] = mapped_column(String(300), default="")
    license: Mapped[str] = mapped_column(Text, default="")
    uploaded_by: Mapped[str] = mapped_column(String(254), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    solution: Mapped[Solution] = relationship(back_populates="photo")


class SpecCheck(Base):
    """Проверка характеристики по странице производителя: что нашли на странице и что с этим делать.
    Одна строка на решение, характеристику и страницу, при следующей проверке она обновляется.
    Расхождение само каталог не меняет: это предложение, его принимает или отклоняет администратор."""

    __tablename__ = "spec_checks"
    __table_args__ = (UniqueConstraint("solution_id", "field", "url", name="uq_spec_checks_solution_field_url"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    solution_id: Mapped[str] = mapped_column(ForeignKey("solutions.id", ondelete="CASCADE"), index=True)
    field: Mapped[str] = mapped_column(String(60))
    url: Mapped[str] = mapped_column(Text)
    quote: Mapped[str] = mapped_column(Text, default="")  # что было на странице, когда собирали данные
    outcome: Mapped[str] = mapped_column(String(20))  # same, differs, manual или blocked
    found_text: Mapped[str] = mapped_column(Text, default="")  # что стоит на странице сейчас
    current: Mapped[str] = mapped_column(String(500), default="")  # значение в каталоге на момент проверки
    proposed: Mapped[str] = mapped_column(String(500), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(10), default="web")  # web или saved, сохраненная страница
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    status: Mapped[str] = mapped_column(String(20), default="")  # new, accepted, rejected у предложений
    decided_by: Mapped[str] = mapped_column(String(254), default="")
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class NormOverride(Base):
    """Норматив, который поправил администратор. Значение по умолчанию с источником остается в
    config/model.yaml, эта строка ложится поверх него, пока ее не удалят кнопкой "Вернуть из файла"."""

    __tablename__ = "norm_overrides"

    path: Mapped[str] = mapped_column(String(200), primary_key=True)
    value: Mapped[float] = mapped_column()
    source: Mapped[str] = mapped_column(Text)
    source_date: Mapped[str | None] = mapped_column(String(10))
    trust: Mapped[str] = mapped_column(String(1))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    user_email: Mapped[str] = mapped_column(String(254), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class NormChange(Base):
    """Журнал правок нормативов: кто, когда, что было и что стало. Номер последней записи служит
    отметкой: поменялся, значит расчет перечитает правки (в том числе в процессах прогона смены)."""

    __tablename__ = "norm_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    user_email: Mapped[str] = mapped_column(String(254), default="")
    action: Mapped[str] = mapped_column(String(20))
    path: Mapped[str] = mapped_column(String(200), index=True)
    name: Mapped[str] = mapped_column(String(300), default="")
    changes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    note: Mapped[str] = mapped_column(Text, default="")
