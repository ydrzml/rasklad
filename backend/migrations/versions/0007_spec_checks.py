"""Проверки характеристик по страницам производителей

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "spec_checks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("solution_id", sa.String(36), sa.ForeignKey("solutions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("field", sa.String(60), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("quote", sa.Text(), nullable=False),
        sa.Column("outcome", sa.String(20), nullable=False),
        sa.Column("found_text", sa.Text(), nullable=False),
        sa.Column("current", sa.String(500), nullable=False),
        sa.Column("proposed", sa.String(500), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("source", sa.String(10), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("decided_by", sa.String(254), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("solution_id", "field", "url", name="uq_spec_checks_solution_field_url"),
    )
    op.create_index("ix_spec_checks_solution_id", "spec_checks", ["solution_id"])


def downgrade() -> None:
    op.drop_index("ix_spec_checks_solution_id", table_name="spec_checks")
    op.drop_table("spec_checks")
