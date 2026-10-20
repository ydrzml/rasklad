"""Письма без отправки: ссылка на новый пароль, когда почта на сервере не настроена

Revision ID: 0010
Revises: 0009
"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mail_outbox",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("to_email", sa.String(254), nullable=False),
        sa.Column("subject", sa.String(200), nullable=False),
        sa.Column("link", sa.Text(), nullable=False),
    )
    op.create_index("ix_mail_outbox_at", "mail_outbox", ["at"])


def downgrade() -> None:
    op.drop_index("ix_mail_outbox_at", table_name="mail_outbox")
    op.drop_table("mail_outbox")
