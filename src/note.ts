import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { findTaskLines, renderMarkdown, toggleTaskLine } from "./markdown";
import { addTitlebarButton, setTitleText } from "./titlebar";
import "./markdown.css";

interface NoteData {
  content: string;
  mtime: number;
}

type Mode = "preview" | "edit";

const FILE_KEY = "farrey.file";
const SAVE_DELAY_MS = 500;
const POLL_MS = 1000;
const SUPPORTED = /\.(md|markdown|mdx|txt)$/i;
const FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }];

const isMac = navigator.userAgent.includes("Mac");
const MOD = isMac ? "⌘" : "Ctrl+";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const root = el("app");
const empty = el("empty");
const emptyHint = el("empty-hint");
const preview = el("preview");
const editor = el<HTMLTextAreaElement>("editor");
const toastEl = el("toast");

/* ---------- state ---------- */
let path: string | null = null;
let source = "";
let lastMtime = 0; // modification time of the file as we last read or wrote it
let dirty = false; // edits not yet written to disk
let mode: Mode = "preview";
let saveTimer: number | undefined;
let saving: Promise<void> | null = null;
let toastTimer: number | undefined;

/* ---------- helpers ---------- */
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function errText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

function toast(message: string) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 3000);
}

function updateTitle() {
  setTitleText(path ? `${dirty ? "• " : ""}${basename(path)}` : "Farrey");
}

/* ---------- view ---------- */
const ICON_OPEN =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.4 1.5h6.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ICON_EDIT =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 13l.6-2.8 7.2-7.2 2.2 2.2-7.2 7.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ICON_EYE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';

function makeButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tb-btn";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = icon;
  b.addEventListener("click", onClick);
  return b;
}

const openBtn = makeButton(ICON_OPEN, `Open file (${MOD}O)`, () => void pickAndOpen());
const modeBtn = makeButton(ICON_EDIT, `Edit (${MOD}E)`, () => toggleMode());

function showView() {
  const hasFile = path !== null;
  empty.hidden = hasFile;
  preview.hidden = !hasFile || mode !== "preview";
  editor.hidden = !hasFile || mode !== "edit";
  modeBtn.hidden = !hasFile;
  modeBtn.innerHTML = mode === "edit" ? ICON_EYE : ICON_EDIT;
  const label = mode === "edit" ? `Preview (${MOD}E)` : `Edit (${MOD}E)`;
  modeBtn.title = label;
  modeBtn.setAttribute("aria-label", label);
  updateTitle();
}

function renderPreview() {
  const scrollTop = preview.scrollTop;
  if (source.trim() === "") {
    preview.innerHTML = `<p class="hint">This note is empty. Press ${MOD}E to start writing.</p>`;
  } else {
    renderMarkdown(source, preview);
  }
  preview.scrollTop = scrollTop;
}

function setMode(next: Mode) {
  mode = next;
  if (path) {
    if (mode === "edit") {
      editor.value = source;
      showView();
      editor.focus();
    } else {
      renderPreview();
      showView();
    }
  } else {
    showView();
  }
}

function toggleMode() {
  if (path) setMode(mode === "edit" ? "preview" : "edit");
}

/* ---------- saving ---------- */
async function saveNow() {
  window.clearTimeout(saveTimer);
  if (!path || !dirty) return;
  if (saving) {
    await saving;
    if (!dirty) return;
  }
  const target = path;
  const snapshot = source;
  saving = (async () => {
    try {
      lastMtime = await invoke<number>("write_note", { path: target, content: snapshot });
      if (source === snapshot) dirty = false;
    } catch (err) {
      toast(`Could not save: ${errText(err)}`);
    } finally {
      saving = null;
      updateTitle();
    }
  })();
  await saving;
}

function scheduleSave() {
  dirty = true;
  updateTitle();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
}

/* ---------- opening files ---------- */
async function openPath(p: string, startInEdit = false) {
  await saveNow();
  const data = await invoke<NoteData>("read_note", { path: p });
  path = p;
  source = data.content;
  lastMtime = data.mtime;
  dirty = false;
  try {
    localStorage.setItem(FILE_KEY, p);
  } catch {
    /* ignore */
  }
  setMode(startInEdit ? "edit" : "preview");
}

