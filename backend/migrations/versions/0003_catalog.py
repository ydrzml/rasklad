"""Каталог решений в базе: решения, характеристики с источниками и журнал правок

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "solutions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("organizer_id", sa.String(36), nullable=True),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("company", sa.String(300), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("type", sa.String(200), nullable=False),
        sa.Column("subtype", sa.String(200), nullable=False),
        sa.Column("scenario", sa.Text(), nullable=False),
        sa.Column("cases", sa.Text(), nullable=False),
        sa.Column("trl", sa.Integer(), nullable=True),
        sa.Column("market_potential", sa.Text(), nullable=False),
        sa.Column("region", sa.String(200), nullable=False),
        sa.Column("industry", sa.Text(), nullable=False),
        sa.Column("price_rub", sa.Numeric(14, 2), nullable=True),
        sa.Column("process", sa.String(200), nullable=False),
        sa.Column("tested_fcbas", sa.Boolean(), nullable=False),
        sa.Column("registry_719", sa.Boolean(), nullable=False),
        sa.Column("origin", sa.String(20), nullable=False),
        sa.Column("manual_fields", sa.JSON(), nullable=False),
        sa.Column("organizer_values", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("origin in ('organizer', 'team')", name="solutions_origin_known"),
        sa.CheckConstraint("trl is null or trl between 1 and 9", name="solutions_trl_range"),
    )

    op.create_index("ix_solutions_organizer_id", "solutions", ["organizer_id"])

    op.create_table(
        "solution_specs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("solution_id", sa.String(36), sa.ForeignKey("solutions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("field", sa.String(60), nullable=False),
        sa.Column("value", sa.String(500), nullable=False),
        sa.Column("unit", sa.String(100), nullable=False),
        sa.Column("rating", sa.String(1), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("source_type", sa.String(200), nullable=False),
        sa.Column("quote", sa.Text(), nullable=False),
        sa.Column("retrieved", sa.Date(), nullable=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.UniqueConstraint("solution_id", "field", name="solution_specs_field_unique"),
        sa.CheckConstraint("rating in ('S', 'A', 'B', 'C', 'D', 'E', 'F')", name="solution_specs_rating_known"),
    )
    op.create_index("ix_solution_specs_solution_id", "solution_specs", ["solution_id"])

    op.create_table(
        "solution_photos",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "solution_id",
            sa.String(36),
            sa.ForeignKey("solutions.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.String(30), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("owner", sa.String(300), nullable=False),
        sa.Column("license", sa.Text(), nullable=False),
        sa.Column("uploaded_by", sa.String(254), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "catalog_changes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_email", sa.String(254), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("solution_id", sa.String(36), nullable=True),
        sa.Column("solution_name", sa.String(300), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
    )
    op.create_index("ix_catalog_changes_at", "catalog_changes", ["at"])
    op.create_index("ix_catalog_changes_solution_id", "catalog_changes", ["solution_id"])


def downgrade() -> None:
    op.drop_table("catalog_changes")
    op.drop_table("solution_photos")
    op.drop_table("solution_specs")
    op.drop_table("solutions")
