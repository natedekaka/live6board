/** Render papan tulis, penyuntingan guru, operasi lokal/oleh server, dan gulir. */

let idCounter = 0;

export function genBlockId() {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `b${Date.now().toString(36)}${idCounter.toString(36)}${rand}`.slice(0, 64);
}

export function markdownToBlocks(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const result = [];
  let bullets = null;

  const flush = () => {
    if (bullets) {
      const content = bullets.join("\n");
      if (content.trim()) result.push({ kind: "ul", content });
      bullets = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("# ")) {
      flush();
      const content = line.slice(2).trim();
      if (content) result.push({ kind: "h1", content });
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      const content = line.slice(3).trim();
      if (content) result.push({ kind: "h2", content });
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!bullets) bullets = [];
      const item = line.replace(/^[-*]\s+/, "").trim();
      if (item) bullets.push(item);
      continue;
    }
    flush();
    if (line) result.push({ kind: "p", content: line });
  }
  flush();
  return result.filter((block) => (block.content || "").trim() !== "");
}

export function createBlockObject(kind, content, extra) {
  const block = {
    id: genBlockId(),
    kind: kind || "p",
    content: content || "",
    image: null,
    width: null,
    height: null,
    alt: "",
    rev: 0,
  };
  if (extra) Object.assign(block, extra);
  return block;
}

function findBlock(blocks, id) {
  return blocks.find((block) => block.id === id) || null;
}

function findIndex(blocks, id) {
  return blocks.findIndex((block) => block.id === id);
}

