"""Layer 6: dispatch ranking, inventory ledger/reservations, technician workflow, hold flows."""
import threading

from sqlalchemy import func, select

from app.db import read_session, write_session
from app.errors import Conflict
from app.models import InventoryItem, StockMovement, StockReservation, Technician, WorkOrder
from app.modules.cmms import inventory
from tests.helpers import REPAIR, act, approved_and_assigned, finish_repair, incident_with_draft, step, tech_status


def _stock(sku="BRG-001"):
    with read_session() as s:
        return inventory.on_hand(s, sku), inventory.reserved(s, sku)


def test_dispatch_returns_ranked_eligible_technicians_with_breakdown(client, auth):
    wo = incident_with_draft(client, auth)
    r = client.get(f"/api/work-orders/{wo['id']}/dispatch-candidates").json()
    cands = r["candidates"]
    eligible = [c for c in cands if c["eligible"]]
    assert [c["technician_id"] for c in eligible][0] in ("TECH-01", "TECH-02")
    assert eligible == sorted(eligible, key=lambda c: -c["score"])
    for c in eligible:
        assert set(c["breakdown"]) == {"skill_fit", "proximity", "availability", "performance"}
        weights = {k: v["weight"] for k, v in c["breakdown"].items()}
        assert weights == {"skill_fit": 0.35, "proximity": 0.25, "availability": 0.20, "performance": 0.20}
        assert abs(sum(v["contribution"] for v in c["breakdown"].values()) - c["score"]) < 1e-3
    t3 = next(c for c in cands if c["technician_id"] == "TECH-03")
    assert not t3["eligible"] and any("BEARING_SERVICE" in x for x in t3["ineligible_reasons"])
    assert [c["rank"] for c in cands if c["eligible"]] == list(range(1, len(eligible) + 1))


def test_ineligible_technician_is_rejected_and_audited(client, auth):
    wo = incident_with_draft(client, auth)
    assert act(client, auth, "supervisor", wo["id"], "approve", note="ok").status_code == 200
    r = act(client, auth, "supervisor", wo["id"], "assign", technician_id="TECH-03")
    assert r.status_code == 409 and r.json()["error"]["code"] == "technician_ineligible"
    assert client.get(f"/api/work-orders/{wo['id']}").json()["status"] == "OPEN"
    assert act(client, auth, "operator", wo["id"], "assign", technician_id="TECH-01").status_code == 403


def test_assignment_reserves_parts_and_technician_flow_consumes_them(client, auth):
    wo = approved_and_assigned(client, auth, "TECH-01")
    assert wo["status"] == "ASSIGNED" and wo["assigned_technician"]["id"] == "TECH-01"
    assert {p["sku"]: p["reserved"] for p in wo["parts"]} == {"BRG-001": 1, "GRS-001": 1}
    assert _stock("BRG-001") == (4, 1)
    # cannot start before arriving on site; only the assigned technician may start
    assert act(client, auth, "tech1", wo["id"], "start").status_code == 409
    assert act(client, auth, "tech2", wo["id"], "start").status_code == 403
    done = finish_repair(client, auth, wo)
    assert done["status"] == "COMPLETED" and done["repair_count"] == 1
    assert _stock("BRG-001") == (3, 0) and _stock("GRS-001") == (11, 0)
    assert done["inspections"][0]["labour_minutes"] > 0
    assert {p["sku"]: p["consumed"] for p in done["parts"]} == {"BRG-001": 1, "GRS-001": 1}
    with read_session() as s:
        assert inventory.on_hand(s, "BRG-001") == s.scalar(select(func.sum(StockMovement.quantity)).where(StockMovement.sku == "BRG-001"))


def test_completion_requires_findings_and_parts_used(client, auth):
    wo = approved_and_assigned(client, auth)
    from tests.helpers import run_until
    run_until(client, auth, lambda: tech_status(client, "TECH-01") == "ON_SITE", 60)
    assert act(client, auth, "tech1", wo["id"], "start").status_code == 200
    assert act(client, auth, "tech1", wo["id"], "complete", parts_used=[]).status_code == 422
    assert act(client, auth, "tech1", wo["id"], "complete", findings="ok").status_code == 422
    assert act(client, auth, "tech1", wo["id"], "complete", findings="No parts needed", parts_used=[]).status_code == 200


