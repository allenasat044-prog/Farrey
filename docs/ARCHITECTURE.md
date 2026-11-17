# Farrey architecture

## Storage

- Every sticker is backed by a plain `.md` file. Farrey never hides your notes in a database.
- New stickers create their file in `<Documents>/Farrey/` (`Note.md`, `Note 2.md`, ...). Existing READMEs can be opened from anywhere.
- Layout and preferences live in one `state.json` in the OS app-data directory:
  - macOS: `~/Library/Application Support/com.farrey.app/state.json`
  - Windows: `%APPDATA%\com.farrey.app\state.json`
  - Linux: `~/.local/share/com.farrey.app/state.json`
- `state.json` holds, per sticker: file path, color, opacity, float-on-top, shaded, size and position.
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

## Known risks

- Linux transparency and always-on-top vary by desktop and Wayland: test in Stage 4/5.
- File watcher + checkbox write-back can loop: Farrey ignores its own writes by comparing modification times.
