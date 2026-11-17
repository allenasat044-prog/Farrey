import "./styles.css";
import { loadSticker } from "./sticker";
import { initTitlebar } from "./titlebar";
import { initNote } from "./note";

async function main() {
  const state = await loadSticker();
  initTitlebar(state);
  await initNote(state);
}

void main();
