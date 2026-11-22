import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { refreshFind } from "./find";
import {
  collectHeadings,
  findTaskLines,
  isLocalTarget,
  renderMarkdown,
  scrollToAnchor,
  toggleTaskLine,
} from "./markdown";
import { stickerId, type StickerState } from "./sticker";
import { addTitlebarButton, onBeforeClose, setTitleText } from "./titlebar";
import "./markdown.css";

interface NoteData {
  content: string;
  mtime: number;
}

type Mode = "preview" | "edit";

export interface NoteHooks {
  /** Switch this sticker to README mode (used when a Markdown file is dropped or opened). */
  switchToReadme(): Promise<void>;
}

export interface NoteApi {
  preview: HTMLElement;
  editor: HTMLTextAreaElement;
  setActive(on: boolean): void;
  flush(): Promise<void>;
  mode(): Mode;
  hasNote(): boolean;
}

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
const tocPanel = el("toc");

/* ---------- state ---------- */
let path: string | null = null;
let source = "";
let lastMtime = 0; // modification time of the file as we last read or wrote it
let dirty = false; // edits not yet written to disk
let mode: Mode = "preview";
let saveTimer: number | undefined;
let saving: Promise<void> | null = null;
let active = false; // false while the sticker is in normal (rich-text) mode
let hooks: NoteHooks;
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
  if (!active) return;
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
const ICON_TOC =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 4h1.5M6.5 4h7M2.5 8h1.5M6.5 8h7M2.5 12h1.5M6.5 12h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';
const tocBtn = makeButton(ICON_TOC, `Table of contents (${MOD}⇧O)`, () => toggleToc());

/* ---------- images inside the README ---------- */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};
let imageUrls: string[] = [];

function releaseImages() {
  imageUrls.forEach((u) => URL.revokeObjectURL(u));
  imageUrls = [];
}

/** Loads a relative image next to the open README through the Rust side, which only
 *  serves image files from the README's own project folder. */
async function loadImage(src: string): Promise<string> {
  if (!path) throw new Error("No file is open");
  const bytes = await invoke<ArrayBuffer>("read_image", { readme: path, src });
  const ext = src.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  const url = URL.createObjectURL(
    new Blob([bytes], { type: IMAGE_TYPES[ext] ?? "image/png" }),
  );
  imageUrls.push(url);
  return url;
}

/* ---------- table of contents ---------- */
function toggleToc() {
  if (!path) return;
  if (!tocPanel.hidden) {
    tocPanel.hidden = true;
    return;
  }
  if (mode === "edit") setMode("preview");
  const headings = collectHeadings(preview);
  tocPanel.replaceChildren();
  if (headings.length === 0) {
    const none = document.createElement("p");
    none.className = "toc-empty";
    none.textContent = "No headings in this file.";
    tocPanel.append(none);
  }
  const shallowest = Math.min(...headings.map((h) => h.level));
  for (const h of headings) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = h.text || "(untitled)";
    item.style.paddingLeft = `${8 + (h.level - shallowest) * 12}px`;
    item.addEventListener("click", () => {
      document.getElementById(h.id)?.scrollIntoView({ block: "start" });
      tocPanel.hidden = true;
    });
    tocPanel.append(item);
  }
  tocPanel.hidden = false;
}

function showView() {
  if (!active) {
    empty.hidden = true;
    preview.hidden = true;
    editor.hidden = true;
    modeBtn.hidden = true;
    openBtn.hidden = true;
    tocBtn.hidden = true;
    tocPanel.hidden = true;
    return;
  }
  openBtn.hidden = false;
  const hasFile = path !== null;
  empty.hidden = hasFile;
  preview.hidden = !hasFile || mode !== "preview";
  editor.hidden = !hasFile || mode !== "edit";
  modeBtn.hidden = !hasFile;
  tocBtn.hidden = !hasFile || mode !== "preview";
  if (tocBtn.hidden) tocPanel.hidden = true;
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
    releaseImages();
    renderMarkdown(source, preview, { resolveImage: loadImage });
  }
  preview.scrollTop = scrollTop;
  refreshFind();
}

function setMode(next: Mode) {
  mode = next;
  if (path) {
    if (mode === "edit") {
      editor.value = source;
      showView();
      editor.focus();
      refreshFind();
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
async function openPath(p: string, startInEdit = false, claim = true) {
  await saveNow();
  const data = await invoke<NoteData>("read_note", { path: p });
  // Claim the file for this sticker (fails if another sticker already has it open).
  if (claim) await invoke("set_file", { id: stickerId(), file: p, kind: "readme" });
  path = p;
  source = data.content;
  lastMtime = data.mtime;
  dirty = false;
  setMode(startInEdit || data.content === "" ? "edit" : "preview");
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
  if (polling || !active || !path || dirty || saving) return;
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
            refreshFind();
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
    refreshFind();
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
    } else if (href.startsWith("#")) {
      if (!scrollToAnchor(preview, href.slice(1))) toast("That section was not found.");
    } else if (path && isLocalTarget(href)) {
      // A link to another Markdown file opens it in its own sticker.
      invoke("open_markdown_link", { readme: path, href }).catch((err) =>
        toast(errText(err)),
      );
    }
  });

  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "o" && e.shiftKey) {
      e.preventDefault();
      if (active) toggleToc();
    } else if (key === "o") {
      e.preventDefault();
      void (async () => {
        if (!active) await hooks.switchToReadme();
        await pickAndOpen();
      })();
    } else if (key === "e" && active) {
      e.preventDefault();
      toggleMode();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !tocPanel.hidden) tocPanel.hidden = true;
  });
  document.addEventListener("mousedown", (e) => {
    const target = e.target as Node;
    if (!tocPanel.hidden && !tocPanel.contains(target) && !tocBtn.contains(target)) {
      tocPanel.hidden = true;
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
      if (file) {
        void (async () => {
          if (!active) await hooks.switchToReadme();
          await tryOpen(file);
        })();
      } else toast("Drop a .md, .markdown or .txt file");
    }
  });
}

export async function initNote(state: StickerState, h: NoteHooks): Promise<NoteApi> {
  hooks = h;
  active = state.mode === "readme";
  emptyHint.textContent = `Drop a README.md here, or press ${MOD}O`;
  addTitlebarButton("right", tocBtn);
  addTitlebarButton("right", openBtn);
  addTitlebarButton("right", modeBtn);
  onBeforeClose(saveNow);
  window.addEventListener("farrey:error", (e) =>
    toast(String((e as CustomEvent).detail)),
  );
  wireEvents();
  showView();

  if (state.file) {
    try {
      await openPath(state.file, false, false);
    } catch (err) {
      toast(`Could not open ${basename(state.file)}: ${errText(err)}`);
      showView();
    }
  }

  window.setInterval(() => void pollOnce(), POLL_MS);

  return {
    preview,
    editor,
    flush: saveNow,
    mode: () => mode,
    hasNote: () => path !== null,
    setActive(on: boolean) {
      active = on;
      if (!on) void saveNow();
      showView();
    },
  };
}
