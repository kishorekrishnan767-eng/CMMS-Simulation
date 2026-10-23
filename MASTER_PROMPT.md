# MASTER PROMPT — 3D CMMS Digital Twin Simulation Website

**Working title:** TwinCMMS (keep the name in ONE config constant so it can be renamed later)

---

## 0. HOW YOU MUST WORK (read first)

1. **Understand before you build.** Before writing code, create `docs/UNDERSTANDING.md` (max 1 page, your own words) explaining what this system is, the 7 layers, the end-to-end incident flow, and what "done" means. Then create `docs/PLAN.md` (phases, risks) and `docs/ASSUMPTIONS.md`. Then create `CLAUDE.md` containing the architecture rules from Sections 1, 3, 7, 8 and 16 so they survive context resets.
2. **Do not ask me questions unless you are truly blocked.** Make the sensible choice, write it into `docs/ASSUMPTIONS.md`, and continue.
3. **Build in the phases of Section 14.** Each phase ends with a gate: tests pass, app runs, you have verified the behaviour yourself (run it; take Playwright screenshots of the 3D scene and pages). Commit after every phase with a clear message.
4. **Everything must be real, connected and persistent.** No hardcoded dashboard numbers, no fake API responses, no mock data in the UI. Every number shown comes from the database through the API. The only "fake" thing allowed is the *simulated sensor data*, and it must be labelled **SIMULATED** in the UI.
5. **Fix, don't skip.** If a test fails or something renders wrong, debug it. Never delete or weaken a test to make it pass.
6. **No paid services, no API keys, no runtime CDN dependencies.** The whole project must run offline after `install`. Bundle all fonts/textures/assets locally or generate them procedurally.
7. Keep code clean: typed (TypeScript strict, Python type hints), small modules, docstrings on every algorithm explaining the formula and parameters.

---

## 1. CONTEXT — WHAT IS THIS PROJECT?

A **CMMS (Computerized Maintenance Management System)** helps a facility team detect equipment problems, decide what to do, manage the repair work, and verify the repair. This project is a **fully working simulation** that shows the complete chain on a **realistic 3D building**:

> **Sensor data → validation → anomaly detection → risk decision → work order → approval → technician dispatch → repair → verification → learning**

It is a **demonstration product**: a visitor opens the website, sees a 3D building with HVAC equipment, watches a simulated fan bearing slowly degrade, sees the system detect it and explain why, sees a work order appear, a supervisor approve it, a technician walk to the fan in 3D, repair it, and a verifier confirm recovery. Every step is driven by the real backend logic below.

**Domain basics you must respect**
- A **BMS** (Building Management System) monitors and controls building systems (HVAC, pumps, lighting, fire safety, electrical). Sensors report what is happening; controllers decide; actuators act. Typical field protocols are BACnet and Modbus (document this in the About page; the simulator stands in for them via an adapter interface).
- An **anomaly is not a diagnosis.** The system may say "persistent vibration rise consistent with possible bearing degradation — inspection recommended". It must **never** claim a component has failed.
- **Deterministic backend rules** control approvals, permissions and safety-related actions. Any text explanation is template-based. (Optionally leave a disabled `LLMExplainer` adapter interface; default OFF, no API keys needed.)
- All thresholds in this project are **demo values, configurable per asset, not taken from any standard**. State this in the UI.

**The one running example (golden scenario):** HVAC fan `AHU-02-FAN-01` develops bearing wear → vibration rises. The whole system is designed around this incident, but must also handle other assets and a failed-repair branch.

---

## 2. DELIVERABLES

1. A **marketing + demo website** (React) containing a **real-looking 3D building** with live data.
2. A **backend** (FastAPI) implementing all 7 layers with real logic, persistence and auth.
3. A **simulation engine** (seeded, deterministic, controllable speed).
4. A **Guided Demo mode** that runs the golden scenario with narration, auto camera moves and pause points — driving the *real* APIs.
5. **Automated tests** (pytest + Playwright) and a headless script `scripts/run_e2e_demo.py` that executes the entire Definition of Done and prints PASS/FAIL per item.
6. `README.md` (setup in under 5 commands, architecture diagram, demo walkthrough), plus `docs/`.

---

## 3. TECH STACK (decided — do not change without recording why)

