FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 9330 9331

CMD ["sh", "-c", "uvicorn live6board.app:create_app --host 0.0.0.0 --port ${LIVE6BOARD_PORT:-9330}"]
