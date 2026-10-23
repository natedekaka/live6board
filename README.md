# Live6Board

Papan tulis langsung (live board) untuk kelas — teks dan gambar tersinkron real-time
melalui WebSocket, tanpa editor kode dan tanpa runtime Python di perangkat siswa.

## Fitur

- **Teks**: heading (`#`, `##`), paragraf, daftar (`-`), dan teks tebal (`**...**`).
- **Gambar**: unggah / tempel / lepas-drag dari file, otomatis dikompresi ke WebP.
- **Live**: perubahan dari pengajar diteruskan ke semua perangkat dalam ruang yang sama.
- **Akses LAN**: dua port untuk klien dan pengajar (`9330` dan `9331`).
- **Login**: pengajar membuat ruang dengan kode guru; siswa bergabung dengan kode ruang + nama.
- **Mode baca**: siswa hanya dapat melihat; pengajar yang dapat menulis/mengunggah.
- **Tema**: terang / gelap, disimpan di perangkat.

## Menjalankan (lokal)

```bash
cd live6board
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # lalu sesuaikan kata sandi
python -m live6board.app
```

Buka:

- Pengajar & Siswa: http://<IP-LAN>:9330  (atau port lain sesuai LIVE6BOARD_PORTS)

Alur:
- Guru: klik "Saya Guru" → masukkan kode guru → bagikan kode ruang ke siswa → "Masuk ke ruang".
- Siswa: klik "Saya Siswa" → masukkan kode ruang + nama → "Gabung".

## Variabel environment

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `LIVE6BOARD_TEACHER_PASSWORD` | `guru` | Kata sandi pengajar (wajib diisi). |
| `LIVE6BOARD_STUDENT_PASSWORD` | `` | Kata sandi siswa; kosongkan agar tidak dipakai. |
| `LIVE6BOARD_ROOM` | `main` | Nama ruang (lowercase, `[a-z0-9][a-z0-9_-]{0,31}`). |
| `LIVE6BOARD_PORTS` | `9330,9331` | Port HTTP (dipisah koma). |
| `LIVE6BOARD_HOST` | `0.0.0.0` | Bind alamat. |
| `LIVE6BOARD_TITLE` | `Live6Board` | Judul yang tampil. |
| `LIVE6BOARD_DATA_DIR` | `./data` | Direktori SQLite & media. |
| `LIVE6BOARD_SESSION_HOURS` | `12` | Masa berakhir sesi. |
| `LIVE6BOARD_MAX_UPLOAD_MB` | `12` | Batas ukuran gambar sebelum dikompresi. |
| `LIVE6BOARD_MAX_BLOCKS` | `400` | Batas jumlah blok. |
| `LIVE6BOARD_MAX_BLOCK_CHARS` | `8000` | Batas karakter blok. |
| `LIVE6BOARD_MAX_IMAGE_PX` | `1920` | Lebar/tinggi gambar setelah kompresi. |
| `LIVE6BOARD_LOG_LEVEL` | `info` | Level log. |

## Docker

```bash
docker compose up -d --build
docker compose exec live6board sh -c 'echo "guru" > /run/secrets/l6b'
```

Atau set `LIVE6BOARD_TEACHER_PASSWORD` di environment host.

## Arsitektur singkat

```
web/static/index.html   Halaman (HTML + Tailwind-lite manual CSS di app.css)
web/static/js/ws.js      Klien WebSocket + reconnect
web/static/js/board.js   Render blok, penyuntingan, markdown-lite, scroll
web/static/js/upload.js  Unggah gambar (multipart/form-data)
server/app.py             FastAPI: HTTP + WebSocket + static
server/rooms.py           Manajemen ruang & operasi sinkron
server/storage.py         SQLite persisten
server/models.py           Validasi blok/operasi (Pydantic)
server/media.py            Validasi & kompresi gambar (Pillow)
server/security.py        Tanda tangan sesi & throttle login
server/config.py           Baca environment
```

## Port

- `9330` — guru (pengarang utama)
- `9331` — siswa (mode baca / pratinjau)

## HTTPS

Via Caddy/Traefik reverse proxy; set `LIVE6BOARD_HOST=localhost` dan
`--proxy-headers --forwarded-allow-ips <CIDR>.
