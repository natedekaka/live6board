import { LiveSocket } from "./ws.js";
import { BoardView, markdownToBlocks } from "./board.js";
import { uploadImage } from "./upload.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  me: null,
  role: null,
  room: null,
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

let socket = null;

function connectSocket() {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* abaikan */
    }
  }
  socket = new LiveSocket({
    url: `/ws/${state.room}`,
    onStatus: (status) => setConnStatus(status),
    onMessage: (message) => handleSocketMessage(message),
  });
  socket.connect();
}

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
    return me;
  } catch {
    return null;
  }
}

function openLogin() {
  const dialog = $("#login-dialog");
  if (dialog && !dialog.open) {
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }
  showLoginError("");
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

function showLoginError(message, target = "login-error") {
  const box = document.getElementById(target);
  if (!box) return;
  box.textContent = message || "";
  box.hidden = !message;
}

function setRoomTag(code) {
  const tag = $("#room-tag");
  if (tag) tag.textContent = code ? `#${code}` : "#—";
  const title = $("#board-title");
  if (title) title.textContent = code ? `Live6Board · ${code}` : "Live6Board";
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
  if (logoutBtn) logoutBtn.hidden = !role;
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
  setRoomTag(state.room);
  board.replace(board.getBlocks());
}

async function createRoom() {
  const input = $("#teacher-code");
  const code = input ? input.value.trim() : "";
  showLoginError("", "login-error");
  const submit = $("#teacher-submit");
  if (submit) submit.disabled = true;
  try {
    const response = await fetch("/api/ruang", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kode_guru: code }),
    });
    const data = await response.json();
    if (!response.ok) {
      showLoginError(data.detail || "Kode guru salah.", "login-error");
      return;
    }
    state.room = data.kode;
    state.role = "teacher";
    state.me = { role: "teacher" };
    try {
      localStorage.setItem("l6b_room", state.room);
      localStorage.setItem("l6b_role", "teacher");
    } catch {
      /* abaikan */
    }
    const display = $("#room-code-display");
    if (display) display.textContent = state.room;
    const result = $("#teacher-result");
    if (result) result.hidden = false;
    const form = $("#teacher-form");
    if (form) form.hidden = true;
  } catch {
    showLoginError("Tidak dapat menghubungkan ke papan.", "login-error");
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function enterRoom() {
  if (!state.room || !state.role) return;
  closeLogin();
  applyRoleUI(state.role);
  connectSocket();
}

async function joinRoom() {
  const roomInput = $("#student-room");
  const nameInput = $("#student-name");
  const kode = roomInput ? roomInput.value.trim().toLowerCase() : "";
  const nama = nameInput ? nameInput.value.trim() : "";
  showLoginError("", "student-error");
  const submit = $("#student-submit");
  if (submit) submit.disabled = true;
  try {
    const response = await fetch("/api/gabung", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kode, nama }),
    });
    const data = await response.json();
    if (!response.ok) {
      showLoginError(data.detail || "Kode ruang tidak ditemukan.", "student-error");
      return;
    }
    state.room = data.kode;
    state.role = "student";
    state.me = { role: "student" };
    try {
      localStorage.setItem("l6b_room", state.room);
      localStorage.setItem("l6b_role", "student");
    } catch {
      /* abaikan */
    }
    await enterRoom();
  } catch {
    showLoginError("Tidak dapat menghubungkan ke papan.", "student-error");
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function logout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    /* abaikan */
  }
  if (socket) {
    try {
      socket.close();
    } catch {
      /* abaikan */
    }
  }
  state.role = null;
  state.me = null;
  state.room = null;
  state.blocks = [];
  state.lastScroll = null;
  board.replace([]);
  try {
    localStorage.removeItem("l6b_room");
    localStorage.removeItem("l6b_role");
  } catch {
    /* abaikan */
  }
  applyRoleUI(null);
  // reset dialog
  const teacherForm = $("#teacher-form");
  if (teacherForm) teacherForm.hidden = false;
  const teacherResult = $("#teacher-result");
  if (teacherResult) teacherResult.hidden = true;
  const codeInput = $("#teacher-code");
  if (codeInput) codeInput.value = "";
  const roomInput = $("#student-room");
  if (roomInput) roomInput.value = "";
  const nameInput = $("#student-name");
  if (nameInput) nameInput.value = "";
  showLoginError("");
  await openLogin();
}

function setTab(mode) {
  const teacherTab = $("#teacher-tab");
  const studentTab = $("#student-tab");
  const teacherPanel = $("#teacher-panel");
  const studentPanel = $("#student-panel");
  if (teacherTab) teacherTab.setAttribute("aria-selected", mode === "teacher" ? "true" : "false");
  if (studentTab) studentTab.setAttribute("aria-selected", mode === "student" ? "true" : "false");
  if (teacherPanel) teacherPanel.hidden = mode !== "teacher";
  if (studentPanel) studentPanel.hidden = mode !== "student";
  showLoginError("");
}

function bindLogin() {
  const teacherTab = $("#teacher-tab");
  const studentTab = $("#student-tab");
  if (teacherTab) teacherTab.addEventListener("click", () => setTab("teacher"));
  if (studentTab) studentTab.addEventListener("click", () => setTab("student"));

  const teacherForm = $("#teacher-form");
  if (teacherForm) {
    teacherForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void createRoom();
    });
  }
  const enterRoomBtn = $("#enter-room");
  if (enterRoomBtn) {
    enterRoomBtn.addEventListener("click", () => void enterRoom());
  }
  const copyBtn = $("#copy-code");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(state.room || "");
        toast("Kode ruang disalin.", "info");
      } catch {
        toast("Gagal menyalin kode.", "error");
      }
    });
  }

  const studentForm = $("#student-form");
  if (studentForm) {
    studentForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void joinRoom();
    });
  }
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

// ----------------------------------------------------------------- teacher bar
function bindTeacherBar() {
  document.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.role !== "teacher") return;
      board.addBlockAndEdit(button.dataset.add);
    });
  });

  const imageButton = $("#add-image");
  if (imageButton) {
    imageButton.addEventListener("click", () => {
      if (state.role !== "teacher") return;
      openImagePicker();
    });
  }

  const followButton = $("#follow-btn");
  if (followButton) {
    followButton.addEventListener("click", () => {
      if (state.role !== "teacher") return;
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
  if (state.role !== "teacher") {
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
  let room = null;
  try {
    room = localStorage.getItem("l6b_room");
  } catch {
    room = null;
  }
  const role = (me && me.role) || (room ? localStorage.getItem("l6b_role") : null);
  if (role && room) {
    state.role = role;
    state.room = room;
    applyRoleUI(role);
    connectSocket();
  } else {
    applyRoleUI(null);
    await openLogin();
  }
}

void init();

// Ekspos untuk debugging di konsol peramban (tidak dipakai aplikasi).
window.__liveBoard = { board, state, socket };
