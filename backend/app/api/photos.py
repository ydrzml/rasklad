from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.db import get_session
from app.services import catalog_photos

router = APIRouter(prefix="/catalog/photos", tags=["каталог"])


@router.get(
    "/{solution_id}",
    response_class=Response,
    summary="Фото решения",
    description="Открыто всем: фото показываются в подборке и рядом с планом. Браузер хранит его сутки.",
    responses={
        200: {"content": {"image/webp": {}, "image/jpeg": {}, "image/png": {}}},
        404: {"description": "Фото нет"},
    },
)
def photo(solution_id: str, session: Annotated[Session, Depends(get_session)]) -> Response:
    try:
        found = catalog_photos.image(session, solution_id)
    except catalog_photos.NotFound as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "У этого решения пока нет фото") from error
    return Response(found.content, media_type=found.content_type, headers={"Cache-Control": "public, max-age=86400"})
