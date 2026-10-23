from sqlalchemy import select

from app.db import read_session
from app.models import AuditLog, Asset, Sensor


def test_seed_building_assets_sensors(world):
    with read_session() as s:
        assets = {a.id: a for a in s.scalars(select(Asset))}
        assert len(assets) == 8
        fan = assets["AHU-02-FAN-01"]
        assert fan.criticality == "HIGH" and fan.floor.level == 6
        sensors = s.scalars(select(Sensor).where(Sensor.asset_id == fan.id)).all()
        assert {x.kind for x in sensors} == {"VIB", "TMP", "CUR", "SPD"}
        assert all(x.asset_id == "AHU-02-FAN-01" for x in sensors)


def test_login_and_me(client, auth):
    h = auth("supervisor")
    me = client.get("/api/me", headers=h).json()
    assert me["role"] == "SUPERVISOR" and "wo.approve" in me["permissions"]


def test_bad_login_is_rejected_and_audited(client):
    r = client.post("/api/auth/login", json={"username": "supervisor", "password": "wrong"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    with read_session() as s:
        row = s.scalars(select(AuditLog).where(AuditLog.action == "auth.login").order_by(AuditLog.id.desc())).first()
        assert row.outcome == "DENIED"


def test_requires_token(client):
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers={"Authorization": "Bearer nonsense"}).status_code == 401


def test_role_denial_returns_403_and_is_audited(client, auth):
    r = client.post("/api/simulation/reset", headers=auth("operator"), json={})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "role_not_permitted"
    with read_session() as s:
        row = s.scalars(select(AuditLog).where(AuditLog.action == "sim.reset").order_by(AuditLog.id.desc())).first()
        assert row.outcome == "DENIED" and row.username == "operator" and "not permitted" in row.reason


def test_allowed_action_is_audited(client, auth):
    r = client.post("/api/simulation/pause", headers=auth("operator"))
    assert r.status_code == 200
    with read_session() as s:
        row = s.scalars(select(AuditLog).where(AuditLog.action == "sim.pause").order_by(AuditLog.id.desc())).first()
        assert row.outcome == "ALLOWED"


def test_tree_assets_and_telemetry(client):
    tree = client.get("/api/buildings/TOWER-A/tree").json()
    assert [f["level"] for f in tree["floors"]] == [-1, 0, 1, 2, 3, 4, 5, 6]
    assert any(a["id"] == "AHU-02-FAN-01" for f in tree["floors"] for a in f["assets"])
    assert client.get("/api/assets/NOPE").status_code == 404
    t = client.get("/api/assets/AHU-02-FAN-01/telemetry?metric=vibration_velocity&hours=6").json()
    assert t["count"] > 300 and t["simulated"] is True
    values = [p["v"] for p in t["points"]]
    assert 0.8 < min(values) and max(values) < 3.0  # healthy range


def test_validation_error_shape(client, auth):
    r = client.patch("/api/simulation", headers=auth("operator"), json={"speed": "fast"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
