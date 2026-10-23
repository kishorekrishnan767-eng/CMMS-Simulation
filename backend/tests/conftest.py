"""Shared fixtures. A seeded + warm-started database is built once and copied per test."""
from __future__ import annotations

import shutil
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import bootstrap, db, wiring
from app.modules.events import bus
from app.modules.simulation import engine


@pytest.fixture(scope="session")
def template_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("tpl") / "template.db"
    db.configure(f"sqlite:///{path.as_posix()}")
    bootstrap.migrate()
    bootstrap.seed()
    wiring.configure()
    wiring.warm_start()
    with sqlite3.connect(path) as con:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.configure(f"sqlite:///{path.as_posix()}")  # reopen then dispose to release the file
    return path


@pytest.fixture
def world(template_db: Path, tmp_path: Path) -> Iterator[Path]:
    """A fresh copy of the warm-started world, bound as the active database."""
    target = tmp_path / "world.db"
    shutil.copy(template_db, target)
    db.configure(f"sqlite:///{target.as_posix()}")
    engine.invalidate()
    bus.BACKOFF_BASE_SECONDS = 0.0
    wiring.configure()
    yield target
    db.configure(f"sqlite:///{template_db.as_posix()}")


@pytest.fixture
def client(world: Path) -> TestClient:
    from app.main import app
    return TestClient(app)


def login(client: TestClient, username: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"username": username, "password": "demo1234"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def auth(client: TestClient):  # type: ignore[no-untyped-def]
    cache: dict[str, dict[str, str]] = {}

    def get(username: str) -> dict[str, str]:
        if username not in cache:
            cache[username] = login(client, username)
        return cache[username]
    return get
