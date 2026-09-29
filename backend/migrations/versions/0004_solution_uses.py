"""Где работает решение и что делает: объект и операция со статусом

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "solution_uses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("solution_id", sa.String(36), sa.ForeignKey("solutions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("facility", sa.String(30), nullable=False),
        sa.Column("operation", sa.String(60), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.UniqueConstraint("solution_id", "facility", "operation", name="solution_uses_unique"),
        sa.CheckConstraint("status in ('confirmed', 'suggested', 'rejected')", name="solution_uses_status_known"),
    )
    op.create_index("ix_solution_uses_solution_id", "solution_uses", ["solution_id"])


def downgrade() -> None:
    op.drop_index("ix_solution_uses_solution_id", table_name="solution_uses")
    op.drop_table("solution_uses")
