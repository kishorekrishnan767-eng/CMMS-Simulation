"""Module boundary rules enforced as tests (import-linter style)."""
import ast
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
FORBIDDEN_FROM_SIM = ("monitoring", "decision", "cmms", "verification", "analytics", "ingestion", "demo")


def _imports(path: Path) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            out |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            out.add(node.module)
            out |= {f"{node.module}.{a.name}" for a in node.names}
    return out


def test_simulator_does_not_import_downstream_modules():
    offenders = []
    for f in (APP / "modules" / "simulation").rglob("*.py"):
        for imp in _imports(f):
            if any(imp.startswith(f"app.modules.{m}") for m in FORBIDDEN_FROM_SIM):
                offenders.append((f.name, imp))
    assert not offenders, offenders


def test_domain_code_never_uses_wall_clock():
    allowed = {"security.py", "bus.py", "engine.py"}  # JWT expiry / retry backoff / runner pacing
    offenders = []
    for f in APP.rglob("*.py"):
        if f.name in allowed:
            continue
        src = f.read_text(encoding="utf-8")
        if "datetime.now(" in src or "datetime.utcnow(" in src or "time.time(" in src:
            offenders.append(f.name)
    assert not offenders, offenders


def test_work_order_status_only_set_in_workflow():
    """Work-order status may only be assigned inside cmms/workflow.py (the single transition service)."""
    offenders = []
    for f in APP.rglob("*.py"):
        if f.parent.name == "cmms" and f.name == "workflow.py":
            continue
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if "wo.status =" in line or "work_order.status =" in line:
                offenders.append(f"{f.name}:{i}")
    assert not offenders, offenders
