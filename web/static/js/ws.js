/** Klien WebSocket ringan dengan ping/pong dan mekanisme reconnect backoff. */

const BACKOFF_STEPS = [500, 1000, 2000, 4000, 8000];
const MAX_BACKOFF = 15000;

export class LiveSocket {
  constructor({ url, onMessage, onStatus }) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.retryIndex = 0;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.manualClose = false;
    this._setStatus("connecting");
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}${this.url}`);
    this.ws = socket;

    socket.addEventListener("open", () => {
      if (this.ws !== socket) return;
      this.retryIndex = 0;
      this._setStatus("online");
      this._startPing();
    });

    socket.addEventListener("message", (event) => {
      if (this.ws !== socket) return;
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data && typeof data === "object") this.onMessage(data);
    });

    socket.addEventListener("close", () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this._stopPing();
      if (this.manualClose) {
        this._setStatus("closed");
        return;
      }
      this._scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // onclose berikutnya akan memicu backoff; abaikan error sesaat.
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  close() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._stopPing();
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.close();
      } catch {
        /* abaikan */
      }
    }
    this._setStatus("closed");
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = window.setInterval(() => {
      if (!this.send({ type: "ping" })) this._scheduleReconnect();
    }, 15000);
  }

  _stopPing() {
    if (this.pingTimer) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.close();
      } catch {
        /* abaikan */
      }
    }
    const retry = BACKOFF_STEPS[this.retryIndex] ?? MAX_BACKOFF;
    this.retryIndex = Math.min(this.retryIndex + 1, BACKOFF_STEPS.length);
    this._setStatus("reconnecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, retry);
  }

  _setStatus(status) {
    if (this.onStatus) this.onStatus(status);
  }
}
