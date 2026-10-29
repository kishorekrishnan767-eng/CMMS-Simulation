"""Store technician machine photos with inspection reports."""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inspection_records", sa.Column("photo_data", sa.Text(), nullable=True))
    op.execute(
        "UPDATE inspection_records SET photo_data = "
        "'data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>'"
    )
    with op.batch_alter_table("inspection_records") as batch_op:
        batch_op.alter_column("photo_data", nullable=False)


def downgrade() -> None:
    op.drop_column("inspection_records", "photo_data")
