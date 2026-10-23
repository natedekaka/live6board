"""Aplikasi FastAPI live6board.

HTTP untuk halaman, login, unggah gambar, dan penyajian media.
WebSocket untuk sinkronisasi blok dan gulir secara real-time.
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import urlparse

import uvicorn
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .config import ROOM_RE, Config
from .media import MediaError, media_path, process_image
from .models import Block, Op, UpsertOp, parse_op
from .rooms import Hub, OpError
from .security import (
    COOKIE_NAME,
    LoginThrottle,
    issue_session,
    read_session,
    role_for_password,
)
from .storage import Storage

log = logging.getLogger("live6board")

MAX_WS_MESSAGE = 300_000


class LoginPayload(BaseModel):
    password: str = Field(default="", max_length=200)


def _origin_ok(headers) -> bool:
    """Tolak permintaan lintas-origin untuk aksi yang mengubah data."""
    origin = headers.get("origin")
    if not origin:
        return True
    host = headers.get("host", "")
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    return bool(parsed.netloc) and parsed.netloc == host


def _is_https(request: Request) -> bool:
    forwarded = request.headers.get("x-forwarded-proto", "")
    return request.url.scheme == "https" or forwarded.split(",")[0].strip() == "https"


def _session_role(request: Request, config: Config) -> str | None:
    token = request.cookies.get(COOKIE_NAME, "")
    payload = read_session(config.secret, token)
    return payload["r"] if payload else None


async def _read_limited(upload: UploadFile, limit: int) -> bytes:
    chunks = bytearray()
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        chunks.extend(chunk)
        if len(chunks) > limit:
            raise HTTPException(status_code=413, detail="Ukuran gambar melebihi batas.")
    return bytes(chunks)


def create_app(config: Config | None = None) -> FastAPI:
    config = config or Config.from_env()
    config.prepare()

    storage = Storage(config.db_path)
    hub = Hub(config, storage)
    throttle = LoginThrottle(limit=20, window=300)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await storage.init()
        await hub.get_room(config.room)
        if config.teacher_password == "guru":
            log.warning(
                "Kata sandi pengajar masih default ('guru'). "
                "Set LIVE6BOARD_TEACHER_PASSWORD sebelum dipakai di kelas."
            )
        try:
            yield
        finally:
            await hub.flush()

    app = FastAPI(
        title=config.title,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.config = config
    app.state.storage = storage
    app.state.hub = hub
    app.state.throttle = throttle

    @app.middleware("http")
    async def security_middleware(request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            if not _origin_ok(request.headers):
                return JSONResponse({"detail": "Origin tidak diizinkan."}, status_code=403)

        content_length = request.headers.get("content-length")
        if content_length:
            try:
                size = int(content_length)
            except ValueError:
                size = 0
            if size > config.max_upload + 2 * 1024 * 1024:
                return JSONResponse({"detail": "Permintaan terlalu besar."}, status_code=413)
            if size > 16 * 1024 and request.url.path == "/api/login":
                return JSONResponse({"detail": "Permintaan terlalu besar."}, status_code=413)

        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; "
            "style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; "
            "object-src 'none'; base-uri 'none'; form-action 'self'; "
            "frame-ancestors 'none'",
        )
        return response

    # ------------------------------------------------------------------ auth
    @app.get("/api/me")
    async def me(request: Request) -> dict:
        role = _session_role(request, config)
        return {
            "role": role,
            "room": config.room,
            "title": config.title,
            "requiresPassword": bool(config.student_password),
            "teacherPasswordSet": True,
            "maxUploadBytes": config.max_upload,
        }

    @app.post("/api/login")
    async def login(payload: LoginPayload, request: Request, response: Response) -> dict:
        ip = request.client.host if request.client else "unknown"
        if not throttle.allowed(ip):
            raise HTTPException(
                status_code=429,
                detail="Terlalu banyak percobaan. Coba lagi beberapa menit lagi.",
            )

        password = payload.password
        role = role_for_password(config, password)
        if role is None and not password and not config.student_password:
            role = "student"

        if role is None:
            throttle.hit(ip)
            raise HTTPException(status_code=401, detail="Kata sandi salah.")
        throttle.reset(ip)

        token = issue_session(config.secret, role, config.session_ttl)
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=config.session_ttl,
            httponly=True,
            samesite="lax",
            secure=_is_https(request),
            path="/",
        )
        log.info("Login %s dari %s", role, ip)
        return {"role": role, "room": config.room, "title": config.title}

    @app.post("/api/logout")
    async def logout(response: Response) -> dict:
        response.delete_cookie(COOKIE_NAME, path="/")
        return {"ok": True}

    # ---------------------------------------------------------------- gambar
    @app.post("/api/rooms/{room}/images")
    async def upload_image(
        room: str,
        request: Request,
        file: UploadFile = File(...),
        afterId: str | None = Form(default=None),
        alt: str = Form(default=""),
    ) -> dict:
        if not ROOM_RE.match(room):
            raise HTTPException(status_code=404, detail="Ruang tidak ditemukan.")
        if _session_role(request, config) != "teacher":
            raise HTTPException(status_code=403, detail="Hanya pengajar yang dapat mengunggah.")
        if not _origin_ok(request.headers):
            raise HTTPException(status_code=403, detail="Origin tidak diizinkan.")

        raw = await _read_limited(file, config.max_upload)
        room_dir = config.media_dir / room
        try:
            meta = await run_in_threadpool(process_image, raw, room_dir)
        except MediaError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception:
            log.exception("Gagal memproses gambar")
            raise HTTPException(status_code=500, detail="Gambar gagal diproses.") from None

        url = f"/media/{room}/{meta['filename']}"
        image_block = Block(
            id=uuid.uuid4().hex,
            kind="img",
            image=url,
            width=meta["width"],
            height=meta["height"],
            alt=alt or "Gambar",
        )
        try:
            await hub.apply(
                room,
                UpsertOp(type="upsert", block=image_block, afterId=afterId or None),
                "teacher",
                origin=None,
            )
        except OpError as exc:
            (room_dir / meta["filename"]).unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        return {"block": image_block.public(), "url": url, "bytes": meta["bytes"]}

    @app.get("/media/{room}/{filename}")
    async def media(room: str, filename: str):
        if not ROOM_RE.match(room):
            raise HTTPException(status_code=404)
        path = media_path(config.media_dir, room, filename)
        if path is None:
            raise HTTPException(status_code=404)
        return FileResponse(
            path,
            media_type="image/webp",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "Content-Disposition": "inline",
            },
        )

    # -------------------------------------------------------------- websocket
    @app.websocket("/ws/{room}")
    async def websocket_endpoint(websocket: WebSocket, room: str) -> None:
        if not ROOM_RE.match(room) or not _origin_ok(websocket.headers):
            await websocket.close(code=4403)
            return
        role = _session_role(websocket, config)  # type: ignore[arg-type]
        if role is None:
            await websocket.close(code=4401)
            return
        if room != config.room:
            await websocket.close(code=4404)
            return

        await websocket.accept()
        client = await hub.connect(room, websocket, role)
        try:
            while True:
                raw = await websocket.receive_text()
                if len(raw) > MAX_WS_MESSAGE:
                    await websocket.close(code=1009)
                    break
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(message, dict):
                    continue
                kind = message.get("type")
                if kind == "ping":
                    await client.send({"type": "pong", "ts": time.time()})
                    continue
                if kind != "op":
                    continue
                op: Op | None = parse_op(message.get("op"))
                if op is None:
                    await client.send(
                        {"type": "error", "message": "Operasi tidak valid."}
                    )
                    continue
                try:
                    await hub.apply(room, op, role, origin=client.id)
                except OpError as exc:
                    await client.send({"type": "error", "message": str(exc)})
                except Exception:
                    log.exception("Gagal menerapkan operasi")
                    await client.send(
                        {"type": "error", "message": "Terjadi kesalahan di server."}
                    )
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("Koneksi WebSocket terputus tidak normal")
        finally:
            await hub.disconnect(room, client)

    # ------------------------------------------------------------------ statis
    @app.get("/healthz")
    async def healthz() -> dict:
        room = hub.rooms.get(config.room)
        return {
            "ok": True,
            "room": config.room,
            "version": room.version if room else 0,
            "blocks": len(room.blocks) if room else 0,
        }

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(
            config.web_dir / "static" / "index.html",
            media_type="text/html",
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/favicon.svg")
    async def favicon() -> FileResponse:
        return FileResponse(
            config.web_dir / "static" / "favicon.svg",
            media_type="image/svg+xml",
        )

    app.mount(
        "/static",
        StaticFiles(directory=str(config.web_dir / "static")),
        name="static",
    )
    return app


# --------------------------------------------------------------------- runner
def _lan_addresses() -> list[str]:
    addresses: set[str] = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            addresses.add(info[4][0])
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.0.2.1", 80))
        addresses.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    return sorted(
        address
        for address in addresses
        if not address.startswith("127.") and not address.startswith("0.")
    )


async def _serve(app: FastAPI, config: Config) -> None:
    sockets: list[socket.socket] = []
    for port in config.ports:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((config.host, port))
            sock.listen(2048)
        except OSError as exc:
            raise SystemExit(f"Tidak dapat membuka port {port}: {exc}") from exc
        sockets.append(sock)

    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=config.host,
            port=config.ports[0],
            log_level=config.log_level,
            proxy_headers=True,
            timeout_keep_alive=30,
            ws_ping_interval=20,
            ws_ping_timeout=20,
        )
    )
    await server.serve(sockets=sockets)


def main() -> None:
    config = Config.from_env()
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )
    app = create_app(config)
    print(f"\n  {config.title} — ruang '{config.room}'")
    if config.host in {"0.0.0.0", "::"}:
        for address in _lan_addresses() or ["<IP-LAN>"]:
            for port in config.ports:
                print(f"  http://{address}:{port}")
        print(f"  http://localhost:{config.ports[0]}\n")
    else:
        for port in config.ports:
            print(f"  http://{config.host}:{port}")
        print()
    if config.teacher_password == "guru":
        print("  Peringatan: kata sandi pengajar masih default 'guru'.\n")
    try:
        asyncio.run(_serve(app, config))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
