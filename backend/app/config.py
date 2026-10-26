"""Application settings. The product name lives here and nowhere else (APP_NAME)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

APP_NAME = "Livewire BMS"
APP_VERSION = "1.0.0"

BACKEND_DIR = Path(__file__).resolve().parent.parent
POLICY_DIR = Path(__file__).resolve().parent / "policies"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(BACKEND_DIR / ".env"), extra="ignore")

    database_url: str = f"sqlite:///{(BACKEND_DIR / 'twincmms.db').as_posix()}"
    jwt_secret: str = "change-me-dev-only-secret-at-least-32-bytes-long"
    jwt_expire_minutes: int = 480
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173"
    sim_autostart: bool = False
    policy_file: str = "policy_v1.yaml"
    # Real-time tick of the simulation runner (seconds of wall time between ticks).
    sim_tick_seconds: float = 0.2
    # Upper bound of sim minutes processed per tick, so a slow machine degrades speed, not latency.
    sim_max_minutes_per_tick: int = 12
    # Wall-clock pacing multiplier of the guided demo (1.0 = cinematic, 0 = as fast as possible).
    demo_pace: float = 1.0
    # Operations autopilot (random wear + the simulated crew working every job). Toggle at runtime via the UI.
    autopilot: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def resolved_database_url(self) -> str:
        """Resolve relative sqlite paths against the backend directory (not the CWD)."""
        url = self.database_url
        prefix = "sqlite:///"
        if url.startswith(prefix) and not url.startswith("sqlite:////"):
            path = url[len(prefix):]
            if path != ":memory:" and not Path(path).is_absolute() and not (len(path) > 1 and path[1] == ":"):
                return prefix + (BACKEND_DIR / path).resolve().as_posix()
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
