# Plan

| Phase | Scope | Gate |
|---|---|---|
| P0 | Docs, CLAUDE.md, repo skeleton, Makefile + `scripts/tasks.py`, tooling | `tasks.py setup` works |
| P1 | SQLAlchemy models + Alembic, seed, JWT auth, roles, audit, API skeleton | login, 403 + DENIED audit, pytest green |
| P2 | Sim clock, physics simulator, ingestion/validation, warm start, outbox + WS, basic 3D shell + chart | live readings in browser, bad data rejected, screenshot |
| P3 | Detector core + state machine, evidence, explanation | 72 h × 5 seeds → 0 anomalies; lead time ≥ 30 % |
| P4 | Decision engine, policy YAML, dedup, draft WO, approvals, outbox idempotency/retry/dead-letter | one WO per incident, replay safe, 403 + audit |
| P5 | Dispatch scoring, inventory ledger, reservations, technician flows | concurrency test, ineligible tech rejected |
| P6 | Verification, rework, evaluations, analytics | pass + fail branches, SoD, metrics match raw |
| P7 | 3D polish: building detail, equipment, day/night, overlays, avatars, pins, camera rig, quality | FPS measured, screenshots |
| P8 | All pages, pipeline ribbon, layer explorer, timeline, guided demo director, control, landing | end-to-end with real data |
| P9 | `run_e2e_demo.py`, Playwright, restart persistence, README, ARCHITECTURE | Section 15 all PASS |

## Key design choices
- **Pure cores, thin DB wrappers.** Physics (`simulation/physics.py`), detector
  (`monitoring/detector.py`), risk (`decision/risk.py`), dispatch scoring and verification criteria
  are pure functions/classes. They are unit-tested directly and run on 72 h × 5 seeds in seconds.
- **Synchronous outbox drain.** Domain writes add `outbox_events` rows in the same transaction. A
  dispatcher drains them in order (in-process handlers recorded in `processed_events`, then pushed
  to the WebSocket hub). A single pipeline lock serialises sim ticks and drains.
- **Telemetry batching.** One `TelemetryAccepted` event per ingested batch (one sim minute), with
  reading IDs and latest values in the payload, keeps outbox volume sane at 1800x.
- **Simulator isolation.** `simulation` imports neither `ingestion`, `monitoring`, `decision` nor
  `cmms`. It writes to a `TelemetrySink` protocol; `main.py` wires the in-process sink (same function
  the HTTP endpoint calls). Repairs reach the simulator via the event bus. An AST test enforces this.
- **SQLite write serialisation.** A separate write engine issues `BEGIN IMMEDIATE`; Postgres uses
  `SELECT … FOR UPDATE` on the inventory item row.

## Risks
| Risk | Mitigation |
|---|---|
| SQLite throughput at 1800x | batch ingestion, cached sensor metadata, per-sensor state on the row |
| False anomalies from slope noise | slope only triggers WATCH; ANOMALY needs 6/10 z≥3.5 persistence; verified over 72 h × 5 seeds |
| WebGL FPS measurement in headless | measure in headed Chromium with GPU; record machine & numbers honestly |
| Runtime CDN leaks (drei Text/Environment fetch fonts/HDRIs) | avoid them; canvas-texture labels, procedural sky |
| No `make` on Windows | `scripts/tasks.py` mirrors every Makefile target |
| Context resets during a long build | CLAUDE.md holds the architecture rules; commit per phase |
