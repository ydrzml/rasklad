"""Отпечаток данных словами у сохраненной версии: модель, файлы, правка каталога и нормативов

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("project_versions", sa.Column("data_note", sa.String(300), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("project_versions", "data_note")