**Frontend:** React 18 + TypeScript (strict) + Vite, `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing` (optional, behind quality toggle), Zustand (UI/live state), TanStack Query (server state), React Router, Tailwind CSS, Framer Motion, a lightweight chart lib (uPlot or Recharts) for telemetry.
**Backend:** Python 3.11+, FastAPI, Pydantic v2, SQLAlchemy 2.x + Alembic, numpy (seeded RNG), uvicorn, WebSocket (or SSE) for live push, pytest.
**Database:** SQLAlchemy models portable across **SQLite (default, WAL mode, zero setup)** and **PostgreSQL** (via `DATABASE_URL` + `docker-compose.yml`). Use only features both support (partial unique indexes are fine).
**Architecture:** a **modular monolith**. One backend app with strict internal modules (`assets`, `simulation`, `ingestion`, `monitoring`, `decision`, `cmms`, `verification`, `audit`, `events`). One database. The **simulator must not import monitoring/decision/cmms code** — it only publishes telemetry through the same ingestion interface a real device adapter would use (module boundary enforced by an import-linter style test). No Kafka, no microservices.
**Dev experience:** `make setup`, `make dev` (backend + frontend), `make test`, `make demo` (headless e2e), `make reset`. Seed data auto-loads.

### Repo structure
```
/backend
  app/{main.py, config.py, db.py, security.py}
  app/modules/{assets,simulation,ingestion,monitoring,decision,cmms,verification,audit,events,analytics}/
  app/policies/policy_v1.yaml        # versioned risk/threshold policy
  alembic/  tests/
/frontend
  src/{pages,components,three,store,api,hooks,styles}/
  src/three/{Building.tsx, Equipment/*, Technicians.tsx, Overlays.tsx, CameraRig.tsx}
/scripts/run_e2e_demo.py
/docs/{UNDERSTANDING.md,PLAN.md,ASSUMPTIONS.md,ARCHITECTURE.md}
CLAUDE.md  README.md  Makefile  docker-compose.yml
```

---

## 4. SIMULATION CLOCK & DETERMINISM

- A single **simulation clock** (UTC, stored in DB, advanced by the sim engine). **All timestamps in all tables derive from the sim clock**, never wall-clock, so pause/reset/speed changes stay consistent.
- Speeds: 1x, 10x, 60x (default: 1 real second = 1 sim minute), 300x, 1800x. Pause, resume, reset-to-seed.
- Sampling interval: **1 sim minute** per sensor.
- All randomness uses `numpy.random.default_rng(seed)`; the same seed gives identical runs (required for tests).
- **Warm start:** on reset, backfill **6 sim hours** of healthy history through the normal ingestion path so the detector has a baseline immediately.

---

## 5. THE BUILDING & ASSET MODEL (Layer 1)

Seed one building: **"Tower A" — commercial office, ground lobby + 5 floors + roof plant deck + basement plant room.**

Seed assets (each with type, location, criticality LOW/MEDIUM/HIGH, status, required skills for maintenance):

| Asset ID | Type | Location | Criticality |
|---|---|---|---|
| `AHU-02-FAN-01` | Supply fan (golden scenario) | Roof deck | HIGH |
| `AHU-01-FAN-01` | Supply fan | Roof deck | HIGH |
| `AHU-03-FAN-01` | Supply fan | Roof deck | MEDIUM |
| `CHILLER-01` | Chiller | Basement | HIGH |
| `CHW-PUMP-01`, `CHW-PUMP-02` | Chilled-water pumps | Basement | MEDIUM |
| `EXH-FAN-01` | Exhaust fan | Roof deck | LOW |
| `FCU-03-01` | Fan coil unit | Floor 3 | LOW |

Each asset has 2–4 sensors, each sensor linked to exactly one asset (FK). Example sensor set for a fan: `VIB-xxx` (vibration velocity, mm/s), `TMP-xxx` (bearing temperature, °C), `CUR-xxx` (motor current, A), `SPD-xxx` (VFD speed command, %). Chiller/pump assets can use a reduced set (temperature, current, pressure). Include metadata: install date, last maintenance, runtime hours.

---

## 6. THE SEVEN LAYERS — EXACT LOGIC AND ALGORITHMS

Every layer: receives X → does Y → emits event Z → stores W. Every event carries `layer`, `correlation_id` (incident ID), `event_id`, `schema_version`, `occurred_at` (sim UTC).

### Layer 2 — Telemetry & Simulation Engine

For fan sensors, at sample time *t* (sim hours):

