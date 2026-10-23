"""Manajemen ruang, penerapan operasi, dan siaran WebSocket."""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from .config import ROOM_RE, Config
from .media import media_path
from .models import (
    Block,
    DeleteOp,
    MoveOp,
    Op,
    ReplaceOp,
    ScrollOp,
    SettingsOp,
    UpsertOp,
    clean_text,
)
from .storage import Storage

log = logging.getLogger("live6board.rooms")

DEFAULT_SETTINGS = {"follow": True}


class OpError(Exception):
    """Operasi ditolak; pesan aman untuk ditampilkan ke pengguna."""


@dataclass
class Client:
    ws: Any
    role: str
    id: str
    name: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, payload: dict) -> None:
        async with self.lock:
            await self.ws.send_json(payload)


class Room:
    def __init__(
        self,
        name: str,
        blocks: list[Block],
        settings: dict,
        config: Config,
    ) -> None:
        self.name = name
        self.blocks: dict[str, Block] = {block.id: block for block in blocks}
        self.settings = {**DEFAULT_SETTINGS, **{
            key: value
            for key, value in settings.items()
            if key in DEFAULT_SETTINGS
        }}
        self.version = 0
        self.last_scroll: dict | None = None
        self.config = config
        self.dirty = False

    def public_blocks(self) -> list[dict]:
        return [block.public() for block in self.blocks.values()]

    def snapshot(self) -> dict:
        return {
            "type": "snapshot",
            "room": self.name,
            "version": self.version,
            "blocks": self.public_blocks(),
            "settings": self.settings,
            "limits": {
                "maxBlocks": self.config.max_blocks,
                "maxBlockChars": self.config.max_block_chars,
            },
            "lastScroll": self.last_scroll,
        }


