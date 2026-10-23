# CLAUDE.md — TwinCMMS architecture rules (survive context resets)

Source of truth for scope: `MASTER_PROMPT.md` (if present) / `docs/UNDERSTANDING.md`.
Decisions: `docs/ASSUMPTIONS.md`. Phases: `docs/PLAN.md`. Product name lives in ONE constant:
`backend/app/config.py: APP_NAME` and `frontend/src/config.ts: APP_NAME`.

## Commands (Windows has no make → use tasks.py; Makefile delegates to it)
- `py -3.11 scripts/tasks.py setup` — venv, pip, npm, migrate + seed
- `python scripts/tasks.py dev` — backend :8000 + frontend :5173
- `python scripts/tasks.py test` — pytest + vitest/playwright
- `python scripts/tasks.py demo` — headless `scripts/run_e2e_demo.py` (Section 15 PASS/FAIL)
- `python scripts/tasks.py reset` — wipe DB, migrate, seed
- Backend python: `backend/.venv/Scripts/python` (Windows) / `backend/.venv/bin/python`.

## Stack (fixed)
Frontend: React 18 + TS strict + Vite, three / R3F / drei, Zustand, TanStack Query, React Router,
Tailwind, Framer Motion, Recharts. Backend: Python 3.11, FastAPI, Pydantic v2, SQLAlchemy 2 +
Alembic, numpy, uvicorn, WebSocket, pytest. DB: SQLite (WAL, default) or Postgres via DATABASE_URL.
Modular monolith — modules under `backend/app/modules/`: assets, simulation, ingestion, monitoring,
decision, cmms, verification, audit, events, analytics (+ auth in app/security.py, demo director).

## Hard rules
1. **Simulator isolation**: `app/modules/simulation` must NOT import ingestion, monitoring,
   decision, cmms, verification, analytics. It publishes via the `TelemetrySink` protocol; wiring
   happens in `app/wiring.py`. Repairs reach it through the event bus. Enforced by
   `tests/test_module_boundaries.py`.
2. **Work-order status changes only via `cmms.workflow.transition()`** — never assign `.status`
   elsewhere. Each transition = one DB transaction writing work_order_events + audit_logs + outbox.
3. **Permissions enforced in the backend.** Denied actions → HTTP 403/409 AND an `audit_logs` row
   with `outcome=DENIED` + reason (written in its own transaction so it survives the rollback).
4. **Sim clock everywhere.** All timestamps come from `simulation_state.sim_now` (UTC), never
   wall-clock (`datetime.now()` is forbidden in domain code; JWT expiry is the only exception).
5. **Determinism**: all randomness via `numpy.random.default_rng(seed)`.
6. **Never silently drop telemetry** — rejected readings go to `rejected_telemetry` with a reason.
7. **Anomaly ≠ diagnosis.** Never write "failed"/"failure confirmed" in explanations; use "consistent
   with possible …, inspection recommended". Thresholds are demo values, not standards — say so.
8. **No hardcoded KPIs / fake API data.** Every UI number comes from the API/DB. Simulated sensor
   data is labelled SIMULATED.
9. **Outbox**: domain change + outbox row in the same transaction; consumers record
   `(event_id, consumer)` in processed_events; retries with exponential backoff, 5 attempts, then
   dead_letters. Event envelope: event_id, event_type, layer, occurred_at, asset_id,
   correlation_id, schema_version, payload.
10. **One active WO per (asset_id, failure_mode)**: partial unique index + in-transaction check;
    repeats attach evidence (+ PriorityEscalationProposed if priority would rise).
11. **No auto-retraining / auto-threshold changes.** Policy changes = new versioned YAML + audit.
12. **Offline**: no runtime CDNs, no external model/texture/font downloads, no paid APIs, no Kafka,
    no microservices. Don't use drei `Text`/`Environment` presets (they fetch from CDNs).
13. Fix, don't skip: never weaken or delete a test to make it pass.
14. Docstrings on every algorithm (formula + parameters). TS strict, Python type hints.
