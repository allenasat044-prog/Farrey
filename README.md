# Farrey

A Stickies-style desktop note where **every sticker is a live Markdown file**.
Open a `README.md`, tick its checkboxes, edit it in place, and keep it floating on your desktop.
Works on macOS, Windows and Linux. Built with [Tauri](https://tauri.app).

<!--
Add screenshots here once you have them, for example:
![Farrey stickers](docs/screenshots/stickers.png)
-->

## Features

Every sticker has two modes. Switch with the **MD** button in the title bar (or Cmd/Ctrl+Shift+M). Each sticker remembers its own file for each mode.

- **Normal mode (default):** a regular rich-text note. Just type. Bold, italic, underline, strikethrough, bullet and numbered lists, a heading, and a font and size picker. Saved as a small `.html` file in `Documents/Farrey`.
- **README mode:** every sticker is a live Markdown file. GitHub-style rendering with code highlighting, an edit/preview toggle (Cmd/Ctrl+E), clickable checkboxes that write back to the file, and live reload when another program changes it.
- **Stickies-style windows:** frameless notes in six colors, adjustable opacity, float-on-top, and window shade (double-click the title bar).
- **You own your notes:** plain files, never a hidden database. Closing a sticker never deletes its file.
- **Many stickers**, each remembering its mode, file, color, size and position across restarts.
- **Find in note**, a tray / menu bar icon, and single-instance handling.
- **Global hotkeys**, **start at login**, **Open With** for Markdown files, and a **command line**. See below.

## Install

Download the installer for your system from the [latest release](https://github.com/allenasat044-prog/Farrey/releases/latest).

| System                   | File                                                         |
| ------------------------ | ------------------------------------------------------------ |
| macOS (Apple Silicon)    | `Farrey_x.y.z_aarch64.dmg`                                   |
| macOS (Intel)            | `Farrey_x.y.z_x64.dmg`                                       |
| Windows                  | `Farrey_x.y.z_x64-setup.exe` or `Farrey_x.y.z_x64_en-US.msi` |
| Linux (any distro)       | `Farrey_x.y.z_amd64.AppImage`                                |
| Linux (Debian, Ubuntu)   | `Farrey_x.y.z_amd64.deb`                                     |
| Linux (Fedora, openSUSE) | `Farrey-x.y.z-1.x86_64.rpm`                                  |

Farrey's builds are **not code-signed yet**, so your system will warn you the first time.

### macOS

1. Open the `.dmg` and drag Farrey to Applications.
2. The first time, right-click Farrey and choose **Open**, then confirm. If macOS still refuses, run:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Farrey.app
   ```
3. On first launch macOS may ask for access to your Documents folder. New notes are created in `~/Documents/Farrey`.

### Windows

Run the installer. If SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.

### Linux

- **AppImage:** `chmod +x Farrey_*.AppImage` and run it.
- **deb:** `sudo apt install ./Farrey_*.deb`
- The tray icon needs `libayatana-appindicator3` (installed automatically with the `.deb`). On GNOME you also need the "AppIndicator and KStatusNotifierItem Support" extension to see it.

**Troubleshooting on Linux**

- Blank or glitchy window: try `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./Farrey_*.AppImage`.
- Transparency or always-on-top misbehaving on Wayland: try `GDK_BACKEND=x11 ./Farrey_*.AppImage`.

## Using Farrey

| Shortcut (Cmd on macOS, Ctrl elsewhere) | Action                                         |
| --------------------------------------- | ---------------------------------------------- |
| Cmd/Ctrl+N                              | New sticker (normal note)                      |
| Cmd/Ctrl+Shift+M                        | Switch between normal and README mode          |
| Cmd/Ctrl+B / I / U                      | Bold / italic / underline (normal mode)        |
| Cmd/Ctrl+O                              | Open a Markdown file (switches to README mode) |
| Cmd/Ctrl+E                              | Toggle edit / preview (README mode)            |
| Cmd/Ctrl+F                              | Find in note                                   |
| Cmd/Ctrl+Shift+P                        | Toggle float on top                            |
| Cmd/Ctrl+W                              | Close this sticker (its file is kept)          |

Dropping a `.md` file onto any sticker switches it to README mode and opens the file.

New notes live in `Documents/Farrey`. Layout and preferences are stored in `state.json` in your app-data folder (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## Hotkeys, start at login, Open With and the command line

**Global hotkeys** work from any app:

| Default              | Action                    |
| -------------------- | ------------------------- |
| Cmd/Ctrl+Alt+Shift+F | Show or hide all stickers |
| Cmd/Ctrl+Alt+Shift+N | New sticker from anywhere |

To change or turn them off, edit `settings.json` and restart Farrey. Set a hotkey to `""` to disable it, or use a name like `"CommandOrControl+Alt+K"`.

- macOS: `~/Library/Application Support/com.farrey.desktop/settings.json`
- Windows: `%APPDATA%\com.farrey.desktop\settings.json`
- Linux: `~/.local/share/com.farrey.desktop/settings.json`

If a hotkey does nothing, another app probably owns it: pick a different one. Global hotkeys do not work on Linux under Wayland (use an X11 session).

**Start at login:** tray / menu bar icon, then **Start at Login**. This is available in the installed app, not in a development build.

**Open With:** right-click any `.md` or `.markdown` file, choose Open With, then Farrey. It opens in a new README-mode sticker, or brings forward the sticker that already has it.

**Command line:** pass files or folders (a folder opens its README):

```bash
farrey README.md
farrey .
```

- macOS: `open -a Farrey README.md` (or run `/Applications/Farrey.app/Contents/MacOS/farrey .` for a folder).
- Windows: run the installed `Farrey.exe` with the file as an argument.
- Linux: `farrey README.md` after installing the `.deb`, or pass the path to the AppImage.

## Development

Prerequisites: Node.js 20+, [Rust](https://rustup.rs) (stable), and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev
```

Checks:

```bash
npm run typecheck
npm run format:check
npm run rust:fmt     # format Rust
npm run rust:lint    # clippy
```

Build installers locally: `npm run tauri build`.

Releases are built by GitHub Actions. See [docs/RELEASING.md](docs/RELEASING.md).

## License

MIT. See [LICENSE](LICENSE).
