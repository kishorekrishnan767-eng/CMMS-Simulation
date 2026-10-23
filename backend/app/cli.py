"""Command line: `python -m app.cli init|reset|seed`."""
from __future__ import annotations

import sys

from app import bootstrap, db


def init() -> None:
    bootstrap.migrate()
    bootstrap.seed()
    from app.wiring import ensure_warm_start
    ensure_warm_start()
    print(f"database ready: {db.database_url()}")


def reset() -> None:
    bootstrap.drop_all()
    init()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "init"
    {"init": init, "reset": reset, "seed": bootstrap.seed}[cmd]()
