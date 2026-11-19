import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { reportError, setPrefs, stickerId, type StickerState } from "./sticker";

const win = getCurrentWindow();

const BAR_HEIGHT = 32;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
const MIN_OPACITY = 0.35;

const COLORS = ["yellow", "blue", "green", "pink", "purple", "gray"] as const;
type NoteColor = (typeof COLORS)[number];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

const isMac = navigator.userAgent.includes("Mac");

/** Set the text shown in the title bar (and the OS window title). */
export function setTitleText(text: string) {
  $("tb-title").textContent = text;
  win.setTitle(text).catch(() => {});
}

/** Let other modules add buttons to the title bar (right-side buttons go before close). */
export function addTitlebarButton(side: "left" | "right", el: HTMLElement) {
  const container = $(side === "left" ? "tb-left" : "tb-right");
  if (side === "right") {
    container.insertBefore(el, $("btn-close"));
  } else {
    container.appendChild(el);
  }
}

const beforeCloseHooks: Array<() => Promise<void>> = [];

/** Register work (e.g. saving) that must finish before this sticker closes. */
export function onBeforeClose(fn: () => Promise<void>) {
  beforeCloseHooks.push(fn);
}

function errorMessage(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

function newSticker() {
  invoke("new_sticker", { fromId: stickerId() }).catch((err) =>
    reportError(`Could not create a sticker: ${errorMessage(err)}`),
  );
}

export function initTitlebar(state: StickerState) {
  const root = $("app");
  const bar = $("titlebar");
  const pinBtn = $("btn-pin");
  const colorBtn = $("btn-color");
  const closeBtn = $("btn-close");
  const newBtn = $("btn-new");
  const popover = $("popover");

  const prefs = {
    color: (COLORS.includes(state.color as NoteColor)
      ? state.color
      : "yellow") as NoteColor,
    opacity: Math.min(1, Math.max(MIN_OPACITY, state.opacity)),
    pinned: state.pinned,
  };

  function persist(patch: Parameters<typeof setPrefs>[0]) {
    setPrefs(patch).catch((err) => console.error("Could not save sticker settings", err));
  }

  /* ---------- color, opacity, pin ---------- */
  function applyPrefs() {
    root.dataset.color = prefs.color;
    root.style.setProperty("--alpha", String(prefs.opacity));
    pinBtn.classList.toggle("on", prefs.pinned);
    pinBtn.setAttribute("aria-pressed", String(prefs.pinned));
  }

  pinBtn.addEventListener("click", () => {
    prefs.pinned = !prefs.pinned;
    applyPrefs();
    persist({ pinned: prefs.pinned });
    win
      .setAlwaysOnTop(prefs.pinned)
      .catch((err) => console.error("setAlwaysOnTop failed", err));
  });

  newBtn.addEventListener("click", newSticker);

  /* ---------- palette popover ---------- */
  const swatches = document.createElement("div");
  swatches.className = "swatches";
  for (const color of COLORS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.dataset.color = color;
    b.title = color;
    b.setAttribute("aria-label", `${color} note`);
    b.addEventListener("click", () => {
      prefs.color = color;
      applyPrefs();
      persist({ color });
    });
    swatches.appendChild(b);
  }

  const opacityLabel = document.createElement("label");
  opacityLabel.className = "opacity";
  const opacityText = document.createElement("span");
  opacityText.textContent = "Opacity";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(Math.round(MIN_OPACITY * 100));
  slider.max = "100";
  slider.step = "1";
  slider.value = String(Math.round(prefs.opacity * 100));
  slider.addEventListener("input", () => {
    prefs.opacity = Number(slider.value) / 100;
    applyPrefs();
  });
  slider.addEventListener("change", () => persist({ opacity: prefs.opacity }));
  opacityLabel.append(opacityText, slider);
  popover.append(swatches, opacityLabel);

  colorBtn.addEventListener("click", () => {
    popover.hidden = !popover.hidden;
  });
  document.addEventListener("mousedown", (e) => {
    const t = e.target as Node;
    if (!popover.hidden && !popover.contains(t) && !colorBtn.contains(t)) {
      popover.hidden = true;
    }
  });

  /* ---------- close (removes the sticker, keeps its file) ---------- */
  async function closeSticker() {
    for (const hook of beforeCloseHooks) {
      try {
        await hook();
      } catch (err) {
        console.error("before-close hook failed", err);
      }
    }
    try {
      await invoke("close_sticker", { id: stickerId() });
    } catch (err) {
      reportError(`Could not close: ${errorMessage(err)}`);
    }
  }
  closeBtn.addEventListener("click", () => void closeSticker());

  // macOS: the menu's "Close Sticker" (Cmd+W) asks the focused window to close itself.
  getCurrentWebviewWindow()
    .listen("farrey-close", () => void closeSticker())
    .catch((err) => console.error("could not listen for close requests", err));

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") popover.hidden = true;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "n" && !e.shiftKey) {
      e.preventDefault();
      newSticker();
    } else if (key === "w" && !e.shiftKey) {
      e.preventDefault();
      void closeSticker();
    } else if (key === "p" && e.shiftKey) {
      e.preventDefault();
      pinBtn.click();
    }
  });

  /* ---------- drag to move (starts only after a small movement,
       so a double-click can still be detected for window shade) ---------- */
  let press: { x: number; y: number } | null = null;
  bar.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    press = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mousemove", (e) => {
    if (!press) return;
    if (e.buttons !== 1) {
      press = null;
      return;
    }
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 3) {
      press = null;
      void win.startDragging();
    }
  });
  window.addEventListener("mouseup", () => {
    press = null;
  });

  /* ---------- window shade ---------- */
  let shaded = state.shaded;
  let expandedHeight = state.height;
  let busy = false;
  if (shaded) root.classList.add("shaded");

  async function toggleShade() {
    if (busy) return;
    busy = true;
    try {
      const scale = await win.scaleFactor();
      const size = (await win.innerSize()).toLogical(scale);
      if (!shaded) {
        expandedHeight = size.height;
        shaded = true;
        root.classList.add("shaded");
        // Tell Rust first, so it stops recording the height while the window shrinks.
        await setPrefs({ shaded: true });
        await win.setResizable(false);
        await win.setMinSize(new LogicalSize(MIN_WIDTH, BAR_HEIGHT));
        await win.setSize(new LogicalSize(size.width, BAR_HEIGHT));
      } else {
        root.classList.remove("shaded");
        await win.setMinSize(new LogicalSize(MIN_WIDTH, MIN_HEIGHT));
        await win.setSize(
          new LogicalSize(size.width, Math.max(expandedHeight, MIN_HEIGHT)),
        );
        await win.setResizable(true);
        await setPrefs({ shaded: false });
        shaded = false;
      }
    } catch (err) {
      console.error("window shade failed", err);
    } finally {
      busy = false;
    }
  }

  bar.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    void toggleShade();
  });

  /* ---------- resize handles (Windows/Linux; macOS resizes natively) ---------- */
  type Dir =
    | "North"
    | "South"
    | "East"
    | "West"
    | "NorthEast"
    | "NorthWest"
    | "SouthEast"
    | "SouthWest";
  if (!isMac) {
    const handles: Array<[string, Dir]> = [
      ["n", "North"],
      ["s", "South"],
      ["e", "East"],
      ["w", "West"],
      ["ne", "NorthEast"],
      ["nw", "NorthWest"],
      ["se", "SouthEast"],
      ["sw", "SouthWest"],
    ];
    for (const [cls, dir] of handles) {
      const h = document.createElement("div");
      h.className = `rz rz-${cls}`;
      h.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        win.startResizeDragging(dir).catch(() => {});
      });
      root.appendChild(h);
    }
  }

  applyPrefs();
}
