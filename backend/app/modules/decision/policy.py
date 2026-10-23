"""Versioned policy loading. The YAML file is the source of truth; a content hash is stored in
``policy_versions`` so every decision can be traced to the exact policy it was made under."""
from __future__ import annotations

import hashlib
from datetime import datetime
from functools import lru_cache
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import POLICY_DIR, get_settings
from app.models import PolicyVersion


@lru_cache
def load_policy(file_name: str | None = None) -> dict[str, Any]:
    name = file_name or get_settings().policy_file
    with open(POLICY_DIR / name, "rb") as fh:
        raw = fh.read()
    data = yaml.safe_load(raw)
    data["_file"] = name
    data["_sha256"] = hashlib.sha256(raw).hexdigest()
    return data


def register_policy(session: Session, now: datetime) -> PolicyVersion:
    """Ensure the active policy file has a row in policy_versions (idempotent)."""
    p = load_policy()
    row = session.scalar(select(PolicyVersion).where(PolicyVersion.version == p["version"]))
    if row is None:
        row = PolicyVersion(version=p["version"], file_name=p["_file"], sha256=p["_sha256"],
                            content={k: v for k, v in p.items() if not k.startswith("_")},
                            active=True, loaded_at=now)
        session.add(row)
        session.flush()
    return row
