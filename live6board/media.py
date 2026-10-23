"""Pemrosesan gambar unggahan: validasi, resize, dan kompresi WebP."""

from __future__ import annotations

import hashlib
import io
import os
import re
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 60_000_000

ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP", "GIF", "BMP"}
FILENAME_RE = re.compile(r"^[a-f0-9]{16,64}\.webp$")


class MediaError(ValueError):
    """Gambar ditolak dengan alasan yang aman ditampilkan ke pengguna."""


def process_image(raw: bytes, media_dir: Path) -> dict:
    """Kembalikan metadata gambar yang sudah disimpan sebagai WebP."""
    if not raw:
        raise MediaError("Berkas gambar kosong.")

    try:
        with Image.open(io.BytesIO(raw)) as probe:
            if probe.format not in ALLOWED_FORMATS:
                raise MediaError("Format gambar tidak didukung. Gunakan PNG, JPG, atau WebP.")
            probe.verify()
    except UnidentifiedImageError:
        raise MediaError("Berkas bukan gambar yang valid.") from None
    except MediaError:
        raise
    except Exception:
        raise MediaError("Gambar rusak atau tidak dapat dibaca.") from None

    try:
        with Image.open(io.BytesIO(raw)) as source:
            source.seek(0)
            image = ImageOps.exif_transpose(source)
            image.load()

            if image.mode in ("RGBA", "LA", "P"):
                image = image.convert("RGBA")
            else:
                image = image.convert("RGB")

            width, height = image.size
            if width < 1 or height < 1:
                raise MediaError("Ukuran gambar tidak valid.")
            if width * height > 60_000_000:
                raise MediaError("Gambar terlalu besar.")

            output = io.BytesIO()
            image.save(output, format="WEBP", quality=82, method=4)
    except MediaError:
        raise
    except Exception:
        raise MediaError("Gambar gagal diproses.") from None

    data = output.getvalue()
    if len(data) > 20 * 1024 * 1024:
        raise MediaError("Gambar hasil kompresi terlalu besar.")

    digest = hashlib.sha256(data).hexdigest()[:24]
    filename = f"{digest}.webp"
    media_dir.mkdir(parents=True, exist_ok=True)
    target = media_dir / filename

    if not target.exists():
        temp = media_dir / f".{filename}.{os.getpid()}.tmp"
        try:
            temp.write_bytes(data)
            temp.replace(target)
        finally:
            temp.unlink(missing_ok=True)

    return {
        "filename": filename,
        "width": image.width,
        "height": image.height,
        "bytes": len(data),
    }


def media_path(media_root: Path, room: str, filename: str) -> Path | None:
    """Ambil path gambar dengan proteksi traversal."""
    if not FILENAME_RE.match(filename):
        return None
    path = (media_root / room / filename).resolve()
    try:
        path.relative_to((media_root / room).resolve())
    except ValueError:
        return None
    return path if path.is_file() else None
