"""Pengujian dasar: kesehatan, autentikasi, unggah gambar, dan operasi blok."""

import io
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from live6board.app import create_app
from live6board.config import Config
from live6board.models import Block, parse_op


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LIVE6BOARD_TEACHER_PASSWORD", "guru-test")
    monkeypatch.setenv("LIVE6BOARD_STUDENT_PASSWORD", "siswa-test")
    monkeypatch.setenv("LIVE6BOARD_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("LIVE6BOARD_PORTS", "9330,9331")
    monkeypatch.setenv("LIVE6BOARD_HOST", "127.0.0.1")
    monkeypatch.delenv("LIVE6BOARD_SECRET", raising=False)
    config = Config.from_env(load_dotenv=False)
    app = create_app(config)
    with TestClient(app) as test_client:
        yield test_client


def _png_bytes() -> bytes:
    image = Image.new("RGB", (64, 64), color=(21, 122, 91))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_health(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_me_defaults_to_anonymous(client):
    response = client.get("/api/me")
    assert response.status_code == 200
    body = response.json()
    assert body["role"] is None


def test_login_wrong_password(client):
    response = client.post("/api/login", json={"password": "salah"})
    assert response.status_code == 401
    assert response.json()["detail"]


def test_login_teacher_and_student(client):
    teacher = client.post("/api/login", json={"password": "guru-test"})
    assert teacher.status_code == 200
    assert teacher.json()["role"] == "teacher"

    student = client.post("/api/login", json={"password": "siswa-test"})
    assert student.status_code == 200
    assert student.json()["role"] == "student"


def test_upload_image_requires_teacher(client):
    client.post("/api/login", json={"password": "siswa-test"})
    response = client.post(
        "/api/rooms/main/images",
        files={"file": ("foto.png", _png_bytes(), "image/png")},
        data={"afterId": "", "alt": "Foto"},
    )
    assert response.status_code == 403


def test_upload_image_teacher(client):
    client.post("/api/login", json={"password": "guru-test"})
    response = client.post(
        "/api/rooms/main/images",
        files={"file": ("foto.png", _png_bytes(), "image/png")},
        data={"afterId": "", "alt": "Foto"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["url"].startswith("/media/main/")
    assert body["block"]["kind"] == "img"


def test_upload_image_rejects_garbage(client):
    client.post("/api/login", json={"password": "guru-test"})
    response = client.post(
        "/api/rooms/main/images",
        files={"file": ("foto.png", b"not-an-image", "image/png")},
        data={"afterId": "", "alt": ""},
    )
    assert response.status_code == 422


def test_parse_op_accepts_upsert():
    op = parse_op(
        {
            "type": "upsert",
            "block": {"id": "abcdefgh", "kind": "h1", "content": "Halo", "rev": 0},
            "afterId": None,
        }
    )
    assert op is not None and op.type == "upsert"


def test_parse_op_rejects_unknown_type():
    assert parse_op({"type": "bogus", "id": "abcdefgh"}) is None


def test_block_rejects_unknown_kind():
    with pytest.raises(Exception):
        Block(id="abcdefgh", kind="nope", content="x")


def test_websocket_student_is_read_only(client):
    student_login = client.post("/api/login", json={"password": "siswa-test"})
    assert student_login.status_code == 200
    with client.websocket_connect("/ws/main") as student_ws:
        snapshot = student_ws.receive_json()
        assert snapshot["type"] == "snapshot"
        presence = student_ws.receive_json()
        assert presence["type"] == "presence"
        student_ws.send_json(
            {
                "type": "op",
                "op": {
                    "type": "upsert",
                    "block": {"id": "zzzzzz", "kind": "p", "content": "materi", "rev": 0},
                },
            }
        )
        error = student_ws.receive_json()
        assert error["type"] == "error"

