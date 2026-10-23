"""Konfigurasi aplikasi live6board.

Semua pengaturan dibaca dari environment variable (atau berkas .env di root
proyek). Tidak ada dependensi tambahan agar mudah dijalankan di mesin kelas.
"""

from __future__ import annotations

import os
import re
import secrets
from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
ROOM_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def _load_dotenv(path: Path) -> None:
    """Muat KEY=VALUE sederhana tanpa menimpa environment yang sudah ada."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return max(minimum, value)


def _env_ports(name: str) -> tuple[int, ...]:
    ports: list[int] = []
    for part in os.environ.get(name, "9330,9331").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            port = int(part)
        except ValueError:
            continue
        if 1 <= port <= 65535 and port not in ports:
            ports.append(port)
    return tuple(ports) or (9330,)


def _load_secret(data_dir: Path) -> str:
    secret = os.environ.get("LIVE6BOARD_SECRET", "").strip()
    if secret:
        return secret
    key_file = data_dir / "secret.key"
    try:
        if key_file.is_file():
            existing = key_file.read_text(encoding="utf-8").strip()
            if len(existing) >= 32:
                return existing
        data_dir.mkdir(parents=True, exist_ok=True)
        generated = secrets.token_hex(32)
        key_file.write_text(generated + "\n", encoding="utf-8")
        key_file.chmod(0o600)
        return generated
    except OSError:
        # Sistem berkas read-only: sesi tetap berjalan, tapi batal saat restart.
        return secrets.token_hex(32)


@dataclass(frozen=True)
class Config:
    title: str
    room: str
    teacher_password: str
    student_password: str
    secret: str
    host: str
    ports: tuple[int, ...]
    data_dir: Path
    web_dir: Path
    media_dir: Path
    db_path: Path
    session_ttl: int
    max_upload: int
    max_blocks: int
    max_block_chars: int
    max_image_px: int
    log_level: str

    @classmethod
    def from_env(cls, *, load_dotenv: bool = True) -> "Config":
        if load_dotenv:
            _load_dotenv(BASE_DIR / ".env")

        room = os.environ.get("LIVE6BOARD_ROOM", "main").strip().lower() or "main"
        if not ROOM_RE.match(room):
            room = "main"

        data_dir = Path(
            os.environ.get("LIVE6BOARD_DATA_DIR", str(BASE_DIR / "data"))
        ).expanduser()
        data_dir = data_dir.resolve()
        web_dir = BASE_DIR / "web"

        return cls(
            title=os.environ.get("LIVE6BOARD_TITLE", "Live6Board").strip()
            or "Live6Board",
            room=room,
            teacher_password=os.environ.get(
                "LIVE6BOARD_TEACHER_PASSWORD", "guru"
            ),
            student_password=os.environ.get("LIVE6BOARD_STUDENT_PASSWORD", ""),
            secret=_load_secret(data_dir),
            host=os.environ.get("LIVE6BOARD_HOST", "0.0.0.0").strip()
            or "0.0.0.0",
            ports=_env_ports("LIVE6BOARD_PORTS"),
            data_dir=data_dir,
            web_dir=web_dir,
            media_dir=data_dir / "media",
            db_path=data_dir / "live6board.sqlite3",
            session_ttl=_env_int("LIVE6BOARD_SESSION_HOURS", 12, 1) * 3600,
            max_upload=_env_int("LIVE6BOARD_MAX_UPLOAD_MB", 12, 1) * 1024 * 1024,
            max_blocks=_env_int("LIVE6BOARD_MAX_BLOCKS", 400, 10),
            max_block_chars=_env_int("LIVE6BOARD_MAX_BLOCK_CHARS", 8000, 100),
            max_image_px=_env_int("LIVE6BOARD_MAX_IMAGE_PX", 1920, 320),
            log_level=os.environ.get("LIVE6BOARD_LOG_LEVEL", "info").lower(),
        )

    def prepare(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        if not self.teacher_password:
            raise RuntimeError(
                "LIVE6BOARD_TEACHER_PASSWORD tidak boleh kosong."
            )
