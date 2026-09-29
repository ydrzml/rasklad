"""Фото решений: загрузка администратором, отдача всем, подхват снимков из data/catalog/photos.

Принимаем только настоящие картинки: смотрим не на расширение, а на первые байты файла. У каждого
фото источник, владелец и условия использования. Если в папке данных лежит снимок, а у решения
фото еще нет, при запуске он попадает в базу сам (формат папки описан в заявке #46)."""

import csv
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.settings import settings
from app.storage.models import CatalogChange, Solution, SolutionPhoto, User

MAX_BYTES = 5 * 1024 * 1024
EXTENSIONS = {".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


class NotFound(Exception):
    pass


class BadImage(Exception):
    pass


def sniff(content: bytes) -> str:
    """Тип картинки по первым байтам. Файл с чужим расширением или вовсе не картинка не пройдет."""
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    raise BadImage("Это не картинка JPEG, PNG или WebP")


def put(
    session: Session, user: User, solution_id: str, content: bytes, source_url: str, owner: str, license_: str
) -> None:
    solution = _solution(session, solution_id)
    if len(content) > MAX_BYTES:
        raise BadImage("Фото больше 5 МБ, уменьшите его")
    content_type = sniff(content)
    replaced = solution.photo is not None
    if solution.photo is not None:
        session.delete(solution.photo)
        session.flush()
    solution.photo = SolutionPhoto(
        content=content,
        content_type=content_type,
        size_bytes=len(content),
        source_url=source_url.strip(),
        owner=owner.strip(),
        license=license_.strip(),
        uploaded_by=user.email,
    )
    _log(
        session,
        user,
        solution,
        "photo_set",
        {
            "фото": ["было" if replaced else None, f"{content_type}, {len(content) // 1024} КБ"],
            "источник": [None, source_url],
        },
    )
    session.commit()


def update_meta(session: Session, user: User, solution_id: str, source_url: str, owner: str, license_: str) -> None:
    photo = _photo(session, solution_id)
    changes = {}
    for name, value in (("source_url", source_url), ("owner", owner), ("license", license_)):
        if getattr(photo, name) != value.strip():
            changes[f"фото.{name}"] = [getattr(photo, name), value.strip()]
            setattr(photo, name, value.strip())
    if changes:
        _log(session, user, photo.solution, "photo_edit", changes)
        session.commit()


def delete(session: Session, user: User, solution_id: str) -> None:
    photo = _photo(session, solution_id)
    _log(session, user, photo.solution, "photo_delete", {"фото": ["было", None], "источник": [photo.source_url, None]})
    session.delete(photo)
    session.commit()


def image(session: Session, solution_id: str) -> SolutionPhoto:
    photo = _photo(session, solution_id)
    session.refresh(photo, ["content"])
    return photo


def seed_photos(session: Session) -> int:
    """Снимки из data/catalog/photos/<номер решения>.webp попадают в базу, если у решения фото еще нет.
    Номер берем организатора: снимок достается и второй комплектации с другой ценой.
    Источник и условия берем из sources.csv рядом. Уже загруженные администратором фото не трогаем."""
    folder = settings.data_dir / "catalog" / "photos"
    if not folder.is_dir():
        return 0
    meta: dict[str, dict[str, str]] = {}
    sources = folder / "sources.csv"
    if sources.exists():
        with sources.open(encoding="utf-8-sig", newline="") as file:
            meta = {row["solution_id"]: row for row in csv.DictReader(file, delimiter=";")}
    added = 0
    for path in sorted(folder.iterdir()):
        if path.suffix.lower() not in EXTENSIONS:
            continue
        # Файл назван номером организатора: у одного номера бывает несколько комплектаций, фото получают все
        targets = session.scalars(
            select(Solution).where(or_(Solution.id == path.stem, Solution.organizer_id == path.stem))
        ).all()
        targets = [solution for solution in targets if solution.photo is None]
        if not targets:
            continue
        content = path.read_bytes()
        try:
            content_type = sniff(content)
        except BadImage:
            continue
        row = meta.get(path.stem, {})
        for solution in targets:
            solution.photo = SolutionPhoto(
                content=content,
                content_type=content_type,
                size_bytes=len(content),
                source_url=row.get("source_url", ""),
                owner=row.get("owner", ""),
                license=" ".join(part for part in (row.get("license", ""), row.get("permission", "")) if part),
                uploaded_by="data/catalog/photos",
            )
            added += 1
    if added:
        session.add(CatalogChange(action="photo_seed", changes={"photos": added}, note=f"Фото из data/: {added}"))
        session.commit()
    return added


def _solution(session: Session, solution_id: str) -> Solution:
    solution = session.get(Solution, solution_id)
    if solution is None:
        raise NotFound(f"решение {solution_id}")
    return solution


def _photo(session: Session, solution_id: str) -> SolutionPhoto:
    photo = session.scalar(select(SolutionPhoto).where(SolutionPhoto.solution_id == solution_id))
    if photo is None:
        raise NotFound(f"фото решения {solution_id}")
    return photo


def _log(session: Session, user: User, solution: Solution, action: str, changes: dict) -> None:
    solution.updated_at = datetime.now(UTC)
    session.add(
        CatalogChange(
            user_id=user.id,
            user_email=user.email,
            action=action,
            solution_id=solution.id,
            solution_name=solution.name,
            changes=changes,
        )
    )