async function tryOpen(p: string, startInEdit = false) {
  try {
    await openPath(p, startInEdit);
  } catch (err) {
    toast(errText(err));
  }
}

async function pickAndOpen() {
  const picked = await open({ multiple: false, directory: false, filters: FILTERS });
  if (typeof picked === "string") await tryOpen(picked);
}

async function createNote() {
  const picked = await save({ defaultPath: "note.md", filters: FILTERS });
  if (!picked) return;
  const target = /\.[A-Za-z0-9]+$/.test(picked) ? picked : `${picked}.md`;
  try {
    // If the file already exists (user picked it in the dialog), open it as is.
    await invoke<number>("note_mtime", { path: target });
  } catch {
    try {
      await invoke<number>("write_note", { path: target, content: "" });
    } catch (err) {
      toast(errText(err));
      return;
    }
  }
  await tryOpen(target, true);
}

/* ---------- live reload (checks the file's modification time) ---------- */
let polling = false;
async function pollOnce() {
  if (polling || !path || dirty || saving) return;
  polling = true;
  try {
    const mtime = await invoke<number>("note_mtime", { path });
    if (mtime !== lastMtime && !dirty) {
      const data = await invoke<NoteData>("read_note", { path });
      if (!dirty) {
        lastMtime = data.mtime;
        if (data.content !== source) {
          source = data.content;
          if (mode === "edit") {
            const pos = Math.min(editor.selectionStart, source.length);
            editor.value = source;
            editor.setSelectionRange(pos, pos);
          } else {
            renderPreview();
          }
        }
      }
    }
  } catch {
    /* file temporarily missing (e.g. an editor swapping it): try again next tick */
  } finally {
    polling = false;
  }
}

/* ---------- events ---------- */
function wireEvents() {
  el("btn-open-empty").addEventListener("click", () => void pickAndOpen());
  el("btn-new-empty").addEventListener("click", () => void createNote());

  editor.addEventListener("input", () => {
    source = editor.value;
    scheduleSave();
  });

  // Tick a checkbox in the preview -> flip the matching "- [ ]" line in the file.
  preview.addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (box.type !== "checkbox" || box.dataset.task === undefined) return;
    const total = preview.querySelectorAll('input[type="checkbox"]').length;
    const lines = findTaskLines(source);
    const line = lines[Number(box.dataset.task)];
    if (lines.length !== total || line === undefined) {
      box.checked = !box.checked;
      toast(`Couldn't match that checkbox. Edit it in edit mode (${MOD}E).`);
      return;
    }
    source = toggleTaskLine(source, line);
    dirty = true;
    void saveNow();
  });

  // Links open in the default browser, never inside the sticker.
  preview.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) {
      void openUrl(href).catch((err) => toast(errText(err)));
    }
  });

  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "o") {
      e.preventDefault();
      void pickAndOpen();
    } else if (key === "e") {
      e.preventDefault();
      toggleMode();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (dirty) void saveNow();
  });

  void getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") {
      root.classList.add("dragover");
    } else if (p.type === "leave") {
      root.classList.remove("dragover");
    } else if (p.type === "drop") {
      root.classList.remove("dragover");
      const file = p.paths.find((x) => SUPPORTED.test(x));
      if (file) void tryOpen(file);
      else toast("Drop a .md, .markdown or .txt file");
    }
  });
}

export async function initNote() {
  emptyHint.textContent = `Drop a README.md here, or press ${MOD}O`;
  addTitlebarButton("right", openBtn);
  addTitlebarButton("right", modeBtn);
  wireEvents();
  showView();

  let saved: string | null = null;
  try {
    saved = localStorage.getItem(FILE_KEY);
  } catch {
    /* ignore */
  }
  if (saved) {
    try {
      await openPath(saved);
    } catch {
      try {
        localStorage.removeItem(FILE_KEY);
      } catch {
        /* ignore */
      }
      showView();
    }
  }

  window.setInterval(() => void pollOnce(), POLL_MS);
}
