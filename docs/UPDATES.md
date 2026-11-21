# Auto-update

Farrey can update itself. It checks the latest published GitHub release, verifies the download against a signature, asks you, then installs and restarts.

- **Automatic check:** about 20 seconds after launch, once per launch. Silent unless a new version exists. Turn it off with `"autoCheckUpdates": false` in `settings.json`.
- **Manual check:** tray / menu bar icon, then **Check for Updates…**.
- **Not in development builds:** `tauri dev` never checks automatically.

Updates are **off until you complete the setup below**. Until then, "Check for Updates…" says updates are not set up, and nothing else changes.

## One-time setup

**1. Apply the Stage 8 files** (once):

```bash
node scripts/apply-stage8.mjs
npm run rust:fmt
npm run tauri dev
```

The tray menu should now have **Check for Updates…**. Clicking it says updates are not set up. That is correct for now.

**2. Create your signing key.** Updates are verified with a key pair. The private key signs releases, and the public key is built into the app.

```bash
npx tauri signer generate -w ~/.tauri/farrey.key
```

Choose a password. This creates `~/.tauri/farrey.key` (private) and `~/.tauri/farrey.key.pub` (public).

> **Keep the private key and its password safe, in a password manager.** If you lose them, installed copies can never update again and people must reinstall by hand. Never commit or share the private key. The repo's `.gitignore` blocks `*.key` as a safety net.

**3. Turn updates on.** This stores only the **public** key in the project:

```bash
npm run updater:enable -- ~/.tauri/farrey.key.pub
```

The script refuses a private key if you pass one by mistake.

**4. Give GitHub the private key** so it can sign releases. In the repo: Settings → Secrets and variables → Actions → New repository secret. Add two:

| Name                                 | Value                                                |
| ------------------------------------ | ---------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | the full contents of `~/.tauri/farrey.key`           |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you chose                               |

On macOS, `pbcopy < ~/.tauri/farrey.key` copies the key to your clipboard.

## Releasing an update

Follow [RELEASING.md](RELEASING.md). Because signing is now on, each release also attaches signed update files and a `latest.json`.

1. `npm run version:set -- 0.3.0`, update `CHANGELOG.md`, commit and push.
2. Tag and push: `git tag v0.3.0` then `git push origin v0.3.0`.
3. When the build is green, open the draft release and check it contains `latest.json` and `.sig` files next to the installers.
4. **Publish the release.** Farrey reads `latest.json` from the latest _published_ release, so a draft is invisible to it.

**The first update-capable release is the only one people must install by hand.** Versions released before updates existed (0.2.x) have no updater.

## What users get

| Platform | Update behaviour                                                            |
| -------- | --------------------------------------------------------------------------- |
| macOS    | Downloads, replaces the app, restarts                                       |
| Windows  | Downloads and runs the installer; Farrey closes and the installer relaunches |
| Linux    | AppImage updates itself. A `.deb` or `.rpm` install must be updated by reinstalling the package |

## Testing it

Install 0.3.0 from the release. Then publish 0.3.1 and, in the installed 0.3.0, choose **Check for Updates…**. You should be offered 0.3.1.

## Troubleshooting

- **"Updates are not set up in this build":** the public key is empty. Run step 3, rebuild.
- **The release build fails with "A public key has been found, but no private key":** the two GitHub secrets are missing or misnamed (step 4).
- **"signature" or "verification" errors:** the private key in GitHub does not match the public key in `tauri.conf.json`. Re-run step 3 with the matching `.pub` file.
- **"Could not check for updates":** no published release has a `latest.json` yet (is the release still a draft?), or there is no network.
