"""Нормативы, поправленные администратором, и журнал их правок

Revision ID: 0008
Revises: 0007
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "norm_overrides",
        sa.Column("path", sa.String(200), primary_key=True),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("source_date", sa.String(10), nullable=True),
        sa.Column("trust", sa.String(1), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_email", sa.String(254), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "norm_changes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_email", sa.String(254), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("path", sa.String(200), nullable=False),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
    )
    op.create_index("ix_norm_changes_at", "norm_changes", ["at"])
    op.create_index("ix_norm_changes_path", "norm_changes", ["path"])


def downgrade() -> None:
    op.drop_index("ix_norm_changes_path", table_name="norm_changes")
    op.drop_index("ix_norm_changes_at", table_name="norm_changes")
    op.drop_table("norm_changes")
    op.drop_table("norm_overrides")