```
load(t)     = clip( 0.80 + 0.15*sin(2π(hour(t) - 7)/24) + step_noise, 0.55, 1.0 )   # occupancy-driven; random load steps every few hours
speed_pct   = 100 * load(t)                                                        # VFD speed command
v_healthy   = 0.5 + 1.5*load(t) + N(0, 0.08)          # mm/s  (≈1.3–2.0 healthy)
D(t)        = 0                                         if t < t0 (fault start)
            = A * ((t - t0)/T)^p                        for t0 ≤ t < t0+T,   then clamp at A*1.15
vibration   = v_healthy + D(t)                          # defaults: A=7.0 mm/s, p=2 (accelerating), T=1.5 sim-hours in demo profile (4 h in "realistic" profile)
bearing_T   = 42 + 12*load + 0.9*D(t) + N(0, 0.4)       # °C
current     = 10*load + 0.12*D(t) + N(0, 0.15)          # A
```
Fault repaired at *t_r*: `D(t) = D(t_r) * (1 - repair_effectiveness)` (full repair = 1.0 → D=0; partial repair 0.4 for the failed-repair scenario), plus exponential settle (τ = 5 min).

**Injectable data-quality faults** (for demonstrating Layer 3): `flatline` (sensor stuck), `spike` (single outlier), `dropout` (missing samples), `duplicate` (same event_id sent twice), `late_event` (timestamp 20+ min old), `bad_unit` (wrong unit string), `unknown_sensor`.

Telemetry event:
```json
{"event_id":"evt-…","asset_id":"AHU-02-FAN-01","sensor_id":"VIB-001","metric":"vibration_velocity",
 "value":5.8,"unit":"mm/s","timestamp":"<sim UTC>","source":"simulation","quality":"good"}
```
The simulator sends batches through `POST /api/ingest/telemetry` (same interface a real adapter / MQTT bridge would use; also provide an `MqttAdapter` stub interface class, unused by default). It never creates alerts or work orders itself.

### Layer 3 — Validation & Processing (`ingestion` module)

Per reading, in this order (first failure → store in `rejected_telemetry` with `reason`, publish `TelemetryRejected`, stop):
1. **Schema check** (required fields, types).
2. **Idempotency:** `event_id` already in `telemetry_readings` or `processed_events` → mark `DUPLICATE`, no side effects.
3. **Referential check:** sensor exists, belongs to that asset, metric matches sensor definition.
4. **Unit check:** unit equals sensor's expected unit.
5. **Timestamp check:** not in the future (> sim now + 1 min); if older than the asset's watermark by more than 5 min → mark `LATE`, store but **do not feed the detector** (flag for review).
6. **Plausibility range** per metric (e.g. vibration 0–50 mm/s); outside → `OUT_OF_RANGE` quarantine.
7. **Flatline detection:** last 15 values identical (ε=1e-9) → quality `SUSPECT_FLATLINE`.
8. **Missing data:** if gap > 3 sample intervals → raise `DataQualityWarning`, set sensor quality `STALE`.

Store the **raw original** reading first (`telemetry_readings`, with `quality` and `status`), then publish `TelemetryAccepted` for good readings only. Bad data is never silently dropped.

### Layer 4 — Condition Monitoring & Anomaly Detection (`monitoring` module)

Transparent statistics, **no black-box ML**. Per (asset, primary metric = vibration) keep a persistent `detector_state` row.

