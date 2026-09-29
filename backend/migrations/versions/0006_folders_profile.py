"""Папки проектов, имя и компания в профиле

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_folders_owner_id", "folders", ["owner_id"])
    # batch: SQLite в тесте миграций не умеет добавлять внешний ключ к готовой таблице иначе
    with op.batch_alter_table("projects") as batch:
        batch.add_column(sa.Column("folder_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("projects_folder_id_fkey", "folders", ["folder_id"], ["id"], ondelete="SET NULL")
        batch.create_index("ix_projects_folder_id", ["folder_id"])
    op.add_column("users", sa.Column("name", sa.String(120), server_default="", nullable=False))
    op.add_column("users", sa.Column("company", sa.String(200), server_default="", nullable=False))


def downgrade() -> None:
    op.drop_column("users", "company")
    op.drop_column("users", "name")
    with op.batch_alter_table("projects") as batch:
        batch.drop_index("ix_projects_folder_id")
        batch.drop_constraint("projects_folder_id_fkey", type_="foreignkey")
        batch.drop_column("folder_id")
    op.drop_index("ix_folders_owner_id", table_name="folders")
    op.drop_table("folders")
