# Changelog

## 0.2.1

- Fixed: the open-file and edit buttons showed in normal mode (and the edit button with no README open). They are now hidden when they do not apply.
- The font menu is wide enough for "Handwriting", and normal notes show their name without `.html`.
- README screenshots; GitHub Actions updated to versions that run on Node 24.

## 0.2.0

- **Two sticker modes.** New stickers are normal rich-text notes: just type, with bold, italic, underline, strikethrough, lists, a heading, and a font and size picker. README mode keeps everything from 0.1.0. Switch with the new **MD** button or Cmd/Ctrl+Shift+M; each mode remembers its own file.
- Normal notes are saved as `.html` files in `Documents/Farrey`. The file is created on your first edit, so empty stickers leave nothing behind.
- Find in note works in normal notes too.
- Dropping a `.md` file onto a normal sticker switches it to README mode.
- Stickers saved by 0.1.0 stay in README mode.
- **Global hotkeys:** show/hide all stickers, and create a new sticker from anywhere. Configurable in `settings.json`.
- **Start at login** option in the tray / menu bar menu (installed app only).
- **Open With Farrey** for `.md` / `.markdown` files, and a command line: `farrey README.md`, `farrey .` (opens the folder's README).

## 0.1.0

First release.

- Frameless sticker windows with six colors, opacity, float-on-top and window shade.
- Open any `.md` / `.markdown` / `.txt` file as a sticker (file picker, drag and drop, or a new note).
- GitHub-style Markdown rendering with code highlighting.
- Edit/preview toggle with auto-save and clickable task-list checkboxes written back to the file.
- Live reload when the file changes in another program.
- Multiple stickers that remember their file, color, size and position across restarts.
- Find in note, tray / menu bar icon, keyboard shortcuts, and single-instance handling.
- Installers for macOS (Apple Silicon and Intel), Windows and Linux. Builds are not code-signed yet.
