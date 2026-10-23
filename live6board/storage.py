"""Persistensi SQLite: blok dan pengaturan per ruang."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from pathlib import Path

from .models import Block

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
    name TEXT PRIMARY KEY,
    settings TEXT NOT NULL DEFAULT '{}',
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
    room TEXT NOT NULL,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    image TEXT,
    width INTEGER,
    height INTEGER,
    alt TEXT NOT NULL DEFAULT '',
    rev INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room, id)
);
CREATE INDEX IF NOT EXISTS blocks_room_position ON blocks (room, position);
"""


class Storage:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._lock = asyncio.Lock()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    async def init(self) -> None:
        def _init() -> None:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as conn:
                conn.executescript(SCHEMA)

        await asyncio.to_thread(_init)

    async def load_room(self, name: str) -> tuple[list[Block], dict]:
        def _load() -> tuple[list[Block], dict]:
            with self._connect() as conn:
                room = conn.execute(
                    "SELECT settings FROM rooms WHERE name = ?", (name,)
                ).fetchone()
                settings: dict = {}
                if room:
                    try:
                        parsed = json.loads(room["settings"])
                        if isinstance(parsed, dict):
                            settings = parsed
                    except json.JSONDecodeError:
                        settings = {}
                rows = conn.execute(
                    "SELECT * FROM blocks WHERE room = ? ORDER BY position ASC",
                    (name,),
                ).fetchall()
                blocks: list[Block] = []
                for row in rows:
                    try:
                        blocks.append(
                            Block(
                                id=row["id"],
                                kind=row["kind"],
                                content=row["content"],
                                image=row["image"],
                                width=row["width"],
                                height=row["height"],
                                alt=row["alt"],
                                rev=row["rev"],
                            )
                        )
                    except Exception:
                        continue
                return blocks, settings

        return await asyncio.to_thread(_load)

    async def save_room(
        self, name: str, blocks: list[Block], settings: dict
    ) -> None:
        payload = [
            (
                name,
                block.id,
                index,
                block.kind,
                block.content,
                block.image,
                block.width,
                block.height,
                block.alt,
                block.rev,
            )
            for index, block in enumerate(blocks)
        ]
        settings_json = json.dumps(settings, ensure_ascii=False)

        def _save() -> None:
            with self._connect() as conn, conn:
                conn.execute("DELETE FROM blocks WHERE room = ?", (name,))
                conn.executemany(
                    "INSERT INTO blocks (room, id, position, kind, content, image,"
                    " width, height, alt, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    payload,
                )
                conn.execute(
                    "INSERT INTO rooms (name, settings, updated_at) VALUES (?, ?, ?)"
                    " ON CONFLICT(name) DO UPDATE SET settings = excluded.settings,"
                    " updated_at = excluded.updated_at",
                    (name, settings_json, time.time()),
                )

        async with self._lock:
            await asyncio.to_thread(_save)
