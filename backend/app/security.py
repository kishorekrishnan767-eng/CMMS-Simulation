"""Authentication, actors and the backend permission matrix.

Passwords: PBKDF2-HMAC-SHA256, 200k iterations, per-user salt (stdlib; see ASSUMPTIONS #15).
Tokens: HS256 JWT with expiry. JWT expiry is the only place wall-clock time is used.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, Header, Query
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_read_db
from app.errors import Forbidden, Unauthorized
from app.models import User

PBKDF2_ITERATIONS = 200_000

# action -> roles allowed. This is THE permission matrix; the UI mirrors it only for convenience.
PERMISSIONS: dict[str, frozenset[str]] = {
    "sim.control": frozenset({"ADMIN", "SUPERVISOR", "OPERATOR"}),
    "sim.fault": frozenset({"ADMIN", "SUPERVISOR", "OPERATOR"}),
    "sim.reset": frozenset({"ADMIN"}),
    "ingest": frozenset({"ADMIN", "OPERATOR", "SUPERVISOR"}),
    "wo.create": frozenset({"ADMIN", "OPERATOR", "SUPERVISOR"}),
    "wo.approve": frozenset({"SUPERVISOR"}),
    "wo.reject": frozenset({"SUPERVISOR"}),
    "wo.cancel": frozenset({"SUPERVISOR"}),
    "wo.assign": frozenset({"SUPERVISOR"}),
    "wo.hold": frozenset({"SUPERVISOR", "TECHNICIAN"}),
    "wo.resume": frozenset({"SUPERVISOR"}),
    "wo.start": frozenset({"TECHNICIAN"}),
    "wo.complete": frozenset({"TECHNICIAN"}),
    "wo.restart": frozenset({"TECHNICIAN"}),
    "wo.verify": frozenset({"VERIFIER"}),
    "wo.close": frozenset({"SUPERVISOR"}),
    "wo.ack_escalation": frozenset({"SUPERVISOR"}),
    "inventory.receive": frozenset({"SUPERVISOR", "ADMIN"}),
    "inventory.adjust": frozenset({"ADMIN"}),
    "anomaly.clear": frozenset({"SUPERVISOR"}),
    "demo.run": frozenset({"ADMIN", "SUPERVISOR", "OPERATOR", "VERIFIER", "TECHNICIAN"}),
}


@dataclass(frozen=True)
class Actor:
    user_id: int | None
    username: str
    display_name: str
    role: str
    technician_id: str | None = None

    @property
    def is_system(self) -> bool:
        return self.user_id is None


SYSTEM_ACTOR = Actor(user_id=None, username="system", display_name="System", role="SYSTEM")


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2${PBKDF2_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt_b64, digest_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iters))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def create_token(user: User) -> str:
    s = get_settings()
    now = datetime.now(UTC)  # infrastructure time, not domain time
    claims = {
        "sub": str(user.id),
        "role": user.role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.jwt_expire_minutes)).timestamp()),
    }
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict[str, object]:
    try:
        return jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError as e:
        raise Unauthorized("Token expired", code="token_expired") from e
    except jwt.PyJWTError as e:
        raise Unauthorized("Invalid token", code="invalid_token") from e


def actor_from_token(token: str, db: Session) -> Actor:
    claims = decode_token(token)
    user = db.get(User, int(str(claims["sub"])))
    if user is None or not user.active:
        raise Unauthorized("Unknown or inactive user", code="invalid_token")
    return Actor(user.id, user.username, user.display_name, user.role, user.technician_id)


def current_actor(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_read_db),
) -> Actor:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise Unauthorized()
    return actor_from_token(authorization[7:].strip(), db)


def optional_actor(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
    db: Session = Depends(get_read_db),
) -> Actor | None:
    raw = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else token
    return actor_from_token(raw, db) if raw else None


def check_permission(actor: Actor, permission: str) -> None:
    """Raise Forbidden (with audit info attached by the caller) if the role may not do this."""
    allowed = PERMISSIONS.get(permission)
    if allowed is None:
        raise Forbidden(f"Unknown permission '{permission}'")
    if actor.role not in allowed:
        raise Forbidden(
            f"Role {actor.role} is not permitted to perform '{permission}' "
            f"(allowed: {', '.join(sorted(allowed))})",
            code="role_not_permitted",
            details={"permission": permission, "role": actor.role, "allowed_roles": sorted(allowed)},
        )