class Hub:
    def __init__(self, config: Config, storage: Storage) -> None:
        self.config = config
        self.storage = storage
        self.rooms: dict[str, Room] = {}
        self.clients: dict[str, dict[str, Client]] = {}
        self._room_locks: dict[str, asyncio.Lock] = {}
        self._save_tasks: dict[str, asyncio.Task] = {}
        self._closing = False

    # ------------------------------------------------------------------ rooms
    async def get_room(self, name: str) -> Room:
        if not ROOM_RE.match(name):
            raise OpError("Nama ruang tidak valid.")
        room = self.rooms.get(name)
        if room is not None:
            return room
        lock = self._room_locks.setdefault(name, asyncio.Lock())
        async with lock:
            room = self.rooms.get(name)
            if room is not None:
                return room
            blocks, settings = await self.storage.load_room(name)
            room = Room(name, blocks, settings, self.config)
            self.rooms[name] = room
            log.info("Ruang %r dimuat (%d blok)", name, len(blocks))
            return room

    async def create_room(self) -> str:
        """Buat ruang baru dengan kode acak dan simpan ke storage."""
        alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
        while True:
            code = "".join(secrets.choice(alphabet) for _ in range(6))
            if code in self.rooms:
                continue
            if await self.storage.room_exists(code):
                continue
            room = Room(code, [], {}, self.config)
            self.rooms[code] = room
            await self.storage.save_room(code, [], {})
            log.info("Ruang baru dibuat: %r", code)
            return code

    # --------------------------------------------------------------- koneksi
    def presence(self, room: str) -> dict:
        clients = self.clients.get(room, {}).values()
        teachers = students = 0
        for client in clients:
            if client.role == "teacher":
                teachers += 1
            else:
                students += 1
        return {"teachers": teachers, "students": students}

    async def connect(self, room_name: str, ws: Any, role: str, name: str = "") -> Client:
        room = await self.get_room(room_name)
        client = Client(ws=ws, role=role, id=secrets.token_hex(8), name=name or ("Guru" if role == "teacher" else "Siswa"))
        self.clients.setdefault(room_name, {})[client.id] = client
        snapshot = room.snapshot()
        snapshot["type"] = "snapshot"
        await client.send(snapshot)
        await self.broadcast(room_name, self._presence_payload(room_name))
        return client

    async def disconnect(self, room_name: str, client: Client) -> None:
        clients = self.clients.get(room_name)
        if not clients or clients.pop(client.id, None) is None:
            return
        if not clients:
            self.clients.pop(room_name, None)
        await self.broadcast(room_name, self._presence_payload(room_name))

    def _presence_payload(self, room_name: str) -> dict:
        presence = self.presence(room_name)
        return {
            "type": "presence",
            "teachers": presence["teachers"],
            "students": presence["students"],
        }

    async def broadcast(
        self, room_name: str, payload: dict, *, exclude: str | None = None
    ) -> None:
        clients = list(self.clients.get(room_name, {}).values())
        if not clients:
            return
        dead: list[Client] = []
        for client in clients:
            if client.id == exclude:
                continue
            try:
                await client.send(payload)
            except Exception:
                dead.append(client)
        for client in dead:
            await self.disconnect(room_name, client)

    # --------------------------------------------------------------- operasi
    async def apply(
        self, room_name: str, op: Op, role: str, *, origin: str | None = None
    ) -> dict | None:
        room = await self.get_room(room_name)

        if isinstance(op, ScrollOp):
            if role != "teacher":
                raise OpError("Hanya pengajar yang dapat menyinkronkan gulir.")
            message = {
                "type": "scroll",
                "anchorId": op.anchorId,
                "offset": op.offset,
                "ts": time.time(),
            }
            room.last_scroll = {
                "anchorId": op.anchorId,
                "offset": op.offset,
            }
            await self.broadcast(room_name, message, exclude=origin)
            return message

        if role != "teacher":
            raise OpError("Mode siswa hanya-baca. Hubungi pengajar.")

        if isinstance(op, UpsertOp):
            public = self._apply_upsert(room, op)
        elif isinstance(op, DeleteOp):
            public = self._apply_delete(room, op)
        elif isinstance(op, MoveOp):
            public = self._apply_move(room, op)
        elif isinstance(op, ReplaceOp):
            public = self._apply_replace(room, op)
        elif isinstance(op, SettingsOp):
            public = self._apply_settings(room, op)
        else:  # pragma: no cover - dibatasi oleh model
            raise OpError("Operasi tidak dikenal.")

        room.version += 1
        self._schedule_save(room)
        message = {
            "type": "op",
            "version": room.version,
            "op": public,
        }
        await self.broadcast(room_name, message, exclude=origin)
        return message

    def _check_block(self, room: Room, block: Block) -> Block:
        block.content = clean_text(block.content, room.config.max_block_chars)
        if block.kind == "img":
            if not block.image:
                raise OpError("Blok gambar tidak memiliki berkas.")
            prefix = f"/media/{room.name}/"
            if not block.image.startswith(prefix):
                raise OpError("Gambar bukan milik ruang ini.")
            filename = block.image[len(prefix):]
            if media_path(self.config.media_dir, room.name, filename) is None:
                raise OpError("Berkas gambar tidak ditemukan.")
            if not block.alt:
                block.alt = "Gambar"
        else:
            block.image = None
            block.width = None
            block.height = None
            block.alt = ""
        return block

    def _apply_upsert(self, room: Room, op: UpsertOp) -> dict:
        block = op.block.model_copy(deep=True)
        block = self._check_block(room, block)
        existing = room.blocks.get(block.id)

        if existing is None:
            if len(room.blocks) >= room.config.max_blocks:
                raise OpError("Batas jumlah blok tercapai.")
            block.rev = 1
            if op.afterId and op.afterId in room.blocks:
                items = list(room.blocks.items())
                index = next(
                    i for i, (key, _) in enumerate(items) if key == op.afterId
                )
                items.insert(index + 1, (block.id, block))
                room.blocks = dict(items)
            else:
                room.blocks[block.id] = block
        else:
            block.rev = existing.rev + 1
            # Menimpa nilai pada posisi yang sama mempertahankan urutan dict.
            room.blocks[block.id] = block

        return {
            "type": "upsert",
            "block": block.public(),
            "afterId": op.afterId if existing is None else None,
        }

    def _apply_delete(self, room: Room, op: DeleteOp) -> dict:
        if op.id not in room.blocks:
            raise OpError("Blok sudah tidak ada.")
        del room.blocks[op.id]
        return {"type": "delete", "id": op.id}

    def _apply_move(self, room: Room, op: MoveOp) -> dict:
        if op.id not in room.blocks:
            raise OpError("Blok tidak ditemukan.")
        if op.beforeId == op.id:
            return {"type": "move", "id": op.id, "beforeId": op.beforeId}

        items = [(key, value) for key, value in room.blocks.items() if key != op.id]
        moved = room.blocks[op.id]
        if op.beforeId and any(key == op.beforeId for key, _ in items):
            index = next(
                i for i, (key, _) in enumerate(items) if key == op.beforeId
            )
            items.insert(index, (op.id, moved))
        else:
            items.append((op.id, moved))
        room.blocks = dict(items)
        return {"type": "move", "id": op.id, "beforeId": op.beforeId}

    def _apply_replace(self, room: Room, op: ReplaceOp) -> dict:
        blocks = [block.model_copy(deep=True) for block in op.blocks]
        if len(blocks) > room.config.max_blocks:
            raise OpError("Batas jumlah blok tercapai.")
        if len({block.id for block in blocks}) != len(blocks):
            raise OpError("Terdapat ID blok ganda.")
        cleaned: list[Block] = []
        for block in blocks:
            block = self._check_block(room, block)
            previous = room.blocks.get(block.id)
            block.rev = previous.rev + 1 if previous else 1
            cleaned.append(block)
        room.blocks = {block.id: block for block in cleaned}
        return {"type": "replace", "blocks": [block.public() for block in cleaned]}

    def _apply_settings(self, room: Room, op: SettingsOp) -> dict:
        if op.follow is not None:
            room.settings["follow"] = op.follow
        return {"type": "settings", "settings": room.settings}

    # -------------------------------------------------------------- persistensi
    def _schedule_save(self, room: Room) -> None:
        if self._closing:
            return
        task = self._save_tasks.pop(room.name, None)
        if task is not None:
            task.cancel()
        self._save_tasks[room.name] = asyncio.create_task(self._save_later(room))

    async def _save_later(self, room: Room) -> None:
        try:
            await asyncio.sleep(0.4)
        except asyncio.CancelledError:
            return
        try:
            await self.storage.save_room(
                room.name, list(room.blocks.values()), room.settings
            )
            room.dirty = False
        except Exception:
            log.exception("Gagal menyimpan ruang %r", room.name)
            room.dirty = True

    async def flush(self) -> None:
        self._closing = True
        pending = list(self._save_tasks.values())
        for task in pending:
            task.cancel()
        self._save_tasks.clear()
        await asyncio.gather(*pending, return_exceptions=True)
        for room in self.rooms.values():
            try:
                await self.storage.save_room(
                    room.name, list(room.blocks.values()), room.settings
                )
            except Exception:
                log.exception("Gagal menyimpan ruang %r saat keluar", room.name)
