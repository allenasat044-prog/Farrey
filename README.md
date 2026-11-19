# Farrey

A Stickies-style desktop note where **every sticker is a live Markdown file**.
Open a `README.md`, tick its checkboxes, edit it in place, and keep it floating on your desktop.
Works on macOS, Windows and Linux. Built with [Tauri](https://tauri.app).

<!--
Add screenshots here once you have them, for example:
![Farrey stickers](docs/screenshots/stickers.png)
-->

## Features

- **Stickies-style notes:** frameless windows in six colors, adjustable opacity, float-on-top, and window shade (double-click the title bar).
- **Real Markdown files:** every sticker is a plain `.md` file you own. Closing a sticker never deletes its file.
- **README viewer and editor:** GitHub-style rendering with code highlighting, an edit/preview toggle, and auto-save.
- **Clickable checkboxes:** tick a `- [ ]` item in the preview and the file on disk is updated.
- **Live reload:** edit the file in another editor and the sticker updates within a second.
- **Many stickers:** each remembers its file, color, size and position across restarts.
- **Find in note**, a tray / menu bar icon, and single-instance handling.

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

| Shortcut (Cmd on macOS, Ctrl elsewhere) | Action                                                |
| --------------------------------------- | ----------------------------------------------------- |
| Cmd/Ctrl+N                              | New sticker                                           |
| Cmd/Ctrl+O                              | Open a file in this sticker (or drag a `.md` onto it) |
| Cmd/Ctrl+E                              | Toggle edit / preview                                 |
| Cmd/Ctrl+F                              | Find in note                                          |
| Cmd/Ctrl+Shift+P                        | Toggle float on top                                   |
| Cmd/Ctrl+W                              | Close this sticker (its file is kept)                 |

New notes live in `Documents/Farrey`. Layout and preferences are stored in `state.json` in your app-data folder (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

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
