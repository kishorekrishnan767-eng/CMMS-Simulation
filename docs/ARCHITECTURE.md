# Architecture

## Shape

A **modular monolith**: one FastAPI app, one database, internal modules with enforced boundaries.

| Module | Layer | Responsibility |
|---|---|---|
| `assets` | 1 | Building/floors/assets/sensors, seed data |
| `simulation` | 2 | Clock, seeded physics (`physics.py`), engine/runner, fault injection. Publishes only through `TelemetrySink` |
| `ingestion` | 3 | Eight-step validation, raw storage, `rejected_telemetry`, gap/stale sweep |
| `monitoring` | 4 | Pure detector (`detector.py`) + persistence wrapper, anomalies, evidence, explanation templates |
| `decision` | 5 | Versioned YAML policy, risk score, decision table, one-WO-per-incident dedup |
| `cmms` | 6 | `workflow.transition()` state machine, dispatch scoring, inventory ledger |
| `verification` | 7 | Post-repair window criteria, separation of duties, rework loop |
| `analytics` | 7 | Evaluation records and aggregate metrics from stored data |
| `events` | – | Transactional outbox, dispatcher, idempotent consumers, dead letters, WebSocket hub, timeline |
| `audit` | – | `audit_logs` (ALLOWED inside the transaction, DENIED in a fresh one) |
| `demo` | – | Guided-demo director — an API client that only calls public endpoints |

`app/wiring.py` is the composition root. `app/commands.py` is the single command executor
(permission → unit of work → audit → drain events). Rules enforced by `tests/test_module_boundaries.py`:
the simulator imports no downstream module; no wall-clock time in domain code; work-order `status` is only
assigned in `cmms/workflow.py`.

## Time and determinism
All domain timestamps come from `simulation_state.sim_now`. Randomness uses `numpy.random.default_rng` keyed
by `(seed, asset, chunk)`, so a seed reproduces an identical run at any speed. `step_minutes(n)` generates
`n` minutes as **one batch** (the detector processes samples sequentially), which lets 1800× (30 sim-min/s) run.

## Events
Envelope: `event_id, event_type, layer, occurred_at, asset_id, correlation_id (incident), schema_version, payload`.
A domain change and its `outbox_events` row commit together. The dispatcher delivers in id order to consumers;
each `(event_id, consumer)` is recorded in `processed_events` in the same transaction as the consumer's work
(replays do nothing). Failures retry with exponential backoff, five attempts, then `dead_letters`.
Every dispatched event is pushed to browsers over `/ws/events`.

Types: `TelemetryAccepted/Rejected, DataQualityWarning, AnomalyWatch, HealthStateChanged, AnomalyDetected,
AnomalyEscalated, AnomalyCorroborated, AnomalyCleared, RiskAssessed, WorkOrderDrafted, EvidenceAttached,
PriorityEscalationProposed/Acknowledged, WorkOrderApproved/Rejected/Cancelled, TechnicianAssigned,
PartsReserved, PartsShortage, StockReceived, WorkOrderOnHold/Resumed, WorkStarted, WorkCompleted,
RepairApplied, VerificationPassed/Failed, ReworkRequired/Started, WorkOrderClosed, EvaluationRecorded,
FaultInjected, SimulationControl/Reset`.

## Concurrency
SQLite: a second engine begins every write transaction with `BEGIN IMMEDIATE` (writers serialise in the
database). PostgreSQL: `SELECT … FOR UPDATE` on the inventory item. Stock is a ledger (`Σ stock_movements`);
consumption re-reads the ledger after taking the lock, so two concurrent completions cannot go negative
(tested with threads).

## Layer 4 in one screen
`residual = v − (a + b·load)`, `σ = max(1.4826·MAD, 0.05)`, `z = residual/σ`, slope over 15 samples,
persistence over 10. NORMAL→WATCH→ANOMALY with hysteresis, frozen baseline outside NORMAL, cleared only by
Layer 7 or a supervisor. Deviations from the literal spec (longer-history slope, 3-sample guard on the slope
trigger) are documented in `ASSUMPTIONS.md` #21.

## Frontend
React 18 + TypeScript strict + Vite. Server state: TanStack Query. Live state (sim clock, health, latest
values, layer counters, toasts): Zustand fed by one WebSocket. The 3D scene (react-three-fiber) is fully
procedural; asset visuals are driven from the store inside `useFrame` (no React re-render per tick).
Technician poses are derived purely from work-order timestamps and the sim clock, so walking speeds up,
slows and pauses with the simulation. No runtime CDNs: fonts are bundled, reflections use three's
procedural `RoomEnvironment`, labels are DOM overlays.
