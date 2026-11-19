/** Find in note (Cmd/Ctrl+F): highlights matches in the preview, selects them in the editor. */

export interface FindHost {
  preview: HTMLElement;
  editor: HTMLTextAreaElement;
  mode(): "preview" | "edit";
  hasNote(): boolean;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const bar = el("findbar");
const input = el<HTMLInputElement>("find-input");
const countEl = el("find-count");

let host: FindHost;
let hits: HTMLElement[] = []; // preview mode: <mark> elements
let offsets: number[] = []; // edit mode: start offset of each match
let current = -1;
let query = "";

function total(): number {
  return host.mode() === "preview" ? hits.length : offsets.length;
}

function updateCount() {
  if (!query) {
    countEl.textContent = "";
  } else if (total() === 0) {
    countEl.textContent = "None";
  } else {
    countEl.textContent = `${current + 1}/${total()}`;
  }
}

/* ---------- preview mode ---------- */
function clearMarks() {
  host.preview.querySelectorAll("mark.find-hit").forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent ?? ""));
  });
  host.preview.normalize();
  hits = [];
}

function highlight(q: string) {
  const lower = q.toLowerCase();
  const walker = document.createTreeWalker(host.preview, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue && n.nodeValue.toLowerCase().includes(lower)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const lowered = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let last = 0;
    let idx = lowered.indexOf(lower);
    while (idx !== -1) {
      if (idx > last) frag.append(text.slice(last, idx));
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.append(mark);
      hits.push(mark);
      last = idx + q.length;
      idx = lowered.indexOf(lower, last);
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/* ---------- edit mode ---------- */
function scrollEditorTo(pos: number) {
  const editor = host.editor;
  const cs = getComputedStyle(editor);
  const mirror = document.createElement("div");
  for (const prop of [
    "font-family",
    "font-size",
    "line-height",
    "letter-spacing",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "box-sizing",
    "tab-size",
  ]) {
    mirror.style.setProperty(prop, cs.getPropertyValue(prop));
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.width = `${editor.clientWidth}px`;
  mirror.textContent = editor.value.slice(0, pos);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  editor.scrollTop = Math.max(0, top - editor.clientHeight / 2);
}

function collectOffsets(q: string) {
  const text = host.editor.value.toLowerCase();
  const lower = q.toLowerCase();
  let idx = text.indexOf(lower);
  while (idx !== -1) {
    offsets.push(idx);
    idx = text.indexOf(lower, idx + Math.max(1, lower.length));
  }
}

/* ---------- shared ---------- */
function reveal() {
  if (current < 0) return;
  if (host.mode() === "preview") {
    hits.forEach((m, i) => m.classList.toggle("current", i === current));
    hits[current]?.scrollIntoView({ block: "center", inline: "nearest" });
  } else {
    const start = offsets[current];
    const editor = host.editor;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(start, start + query.length);
    scrollEditorTo(start);
    // Keep typing in the find box.
    input.focus({ preventScroll: true });
  }
}

function runSearch(showMatch: boolean) {
  query = input.value;
  clearMarks();
  offsets = [];
  if (!query) {
    current = -1;
    updateCount();
    return;
  }
  if (host.mode() === "preview") highlight(query);
  else collectOffsets(query);

  const n = total();
  if (n === 0) current = -1;
  else if (showMatch) current = 0;
  else current = Math.min(Math.max(current, 0), n - 1);
  updateCount();
  if (showMatch) reveal();
  else if (host.mode() === "preview" && current >= 0) {
    hits.forEach((m, i) => m.classList.toggle("current", i === current));
  }
}

function step(delta: number) {
  const n = total();
  if (n === 0) return;
  current = (current + delta + n) % n;
  updateCount();
  reveal();
}

function open() {
  if (!host.hasNote()) return;
  let selected = "";
  if (host.mode() === "edit") {
    const e = host.editor;
    selected = e.value.slice(e.selectionStart, e.selectionEnd);
  } else {
    selected = window.getSelection()?.toString() ?? "";
  }
  if (selected && !selected.includes("\n") && selected.length <= 80)
    input.value = selected;
  bar.hidden = false;
  input.focus();
  input.select();
  runSearch(true);
}

function close() {
  bar.hidden = true;
  clearMarks();
  offsets = [];
  current = -1;
  query = "";
  countEl.textContent = "";
  if (host.mode() === "edit") host.editor.focus({ preventScroll: true });
}

/** Call after the preview is re-rendered or the editor text changes. */
export function refreshFind() {
  if (!bar.hidden) runSearch(false);
}

export function initFind(h: FindHost) {
  host = h;

  input.addEventListener("input", () => runSearch(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  el("find-next").addEventListener("click", () => step(1));
  el("find-prev").addEventListener("click", () => step(-1));
  el("find-close").addEventListener("click", close);

  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "f") {
      e.preventDefault();
      open();
    } else if (key === "g" && !bar.hidden) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });
}
