# Farrey architecture

## Storage

- Every sticker is backed by plain files. Farrey never hides your notes in a database.
  - Normal mode: a small HTML fragment in `<Documents>/Farrey/` (`Note.html`, `Note 2.html`, ...), created on the first edit.
  - README mode: any `.md` / `.markdown` / `.mdx` / `.txt` file you open or create.
- Layout and preferences live in one `state.json` in the OS app-data directory:
  - macOS: `~/Library/Application Support/com.farrey.desktop/state.json`
  - Windows: `%APPDATA%\com.farrey.desktop\state.json`
  - Linux: `~/.local/share/com.farrey.desktop/state.json`
- `state.json` holds, per sticker: mode, README file, normal-note file, font, font size, color, opacity, float-on-top, shaded, size and position. Stickers saved before modes existed load as README stickers.
- Closing a sticker (the x button) removes it from `state.json` but never deletes its file.
  Quitting the app keeps every sticker, so they all come back on the next launch.

## Layout

- `src/` TypeScript frontend (Vite, no framework)
- `src-tauri/` Rust backend (windows, state, file I/O)
- `docs/` design notes

## Multi-sticker model (Stage 3)

- One Tauri window per sticker, labelled `sticker-<id>`. The same frontend runs in each window and finds its own state by label.
- Rust owns the state (`Mutex<Store>`): window move/resize events update it in memory, and a background thread writes it to disk about once a second (plus on exit).
- Window shade is stored as a flag; the saved `height` is always the expanded height.
- A file can only be open in one sticker at a time. Opening it again focuses the sticker that has it.
- Stickers saved on a monitor that is no longer connected are placed by the OS instead of off-screen.

## Modes (Stage 6)

- `mode` is `normal` or `readme`. Both frontend modules (`rich.ts`, `note.ts`) are always loaded; only the active one is visible and handles shortcuts. `main.ts` switches between them and saves the outgoing one first.
- Normal notes are `contenteditable` rich text. Pasted and loaded HTML is reduced to a small safe set of tags (no styles, links or scripts). Font and size apply to the whole note and are stored per sticker.
- Find highlights are removed from the saved HTML, and cleared when you click into the note.

## Settings, hotkeys and opening files (Stage 7)

- `settings.json` sits next to `state.json`. It is created with defaults on first launch and currently holds the two global hotkeys.
- Hotkeys are registered in Rust; only the ones that registered successfully are remembered, so a conflict with another app is logged and skipped.
- Files reach Farrey three ways, all ending in `open_readme_in_sticker`: macOS `RunEvent::Opened` (Open With / double-click), process arguments on a cold start, and the single-instance callback for later launches. A file that is already in a sticker is brought forward instead of opened twice.
- Start at Login uses the autostart plugin and is disabled in debug builds so a dev binary never becomes a login item.

## Known risks

- Linux transparency and always-on-top vary by desktop and Wayland: test in Stage 4/5.
- File watcher + checkbox write-back can loop: Farrey ignores its own writes by comparing modification times.
