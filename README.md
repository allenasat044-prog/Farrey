
<p align="center">
  <img src="https://raw.githubusercontent.com/allenasat044-prog/assets/main/gifs/rrr.gif" width="100%" height="250" alt="Banner">
</p>

# Farrey

A Stickies-style desktop note where every sticker is a live `README.md`.
Windows, macOS and Linux, built with [Tauri](https://tauri.app).

> Status: Stage 0 (project scaffold). See `docs/ARCHITECTURE.md`.

## Prerequisites

- Node.js 20+
- Rust (stable): https://rustup.rs
- Tauri system dependencies for your OS: https://tauri.app/start/prerequisites/

## Run

```bash
npm install
npm run tauri icon app-icon.png   # one-time: generates src-tauri/icons
npm run tauri dev
```

## Checks

```bash
npm run typecheck
npm run format:check
npm run rust:lint
```

## License

MIT
