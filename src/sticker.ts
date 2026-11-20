import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Per-sticker state, stored by the Rust side in state.json. */
export interface StickerState {
  id: string;
  file: string | null;
  color: string;
  opacity: number;
  pinned: boolean;
  shaded: boolean;
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  /** "normal" = rich-text note, "readme" = Markdown file. */
  mode: "normal" | "readme";
  /** File behind the sticker in normal mode (`file` is the README-mode file). */
  noteFile: string | null;
  fontFamily: string;
  fontSize: number;
}

export interface PrefsPatch {
  color?: string;
  opacity?: number;
  pinned?: boolean;
  shaded?: boolean;
  mode?: "normal" | "readme";
  fontFamily?: string;
  fontSize?: number;
}

/** Each sticker window is labelled "sticker-<id>". */
export function stickerId(): string {
  const label = getCurrentWindow().label;
  return label.startsWith("sticker-") ? label.slice("sticker-".length) : label;
}

export function loadSticker(): Promise<StickerState> {
  return invoke<StickerState>("get_sticker", { id: stickerId() });
}

export function setPrefs(prefs: PrefsPatch): Promise<void> {
  return invoke<void>("set_prefs", { id: stickerId(), prefs });
}

/** Show an error in the sticker's toast (listened to in note.ts). */
export function reportError(message: string) {
  window.dispatchEvent(new CustomEvent("farrey:error", { detail: message }));
}
