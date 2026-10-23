import { LiveSocket } from "./ws.js";
import { BoardView, markdownToBlocks } from "./board.js";
import { uploadImage } from "./upload.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  me: null,
  role: null,
  room: "main",
  blocks: [],
  settings: { follow: true },
  version: 0,
  connected: false,
  lastScroll: null,
};

const board = new BoardView({
  container: $("#board"),
  editable: false,
  api: { send: (message) => socket.send(message) },
  onImageClick: (block) => openImagePicker(block),
  onBlocksChanged: (blocks) => updateEmptyState(blocks),
  onSettings: (settings) => {
    state.settings = { ...state.settings, ...settings };
    board.follow = !!settings.follow;
    const followBtn = $("#follow-btn");
    if (followBtn) {
      followBtn.setAttribute("aria-pressed", String(!!settings.follow));
      const label = $("#follow-label");
      if (label) label.textContent = settings.follow ? "Ikuti" : "Lepas";
    }
  },
});

function updateEmptyState(blocks) {
  const emptyState = $("#empty-state");
  if (!emptyState) return;
  emptyState.hidden = Array.isArray(blocks) && blocks.length > 0;
}

const socket = new LiveSocket({
  url: `/ws/${state.room}`,
  onStatus: (status) => setConnStatus(status),
  onMessage: (message) => handleSocketMessage(message),
});

function setConnStatus(status) {
  state.connected = status === "online";
  const pill = $("#conn");
  const text = $("#conn-text");
  const reconnecting = status === "connecting" || status === "reconnecting";
  pill.dataset.state = status === "online" ? "online" : reconnecting ? "reconnecting" : "offline";
  text.textContent = status === "online" ? "Online" : reconnecting ? "Menghubungkan ulang…" : "Terputus";
}

function handleSocketMessage(message) {
  if (message.type === "snapshot") {
    state.blocks = message.blocks || [];
    state.version = message.version || 0;
    state.settings = { follow: true, ...(message.settings || {}) };
    if (message.settings && typeof message.settings.follow === "boolean") {
      board.setFollow(message.settings.follow);
    }
    board.replace(message.blocks || []);
    state.lastScroll = message.lastScroll || null;
    if (state.lastScroll && state.lastScroll.anchorId) {
      board.scrollTo(state.lastScroll.anchorId, state.lastScroll.offset || 0);
    }
    return;
  }
  if (message.type === "op") {
    board.applyOp(message.op);
    return;
  }
  if (message.type === "scroll") {
    state.lastScroll = { anchorId: message.anchorId || null, offset: message.offset || 0 };
    board.scrollTo(message.anchorId, message.offset || 0);
    return;
  }
  if (message.type === "error") {
    toast(message.message || "Permintaan gagal.", "error");
    return;
  }
  if (message.type === "presence") {
    renderPresence(message);
    return;
  }
}

function renderPresence(payload) {
  const badge = $("#presence");
  if (!badge) return;
  const teachers = payload.teachers || 0;
  const students = payload.students || 0;
  if (teachers + students === 0) {
    badge.hidden = true;
    badge.textContent = "";
    return;
  }
  badge.hidden = false;
  badge.textContent = `${teachers} pengajar · ${students} siswa online`;
}

// --------------------------------------------------------------------- auth
async function refreshMe() {
  try {
    const response = await fetch("/api/me");
    const me = await response.json();
    state.me = me;
    state.room = me.room || state.room;
    return me;
  } catch {
    return null;
  }
}

async function openLogin() {
  const dialog = $("#login-dialog");
  if (dialog && !dialog.open) {
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }
  const errorBox = $("#login-error");
  if (errorBox) errorBox.hidden = true;
  const password = $("#password");
  if (password) {
    password.value = "";
    password.focus();
  }
}

function closeLogin() {
  const dialog = $("#login-dialog");
  if (!dialog) return;
  if (dialog.open && typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

async function submitLogin(event) {
  if (event && event.preventDefault) event.preventDefault();
  const password = $("#password");
  const value = password ? password.value : "";
  const errorBox = $("#login-error");
  const submitButton = $("#login-submit");
  if (errorBox) errorBox.hidden = true;
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: value }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (errorBox) {
        errorBox.textContent = data.detail || "Kata sandi salah.";
        errorBox.hidden = false;
      }
      return;
    }
    state.role = data.role;
    await refreshMe();
    closeLogin();
    applyRoleUI(state.role);
    socket.connect();
  } catch {
    if (errorBox) {
      errorBox.textContent = "Tidak dapat menghubungkan ke papan.";
      errorBox.hidden = false;
    }
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function applyRoleUI(role) {
  const isTeacher = role === "teacher";
  document.body.dataset.role = role || "visitor";
  board.editable = isTeacher;
  const topbar = $("#topbar");
  if (topbar) topbar.hidden = !role;
  const teacherBar = $("#teacher-bar");
  if (teacherBar) teacherBar.hidden = !isTeacher;
  const logoutBtn = $("#logout-btn");
  if (logoutBtn) logoutBtn.hidden = !isTeacher;
  const followBtn = $("#follow-btn");
  if (followBtn) followBtn.hidden = !isTeacher;
  const jumpBtn = $("#jump-btn");
  if (jumpBtn) jumpBtn.hidden = !role || isTeacher;
  const roleBadge = $("#role-badge");
  if (roleBadge) {
    roleBadge.hidden = !role;
    roleBadge.textContent = isTeacher ? "Pengajar" : "Siswa";
  }
  const emptyHint = $("#empty-hint");
  if (emptyHint) {
    emptyHint.textContent = isTeacher
      ? "Klik di sini atau gunakan bilah bawah untuk mulai menulis."
      : "Tunggu pengajar menulis materi.";
  }
  board.replace(board.getBlocks());
}

async function logout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    /* abaikan */
  }
  socket.close();
  state.role = null;
  state.me = null;
  state.blocks = [];
  state.lastScroll = null;
  board.replace([]);
  applyRoleUI(null);
  await openLogin();
}

