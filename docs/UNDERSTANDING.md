# Understanding — TwinCMMS

**What it is.** A self-contained demonstration of a CMMS (Computerized Maintenance Management
System) wrapped around a 3D digital twin of a commercial office tower ("Tower A"). A visitor
watches simulated sensor data flow from building equipment through a real backend pipeline —
validation, anomaly detection, risk scoring, work-order workflow, technician dispatch, repair and
verification — with every number coming from the database. Only the *sensor data* is fake, and it
is labelled SIMULATED everywhere.

**The 7 layers.**
1. **Asset model** — building, floors, assets, sensors (FKs, criticality, skills).
2. **Telemetry & simulation** — a seeded, deterministic physics model (load-driven fan vibration,
   bearing temperature, motor current) plus injectable bearing wear and data-quality faults. It
   only *publishes* readings through the ingestion interface; it never decides anything.
3. **Validation** — schema, idempotency, referential, unit, timestamp, plausibility, flatline and
   gap checks. Bad data is stored with a reason, never dropped.
4. **Condition monitoring** — a load-compensated robust baseline (OLS + MAD), z-score, residual
   slope and persistence feed a hysteresis state machine NORMAL→WATCH→ANOMALY→CLEARED. Output is
   evidence + a template explanation. An anomaly is *not* a diagnosis.
5. **Decision** — a versioned YAML policy turns severity, criticality, persistence, trend and data
   quality into a 0–100 risk score and an action (MONITOR/INSPECT/INSPECT_URGENT/URGENT_HUMAN_REVIEW).
   Deduplication guarantees one active work order per (asset, failure mode).
6. **CMMS workflow** — one `transition()` service owns the work-order state machine, role guards,
   audit and outbox writes; transparent technician dispatch scoring; a ledger-based inventory with
   reservations and concurrency-safe consumption.
7. **Verification & learning** — a 30-sample post-repair window must pass statistical criteria and
   separation of duties; failures loop to rework. Evaluation metrics (latency, lead time, precision,
   MTTA, MTTR, cost) are computed from stored ground truth. No auto-retraining.

**End-to-end incident flow (golden scenario).** Bearing wear is injected on `AHU-02-FAN-01` →
vibration rises → readings pass validation → detector goes WATCH then ANOMALY (`AnomalyDetected`,
incident `INC-xxxx`) → decision engine scores risk → a single DRAFT work order is created; later
escalations attach as evidence → an operator's approval is denied (403 + audit) → a supervisor
approves → dispatch ranks technicians, supervisor assigns, parts are reserved → the technician
avatar walks to the roof, starts and completes work (parts consumed) → the simulator applies the
repair → 30 post-repair samples are collected → the technician cannot verify their own work, the
verifier passes it → supervisor closes → anomaly CLEARED, baseline unfreezes. Every step emits an
event with the same `correlation_id`, persisted through a transactional outbox and pushed live over
WebSocket to the 3D scene, ribbon and timeline.

**What "done" means.** All 17 items in Section 15 of the master prompt pass in
`scripts/run_e2e_demo.py` + Playwright: real persistence, no false anomalies over 72 h × 5 seeds,
detection before the alarm limit, one WO per incident, backend-enforced roles with DENIED audit
rows, concurrency-safe stock, pass and fail verification branches, idempotent replay, restart
persistence, data-derived analytics, a guided demo that runs all 10 steps, and a 3D scene measured
at ≥60 fps on Medium (with the machine recorded).