**Load-compensated baseline** (so normal load changes don't trigger alerts):
```
Healthy window W = last 120 samples with state == NORMAL (frozen when state != NORMAL)
Fit OLS:  v ≈ a + b * load      (load = speed_pct/100)
residual r_t = v_t - (a + b*load_t)
σ = max( 1.4826 * MAD(residuals in W), σ_min=0.05 )         # robust std
z_t = r_t / σ
slope_t = OLS slope of r over last K=15 samples, in mm/s per hour
persistence = number of last N=10 samples with z ≥ 3.5
```
**State machine (with hysteresis):**
```
NORMAL  → WATCH     if z ≥ 2.5 for 3 consecutive samples  OR  slope ≥ 0.5 mm/s/h
WATCH   → NORMAL    if z < 2.0 for 5 consecutive samples
WATCH   → ANOMALY   if persistence ≥ M=6 (of N=10)  AND  slope > 0
ANOMALY → ANOMALY   (escalate severity if it increases)
ANOMALY → CLEARED   only via Layer 7 verification pass (or manual supervisor clear) — and then z < 1.5 for 10 consecutive samples → NORMAL
```
**Severity** = max of statistical and absolute rules:
```
sev_stat: z ≥ 3.5 → LOW(1);  z ≥ 6 → MEDIUM(2);  z ≥ 10 → HIGH(3)
sev_abs (per-asset limits, demo defaults): v ≥ 4.5 → MEDIUM;  v ≥ 7.1 → HIGH;  v ≥ 11.0 → CRITICAL
```
**Corroboration:** if bearing temperature and/or current residuals also have z ≥ 3 → confidence += 0.25 each (base 0.5, max 1.0). Corroboration raises confidence, never severity alone.
**Projection (indicative only):** `t_to_alarm_limit = (alarm_limit - v_now) / slope` — label in UI "trend extrapolation, indicative, not a prediction guarantee".

**Anomaly event payload** must contain: asset_id, metric, observed value, baseline mean/σ, z, slope, persistence, severity, confidence, corroborating metrics, window start/end, **the supporting readings (IDs)**, detector version, projection. Emit `AnomalyDetected` on first transition to ANOMALY, `AnomalyEscalated` when severity increases, `AnomalyCleared` on clear.

**Template explanation (deterministic):** "Vibration on AHU-02-FAN-01 has risen 3.8σ above its load-adjusted baseline and kept rising for 12 min (slope 1.9 mm/s/h). Bearing temperature corroborates. This pattern is consistent with possible bearing degradation. Recommended: inspection." Never say "failed".

### Layer 5 — Risk Assessment & Decision Engine (`decision` module)

Policy lives in `policies/policy_v1.yaml` (versioned; every decision stores `policy_version`). Compute:
```
S = {LOW:.25, MEDIUM:.5, HIGH:.75, CRITICAL:1.0}[severity]
C = {LOW:.3, MEDIUM:.6, HIGH:1.0}[asset.criticality]
P = min(1, consecutive_anomalous_samples / 20)
R = min(1, slope / slope_critical)            # slope_critical = 6 mm/s/h
Q = data-quality multiplier 0..1 (1.0 good; 0.7 if any corroborating sensor stale/suspect)
risk = 100 * (0.40*S + 0.25*C + 0.20*P + 0.15*R) * (0.5 + 0.5*Q)
```
Decision table:

| risk | Action | Priority | Required approval |
|---|---|---|---|
| < 30 | MONITOR (no work order) | – | – |
| 30–55 | INSPECT | P3 | Supervisor |
| 55–75 | INSPECT_URGENT | P2 | Supervisor |
| ≥ 75 or severity CRITICAL | URGENT_HUMAN_REVIEW | P1 | Supervisor + notify all operators |

Output a **decision record**: severity, risk score with each term shown, reason text, recommended action, policy version, required approval. In demo, the system **never** automatically stops equipment; P1 produces a "request supervisor to follow site safety procedure" action.

**Deduplication (critical rule):** one active work order per `(asset_id, failure_mode)`. Enforce with a **partial unique index** on active states plus an application check inside the same transaction. If an active WO exists: **attach the new anomaly/decision as evidence**, and if priority should rise, record a `PriorityEscalationProposed` event requiring supervisor acknowledgement. Never create a second WO.

### Layer 6 — Maintenance Workflow / CMMS (`cmms` module)

**Work-order state machine** — implemented in ONE service (`transition(work_order, action, actor)`), never by setting status strings elsewhere. Every transition runs in a single DB transaction that also writes `work_order_events`, `audit_logs` and an outbox event.

| From | Action | To | Allowed role | Guard |
|---|---|---|---|---|
| (new) | system draft | DRAFT | system | decision exists |
| DRAFT | approve | OPEN | SUPERVISOR | evidence attached |
| DRAFT | reject | REJECTED | SUPERVISOR | reason required |
| DRAFT/OPEN | cancel | CANCELLED | SUPERVISOR | reason required |
| OPEN | assign | ASSIGNED | SUPERVISOR | technician eligible (see dispatch) |
| OPEN/ASSIGNED | hold | ON_HOLD | SUPERVISOR/TECH | reason (e.g. AWAITING_PARTS) |
| ON_HOLD | resume | previous state | SUPERVISOR | blocker cleared |
| ASSIGNED | start | IN_PROGRESS | assigned TECHNICIAN only | – |
| IN_PROGRESS | complete | COMPLETED | assigned TECHNICIAN only | inspection record + findings + parts used recorded |
| COMPLETED | verify pass | VERIFIED | VERIFIER (≠ technician) | verification criteria pass (Layer 7) |
| COMPLETED | verify fail | REWORK_REQUIRED | VERIFIER | reason + evidence |
| REWORK_REQUIRED | restart | IN_PROGRESS | assigned TECHNICIAN | – |
| VERIFIED | close | CLOSED | SUPERVISOR | closure checklist complete |

Any other transition → HTTP 409/403, **and an audit_log row with `outcome=DENIED` and the reason**.

**Technician dispatch algorithm (transparent, explainable):**
```
eligible = technicians where required_skills ⊆ tech.skills
           AND on_shift(sim_now) AND active_jobs < max_jobs(2)
score = 0.35*skill_fit + 0.25*proximity + 0.20*(1 - workload_ratio) + 0.20*performance
  skill_fit   = |required ∩ skills| / |required| + 0.2 bonus for higher certification level (cap 1)
  proximity   = 1 - floor_distance(tech.current_floor, asset.floor) / max_floors
  workload    = active_jobs / max_jobs
  performance = historical first-time-fix rate (seeded 0.6–0.95, updated from real outcomes)
```
Return ranked candidates **with the score breakdown**; the supervisor confirms (system never silently assigns).

**Inventory (transactional ledger):**
- `stock_movements` is the source of truth; `quantity_on_hand = Σ movements`.
- On assignment: **reserve** required parts (e.g. bearing set `BRG-001`, grease `GRS-001`). If insufficient → work order goes `ON_HOLD (AWAITING_PARTS)` and a reorder event is created; a supervisor can "receive stock" to resume.
- On completion: **consume** the parts actually used. Use row locks / serializable transaction so two concurrent completions cannot drive stock negative (test this).

### Layer 7 — Repair Verification & Learning (`verification` module)

After `COMPLETED`, the simulator applies the repair (effectiveness set by the scenario). Collect a **verification window of 30 post-repair samples**; pass requires ALL of:
```
mean(residual) within ±2σ of baseline  AND  max(z) < 3.0 over the window
AND slope not significantly positive (|slope| < 0.3 mm/s/h)
AND no anomaly raised during the window
AND corroborating metrics (bearing temp, current) normal
AND verifier.id != technician.id  (separation of duties)
```
Pass → `VERIFIED` → supervisor closes → anomaly `CLEARED`, detector baseline unfreezes. Fail → `REWORK_REQUIRED` with the failing criteria listed; demonstrate with `repair_effectiveness = 0.4`.

**Learning/evaluation (no auto-retraining, no auto-threshold changes):** for each injected fault (ground truth in `fault_injections`) compute and store: detection latency (t_detect − t_fault_start), **lead time before the alarm limit was crossed**, true positive / false positive / false negative counts, alert precision, MTTA (alert → approval/assignment), MTTR (alert → verified), maintenance cost (labour + parts), before/after measurement comparison. Threshold changes happen only via a new versioned policy file + audit entry.

---

## 7. EVENT BUS & COMMUNICATION CONTRACT

Three mechanisms: **(A)** HTTP API for commands/queries, **(B)** telemetry ingestion endpoint (+ MQTT adapter stub), **(C)** internal events for asynchronous workflow.

- Implement the **transactional outbox**: domain change + `outbox_events` row in the same DB transaction; a dispatcher publishes to in-process async handlers and to the WebSocket hub.
- **Event envelope:**
```json
{"event_id":"uuid","event_type":"AnomalyDetected","layer":4,"occurred_at":"<sim UTC>",
 "asset_id":"AHU-02-FAN-01","correlation_id":"INC-0001","schema_version":1,"payload":{…}}
```
- **Idempotency:** every consumer records `(event_id, consumer)` in `processed_events`; replaying an event produces no duplicate side effects (test it).
- **Retries:** exponential backoff, max 5 attempts, then **dead-letter** (visible in an admin view).
- **Event types:** `TelemetryAccepted`, `TelemetryRejected`, `DataQualityWarning`, `AnomalyDetected`, `AnomalyEscalated`, `AnomalyCleared`, `RiskAssessed`, `WorkOrderDrafted`, `EvidenceAttached`, `PriorityEscalationProposed`, `WorkOrderApproved`, `TechnicianAssigned`, `PartsReserved`, `PartsShortage`, `WorkStarted`, `WorkCompleted`, `VerificationPassed`, `VerificationFailed`, `ReworkRequired`, `WorkOrderClosed`.
- Push every event to the browser over **WebSocket** so the UI updates live. The `correlation_id` links every record of one incident for the timeline view.
- Authorization: events never bypass permission/workflow checks — consumers call the same service functions as the API.

---

## 8. AUTH, ROLES, AUDIT

- JWT auth with seeded demo users shown on a login/role-switcher panel: **ADMIN, OPERATOR, SUPERVISOR, TECHNICIAN (×3, different skills/floors), VERIFIER**.
- Permissions enforced **in the backend**. The UI hides buttons for convenience, but the backend must reject unauthorized actions (this is demonstrated live).
- `audit_logs`: who, role, action, target, outcome (`ALLOWED`/`DENIED`), reason, before/after, sim timestamp, correlation_id. Denied actions are logged too.

---

## 9. DATA MODEL (tables)

`buildings, floors, assets, sensors, telemetry_readings, rejected_telemetry, detector_state, anomaly_events, anomaly_evidence, risk_assessments, policy_versions, work_orders, work_order_events, work_order_parts, approvals, inspection_records, verification_records, users, roles, technicians, technician_shifts, inventory_items, stock_movements, stock_reservations, outbox_events, processed_events, dead_letters, simulation_runs, simulation_state, fault_injections, evaluations, audit_logs`.
Use foreign keys, CHECK constraints, and indexes (e.g. `telemetry_readings(sensor_id, timestamp)`). Keep **raw readings separate from derived analysis** so detectors can be re-run on history. Alembic migrations for everything.

---

## 10. API SURFACE (proposed — implement, with validation, pagination, auth, consistent errors)

```
POST /api/auth/login            GET /api/me
GET  /api/buildings/{id}/tree   GET /api/assets  GET /api/assets/{id}  GET /api/assets/{id}/telemetry?metric=&from=&to=
POST /api/simulation/{start|pause|resume|reset}   PATCH /api/simulation   # speed, seed, profile
POST /api/simulation/faults      # inject: bearing_wear | sensor faults (flatline/spike/dropout/duplicate/late/bad_unit)
POST /api/simulation/repair-effectiveness
POST /api/ingest/telemetry       # batch, used by simulator/adapters
GET  /api/anomalies  GET /api/anomalies/{id}  (with evidence)
GET  /api/decisions/{id}
GET/POST /api/work-orders   GET /api/work-orders/{id}   GET /api/work-orders/{id}/timeline
POST /api/work-orders/{id}/{approve|reject|cancel|hold|resume|assign|start|complete|verify|close}
GET  /api/work-orders/{id}/dispatch-candidates
GET  /api/technicians   GET /api/inventory   POST /api/inventory/receive   GET /api/inventory/movements
GET  /api/analytics/{maintenance|detector|assets}
GET  /api/audit-logs?outcome=DENIED
GET  /api/events?correlation_id=…   WS /ws/events
POST /api/demo/{step|autoplay|reset}   # Guided Demo director (calls the same services)
```

---

## 11. THE 3D BUILDING (must look real and polished)

Build with react-three-fiber, **procedurally** (no external model downloads). Target **60 fps on an integrated GPU at "Medium"**; provide Low/Medium/High quality toggle and an FPS auto-downgrade. Use instancing, frustum culling, shared geometries/materials.

**Building:** ground lobby + 5 floors + roof deck + basement plant room. Floor slabs, structural columns, curtain-wall glass facade (semi-transparent, reflective), interior partitions, stair/lift cores, ceiling grid, floor-by-floor interior lighting, signage, roof parapet.
**Equipment (modelled recognisably, not boxes):** rooftop AHUs with housings, louvres, **supply fans with visible rotating blades**, ductwork running down the shaft to floors, chiller + pump sets with pipes (blue/red), electrical panels, exhaust fan, fan coil units. Sensor markers (small glowing icons with billboard labels).
**Environment:** procedural sky + sun position tied to sim clock (day/night cycle, interior lights respond to occupancy), ground plane, surrounding low-poly city blocks and trees, soft shadows, subtle fog. Colour palette: deep teal/graphite with luminous accent colours for status — modern, premium, not toy-like.

**Data-driven visuals (this is what makes it a *twin*):**
- Asset **health colour/glow**: green (normal), amber pulse (WATCH), red pulse (ANOMALY), blue (under repair), grey (offline). Smooth transitions.
- Fan blade angular velocity = speed_pct; **wobble/shake amplitude proportional to vibration** (visually exaggerated, clamped); bearing hot-spot glow scales with bearing temperature; heat-haze/particle hint at high temp.
- **Floor isolation / exploded view / X-ray** toggles; floor slider; per-floor alarm badges.
- **Condition heat overlay** option (floor gradient by alarm severity).
- **Work-order pin** above the asset (icon + colour by state) that animates through DRAFT → … → CLOSED.
- **Technician avatars** (stylised figures with hard hats, name tag) that **walk along a waypoint graph** (lobby → lift/stairs → floor → roof path) to the asset when assigned, perform a visible "working" animation at the asset, then return. Walking speed scaled by sim speed; pauses when sim pauses.
- **Selection:** click an asset → outline highlight, smooth **camera fly-to** (eased), and the side panel opens. Orbit/pan/zoom with sensible limits; preset camera views (Overview, Roof, Plant Room, Floor N).
- Optional `glTF` loader hook so real models can replace procedural ones later.

---

## 12. WEBSITE PAGES & UX

Modern, responsive, dark theme with a light-mode option; consistent design system; accessible (keyboard, contrast, reduced-motion option). Header shows **sim clock, speed control, role switcher, SIMULATED badge**.

1. **`/` Landing:** hero with auto-orbiting live 3D building, one-paragraph explanation, the 7-layer animated diagram, "Launch Live Simulation" and "Watch Guided Demo" buttons, short honest "What this is / isn't" section.
2. **`/sim` Live Twin (main screen):** full-viewport 3D scene; left: building tree + floor controls + layer toggles; right: asset detail panel (live charts for vibration/temperature/current with baseline band and anomaly markers, health state, evidence card, open WO link, template explanation); **bottom: "Layer Pipeline" ribbon** showing Layers 1→7 as nodes; whenever an event passes through a layer, that node pulses and its counter increments; clicking a node opens that layer's panel; toast alerts for key events.
3. **`/pipeline` Layer Explorer:** one section per layer with: purpose, inputs, algorithm summary (formulas), outputs, stored tables, and a **live event feed** for that layer. Plus an **Incident Timeline** (by `correlation_id`) showing the whole journey from first reading to closure with timestamps.
4. **`/cmms` Work Orders:** Kanban by state + table view; detail drawer with evidence, risk score breakdown, approvals, dispatch candidates with score breakdown, inspection checklist, parts, timeline, before/after chart, and only the actions the current role may take.
5. **`/dispatch` Technicians:** roster with skills, shift, location, workload, performance.
6. **`/inventory`:** stock levels, reservations, movement ledger, low-stock alerts, "receive stock".
7. **`/analytics`:** MTTA, MTTR, detector evaluation (latency, lead time, precision, FP/FN), alerts by asset, cost, work-order throughput — all computed from stored data.
8. **`/audit`:** filterable audit log highlighting DENIED actions; dead-letter queue viewer.
9. **`/control`:** simulation controls — speed, seed, profile, inject bearing wear on any fan, inject sensor faults, set repair effectiveness, reset.
10. **`/about`:** architecture diagram, layer explanations, BACnet/Modbus context, honest limitations, "demo thresholds are not standards".

### Guided Demo ("Director")
A scripted storyline with narration captions and automatic camera moves, **driving the real backend** (the director only calls the same APIs/services a user would, with a pause between steps and a "Next / Autoplay / Exit" control). Storyline:
1. Intro: tour the building, point at AHU-02 and its sensors (Layer 1).
2. Healthy telemetry flows; show validation catching a duplicate and a bad-unit reading (Layers 2–3).
3. Inject bearing wear on `AHU-02-FAN-01`; fan begins to wobble; detector goes WATCH → ANOMALY with evidence (Layer 4).
4. Decision engine shows risk score breakdown and recommendation; a **single** draft work order appears (Layer 5); a second alert attaches as evidence (dedup demonstrated).
5. **Operator attempts to approve → denied by the backend** (audit shows DENIED); supervisor approves (Layer 6).
6. Dispatch candidates ranked with score breakdown; supervisor assigns; parts reserved.
7. Technician avatar walks to the roof fan and repairs it; parts consumed.
8. Verification: window collected, technician cannot verify own work (denied), verifier passes → closed → anomaly cleared (Layer 7).
9. **Failure branch:** replay with `repair_effectiveness = 0.4` → verification fails → rework required → second repair → pass.
10. Analytics summary: detection lead time, MTTA, MTTR, cost.

---

## 13. QUALITY & HONESTY RULES

- Label simulated data everywhere. Never claim real-world diagnostic accuracy or standards compliance.
- No hardcoded KPIs. Charts, KPIs and timelines are computed from the DB.
- Graceful empty/loading/error states on every page; no console errors.
- Data persists across backend restarts (test it).
- Security basics: password hashing, JWT expiry, input validation, CORS locked to dev origin, no secrets in repo (`.env.example`).

---

## 14. BUILD PHASES (do them in order; each ends with a gate)

| Phase | Build | Gate (must pass before continuing) |
|---|---|---|
| **P0** | UNDERSTANDING / PLAN / ASSUMPTIONS / CLAUDE.md; repo skeleton, Makefile, lint/test tooling | Files exist; `make setup` works |
| **P1** | DB schema + migrations, seed building/assets/sensors/users/technicians/inventory, auth + role enforcement, audit logging, API skeleton | Login works; role denial returns 403 and is audited; `pytest` green |
| **P2** | Sim clock + simulator + ingestion/validation (Layer 2–3), warm-start backfill, WebSocket push, **basic 3D building shell** with live fan data and a telemetry chart | Browser start-sim → readings stored → chart + fan spin update live; bad-data cases rejected with reasons; screenshot taken |
| **P3** | Detector (Layer 4) with state machine, evidence, template explanation | Healthy 72 h × 5 seeds → **0 ANOMALY**; fault scenario detected with lead time ≥ 30% of horizon before alarm limit; unit tests for each rule |
| **P4** | Decision engine, policy file, dedup, draft WO, approvals, outbox/idempotency/retry | One WO per incident even with repeated alerts; replayed event = no duplicate; unauthorized approve → 403 + audit |
| **P5** | Dispatch ranking, inventory ledger/reservations, technician workflow, complete/hold flows | Concurrency test: stock never negative; ineligible technician rejected |
| **P6** | Verification, rework loop, evaluation metrics, analytics endpoints | Pass and fail branches both proven; separation of duties enforced; metrics match raw data |
| **P7** | **3D polish:** full building detail, equipment models, day/night, overlays, technician avatars + pathing, WO pins, camera rig, quality toggle | 60 fps Medium on a normal laptop (measure and record); visual checklist in Section 11 complete; screenshots |
| **P8** | All website pages, Layer Pipeline ribbon, Layer Explorer, Incident Timeline, Guided Demo director, control page, landing page | Every page works end-to-end with real data; guided demo runs start to finish |
| **P9** | Hardening: `scripts/run_e2e_demo.py`, Playwright suite, restart-persistence test, README, ARCHITECTURE.md, cleanup | **Section 15 passes fully**, zero console errors, README setup works from a clean clone |

---

## 15. DEFINITION OF DONE (all items automated in `scripts/run_e2e_demo.py` + Playwright; print PASS/FAIL per line)

1. Fresh clone → `make setup && make dev` starts everything; seed building, fan, sensors present.
2. Healthy simulation shows normal readings; **no false anomaly** over 72 sim-hours on 5 seeds.
3. Validation rejects/flags: duplicate, bad unit, unknown sensor, late event, flatline; each recorded with a reason.
4. Injecting bearing wear → detector reaches ANOMALY **before** the alarm limit; anomaly carries evidence, z-score, slope, corroboration and a template explanation that never says "failed".
5. Exactly **one** draft work order is created per unresolved incident; repeated alerts attach evidence (partial unique index + test).
6. Operator approval attempt → **403 from the backend** and a DENIED audit row; supervisor approval succeeds.
7. Dispatch returns ranked eligible technicians with score breakdown; ineligible technician rejected.
8. Parts reserved on assignment; shortage path puts WO `ON_HOLD (AWAITING_PARTS)`; completion consumes stock transactionally (concurrency-safe).
9. Technician avatar visibly walks to the asset in 3D, works, and the WO pin changes state live.
10. Technician cannot verify own work; verifier pass → VERIFIED → CLOSED → anomaly CLEARED.
11. **Failed-repair branch:** `repair_effectiveness=0.4` → verification fails → REWORK_REQUIRED → second repair → pass.
12. Replaying an already-processed event creates no duplicate records (idempotency test).
13. Backend restart → all records, WO states, stock and history intact.
14. Analytics page shows detection latency, lead time, MTTA, MTTR, precision, cost **computed from stored data**.
15. Layer Pipeline ribbon pulses in the correct order for the golden scenario; Incident Timeline shows the full journey by `correlation_id`.
16. Guided Demo plays all 10 steps with no manual fixes and no console errors.
17. 3D scene holds ≥ 60 fps at Medium on a typical laptop GPU (record measured FPS and machine in docs).

---

## 16. HARD "DO NOT" LIST

- Do not let the simulator import or call monitoring/decision/CMMS code.
- Do not set work-order status outside the single `transition()` service.
- Do not hide permission checks only in the UI.
- Do not hardcode KPIs, alarms, or demo results.
- Do not claim an anomaly proves a failure, or present demo thresholds as standards.
- Do not auto-retrain or auto-change thresholds from closed work orders.
- Do not silently drop bad telemetry.
- Do not add Kafka/microservices/paid APIs.
- Do not use runtime CDNs or external model/texture downloads.
- Do not stop at "looks done" — run the full Definition of Done and fix every failure.

---

## 17. FIRST ACTIONS (start now)

1. Write `docs/UNDERSTANDING.md`, `docs/PLAN.md`, `docs/ASSUMPTIONS.md`, `CLAUDE.md`.
2. Scaffold the repo (Section 3) and complete **P0**, then proceed phase by phase to **P9**.
3. When finished, print the Section 15 results table and the exact commands to run the demo.