// ---------------------------------------------------------------------- toast
function toast(message, kind = "info") {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => {
      el.hidden = true;
    }, 250);
  }, kind === "error" ? 4200 : 2600);
}

// ----------------------------------------------------------------------- theme
function initTheme() {
  const saved = localStorage.getItem("live6board-theme");
  const theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  const button = $("#theme-btn");
  if (button) {
    button.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("live6board-theme", next);
    });
  }
}

// -------------------------------------------------------------------- login UI
function setLoginHint(mode) {
  const teacherHint = document.getElementById("teacher-login-hint");
  const studentHint = document.getElementById("student-login-hint");
  if (teacherHint) teacherHint.hidden = mode !== "teacher";
  if (studentHint) studentHint.hidden = mode !== "student";
  const errorBox = $("#login-error");
  if (errorBox) errorBox.hidden = true;
}

function bindLogin() {
  const form = $("#login-form");
  const password = $("#password");
  const teacherButton = $("#teacher-login-btn");
  const studentButton = $("#student-login-btn");
  const errorBox = $("#login-error");

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitLogin(event);
    });
  }
  if (teacherButton) {
    teacherButton.addEventListener("click", () => setLoginHint("teacher"));
  }
  if (studentButton) {
    studentButton.addEventListener("click", () => setLoginHint("student"));
  }
  if (password) {
    password.addEventListener("input", () => {
      if (errorBox) errorBox.hidden = true;
    });
  }
}

// ----------------------------------------------------------------- teacher bar
function bindTeacherBar() {
  document.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.me && state.me.role !== "teacher") return;
      board.addBlockAndEdit(button.dataset.add);
    });
  });

  const imageButton = $("#add-image");
  if (imageButton) {
    imageButton.addEventListener("click", () => {
      if (state.me && state.me.role !== "teacher") return;
      openImagePicker();
    });
  }

  const followButton = $("#follow-btn");
  if (followButton) {
    followButton.addEventListener("click", () => {
      if (state.me && state.me.role !== "teacher") return;
      const next = !board.getFollow();
      board.setFollow(next);
      board.api.send({ type: "op", op: { type: "settings", follow: next } });
      toast(next ? "Siswa akan mengikuti gulir Anda." : "Siswa tidak akan lagi mengikuti.", "info");
    });
  }

  const jumpButton = $("#jump-btn");
  if (jumpButton) {
    jumpButton.addEventListener("click", () => {
      if (state.lastScroll && state.lastScroll.anchorId) {
        board.scrollTo(state.lastScroll.anchorId, state.lastScroll.offset || 0);
      } else {
        board.jumpToTop();
      }
    });
  }
}

// ----------------------------------------------------------------------- image
let imagePickerTarget = null;

function openImagePicker(block) {
  if (state.role !== "teacher") return;
  imagePickerTarget = block || null;
  const input = $("#file-input");
  if (!input) return;
  input.value = "";
  input.dataset.afterId = block ? block.id : "";
  input.dataset.alt = block ? block.alt || "" : "";
  input.click();
}

async function handleFiles(files) {
  if (state.role !== "teacher") {
    toast("Hanya pengajar yang dapat mengunggah gambar.", "error");
    return;
  }
  const input = $("#file-input");
  const afterId = input?.dataset.afterId || null;
  const alt = input?.dataset.alt || "";
  try {
    await uploadImages(files, afterId, alt);
  } finally {
    imagePickerTarget = null;
    if (input) {
      input.value = "";
      input.dataset.afterId = "";
      input.dataset.alt = "";
    }
  }
}

