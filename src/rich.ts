/** Normal mode: a plain rich-text note (bold, italic, lists, font and size), stored as an
 *  HTML fragment in its own file. */
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { clearHighlights } from "./find";
import { reportError, setPrefs, stickerId, type StickerState } from "./sticker";
import { onBeforeClose, setTitleText } from "./titlebar";

interface NoteData {
  content: string;
  mtime: number;
}

export interface RichApi {
  element: HTMLElement;
  setActive(on: boolean): void;
  flush(): Promise<void>;
}

const FONTS: Record<string, { label: string; css: string }> = {
  sans: {
    label: "Sans",
    css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  serif: { label: "Serif", css: 'Georgia, "Times New Roman", serif' },
  mono: {
    label: "Mono",
    css: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  hand: {
    label: "Handwriting",
    css: '"Marker Felt", "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
  },
};
const SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40];
const SAVE_DELAY_MS = 500;
const POLL_MS = 1000;

// Anything pasted or loaded is reduced to this small set of tags (no styles, links or scripts).
const PURIFY_TAGS = [
  "p",
  "div",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "blockquote",
  "span",
];

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function errText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: PURIFY_TAGS, ALLOWED_ATTR: [] });
}

export function initRich(state: StickerState): RichApi {
  const wrap = el("rich-wrap");
  const rich = el("rich");
  const bar = el("richbar");
  const fontSelect = el<HTMLSelectElement>("rich-font");
  const sizeLabel = el("rich-size");

  let path = state.noteFile;
  let lastMtime = 0;
  let dirty = false;
  let active = false;
  let polling = false;
  let saving: Promise<void> | null = null;
  let saveTimer: number | undefined;

  let fontFamily = FONTS[state.fontFamily] ? state.fontFamily : "sans";
  let fontSize = Math.min(72, Math.max(8, state.fontSize || 14));

  /* ---------- font and size (whole note) ---------- */
  for (const [key, f] of Object.entries(FONTS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = f.label;
    fontSelect.appendChild(opt);
  }

  function applyFont() {
    rich.style.setProperty("--rich-font", FONTS[fontFamily].css);
    rich.style.setProperty("--rich-size", `${fontSize}px`);
    fontSelect.value = fontFamily;
    sizeLabel.textContent = String(fontSize);
  }

  function changeSize(delta: number) {
    let nearest = 0;
    SIZES.forEach((s, i) => {
      if (Math.abs(s - fontSize) < Math.abs(SIZES[nearest] - fontSize)) nearest = i;
    });
    const next = Math.min(SIZES.length - 1, Math.max(0, nearest + delta));
    fontSize = SIZES[next];
    applyFont();
    setPrefs({ fontSize }).catch((err) => console.error("could not save font size", err));
  }

  fontSelect.addEventListener("change", () => {
    fontFamily = fontSelect.value;
    applyFont();
    setPrefs({ fontFamily }).catch((err) => console.error("could not save font", err));
    rich.focus();
  });
  el("rich-smaller").addEventListener("click", () => changeSize(-1));
  el("rich-bigger").addEventListener("click", () => changeSize(1));

  /* ---------- content ---------- */
  /** The note's HTML without find-highlights. */
  function getHtml(): string {
    const clone = rich.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("mark.find-hit").forEach((m) => {
      m.replaceWith(...Array.from(m.childNodes));
    });
    return clone.innerHTML;
  }

  function updateTitle() {
    if (!active) return;
    setTitleText(path ? `${dirty ? "• " : ""}${basename(path)}` : "New note");
  }

  async function load() {
    if (!path) return;
    try {
      const data = await invoke<NoteData>("read_note", { path });
      rich.innerHTML = sanitize(data.content);
      lastMtime = data.mtime;
    } catch (err) {
      reportError(`Could not open ${basename(path)}: ${errText(err)}`);
    }
  }

  /* ---------- saving ---------- */
  async function saveNow() {
    window.clearTimeout(saveTimer);
    if (!dirty) return;
    if (saving) {
      await saving;
      if (!dirty) return;
    }
    const html = getHtml();
    saving = (async () => {
      try {
        if (!path) path = await invoke<string>("ensure_note_file", { id: stickerId() });
        lastMtime = await invoke<number>("write_note", { path, content: html });
        if (getHtml() === html) dirty = false;
      } catch (err) {
        reportError(`Could not save: ${errText(err)}`);
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

  /* ---------- live reload ---------- */
  async function pollOnce() {
    if (polling || !active || !path || dirty || saving) return;
    polling = true;
    try {
      const mtime = await invoke<number>("note_mtime", { path });
      if (mtime !== lastMtime && !dirty) {
        const data = await invoke<NoteData>("read_note", { path });
        if (!dirty) {
          lastMtime = data.mtime;
          const clean = sanitize(data.content);
          if (clean !== getHtml()) rich.innerHTML = clean;
        }
      }
    } catch {
      /* file temporarily missing: try again next tick */
    } finally {
      polling = false;
    }
  }

  /* ---------- formatting commands ---------- */
  type Cmd =
    | "bold"
    | "italic"
    | "underline"
    | "strikeThrough"
    | "insertUnorderedList"
    | "insertOrderedList"
    | "heading"
    | "clear";

  function currentBlock(): string {
    return document.queryCommandValue("formatBlock").toLowerCase();
  }

  function run(cmd: Cmd) {
    rich.focus();
    if (cmd === "heading") {
      document.execCommand("formatBlock", false, currentBlock() === "h2" ? "p" : "h2");
    } else if (cmd === "clear") {
      document.execCommand("removeFormat");
      document.execCommand("formatBlock", false, "p");
    } else {
      document.execCommand(cmd);
    }
    scheduleSave();
    updateToolbar();
  }

  function updateToolbar() {
    if (!active) return;
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !rich.contains(sel.anchorNode)) return;
    const states: Array<[Cmd, boolean]> = [
      ["bold", document.queryCommandState("bold")],
      ["italic", document.queryCommandState("italic")],
      ["underline", document.queryCommandState("underline")],
      ["strikeThrough", document.queryCommandState("strikeThrough")],
      ["insertUnorderedList", document.queryCommandState("insertUnorderedList")],
      ["insertOrderedList", document.queryCommandState("insertOrderedList")],
      ["heading", currentBlock() === "h2"],
    ];
    for (const [cmd, on] of states) {
      bar.querySelector(`[data-cmd="${cmd}"]`)?.classList.toggle("on", on);
    }
  }

  bar.querySelectorAll<HTMLElement>("[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => run(btn.dataset.cmd as Cmd));
  });
  // Keep the text selection while clicking toolbar buttons (the font menu may take focus).
  bar.addEventListener("mousedown", (e) => {
    if (!(e.target as HTMLElement).closest("select")) e.preventDefault();
  });
  document.addEventListener("selectionchange", updateToolbar);

  /* ---------- editor events ---------- */
  try {
    document.execCommand("defaultParagraphSeparator", false, "p");
  } catch {
    /* not supported: Enter will make <div>s, which are fine */
  }

  rich.addEventListener("input", () => {
    // A cleared note can leave a lone <br>; reset it so the placeholder shows again.
    if (/^(<br>|<(p|div)><br><\/(p|div)>)$/.test(rich.innerHTML)) rich.innerHTML = "";
    scheduleSave();
  });

  rich.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    const map: Record<string, Cmd> = { b: "bold", i: "italic", u: "underline" };
    if (map[key]) {
      e.preventDefault();
      run(map[key]);
    }
  });

  // Always paste as plain text, so notes never pick up fonts and colors from other apps.
  rich.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, text);
  });

  // Clicking into the note clears find highlights, so they never interfere with typing.
  rich.addEventListener("focusin", () => clearHighlights());

  window.addEventListener("beforeunload", () => {
    if (dirty) void saveNow();
  });
  onBeforeClose(saveNow);
  window.setInterval(() => void pollOnce(), POLL_MS);

  applyFont();
  void load();

  return {
    element: rich,
    flush: saveNow,
    setActive(on: boolean) {
      active = on;
      wrap.hidden = !on;
      if (on) {
        updateTitle();
        rich.focus({ preventScroll: true });
      } else {
        void saveNow();
      }
    },
  };
}
