# Assumptions & decisions

Recorded whenever the master prompt left a choice open. Numbered so code comments can cite them.

1. **No `make` on the dev machine (Windows).** A `Makefile` is provided for Unix/Git-Bash users and
   `python scripts/tasks.py <target>` implements the same targets (`setup`, `dev`, `test`, `demo`,
   `reset`) cross-platform. The Makefile delegates to it.
2. **Python 3.11+.** `tasks.py setup` creates `backend/.venv` with the interpreter that runs it
   (must be ≥ 3.11; on Windows `py -3.11 scripts/tasks.py setup` is recommended).
3. **Uniform sensor set.** Every asset has a vibration sensor (primary metric for Layer 4), a
   temperature sensor, a motor-current sensor and a load/speed sensor (`SPD`, `speed_command`, %).
   Pumps, the chiller and the FCU use the same physics with per-type coefficients. This keeps the
   detector generic; it is still "2–4 sensors per asset".
4. **Sim epoch.** Reset puts the clock at Monday 2026-03-02 02:00 UTC, backfills 6 h, so "now" is
   08:00 — start of the working day. Day/night lighting follows the sim clock.
5. **Batch-level telemetry events.** `TelemetryAccepted` / `TelemetryRejected` are published once per
   ingested batch (with counts, reading ids and latest values) rather than once per reading, to keep
   the outbox small at 1800x. Each reading is still stored individually.
6. **Per-sensor running state** (`last_value`, `flat_count`, `last_timestamp`, `quality`) is stored on
   the `sensors` row and the per-asset watermark on `assets`, so flatline / gap / late checks are O(1)
   per reading and survive restarts.
7. **Detector derived state** (healthy window, recent residuals) lives as JSON on `detector_state`.
   Raw readings stay untouched in `telemetry_readings`, so detectors can be replayed on history.
8. **Corroborating metrics** (temperature, current) use the same load-compensated OLS+MAD baseline
   as vibration, held in their own `detector_state` rows (no state machine; residual z only).
9. **Failure mode** for vibration anomalies is `VIBRATION_RISE` ("possible bearing degradation").
   The dedup key is `(asset_id, failure_mode)`.
10. **Active work-order states** for the partial unique index: everything except `CLOSED`,
    `REJECTED`, `CANCELLED`.
11. **Escalation acknowledgement** is a separate endpoint
    `POST /api/work-orders/{id}/acknowledge-escalation` (SUPERVISOR). It changes priority, not status,
    so it does not go through the status state machine, but it is audited and emits an event.
12. **Verify action** takes `{"outcome": "auto"|"pass"|"fail", "notes": ...}`. The backend evaluates
    the Layer 7 criteria; a verifier cannot pass a window whose criteria fail (→ 409 and the failing
    criteria are returned); a failing window, or an explicit `fail` with reason, → `REWORK_REQUIRED`.
    Verification needs the full 30-sample window after the latest completion (else 409).
13. **Technician travel.** On assignment the backend computes `travel_minutes = 3 + 2 × floor
    distance` and stores `arrives_at` (sim time). The frontend interpolates the avatar along the
    waypoint graph using the sim clock, so walking pauses/accelerates with the simulation. After
    completion the technician returns to their home floor (`returns_at`).
14. **Inventory adjust.** An ADMIN-only `POST /api/inventory/adjust` (cycle count, audited) exists so
    the shortage path can be demonstrated deterministically.
15. **Password hashing** uses stdlib PBKDF2-HMAC-SHA256 (200 000 iterations, per-user salt); JWTs are
    HS256 via PyJWT with an 8 h expiry. The dev secret comes from `.env` (`.env.example` provided).
    Demo users all use password `demo1234` (shown on the login panel — it is a demo).
16. **Labels in 3D** are canvas-texture sprites / DOM overlays; drei `Text` and `Environment` are not
    used because they fetch fonts/HDRIs from CDNs at runtime.
17. **Charts** use Recharts (lightweight enough, declarative).
18. **Detection-latency / lead-time ground truth** comes from `fault_injections`. The alarm-limit
    crossing time is the first stored vibration reading ≥ the asset's alarm limit (7.1 mm/s demo
    default) after fault start; if it was never crossed (repaired first) the lead time is reported
    as "limit not reached (prevented)" together with the detection-to-repair interval.
19. **Labour cost** = hours in `IN_PROGRESS` × technician hourly rate (seeded); parts cost = Σ consumed
    quantity × unit cost.
20. **Repair effectiveness is one-shot.** The configured value applies to the *next* repair and then
    reverts to 1.0, so the failed-repair demo (0.4) can be followed by a proper second repair.
21. **Detector deviations from the literal spec** (all documented in `monitoring/detector.py`):
    (a) the load slope `b` is fitted on a longer healthy history (≤24 h, 1 sample in 5) with ridge
    shrinkage toward a generic prior when load spread is small; the intercept `a` and `σ` still come from
    the 120-sample window — a pure 120-sample OLS drifted and produced false anomalies once the window
    froze during WATCH; (b) the slope trigger for WATCH additionally needs the mean z of the last 3
    samples ≥ 1.5, otherwise noise alone enters WATCH ~4 % of the time.
22. **Extra Layer 4 events** beyond the spec list: `HealthStateChanged` (every state change),
    `AnomalyWatch` (entering WATCH) and `AnomalyCorroborated` (a corroborating metric newly agrees).
23. **Verification settle period.** After a repair the simulated degradation decays with τ = 5 min, so the
    30-sample verification window starts after a 30-minute settle (6τ).
24. **Crew room.** All technicians are based in a maintenance crew room on the ground floor (level 0) and
    every job starts and ends there (seat → tool cabinet → door → east service line → glass lift in the
    front light-well → corridor → asset). Dispatch proximity and travel time (`3 + 2·|Δfloor|` min) are
    therefore measured from the ground floor. Off-shift technicians are not drawn in the building.
25. **Operations autopilot** (`app/modules/autopilot`). On by default (`AUTOPILOT=false` disables it; the
    UI toggle changes it at runtime, audited as `sim.autopilot`). It is an API client like the guided-demo
    director: it injects seeded random bearing wear (Poisson process in sim time, rate Off/Low/Normal/High)
    and plays the supervisor, technicians and verifier through the real endpoints with seeded delays. It
    pauses while the clock is paused or the guided demo runs. Test harnesses (pytest, Playwright, the DoD
    runner) run with it off so scripted scenarios stay deterministic.
26. **Job procedures** (`cmms/procedures.py`) are demo step lists with demo durations per asset type. The
    UI shows the current step from elapsed sim time since work began; the autopilot signs the job off when
    the planned minutes have elapsed and records the step keys as the inspection checklist.