def test_parts_shortage_puts_work_order_on_hold_then_receiving_stock_resumes_it(client, auth):
    wo = incident_with_draft(client, auth)
    assert act(client, auth, "supervisor", wo["id"], "approve", note="ok").status_code == 200
    assert client.post("/api/inventory/adjust", headers=auth("admin"), json={"sku": "BRG-001", "delta": -4}).status_code == 200
    r = act(client, auth, "supervisor", wo["id"], "assign", technician_id="TECH-01")
    assert r.status_code == 200
    held = r.json()
    assert held["status"] == "ON_HOLD" and held["hold_reason"] == "AWAITING_PARTS"
    types = [e["event_type"] for e in client.get(f"/api/events?correlation_id={wo['incident_id']}&order=asc&limit=500").json()["items"]]
    assert "PartsShortage" in types and "WorkOrderOnHold" in types and "PartsReserved" not in types
    shortage = next(e for e in client.get("/api/events?event_type=PartsShortage").json()["items"])
    assert shortage["payload"]["reorder"][0]["sku"] == "BRG-001"
    assert act(client, auth, "supervisor", wo["id"], "resume").status_code == 409   # blocker not cleared
    assert client.post("/api/inventory/receive", headers=auth("operator"), json={"sku": "BRG-001", "quantity": 2}).status_code == 403
    rec = client.post("/api/inventory/receive", headers=auth("supervisor"), json={"sku": "BRG-001", "quantity": 2})
    assert rec.status_code == 200 and rec.json()["resumed_work_orders"] == [wo["number"]]
    after = client.get(f"/api/work-orders/{wo['id']}").json()
    assert after["status"] == "ASSIGNED" and after["hold_reason"] is None
    assert {p["sku"]: p["reserved"] for p in after["parts"]}["BRG-001"] == 1


def test_manual_hold_and_resume(client, auth):
    wo = incident_with_draft(client, auth)
    assert act(client, auth, "supervisor", wo["id"], "approve", note="ok").status_code == 200
    assert act(client, auth, "supervisor", wo["id"], "hold").status_code == 422        # reason required
    r = act(client, auth, "supervisor", wo["id"], "hold", note="Waiting for access", reason_code="ACCESS")
    assert r.json()["status"] == "ON_HOLD"
    back = act(client, auth, "supervisor", wo["id"], "resume")
    assert back.json()["status"] == "OPEN"


def test_concurrent_consumption_never_drives_stock_negative(client):
    """Two work orders race for the last bearing set; SQLite BEGIN IMMEDIATE / PG row locks serialise them."""
    with write_session() as s:
        s.add(StockMovement(sku="BRG-001", quantity=-3, movement_type="ADJUST", balance_after=1, note="leave one",
                            occurred_at=s.scalar(select(StockMovement.occurred_at).limit(1))))
        wos = []
        for n in (1, 2):
            w = WorkOrder(number=f"WO-T{n}", asset_id="AHU-01-FAN-01" if n == 1 else "AHU-03-FAN-01", failure_mode="VIBRATION_RISE",
                          title="t", description="d", status="IN_PROGRESS", priority="P2", action="INSPECT",
                          required_skills=[], created_at=s.scalar(select(StockMovement.occurred_at).limit(1)),
                          updated_at=s.scalar(select(StockMovement.occurred_at).limit(1)))
            s.add(w)
            wos.append(w)
        s.flush()
        ids = [w.id for w in wos]
    results: list[str] = []
    barrier = threading.Barrier(2)

    def worker(wid: int) -> None:
        barrier.wait()
        try:
            with write_session() as s:
                inventory.consume_parts(s, s.get(WorkOrder, wid), [{"sku": "BRG-001", "quantity": 1}], None)
            results.append("ok")
        except Conflict:
            results.append("conflict")

    threads = [threading.Thread(target=worker, args=(i,)) for i in ids]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["conflict", "ok"]
    with read_session() as s:
        assert inventory.on_hand(s, "BRG-001") == 0
        assert s.scalar(select(func.min(StockMovement.balance_after)).where(StockMovement.sku == "BRG-001")) >= 0


def test_reservations_cannot_oversubscribe(client, auth):
    with write_session() as s:
        wo = WorkOrder(number="WO-R1", asset_id="AHU-01-FAN-01", failure_mode="VIBRATION_RISE", title="t", description="d",
                       status="OPEN", priority="P2", action="INSPECT", required_skills=[],
                       created_at=s.scalar(select(StockMovement.occurred_at).limit(1)),
                       updated_at=s.scalar(select(StockMovement.occurred_at).limit(1)))
        s.add(wo)
        s.flush()
        assert inventory.reserve_parts(s, wo, [{"sku": "BRG-001", "quantity": 4}]) == []
        wo2 = WorkOrder(number="WO-R2", asset_id="AHU-03-FAN-01", failure_mode="VIBRATION_RISE", title="t", description="d",
                        status="OPEN", priority="P2", action="INSPECT", required_skills=[],
                        created_at=wo.created_at, updated_at=wo.created_at)
        s.add(wo2)
        s.flush()
        short = inventory.reserve_parts(s, wo2, [{"sku": "BRG-001", "quantity": 1}])
        assert short and short[0]["short_by"] == 1
        assert s.scalar(select(func.count()).select_from(StockReservation).where(StockReservation.work_order_id == wo2.id)) == 0


def test_cancel_releases_reservations_and_technician(client, auth):
    wo = approved_and_assigned(client, auth)
    assert _stock("BRG-001") == (4, 1)
    r = act(client, auth, "supervisor", wo["id"], "cancel")
    assert r.status_code == 409          # ASSIGNED work orders cannot be cancelled (only DRAFT/OPEN)
    assert _stock("BRG-001") == (4, 1)