async function uploadImages(files, afterId = null, alt = "") {
  const images = Array.from(files || []).filter((file) => file.type && file.type.startsWith("image/"));
  if (!images.length) {
    toast("Berkas harus berupa gambar.", "error");
    return null;
  }
  let anchorId = afterId;
  try {
    for (const file of images) {
      const data = await uploadImage({ file, room: state.room, afterId: anchorId, alt });
      board.upsertLocal(data.block, anchorId);
      anchorId = data.block.id;
    }
    board.focusBlock(anchorId);
    const text = images.length > 1 ? `${images.length} gambar dipasang ke papan.` : "Gambar dipasang ke papan.";
    toast(text, "info");
    return anchorId;
  } catch (error) {
    toast(error && error.message ? error.message : "Gagal mengunggah gambar.", "error");
    return null;
  }
}

function bindFileInput() {
  const input = $("#file-input");
  if (!input) return;
  input.addEventListener("change", (event) => {
    const files = event.target && event.target.files;
    if (files && files.length > 0) void handleFiles(files);
  });
}

// ----------------------------------------------------------------------- paste
function onPaste(event) {
  if (state.role !== "teacher") return;
  const target = event.target;
  const editingEl =
    target instanceof Element
      ? target.closest(".block.is-editing")
      : document.activeElement instanceof Element
        ? document.activeElement.closest(".block.is-editing")
        : null;
  const clipboardData = event.clipboardData;
  if (!clipboardData) return;
  const items = Array.from(clipboardData.items || []);
  const imageItem = items.find((item) => item.kind === "file" && item.type && item.type.startsWith("image/"));
  if (imageItem) {
    event.preventDefault();
    const file = imageItem.getAsFile ? imageItem.getAsFile() : null;
    if (!file) return;
    const afterId = editingEl
      ? editingEl.dataset.id
      : imagePickerTarget
        ? imagePickerTarget.id
        : lastBlockId();
    void uploadImages([file], afterId, "");
    return;
  }
  if (editingEl) return; // biarkan tempel teks biasa masuk ke penyunting.
  const text = clipboardData.getData("text/plain");
  if (text && text.trim()) {
    event.preventDefault();
    void insertPastedText(text);
  }
}

function lastBlockId() {
  const blocks = board.getBlocks();
  return blocks.length ? blocks[blocks.length - 1].id : null;
}

async function insertPastedText(text) {
  if (state.me && state.me.role !== "teacher") {
    toast("Hanya pengajar yang dapat menempel teks ke papan.", "error");
    return;
  }
  const parsed = markdownToBlocks(text);
  if (!parsed.length) return;
  const created = board.addParsed(parsed);
  board.focusBlock(created[created.length - 1].id);
}

// ---------------------------------------------------------------------- events
function bindBoardEvents() {
  const boardEl = $("#board");
  boardEl.addEventListener("paste", onPaste);
  const emptyState = $("#empty-state");
  if (emptyState) {
    emptyState.addEventListener("click", () => {
      if (state.role !== "teacher") return;
      board.addBlockAndEdit("p");
    });
  }

  const overlay = $("#drop-overlay");
  let dragDepth = 0;
  const hideOverlay = () => {
    dragDepth = 0;
    if (overlay) overlay.hidden = true;
  };

  const stage = document.querySelector(".stage") || boardEl.parentElement;
  if (stage) {
    stage.addEventListener("dragenter", (event) => {
      if (state.role !== "teacher") return;
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes("Files")) return;
      event.preventDefault();
      dragDepth += 1;
      if (overlay) overlay.hidden = false;
    });
    stage.addEventListener("dragover", (event) => {
      if (state.role !== "teacher") return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    stage.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && overlay) overlay.hidden = true;
    });
    stage.addEventListener("drop", (event) => {
      event.preventDefault();
      hideOverlay();
      if (state.role !== "teacher") return;
      const files = Array.from(event.dataTransfer ? event.dataTransfer.files || [] : []);
      if (files.length > 0) {
        event.stopPropagation();
        void handleFiles(files);
      }
    });
  }

  document.addEventListener("drop", (event) => {
    if (!overlay || overlay.hidden) return;
    event.preventDefault();
    hideOverlay();
  });
  document.addEventListener("dragend", hideOverlay);
}

// ------------------------------------------------------------------------ init
async function init() {
  initTheme();
  applyRoleUI(null);
  bindLogin();
  bindTeacherBar();
  bindFileInput();
  bindBoardEvents();
  setLoginHint("teacher");

  const dialog = $("#login-dialog");
  const logoutButton = $("#logout-btn");

  if (dialog) {
    // Login adalah gerbang masuk; dialog tidak boleh ditutup sebelum masuk.
    dialog.addEventListener("cancel", (event) => event.preventDefault());
  }
  if (logoutButton) {
    logoutButton.addEventListener("click", () => void logout());
  }

  const me = await refreshMe();
  state.me = me;
  if (me && me.role) {
    state.role = me.role;
    applyRoleUI(me.role);
    socket.connect();
  } else {
    await openLogin();
  }
}

void init();

// Ekspos untuk debugging di konsol peramban (tidak dipakai aplikasi).
window.__liveBoard = { board, state, socket };
