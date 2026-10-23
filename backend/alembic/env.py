"""Alembic environment — uses the application's own database URL and metadata."""
from alembic import context
from sqlalchemy import create_engine

import app.models  # noqa: F401  (register all tables)
from app import db
from app.config import get_settings
from app.db import Base

target_metadata = Base.metadata


def _url() -> str:
    return context.config.attributes.get("url") or db.database_url() or get_settings().resolved_database_url


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True,
                      render_as_batch=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(_url())
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata,
                          render_as_batch=connection.dialect.name == "sqlite", compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
