"""The Guided Demo plays all ten steps against the real backend with no manual fixes."""
import pytest
from sqlalchemy import func, select

from app.db import read_session
from app.models import AuditLog, WorkOrder
from app.modules.demo import director as dmod


@pytest.fixture
def director(world):
    d = dmod.Director()
    d.pace = 0.0
    return d


def test_all_ten_steps_run_end_to_end(director):
    for _ in dmod.STEPS:
        director._exec_next()
    assert director.step == 10 and director.error is None
    r = director.results
    assert r[2]["after"]["rejected_total"] >= 2 and {x["reason"] for x in r[2]["rejected"]} >= {"UNIT_MISMATCH", "UNKNOWN_SENSOR"}
    assert r[3]["anomaly"]["state"] == "ACTIVE" and "failed" not in r[3]["anomaly"]["explanation"].lower()
    assert r[4]["active_work_orders"] == 1 and len(r[4]["work_order"]["evidence"]) >= 2
    assert r[5]["denied"]["status_code"] == 403 and r[5]["approved"] == "OPEN"
    assert r[6]["rejected_assignment"]["status_code"] == 409 and r[6]["work_order"]["status"] == "ASSIGNED"
    assert r[7]["work_order"]["status"] == "COMPLETED"
    assert r[8]["separation_of_duties"]["code"] == "separation_of_duties" and r[8]["closed"] == "CLOSED"
    assert r[9]["first_outcome"] == "REWORK_REQUIRED" and r[9]["second_outcome"] == "VERIFIED" and r[9]["final"] == "CLOSED"
    assert [v["outcome"] for v in r[9]["verifications"]] == ["FAIL", "PASS"]
    assert r[10]["detector"]["true_positives"] == 2 and r[10]["maintenance"]["closed"] == 2
    with read_session() as s:
        assert s.scalar(select(func.count()).select_from(WorkOrder)) == 2
        denied = s.scalars(select(AuditLog).where(AuditLog.outcome == "DENIED")).all()
        assert {d.action for d in denied} >= {"wo.approve", "wo.assign", "wo.verify"}
