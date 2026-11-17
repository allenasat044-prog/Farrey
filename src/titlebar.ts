import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

const win = getCurrentWindow();

const BAR_HEIGHT = 32;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
const MIN_OPACITY = 0.35;

const COLORS = ["yellow", "blue", "green", "pink", "purple", "gray"] as const;
type NoteColor = (typeof COLORS)[number];

interface Prefs {
  color: NoteColor;
  opacity: number;
  pinned: boolean;
}

const PREFS_KEY = "farrey.prefs";
const DEFAULTS: Prefs = { color: "yellow", opacity: 1, pinned: false };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      color: COLORS.includes(p.color as NoteColor)
        ? (p.color as NoteColor)
        : DEFAULTS.color,
      opacity:
        typeof p.opacity === "number"
          ? Math.min(1, Math.max(MIN_OPACITY, p.opacity))
          : DEFAULTS.opacity,
      pinned: p.pinned === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}

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

/** Let other modules add buttons to the title bar (placed before the close button). */
export function addTitlebarButton(side: "left" | "right", el: HTMLElement) {
  const container = $(side === "left" ? "tb-left" : "tb-right");
  if (side === "right") {
    container.insertBefore(el, $("btn-close"));
  } else {
    container.appendChild(el);
  }
}

export function initTitlebar() {
  const root = $("app");
  const bar = $("titlebar");
  const pinBtn = $("btn-pin");
  const colorBtn = $("btn-color");
  const closeBtn = $("btn-close");
  const popover = $("popover");

  const prefs = loadPrefs();

  /* ---------- color, opacity, pin ---------- */
  function applyPrefs() {
    root.dataset.color = prefs.color;
    root.style.setProperty("--alpha", String(prefs.opacity));
    pinBtn.classList.toggle("on", prefs.pinned);
    pinBtn.setAttribute("aria-pressed", String(prefs.pinned));
  }

  async function applyPinned() {
    try {
      await win.setAlwaysOnTop(prefs.pinned);
    } catch (err) {
      console.error("setAlwaysOnTop failed", err);
    }
  }

  pinBtn.addEventListener("click", () => {
    prefs.pinned = !prefs.pinned;
    applyPrefs();
    savePrefs(prefs);
    void applyPinned();
  });

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
      savePrefs(prefs);
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
  slider.addEventListener("change", () => savePrefs(prefs));
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") popover.hidden = true;
  });

  /* ---------- close ---------- */
  closeBtn.addEventListener("click", () => {
    void win.close();
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
  let shaded = false;
  let expandedHeight = 0;

  async function toggleShade() {
    try {
      const scale = await win.scaleFactor();
      const size = (await win.innerSize()).toLogical(scale);
      if (!shaded) {
        expandedHeight = size.height;
        shaded = true;
        root.classList.add("shaded");
        await win.setResizable(false);
        await win.setMinSize(new LogicalSize(MIN_WIDTH, BAR_HEIGHT));
        await win.setSize(new LogicalSize(size.width, BAR_HEIGHT));
      } else {
        shaded = false;
        root.classList.remove("shaded");
        await win.setMinSize(new LogicalSize(MIN_WIDTH, MIN_HEIGHT));
        await win.setSize(
          new LogicalSize(size.width, Math.max(expandedHeight, MIN_HEIGHT)),
        );
        await win.setResizable(true);
      }
    } catch (err) {
      console.error("window shade failed", err);
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
  void applyPinned();
}
