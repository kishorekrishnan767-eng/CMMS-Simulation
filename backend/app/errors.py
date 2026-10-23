"""Domain errors with consistent JSON shape: {"error": {"code", "message", "details"}}.

A DomainError may carry an ``AuditInfo``; the command executor writes an ``outcome=DENIED`` audit
row for it in a fresh transaction after the failed unit of work has rolled back.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AuditInfo:
    action: str
    target_type: str
    target_id: str | None = None
    correlation_id: str | None = None
    before: dict[str, Any] | None = None


@dataclass
class DomainError(Exception):
    message: str
    code: str = "error"
    details: dict[str, Any] = field(default_factory=dict)
    audit: AuditInfo | None = None
    status_code: int = 400

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


class NotFound(DomainError):
    def __init__(self, message: str, **kw: Any) -> None:
        super().__init__(message=message, code=kw.pop("code", "not_found"), status_code=404, **kw)


class Forbidden(DomainError):
    def __init__(self, message: str, **kw: Any) -> None:
        super().__init__(message=message, code=kw.pop("code", "forbidden"), status_code=403, **kw)


class Conflict(DomainError):
    def __init__(self, message: str, **kw: Any) -> None:
        super().__init__(message=message, code=kw.pop("code", "conflict"), status_code=409, **kw)


class Invalid(DomainError):
    def __init__(self, message: str, **kw: Any) -> None:
        super().__init__(message=message, code=kw.pop("code", "invalid"), status_code=422, **kw)


class Unauthorized(DomainError):
    def __init__(self, message: str = "Authentication required", **kw: Any) -> None:
        super().__init__(message=message, code=kw.pop("code", "unauthorized"), status_code=401, **kw)
