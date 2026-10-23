"""Database engines and sessions.

Two engines point at the same database:

* ``read`` — plain deferred transactions, for queries.
* ``write`` — on SQLite every transaction starts with ``BEGIN IMMEDIATE`` so concurrent writers are
  serialised by the database itself (this is what makes stock consumption concurrency-safe on
  SQLite). On PostgreSQL both engines are identical and row locks (``SELECT … FOR UPDATE``) are used.

SQLite runs in WAL mode with a busy timeout so readers never block writers.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Engine, MetaData, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


@dataclass
class _DbState:
    url: str = ""
    read_engine: Engine | None = None
    write_engine: Engine | None = None
    ReadSession: sessionmaker[Session] | None = None
    WriteSession: sessionmaker[Session] | None = None


_state = _DbState()


def is_sqlite(url: str | None = None) -> bool:
    return (url or _state.url).startswith("sqlite")


def _make_engine(url: str, immediate: bool) -> Engine:
    if not is_sqlite(url):
        return create_engine(url, pool_pre_ping=True, future=True)

    engine = create_engine(
        url,
        connect_args={"check_same_thread": False, "timeout": 60},
        future=True,
    )

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn: Any, _rec: Any) -> None:
        # Take over transaction control from pysqlite so BEGIN IMMEDIATE is possible.
        dbapi_conn.isolation_level = None
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=60000")
        cur.close()

    @event.listens_for(engine, "begin")
    def _on_begin(conn: Any) -> None:
        conn.exec_driver_sql("BEGIN IMMEDIATE" if immediate else "BEGIN")

    return engine


def configure(url: str | None = None) -> None:
    """(Re)create engines. Called at import and by tests that use a temporary database."""
    if _state.read_engine is not None:
        _state.read_engine.dispose()
    if _state.write_engine is not None:
        _state.write_engine.dispose()
    _state.url = url or get_settings().resolved_database_url
    _state.read_engine = _make_engine(_state.url, immediate=False)
    _state.write_engine = _make_engine(_state.url, immediate=True) if is_sqlite(_state.url) else _state.read_engine
    _state.ReadSession = sessionmaker(bind=_state.read_engine, expire_on_commit=False, future=True)
    _state.WriteSession = sessionmaker(bind=_state.write_engine, expire_on_commit=False, future=True)


def engine() -> Engine:
    assert _state.write_engine is not None
    return _state.write_engine


def database_url() -> str:
    return _state.url


@contextmanager
def write_session() -> Iterator[Session]:
    """Unit of work: commits on success, rolls back on error."""
    assert _state.WriteSession is not None
    session = _state.WriteSession()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


@contextmanager
def read_session() -> Iterator[Session]:
    assert _state.ReadSession is not None
    session = _state.ReadSession()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def get_read_db() -> Iterator[Session]:
    """FastAPI dependency for read-only endpoints."""
    with read_session() as s:
        yield s


configure()
