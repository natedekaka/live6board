"""Model blok dan operasi yang dipertukarkan lewat WebSocket."""

from __future__ import annotations

import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

KINDS = ("h1", "h2", "p", "ul", "img")
BLOCK_ID_RE = r"^[A-Za-z0-9_-]{6,64}$"
IMAGE_PATH_RE = re.compile(r"^/media/[a-z0-9][a-z0-9_-]{0,31}/[a-f0-9]{16,64}\.webp$")


def clean_text(value: str, limit: int) -> str:
    """Buang karakter kendali dan batasi panjang tanpa merusak newline."""
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    value = "".join(ch for ch in value if ch == "\n" or ch == "\t" or ord(ch) >= 32)
    return value[:limit]


class Block(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=BLOCK_ID_RE)
    kind: Literal["h1", "h2", "p", "ul", "img"] = "p"
    content: str = ""
    image: str | None = None
    width: int | None = Field(default=None, ge=0, le=10000)
    height: int | None = Field(default=None, ge=0, le=10000)
    alt: str = ""
    rev: int = Field(default=0, ge=0)

    @field_validator("content")
    @classmethod
    def _content(cls, value: str) -> str:
        return clean_text(value, 8000)

    @field_validator("alt")
    @classmethod
    def _alt(cls, value: str) -> str:
        return clean_text(value, 300).replace("\n", " ").strip()

    @field_validator("image")
    @classmethod
    def _image(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return None
        if not IMAGE_PATH_RE.match(value):
            raise ValueError("path gambar tidak valid")
        return value

    def public(self) -> dict:
        return self.model_dump()


class UpsertOp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["upsert"]
    block: Block
    afterId: str | None = Field(default=None, pattern=BLOCK_ID_RE)


class DeleteOp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["delete"]
    id: str = Field(pattern=BLOCK_ID_RE)


class MoveOp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["move"]
    id: str = Field(pattern=BLOCK_ID_RE)
    beforeId: str | None = Field(default=None, pattern=BLOCK_ID_RE)


class ReplaceOp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["replace"]
    blocks: list[Block] = Field(max_length=400)


class SettingsOp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["settings"]
    follow: bool | None = None


class ScrollOp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["scroll"]
    anchorId: str | None = Field(default=None, pattern=BLOCK_ID_RE)
    offset: float = Field(default=0, ge=-10000, le=10000)


Op = Annotated[
    Union[UpsertOp, DeleteOp, MoveOp, ReplaceOp, SettingsOp, ScrollOp],
    Field(discriminator="type"),
]

_op_adapter: TypeAdapter[Op] = TypeAdapter(Op)


def parse_op(data: object) -> Op | None:
    try:
        return _op_adapter.validate_python(data)
    except Exception:
        return None
