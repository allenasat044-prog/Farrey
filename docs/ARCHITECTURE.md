# Farrey architecture (Stage 0 decisions)

## Storage

- Every sticker is backed by a plain `.md` file you choose. Farrey never hides your notes in a database.
- Default notes folder: `<Documents>/Farrey/`. Existing READMEs can be opened from anywhere.
- App state (open stickers, color, size, position, shade, file path) lives in one `state.json` in the OS app-data directory.
- Closing a sticker never deletes its file.

## Layout

- `src/` TypeScript frontend (Vite, no framework yet)
- `src-tauri/` Rust backend (windows, file I/O, watcher, tray)
- `docs/` design notes

## Planned multi-window model (Stage 3)

One Tauri window per sticker, labeled `sticker-<id>`. A Rust-side manager owns the list and persists it to `state.json`.

## Known risks

- Linux transparency and always-on-top vary by desktop and Wayland: test in Stage 1.
- File watcher + checkbox write-back can loop: ignore Farrey's own writes in Stage 2.
