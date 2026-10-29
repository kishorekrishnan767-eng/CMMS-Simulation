"""Scenario helpers shared by workflow tests (all drive the real HTTP API / services)."""
from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def step(client: TestClient, auth, minutes: int) -> dict[str, Any]:
    r = client.post(f"/api/simulation/step?minutes={minutes}", headers=auth("operator"))
    assert r.status_code == 200, r.text
    return r.json()


def inject_wear(client: TestClient, auth, asset: str = "AHU-02-FAN-01") -> None:
    r = client.post("/api/simulation/faults", headers=auth("operator"),
                    json={"asset_id": asset, "fault_type": "bearing_wear"})
    assert r.status_code == 200, r.text


def run_until(client: TestClient, auth, predicate, max_minutes: int = 240, chunk: int = 1) -> int:
    done = 0
    while done < max_minutes:
        step(client, auth, chunk)
        done += chunk
        if predicate():
            return done
    raise AssertionError(f"condition not reached within {max_minutes} sim minutes")


def active_wos(client: TestClient) -> list[dict[str, Any]]:
    return client.get("/api/work-orders?active=true").json()["items"]


def tech_status(client: TestClient, tech_id: str) -> str:
    return next(t for t in client.get("/api/technicians").json() if t["id"] == tech_id)["status"]


def incident_with_draft(client: TestClient, auth) -> dict[str, Any]:
    """Inject wear on AHU-02-FAN-01 and run until the single draft work order exists."""
    inject_wear(client, auth)
    run_until(client, auth, lambda: bool(active_wos(client)), max_minutes=120)
    wos = active_wos(client)
    assert len(wos) == 1
    return client.get(f"/api/work-orders/{wos[0]['id']}").json()


def act(client: TestClient, auth, user: str, wo_id: int, action: str, **body: Any):
    return client.post(f"/api/work-orders/{wo_id}/{action}", headers=auth(user), json=body)


def approved_and_assigned(client: TestClient, auth, tech: str = "TECH-01") -> dict[str, Any]:
    wo = incident_with_draft(client, auth)
    assert act(client, auth, "supervisor", wo["id"], "approve", note="ok").status_code == 200
    r = act(client, auth, "supervisor", wo["id"], "assign", technician_id=tech)
    assert r.status_code == 200, r.text
    return r.json()


REPAIR = dict(
    findings="Bearing shows spalling; replaced bearing set and re-greased.",
    photo_data="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>",
    checklist={"lockout_tagout": True, "bearing_replaced": True},
    parts_used=[{"sku": "BRG-001", "quantity": 1}, {"sku": "GRS-001", "quantity": 1}],
)


def finish_repair(client: TestClient, auth, wo: dict[str, Any], user: str = "tech1"):
    tid = wo["assigned_technician"]["id"]
    run_until(client, auth, lambda: tech_status(client, tid) == "ON_SITE", max_minutes=60)
    if wo["status"] == "ASSIGNED":
        assert act(client, auth, user, wo["id"], "start").status_code == 200
    step(client, auth, 10)
    r = act(client, auth, user, wo["id"], "complete", **REPAIR)
    assert r.status_code == 200, r.text
    return r.json()
