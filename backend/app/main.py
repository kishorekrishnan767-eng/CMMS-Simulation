"""FastAPI application: lifespan, CORS, error handling, routers."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import inspect

from app import bootstrap, db, wiring
from app.config import APP_NAME, APP_VERSION, get_settings
from app.errors import DomainError
from app.modules.events import bus
from app.modules.simulation import engine


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    bus.hub.bind_loop(asyncio.get_running_loop())
    if "simulation_state" not in inspect(db.engine()).get_table_names():
        bootstrap.migrate()
    bootstrap.seed()
    wiring.ensure_warm_start()
    engine.runner.start()
    if get_settings().sim_autostart:
        from app.db import write_session
        from app.models import SimulationState
        with write_session() as s:
            s.get(SimulationState, 1).running = True  # type: ignore[union-attr]
    yield
    engine.runner.stop()


def create_app() -> FastAPI:
    app = FastAPI(title=f"{APP_NAME} API", version=APP_VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=get_settings().cors_origin_list, allow_credentials=True,
        allow_methods=["*"], allow_headers=["*"],
    )

    @app.exception_handler(DomainError)
    async def domain_error(_: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={
            "error": {"code": exc.code, "message": exc.message, "details": exc.details}})

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"error": {
            "code": "validation_error", "message": "Request validation failed",
            "details": {"errors": [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]}}})

    from app.api import routes, routes_cmms
    app.include_router(routes.router)
    app.include_router(routes_cmms.router)
    app.include_router(routes.ws_router)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "app": APP_NAME, "version": APP_VERSION, "simulated": True,
                "runner_error": engine.runner.last_error, "ws_clients": bus.hub.client_count}

    return app


app = create_app()
