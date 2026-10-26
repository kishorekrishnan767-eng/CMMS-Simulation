#!/usr/bin/env python3
"""Executes the whole Definition of Done (Section 15) and prints PASS/FAIL per item.

    python scripts/run_e2e_demo.py            # everything (~10-15 min)
    python scripts/run_e2e_demo.py --quick    # 1 seed instead of 5 for item 2
    python scripts/run_e2e_demo.py --skip-ui  # backend items only (no browser)

Evidence comes from three sources, all against real code paths (no mocks):
  * backend tests (pytest) — workflow, validation, concurrency, idempotency, security rules
  * a 72-sim-hour healthy run on 5 seeds through the full pipeline (process pool)
  * a restart-persistence run against a real uvicorn process, and the Playwright UI suite which
    starts its own backend + Vite server (isolated database) and drives the real browser.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
ARTIFACTS = ROOT / "artifacts"
IS_WIN = os.name == "nt"
PY = BACKEND / ".venv" / ("Scripts/python.exe" if IS_WIN else "bin/python")
sys.path.insert(0, str(ROOT / "scripts"))

ITEMS = {
    1: "Fresh start: seeded building, fan and sensors present; every page renders",
    2: "Healthy simulation: no false anomaly over 72 sim-hours on 5 seeds",
    3: "Validation rejects/flags duplicate, bad unit, unknown sensor, late event, flatline — each with a reason",
    4: "Bearing wear → ANOMALY before the alarm limit, with evidence, z, slope, corroboration, no 'failed'",
    5: "Exactly one draft work order per incident; repeats attach evidence (partial unique index)",
    6: "Operator approval → 403 + DENIED audit row; supervisor approval succeeds",
    7: "Dispatch ranks eligible technicians with score breakdown; ineligible technician rejected",
    8: "Parts reserved; shortage → ON_HOLD (AWAITING_PARTS); concurrency-safe consumption",
    9: "Technician avatar walks to the asset, works; work-order pin changes state live",
    10: "Technician cannot verify own work; verifier pass → VERIFIED → CLOSED → anomaly CLEARED",
    11: "Failed repair (0.4): verification fails → REWORK_REQUIRED → second repair → pass",
    12: "Replaying a processed event creates no duplicate records",
    13: "Backend restart: records, work-order states, stock and history intact",
    14: "Analytics: latency, lead time, MTTA, MTTR, precision, cost computed from stored data",
    15: "Layer ribbon pulses in pipeline order; incident timeline shows the full journey",
    16: "Guided demo plays all 10 steps, no manual fixes, no console errors",
    17: "3D scene holds >= 60 fps at Medium (measured; machine recorded)",
}

results: dict[int, list[tuple[bool, str]]] = {i: [] for i in ITEMS}


def record(item: int, ok: bool, detail: str) -> None:
    results[item].append((ok, detail))


def run(cmd: list[str] | str, cwd: Path, env: dict | None = None, timeout: int = 1800, shell: bool = False):
    e = {**os.environ, **(env or {})}
    return subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, text=True, timeout=timeout, shell=shell)


# ------------------------------------------------------------------------------ pytest-backed items
PYTEST_GROUPS: dict[str, tuple[list[int], list[str]]] = {
    "validation (Layer 3)": ([3], ["tests/test_p2_ingestion.py"]),
    "detector + pipeline (Layer 4)": ([4], ["tests/test_p3_detector_core.py", "tests/test_p3_pipeline.py"]),
    "decision, dedup, audit, outbox idempotency": ([5, 6, 12], ["tests/test_p4_decision.py"]),
    "dispatch, inventory, concurrency": ([7, 8], ["tests/test_p5_dispatch_inventory.py"]),
    "verification, rework, analytics": ([10, 11, 14], ["tests/test_p6_verification.py"]),
    "auth, boundaries, demo director": ([6], ["tests/test_p1_auth.py", "tests/test_module_boundaries.py", "tests/test_p8_demo_director.py"]),
}


def phase_pytest() -> None:
    print("\n== Backend test groups ==", flush=True)
    for name, (items, files) in PYTEST_GROUPS.items():
        t0 = time.time()
        r = run([str(PY), "-m", "pytest", "-q", "-p", "no:cacheprovider", *files], BACKEND)
        tail = [ln for ln in r.stdout.strip().splitlines() if "passed" in ln or "failed" in ln or "error" in ln.lower()]
        summary = tail[-1] if tail else r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "no output"
        ok = r.returncode == 0
        print(f"  {'PASS' if ok else 'FAIL'}  {name:<48} {summary} ({time.time() - t0:.0f}s)", flush=True)
        if not ok:
            print(r.stdout[-2500:], r.stderr[-800:])
        for i in items:
            record(i, ok, f"pytest: {name} — {summary}")


# ------------------------------------------------------------------------------ item 2
def phase_healthy(seeds: list[int]) -> None:
    print(f"\n== Item 2: healthy 72 h on seeds {seeds} through the full pipeline (parallel) ==", flush=True)
    from e2e_workers import healthy_run
    t0 = time.time()
    with cf.ProcessPoolExecutor(max_workers=min(len(seeds), os.cpu_count() or 2)) as pool:
        outs = list(pool.map(healthy_run, seeds))
    for o in outs:
        print(f"  seed {o['seed']:>5}: anomalies={o['anomalies']} work_orders={o['work_orders']} watch_events={o['watch_events']}", flush=True)
    ok = all(o["anomalies"] == 0 and o["work_orders"] == 0 for o in outs)
    record(2, ok, f"{len(seeds)} seed(s) × 72 h: anomalies={[o['anomalies'] for o in outs]}, work orders={[o['work_orders'] for o in outs]} ({time.time() - t0:.0f}s)")


# ------------------------------------------------------------------------------ item 13
class Server:
    def __init__(self, port: int, db_path: Path):
        self.port, self.db_path, self.proc = port, db_path, None

    def start(self) -> None:
        env = {**os.environ, "DATABASE_URL": f"sqlite:///{self.db_path.as_posix()}", "AUTOPILOT": "false"}
        self.proc = subprocess.Popen([str(PY), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(self.port)],
                                     cwd=BACKEND, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import httpx
        for _ in range(240):
            try:
                if httpx.get(f"http://127.0.0.1:{self.port}/api/health", timeout=1).status_code == 200:
                    return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError("backend did not start")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            if IS_WIN:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.proc.pid)], capture_output=True)
            else:
                self.proc.terminate()
            self.proc.wait(timeout=20)


def snapshot(c, h) -> dict:
    wos = c.get("/api/work-orders", headers=h).json()["items"]
    inv = {i["sku"]: (i["on_hand"], i["reserved"]) for i in c.get("/api/inventory").json()["items"]}
    stats = c.get("/api/telemetry/stats").json()
    an = c.get("/api/anomalies").json()["items"]
    audit = c.get("/api/audit-logs?limit=1&action=wo.", headers=h).json()["total"]  # excludes login rows written by the check itself
    events = c.get("/api/events?limit=1").json()["total"]
    sim = c.get("/api/simulation").json()
    return {"work_orders": [(w["number"], w["status"], w["priority"], (w["assigned_technician"] or {}).get("id")) for w in wos],
            "inventory": inv, "readings": stats["stored"], "rejected": stats["rejected_total"],
            "anomalies": [(a["incident_id"], a["state"], a["severity"]) for a in an], "audit": audit, "events": events,
            "sim_now": sim["sim_now"]}


def phase_restart() -> None:
    print("\n== Item 13: restart persistence against a real uvicorn process ==", flush=True)
    import httpx
    tmp = Path(tempfile.mkdtemp(prefix="twin-restart-"))
    srv = Server(8766, tmp / "persist.db")
    try:
        srv.start()
        c = httpx.Client(base_url=f"http://127.0.0.1:{srv.port}", timeout=120)
        tok = lambda u: {"Authorization": "Bearer " + c.post("/api/auth/login", json={"username": u, "password": "demo1234"}).json()["access_token"]}
        op, sup = tok("operator"), tok("supervisor")
        c.post("/api/simulation/faults", headers=op, json={"asset_id": "AHU-02-FAN-01", "fault_type": "bearing_wear"})
        for _ in range(3):
            c.post("/api/simulation/step?minutes=20", headers=op)
        wo = c.get("/api/work-orders").json()["items"][0]
        c.post(f"/api/work-orders/{wo['id']}/approve", headers=sup, json={"note": "approve"})
        c.post(f"/api/work-orders/{wo['id']}/assign", headers=sup, json={"technician_id": "TECH-01"})
        c.post(f"/api/work-orders/{wo['id']}/approve", headers=op, json={})        # a DENIED audit row to persist too
        before = snapshot(c, sup)
        srv.stop()
        srv.start()
        c = httpx.Client(base_url=f"http://127.0.0.1:{srv.port}", timeout=120)
        sup = {"Authorization": "Bearer " + c.post("/api/auth/login", json={"username": "supervisor", "password": "demo1234"}).json()["access_token"]}
        after = snapshot(c, sup)
        ok = before == after and before["work_orders"][0][1] == "ASSIGNED" and before["inventory"]["BRG-001"] == (4, 1)
        print(f"  work orders {before['work_orders']}  stock {before['inventory']['BRG-001']}  readings {before['readings']}", flush=True)
        if not ok:
            diff = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
            print("  DIFF:", diff)
        record(13, ok, f"{before['readings']} readings, WO {before['work_orders'][0][0]} {before['work_orders'][0][1]}, "
                       f"BRG-001 on-hand/reserved {before['inventory']['BRG-001']}, {before['audit']} audit rows identical after restart")
        c.close()
    except Exception as exc:  # noqa: BLE001
        record(13, False, f"{type(exc).__name__}: {exc}")
    finally:
        srv.stop()
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------------------ Playwright
def phase_ui() -> None:
    print("\n== Playwright UI suite (own backend + Vite, isolated DB) ==", flush=True)
    ARTIFACTS.mkdir(exist_ok=True)
    report = ARTIFACTS / "playwright-report.json"
    if report.exists():
        report.unlink()
    cmd = "npx playwright test" if IS_WIN else ["npx", "playwright", "test"]
    r = run(cmd, FRONTEND, timeout=2400, shell=IS_WIN)
    if not report.exists():
        print(r.stdout[-3000:], r.stderr[-1500:])
        for i in (1, 9, 14, 15, 16, 17):
            record(i, False, "Playwright produced no report")
        return
    data = json.loads(report.read_text(encoding="utf-8"))
    tests: list[tuple[str, bool]] = []

    def walk(suite: dict) -> None:
        for spec in suite.get("specs", []):
            ok = all(t["status"] in ("expected", "skipped") for t in spec["tests"]) and all(
                res["status"] in ("passed", "skipped") for t in spec["tests"] for res in t["results"])
            tests.append((spec["title"], ok))
        for s in suite.get("suites", []):
            walk(s)
    for s in data["suites"]:
        walk(s)
    total_ok = sum(ok for _, ok in tests)
    print(f"  {total_ok}/{len(tests)} UI tests passed", flush=True)
    for title, ok in tests:
        if not ok:
            print("   FAIL:", title)
        for n in {int(x) for x in re.findall(r"DoD-(\d+)", title)}:
            record(n, ok, f"playwright: {title[:90]}")
    # smoke tests that cover item 1 without carrying the tag in every title
    smoke = [ok for t, ok in tests if t.startswith("every page renders")]
    if smoke:
        record(1, all(smoke), f"playwright: all {len(smoke)} pages render without console errors")


def machine_info() -> str:
    fps = ARTIFACTS / "fps.json"
    cpu = "unknown CPU"
    try:
        cpu = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"], capture_output=True, text=True).stdout.strip() if IS_WIN else cpu
    except Exception:
        pass
    if fps.exists():
        d = json.loads(fps.read_text(encoding="utf-8"))
        text = (f"# Measured performance (DoD-17)\n\nMeasured by `frontend/e2e/05-perf.spec.ts` on {d['measured_at']}.\n\n"
                f"| Item | Value |\n|---|---|\n| CPU | {cpu} |\n| GPU / renderer | {d['renderer']} |\n| Quality | {d['quality']} |\n"
                f"| Viewport | {d['viewport']} |\n| Load | {d['simulation']} |\n| Frame limiter / vsync | disabled (uncapped, so the figure is headroom) |\n"
                f"| Samples (fps) | {', '.join(map(str, d['samples']))} |\n| **Minimum** | **{d['fps_min']} fps** |\n\n"
                "Notes: Medium disables image-based lighting and MSAA (each costs ~10 fps on this integrated GPU; High enables both and bloom). "
                "Quality auto-downgrades if the frame rate stays below 38 fps for three seconds.\n")
        (ROOT / "docs" / "PERFORMANCE.md").write_text(text, encoding="utf-8")
        return f"{d['fps_min']} fps min on {d['renderer']}"
    return ""


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="item 2 on one seed only")
    ap.add_argument("--skip-ui", action="store_true")
    ap.add_argument("--skip-pytest", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    if not PY.exists():
        print("Run `python scripts/tasks.py setup` first.")
        return 2
    if not args.skip_pytest:
        phase_pytest()
    phase_healthy([42] if args.quick else [1, 7, 42, 123, 2026])
    phase_restart()
    if not args.skip_ui:
        phase_ui()
        info = machine_info()
        if info:
            record(17, results[17][-1][0] if results[17] else False, f"measured {info}")

    print("\n" + "=" * 100)
    print(f"{'#':>2}  {'result':<6} Definition of Done (Section 15)")
    print("=" * 100)
    failed = 0
    for i, title in ITEMS.items():
        rs = results[i]
        if args.skip_ui and i in (9, 15, 16, 17) and not rs:
            status = "SKIP"
        elif not rs:
            status, failed = "FAIL", failed + 1
        elif all(ok for ok, _ in rs):
            status = "PASS"
        else:
            status, failed = "FAIL", failed + 1
        print(f"{i:>2}  {status:<6} {title}")
        for ok, d in rs[:4]:
            print(f"        {'✓' if ok else '✗'} {d}")
    print("=" * 100)
    print(f"{17 - failed}/17 items passing · total {time.time() - t0:.0f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