export class BoardView {
  constructor({ container, editable, api, onImageClick, onSettings, onBlocksChanged }) {
    this.container = container;
    this.editable = editable;
    this.api = api;
    this.onImageClick = onImageClick;
    this.onSettings = onSettings;
    this.onBlocksChanged = onBlocksChanged;
    this.blocks = [];
    this.editingId = null;
    this.follow = true;
    this._editingInput = null;
    this._editingBlock = null;
    this._debounceTimer = null;
    this._boundClick = this._handleClick.bind(this);
    this._boundKeydown = this._handleKeydown.bind(this);
    this._boundScroll = this._handleScroll.bind(this);
    this.rootEl = null;
    this.container.addEventListener("click", this._boundClick);
    this.container.addEventListener("keydown", this._boundKeydown);
    window.addEventListener("scroll", this._boundScroll, { passive: true });
    this._boundDocPointer = (event) => {
      if (!this.editingId) return;
      const input = this._editingInput;
      if (!input) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target === input) return;
      if (target instanceof Element && target.closest(".block.is-editing")) return;
      this._commitEditing();
    };
    document.addEventListener("pointerdown", this._boundDocPointer, true);
    this._buildRoot();
  }

  // ------------------------------------------------------------------ render
  _buildRoot() {
    const liveEditing =
      this.editingId && this._editingInput
        ? {
            id: this.editingId,
            value: this._editingInput.value,
            start: this._editingInput.selectionStart,
            end: this._editingInput.selectionEnd,
          }
        : null;
    this.container.innerHTML = "";
    const root = document.createElement("div");
    root.className = "board";
    root.id = "board-root";
    this.rootEl = root;
    for (const block of this.blocks) root.appendChild(this._createBlockElement(block));
    this.container.appendChild(root);
    if (liveEditing) {
      const block = findBlock(this.blocks, liveEditing.id);
      if (block) {
        block.content = liveEditing.value;
        this.editingId = block.id;
        this._editingBlock = block;
        this._mountEditing(block);
        const input = this._editingInput;
        if (input && typeof liveEditing.start === "number" && input.setSelectionRange) {
          try {
            input.setSelectionRange(liveEditing.start, liveEditing.end);
          } catch {
            /* tipe input tertentu tidak mendukung seleksi */
          }
        }
      } else {
        this.editingId = null;
        this._editingBlock = null;
        this._editingInput = null;
      }
    }
    if (this.onBlocksChanged) this.onBlocksChanged(this.blocks);
  }

  _createBlockElement(block) {
    const el = document.createElement("div");
    el.className = "block";
    el.dataset.id = block.id;
    el.dataset.kind = block.kind;

    const body = document.createElement("div");
    body.className = "block-body";
    const text = (block.content || "").trim();

    if (block.kind === "img") {
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = block.image || "";
      img.alt = block.alt || "Gambar";
      if (block.width) img.width = block.width;
      if (block.height) img.height = block.height;
      img.loading = "lazy";
      figure.appendChild(img);
      body.appendChild(figure);
    } else if (block.kind === "ul") {
      const ul = document.createElement("ul");
      const items = text ? text.split("\n").filter(Boolean) : [];
      for (const item of items) {
        const li = document.createElement("li");
        renderRichText(li, item);
        ul.appendChild(li);
      }
      body.appendChild(ul);
    } else {
      body.classList.toggle("is-empty", text === "");
      if (block.kind === "h1" || block.kind === "h2") {
        const h = document.createElement(block.kind);
        h.className = "block-body-heading";
        renderRichText(h, block.content || "");
        body.appendChild(h);
      } else {
        renderRichText(body, block.content || "");
      }
    }

    el.appendChild(body);

    if (this.editable) {
      const tools = document.createElement("div");
      tools.className = "block-tools";
      tools.dataset.act = "tools";

      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "|";
      tools.appendChild(sep);

      const moveUp = document.createElement("button");
      moveUp.type = "button";
      moveUp.dataset.act = "move-up";
      moveUp.title = "Geser ke atas";
      moveUp.textContent = "↑";
      tools.appendChild(moveUp);

      const moveDown = document.createElement("button");
      moveDown.type = "button";
      moveDown.dataset.act = "move-down";
      moveDown.title = "Geser ke bawah";
      moveDown.textContent = "↓";
      tools.appendChild(moveDown);

      const del = document.createElement("button");
      del.type = "button";
      del.dataset.act = "delete";
      del.title = "Hapus blok";
      del.textContent = "✕";
      tools.appendChild(del);

      el.appendChild(tools);
    }

    return el;
  }

  replace(blocks) {
    this.blocks = (blocks || []).map((block) => Object.assign({}, block));
    this._buildRoot();
  }

  getBlocks() {
    return this.blocks;
  }

  // ------------------------------------------------------------------ ops lokal
  upsertLocal(block, afterId) {
    const existingIndex = findIndex(this.blocks, block.id);
    if (existingIndex >= 0) {
      this.blocks[existingIndex] = Object.assign({}, this.blocks[existingIndex], block, {
        rev: (this.blocks[existingIndex].rev || 0) + 1,
      });
      this._buildRoot();
      this._sendUpsert(block, afterId, true);
    } else {
      const index = afterId ? findIndex(this.blocks, afterId) : -1;
      const at = index >= 0 ? index + 1 : this.blocks.length;
      this.blocks.splice(at, 0, Object.assign({}, block, { rev: block.rev || 0 }));
      this._buildRoot();
      this._sendUpsert(block, afterId, true);
    }
  }

  addBlock(kind, afterId) {
    const block = createBlockObject(kind, "");
    const index = afterId ? findIndex(this.blocks, afterId) : -1;
    const at = index >= 0 ? index + 1 : this.blocks.length;
    this.blocks.splice(at, 0, block);
    this._buildRoot();
    this._sendUpsert(block, afterId, true);
    this.setEditing(block);
    return block;
  }

  addBlockAndEdit(kind) {
    return this.addBlock(kind, null);
  }

  /** Tambah banyak blok sekaligus (mis. hasil tempel teks) tanpa membuka editor. */
  addParsed(parsed) {
    const created = [];
    for (const item of parsed) {
      const block = createBlockObject(item.kind, item.content);
      this.blocks.push(block);
      this._sendUpsert(block, null, true);
      created.push(block);
    }
    this._buildRoot();
    return created;
  }

  _sendUpsert(block, afterId, immediate) {
    const payload = Object.assign({}, block, { rev: (block.rev || 0) + 1 });
    const message = { type: "op", op: { type: "upsert", block: payload, afterId: afterId || null } };
    if (immediate) this.api.send(message);
    else this._scheduleSendWithPayload(message);
  }

  _scheduleSendWithPayload(message) {
    if (this._debounceTimer) window.clearTimeout(this._debounceTimer);
    this._debounceTimer = window.setTimeout(() => {
      this._debounceTimer = null;
      this.api.send(message);
    }, 700);
  }

  removeBlock(id) {
    this._removeLocal(id);
    this.api.send({ type: "op", op: { type: "delete", id } });
  }

  _removeLocal(id) {
    this.blocks = this.blocks.filter((block) => block.id !== id);
    if (this.editingId === id) {
      this.editingId = null;
      this._editingBlock = null;
      this._editingInput = null;
    }
    this._buildRoot();
  }

  moveBlock(id, beforeId) {
    this._moveLocal(id, beforeId);
    this.api.send({ type: "op", op: { type: "move", id, beforeId: beforeId || null } });
  }

  _moveLocal(id, beforeId) {
    const from = findIndex(this.blocks, id);
    if (from < 0) return;
    const block = this.blocks[from];
    this.blocks.splice(from, 1);
    let at = beforeId ? findIndex(this.blocks, beforeId) : -1;
    if (at < 0) at = this.blocks.length;
    this.blocks.splice(Math.max(0, at), 0, block);
    this._buildRoot();
  }

  // -------------------------------------------------------------- ops remote
  applyOp(op) {
    if (!op || typeof op !== "object") return;
    if (op.type === "upsert") this._applyUpsert(op.block, op.afterId || null);
    else if (op.type === "delete") this._removeLocal(op.id);
    else if (op.type === "move") this._moveLocal(op.id, op.beforeId || null);
    else if (op.type === "replace") this.replace(op.blocks);
    else if (op.type === "settings") {
      if (this.onSettings) this.onSettings(op.settings);
    }
  }

  _applyUpsert(block, afterId) {
    const existingIndex = findIndex(this.blocks, block.id);
    if (existingIndex >= 0) {
      this.blocks[existingIndex] = Object.assign({}, this.blocks[existingIndex], block);
    } else {
      const index = afterId ? findIndex(this.blocks, afterId) : -1;
      const at = index >= 0 ? index + 1 : this.blocks.length;
      this.blocks.splice(at, 0, Object.assign({}, block));
    }
    this._buildRoot();
  }

  // ----------------------------------------------------------------- editing
  setEditing(block) {
    if (!block) {
      this.clearEditing();
      return;
    }
    if (this.editingId && this.editingId !== block.id) this.clearEditing();
    this.editingId = block.id;
    this._editingBlock = block;
    this._mountEditing(block);
  }

  clearEditing() {
    const wasEditing = !!this.editingId;
    this.editingId = null;
    this._editingBlock = null;
    this._editingInput = null;
    // Bangun ulang papan agar badan blok kembali dirender dari state.
    if (wasEditing) this._buildRoot();
  }

  _teardownEditingDom() {
    this._editingInput = null;
    this._editingBlock = null;
    if (this.rootEl) {
      const el = this.rootEl.querySelector(`[data-id="${this.editingId || ""}"]`);
      if (el) el.classList.remove("is-editing");
    }
  }

  _mountEditing(block) {
    if (!this.editingId) return;
    const el = this.rootEl
      ? this.rootEl.querySelector(`[data-id="${this.editingId}"]`)
      : this.container.querySelector(`[data-id="${this.editingId}"]`);
    if (!el) {
      this.clearEditing();
      return;
    }
    const body = el.querySelector(".block-body");
    if (!body) {
      this.clearEditing();
      return;
    }
    this._teardownEditingDom();
    if (block.kind === "img") {
      this.editingId = null;
      if (this.onImageClick) this.onImageClick(block);
      return;
    }
    let input;
    if (block.kind === "h1" || block.kind === "h2") {
      input = document.createElement("input");
      input.className = "block-input";
      input.type = "text";
      input.value = block.content || "";
    } else {
      input = document.createElement("textarea");
      input.className = "block-input";
      input.value = block.content || "";
      input.rows = Math.min(8, Math.max(2, String(block.content || "").split("\n").length));
    }
    body.textContent = "";
    body.appendChild(input);
    const placeholders = { h1: "Judul", h2: "Sub judul", ul: "Butir daftar", p: "Tulis sesuatu…" };
    input.placeholder = placeholders[block.kind] || "";
    el.classList.add("is-editing");
    this.editingId = block.id;
    this._editingBlock = block;
    this._editingInput = input;
    input.addEventListener("input", () => this._onEditingInput(block, input));
    input.addEventListener("blur", () => this._onEditingBlur(block, input));
    if (input instanceof HTMLTextAreaElement) this._autoResize(input);
    input.focus();
    if (input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
    el.scrollIntoView({ block: "center", behavior: "auto" });
  }

  _autoResize(input) {
    input.style.height = "auto";
    input.style.height = `${Math.max(44, input.scrollHeight)}px`;
  }

  _onEditingInput(block, input) {
    const shortcuts = [
      ["## ", "h2"],
      ["# ", "h1"],
      ["- ", "ul"],
      ["* ", "ul"],
    ];
    let value = input.value;
    let kind = block.kind;
    if (block.kind === "p") {
      for (const [prefix, nextKind] of shortcuts) {
        if (value.startsWith(prefix)) {
          value = value.slice(prefix.length);
          kind = nextKind;
          input.value = value;
          if (input.setSelectionRange) input.setSelectionRange(0, 0);
          break;
        }
      }
    } else if (block.kind === "ul") {
      const cleaned = value.replace(/(^|\n)[-*]\s+/g, "$1");
      if (cleaned !== value) {
        const delta = value.length - cleaned.length;
        const caret = input.selectionStart;
        value = cleaned;
        input.value = cleaned;
        if (input.setSelectionRange && typeof caret === "number") {
          const next = Math.max(0, caret - delta);
          input.setSelectionRange(next, next);
        }
      }
    }
    const index = findIndex(this.blocks, block.id);
    if (index >= 0) {
      this.blocks[index] = Object.assign({}, this.blocks[index], { kind, content: value });
    }
    if (this._editingBlock) {
      this._editingBlock.kind = kind;
      this._editingBlock.content = value;
    }
    if (this.rootEl) {
      const el = this.rootEl.querySelector(`[data-id="${block.id}"]`);
      if (el) el.dataset.kind = kind;
    }
    this._scheduleSendWithPayload({
      type: "op",
      op: {
        type: "upsert",
        block: Object.assign({}, block, { kind, content: value, rev: (block.rev || 0) + 1 }),
        afterId: null,
      },
    });
    if (input instanceof HTMLTextAreaElement) this._autoResize(input);
  }

  _onEditingBlur(block, input) {
    if (this._debounceTimer) {
      window.clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._commitEditing();
  }

  _insertNewBlockAfter(anchorId, fresh) {
    const index = findIndex(this.blocks, anchorId);
    const at = index >= 0 ? index + 1 : this.blocks.length;
    this.blocks.splice(at, 0, fresh);
    this._buildRoot();
    this._sendUpsert(fresh, anchorId, true);
    this.setEditing(fresh);
  }

  // ------------------------------------------------------------------ helpers
  _handleClick(event) {
    const target = event.target;
    const tools = target && target.closest ? target.closest("[data-act='tools']") : null;
    if (tools) {
      const act = target.dataset.act;
      const blockEl = target.closest(".block");
      const id = blockEl ? blockEl.dataset.id : null;
      if (!id) return;
      if (act === "delete") {
        if (this.editable) this.removeBlock(id);
      } else if (act === "move-up") {
        const index = findIndex(this.blocks, id);
        if (index > 0 && this.editable) {
          this.moveBlock(id, this.blocks[index - 1].id);
        }
      } else if (act === "move-down") {
        const index = findIndex(this.blocks, id);
        if (index >= 0 && index < this.blocks.length - 1 && this.editable) {
          const beforeId = index + 2 < this.blocks.length ? this.blocks[index + 2].id : null;
          this.moveBlock(id, beforeId);
        }
      }
      return;
    }

    const el = target && target.closest ? target.closest(".block") : null;
    if (!el) return;
    if (this.editable && event.target !== el) {
      const id = el.dataset.id;
      const block = id ? findBlock(this.blocks, id) : null;
      if (!block) return;
      if (block.kind === "img") {
        if (this.onImageClick) this.onImageClick(block);
      } else {
        this.setEditing(block);
      }
    }
  }

  _handleKeydown(event) {
    const target = event.target;
    const isEditingTarget =
      target &&
      (target.classList?.contains("block-input") ||
        (target.tagName === "TEXTAREA" && target.classList?.contains("block-input")));
    if (!isEditingTarget) return;
    if (event.key !== "Enter") return;
    const block = this._editingBlock;
    const kind = block ? block.kind : "p";
    const isTextarea = target instanceof HTMLTextAreaElement;
    if (isTextarea && kind === "ul" && !event.shiftKey) {
      // Daftar: Enter menambah butir baru di blok yang sama.
      return;
    }
    if (isTextarea && event.shiftKey) return;
    event.preventDefault();
    const anchorId = this.editingId;
    this._commitEditing();
    if (!anchorId) return;
    const nextKind = kind === "h1" || kind === "h2" ? "p" : kind;
    this._insertNewBlockAfter(anchorId, createBlockObject(nextKind, ""));
  }

  _commitEditing() {
    if (!this.editingId) return;
    if (this._debounceTimer) {
      window.clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    const id = this.editingId;
    const block = this._editingBlock || findBlock(this.blocks, id);
    const input = this._editingInput;
    const value = input ? input.value : block ? block.content : "";

    if ((value || "").trim() === "") {
      this.removeBlock(id);
      return;
    }

    const updated = Object.assign({}, block, { content: value });
    this._editingBlock = updated;
    const index = findIndex(this.blocks, id);
    if (index >= 0) {
      this.blocks[index] = Object.assign({}, this.blocks[index], updated);
      this._sendUpsert(updated, null, true);
    }
    this.clearEditing();
  }

  _handleScroll() {
    if (!this.editable) return;
    if (!this.follow) return;
    const now = Date.now();
    if (now - (this._lastScrollSent || 0) < 120) {
      if (!this._scrollTimer) {
        this._scrollTimer = window.setTimeout(() => {
          this._scrollTimer = null;
          this._handleScroll();
        }, 120);
      }
      return;
    }
    this._lastScrollSent = now;
    const scrollTop = this._currentScrollTop();
    const anchorEl = this._resolveAnchorEl(scrollTop);
    const anchorId = anchorEl ? anchorEl.dataset.id : null;
    const top = anchorEl ? this._documentTop(anchorEl) : 0;
    const offset = Math.round(scrollTop - top);
    this.api.send({ type: "op", op: { type: "scroll", anchorId: anchorId || null, offset } });
  }

  _currentScrollTop() {
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  _documentTop(el) {
    return el.getBoundingClientRect().top + this._currentScrollTop();
  }

  _resolveAnchorEl(scrollTop) {
    const root = this.rootEl;
    if (!root) return null;
    let anchor = null;
    for (const child of Array.from(root.children)) {
      if (this._documentTop(child) <= scrollTop) anchor = child;
    }
    return anchor;
  }

  scrollTo(anchorId, offset) {
    let top = 0;
    if (anchorId) {
      const el = this.container.querySelector(`[data-id="${anchorId}"]`);
      if (el) top = this._documentTop(el);
    }
    window.scrollTo({ top: Math.max(0, top + (offset || 0)), behavior: "auto" });
  }

  jumpToTop() {
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  focusBlock(id) {
    const el = this.container.querySelector(`[data-id="${id}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
  }

  setFollow(follow) {
    const next = !!follow;
    if (this.follow === next) return;
    this.follow = next;
    if (this.onSettings) this.onSettings({ follow: next });
    if (next && this.editable) this._handleScroll();
  }

  getFollow() {
    return this.follow;
  }

  isEditing() {
    return !!this.editingId;
  }
}

export function renderRichText(container, text) {
  container.textContent = "";
  const regex = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const strong = document.createElement("strong");
    strong.textContent = match[1];
    container.appendChild(strong);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}
