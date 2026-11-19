# Releasing Farrey

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when you push a tag that starts with `v`.

## One-time setup

1. In the GitHub repo go to **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**. The release job needs it to attach files.
2. Make sure `package-lock.json` and `src-tauri/Cargo.lock` are committed (the workflows use `npm ci`).
3. Run `npm run rust:fmt` once and commit the result, so the CI formatting check passes.

## Try the build first (no release)

**Actions → Release → Run workflow.** It builds all platforms and keeps the installers as downloadable artifacts, without creating a release. Do this before your first tag: it is the first time the app is compiled on Windows and Linux.

## Cutting a release

1. Update `CHANGELOG.md`.
2. Set the version everywhere: `npm run version:set -- 0.1.1`.
3. Build once locally (`npm run tauri dev`) so `Cargo.lock` picks up the new version, then commit everything.
4. Tag it: the tag must match the version, with a leading `v` (for example `v0.1.1`). Push the commit and the tag.
5. Watch **Actions → Release**. When all four jobs are green, open **Releases**: a **draft** appears with every installer attached.
6. Test the installers (checklist below), edit the notes if you like, and click **Publish release**.

## Signing (optional, later)

Unsigned builds work but show security warnings.

- **macOS:** needs an Apple Developer account. Add these repository secrets: `APPLE_CERTIFICATE` (base64 of the .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`. Then, in `.github/workflows/release.yml`, add them to the `env:` block of the "Build and publish release" step, next to `GITHUB_TOKEN`:
  ```yaml
  APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
  APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
  APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  ```
  Only add them once all six secrets exist: an empty value makes the build fail. Also remove `"signingIdentity": "-"` from `src-tauri/tauri.conf.json`, which currently forces ad-hoc signing.
- **Windows:** needs a code-signing certificate. See the Tauri guide: https://tauri.app/distribute/sign/windows/

## Per-OS test checklist

Run this on a real install, not just `tauri dev`.

- [ ] Launches; the Welcome sticker appears and its checkbox ticks and saves.
- [ ] Move, resize, shade, color, opacity and pin all work.
- [ ] Quit and relaunch: stickers come back in the same place.
- [ ] Tray / menu bar icon works (New, Show All, Hide All, Quit).
- [ ] Drag a `.md` onto a sticker; edit it in another editor and watch it reload.
- [ ] Launching a second copy brings the existing stickers forward.

**macOS:** first launch works after right-click → Open; Documents access prompt appears once.
**Windows:** SmartScreen "Run anyway" works; the tray icon shows in the overflow area; resize from the edges works.
**Linux:** transparency works; if not, note the desktop and session type (X11 or Wayland) and try the variables in the README.
