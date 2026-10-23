#!/usr/bin/env python3
"""Cross-platform task runner mirroring the Makefile targets.

Usage:  python scripts/tasks.py <setup|dev|test|demo|reset|backend|frontend|build>

Windows machines often have no `make`; this script is the canonical implementation and the
Makefile simply delegates to it (see docs/ASSUMPTIONS.md #1).
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV = BACKEND / ".venv"
IS_WIN = os.name == "nt"


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if IS_WIN else "bin/python")


def run(cmd: list[str] | str, cwd: Path, env: dict[str, str] | None = None, shell: bool = False) -> None:
    print(f"\n$ {cmd if isinstance(cmd, str) else ' '.join(cmd)}   (in {cwd.name})", flush=True)
    merged = {**os.environ, **(env or {})}
    result = subprocess.run(cmd, cwd=cwd, env=merged, shell=shell)
    if result.returncode != 0:
        sys.exit(result.returncode)


def npm(*args: str) -> list[str] | str:
    # npm is a .cmd shim on Windows; it must run through the shell.
    return " ".join(["npm", *args]) if IS_WIN else ["npm", *args]


def ensure_env_file() -> None:
    env_file = BACKEND / ".env"
    if not env_file.exists():
        shutil.copy(ROOT / ".env.example", env_file)
        print("created backend/.env from .env.example")


def setup() -> None:
    if sys.version_info < (3, 11):
        sys.exit("Python 3.11+ is required (on Windows try: py -3.11 scripts/tasks.py setup)")
    if not venv_python().exists():
        run([sys.executable, "-m", "venv", str(VENV)], ROOT)
    run([str(venv_python()), "-m", "pip", "install", "-q", "--upgrade", "pip"], BACKEND)
    run([str(venv_python()), "-m", "pip", "install", "-q", "-r", "requirements-dev.txt"], BACKEND)
    ensure_env_file()
    run(npm("install", "--no-fund", "--no-audit"), FRONTEND, shell=IS_WIN)
    run([str(venv_python()), "-m", "app.cli", "init"], BACKEND)
    print("\nSetup complete. Next: python scripts/tasks.py dev")


def _spawn(cmd: list[str] | str, cwd: Path, shell: bool = False) -> subprocess.Popen[bytes]:
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if IS_WIN else 0  # type: ignore[attr-defined]
    return subprocess.Popen(cmd, cwd=cwd, shell=shell, creationflags=flags)


def _stop(procs: list[subprocess.Popen[bytes]]) -> None:
    for p in procs:
        if p.poll() is None:
            if IS_WIN:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
            else:
                p.send_signal(signal.SIGTERM)


def backend() -> None:
    ensure_env_file()
    run([str(venv_python()), "-m", "app.cli", "init"], BACKEND)
    run([str(venv_python()), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], BACKEND)


def frontend() -> None:
    run(npm("run", "dev"), FRONTEND, shell=IS_WIN)


def dev() -> None:
    ensure_env_file()
    run([str(venv_python()), "-m", "app.cli", "init"], BACKEND)
    procs = [
        _spawn([str(venv_python()), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], BACKEND),
        _spawn(npm("run", "dev"), FRONTEND, shell=IS_WIN),
    ]
    print("\nBackend  http://127.0.0.1:8000/docs\nFrontend http://localhost:5173   (Ctrl+C to stop)\n", flush=True)
    try:
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        _stop(procs)


def test() -> None:
    run([str(venv_python()), "-m", "pytest", "-q"], BACKEND)
    run(npm("run", "typecheck"), FRONTEND, shell=IS_WIN)
    run(npm("run", "test:e2e"), FRONTEND, shell=IS_WIN)


def build() -> None:
    run(npm("run", "build"), FRONTEND, shell=IS_WIN)


def demo() -> None:
    run([str(venv_python()), str(ROOT / "scripts" / "run_e2e_demo.py"), *sys.argv[2:]], ROOT)


def reset() -> None:
    ensure_env_file()
    run([str(venv_python()), "-m", "app.cli", "reset"], BACKEND)


TARGETS = {"setup": setup, "dev": dev, "test": test, "demo": demo, "reset": reset,
           "backend": backend, "frontend": frontend, "build": build}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in TARGETS:
        sys.exit(f"usage: python scripts/tasks.py <{'|'.join(TARGETS)}>")
    TARGETS[sys.argv[1]]()
