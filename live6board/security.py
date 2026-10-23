"""Penandatanganan cookie sesi dan pembatasan percobaan login."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections import defaultdict, deque

COOKIE_NAME = "l6b_session"
ROLES = ("teacher", "student")


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def _signature(secret: str, body: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256)
    return _b64encode(digest.digest())


def issue_session(secret: str, role: str, ttl: int, *, now: float | None = None) -> str:
    if role not in ROLES:
        raise ValueError("role tidak dikenal")
    issued = int(now if now is not None else time.time())
    body = _b64encode(
        json.dumps(
            {"r": role, "iat": issued, "exp": issued + ttl},
            separators=(",", ":"),
        ).encode("utf-8")
    )
    return f"{body}.{_signature(secret, body)}"


def read_session(secret: str, token: str, *, now: float | None = None) -> dict | None:
    if not token or token.count(".") != 1:
        return None
    body, signature = token.split(".", 1)
    expected = _signature(secret, body)
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_b64decode(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    role = payload.get("r")
    expires = payload.get("exp")
    current = now if now is not None else time.time()
    if role not in ROLES or not isinstance(expires, (int, float)):
        return None
    if expires < current:
        return None
    return payload


def role_for_password(config, candidate: str) -> str | None:
    """Cocokkan kata sandi. Pengajar diperiksa lebih dulu."""
    if not candidate:
        return None
    if hmac.compare_digest(candidate, config.teacher_password):
        return "teacher"
    if config.student_password and hmac.compare_digest(
        candidate, config.student_password
    ):
        return "student"
    return None


class LoginThrottle:
    """Batasi percobaan login per alamat IP (in-memory)."""

    def __init__(self, limit: int = 10, window: float = 300.0) -> None:
        self.limit = limit
        self.window = window
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _prune(self, key: str, now: float) -> deque[float]:
        hits = self._hits[key]
        while hits and now - hits[0] > self.window:
            hits.popleft()
        return hits

    def allowed(self, key: str) -> bool:
        now = time.time()
        return len(self._prune(key, now)) < self.limit

    def hit(self, key: str) -> None:
        now = time.time()
        hits = self._prune(key, now)
        hits.append(now)
        # Hindari pertumbuhan memori untuk IP yang sudah lama tidak aktif.
        if len(self._hits) > 2048:
            for stale in [k for k, v in self._hits.items() if not v][:1024]:
                self._hits.pop(stale, None)

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)
