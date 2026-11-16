import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

async function boot() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  let version = "unknown";
  try {
    // Proves the frontend <-> Rust bridge works (Stage 0 "done" check).
    version = await invoke<string>("app_version");
  } catch {
    version = "browser preview (no Tauri)";
  }
  app.innerHTML = `
    <main class="note">
      <h1>Farrey</h1>
      <p>Stage 0 complete. Your sticker will live here.</p>
      <small>v${version}</small>
    </main>`;
}

boot();
