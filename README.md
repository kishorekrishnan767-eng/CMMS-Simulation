# TwinCMMS — a 3D CMMS digital-twin simulation

A fully working **CMMS (Computerized Maintenance Management System)** demonstration on a procedural 3D
digital twin of an office tower. One incident runs through all seven layers:

> sensor data → validation → anomaly detection → risk decision → work order → approval → technician
> dispatch → repair → verification → learning

A simulated fan bearing degrades, the detector finds it and explains why, a single draft work order
appears, an operator is **denied by the backend**, a supervisor approves, a technician walks to the roof
in 3D and repairs it, and an independent verifier confirms recovery. Everything except the sensor values
is real application logic on a real database. **All sensor data is simulated** and labelled so; thresholds
are demo values, not standards; an anomaly is never presented as a confirmed failure.

![scene](artifacts/dod17-medium-scene.png)

## Quick start (5 commands)

Requirements: Python ≥ 3.11, Node ≥ 20. No paid services, no API keys, no CDNs — it runs offline after install.

```bash
git clone <this repo> && cd <repo>
py -3.11 scripts/tasks.py setup      # Windows (or: python3 scripts/tasks.py setup)
python scripts/tasks.py dev          # backend :8000 + frontend :5173  (or: make setup && make dev)
# open http://localhost:5173  →  "Watch guided demo"
python scripts/tasks.py demo         # headless Definition-of-Done run (PASS/FAIL per item)
```

`make setup | dev | test | demo | reset` exist too and simply call `scripts/tasks.py`
(Windows usually has no `make`). `reset` wipes the database and re-seeds it.

Optional PostgreSQL: `docker compose up -d db`, `pip install -r backend/requirements-postgres.txt`, set
`DATABASE_URL=postgresql+psycopg://twin:twin@localhost:5432/twincmms` in `backend/.env`.

## Demo walkthrough (about 4 minutes)

1. Open **/** — the live 3D twin orbits behind the hero; the seven-layer diagram shows live event counts.
2. Click **Watch guided demo**, press **Start** then **Autoplay** (or step with **Next**). Captions narrate
   and the camera follows; each step calls the real API:
   1. the building and assets · 2. duplicate / wrong-unit / unknown-sensor readings are stored with reasons ·
   3. bearing wear → fan wobbles → WATCH → ANOMALY with evidence · 4. risk score breakdown, **one** draft
   work order, later alerts attach as evidence · 5. operator approve → **403 + DENIED audit row**, supervisor
   approves · 6. ranked dispatch, ineligible technician rejected, parts reserved · 7. technician avatar
   walks to the roof, repairs, parts consumed · 8. technician cannot verify own work, verifier passes,
   close → anomaly cleared · 9. partial repair (0.4) fails verification → rework → second repair passes ·
   10. analytics from stored data.
3. Explore: **/pipeline** (layer explorer + incident timeline), **/cmms** (board, drawer, role-aware
   actions — use *“Try any action”* to watch the backend refuse), **/dispatch**, **/inventory**,
   **/analytics**, **/audit** (filter `DENIED`, dead-letter queue), **/control** (speed, seed, profile,
   inject bearing wear or data-quality faults, repair effectiveness, reset), **/about**.

Demo users (password `demo1234`): `admin`, `operator`, `supervisor`, `tech1`–`tech3`, `verifier`. The
header role switcher logs in as any of them.

## Live operations (autopilot)

Open **Live twin** and press **Run**. With the **Operations autopilot** on (right panel → Operations),
equipment wears at random and the simulated crew handles every job through the real workflow: the
supervisor approves and dispatches, the technician gets a dispatch message in the ground-floor crew room,
collects tools, rides the glass lift, works through the job procedure on site, and walks back; the verifier
checks the post-repair window and the supervisor closes the job. Click any machine to follow its job story
in the **Job** tab (issue → decision → dispatch → travel → repair steps → verification → closure). Switch the
autopilot off to do every step yourself from **Work orders**; set the wear frequency to Off/Low/Normal/High.

## Architecture

```
simulator (L2) ──TelemetrySink──► ingestion (L3) ──► monitoring (L4) ──► decision (L5) ──► cmms (L6) ──► verification (L7)
   seeded physics                 validate+store      baseline, z,        risk, dedup       state machine,    post-repair window,
   + injected faults              raw readings        slope, state        versioned policy  dispatch, stock   metrics, learning
        ▲                                 │                 │                  │                 │
        └──── RepairApplied ◄─────────────┴──── transactional outbox / event bus ──────────────┘──► WebSocket ► React + three.js
```

A modular monolith (FastAPI + SQLAlchemy, SQLite WAL by default / PostgreSQL), one database, no broker.
The simulator cannot import monitoring/decision/cmms code (enforced by a test). Details, event catalogue
and algorithms: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Design decisions and deviations:
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md). Measured performance: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Tests

* `python scripts/tasks.py test` — pytest (≈70 backend tests incl. 72 h × 5 seeds, concurrency, idempotency, boundaries) + typecheck + Playwright UI suite.
* `python scripts/run_e2e_demo.py` — the full Definition of Done, PASS/FAIL per item (`--quick`, `--skip-ui`).

## Honest limitations

One building, eight assets, one modelled failure mode; one-minute sampling (real vibration analysis uses
far higher rates); explanations are templates; metrics describe this detector on injected, simulated
faults only — no claim about real-world accuracy or standards compliance.
