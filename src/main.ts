import "./styles.css";
import { closeFind, initFind } from "./find";
import { initNote } from "./note";
import { initRich } from "./rich";
import { loadSticker, setPrefs } from "./sticker";
import { bindModeButton, initTitlebar, setModeButton, type Mode } from "./titlebar";

async function main() {
  const state = await loadSticker();
  initTitlebar(state);

  let mode: Mode = state.mode === "readme" ? "readme" : "normal";

  async function switchMode(next: Mode) {
    if (next === mode) return;
    closeFind();
    await (mode === "readme" ? readme.flush() : rich.flush());
    mode = next;
    setModeButton(mode);
    readme.setActive(mode === "readme");
    rich.setActive(mode === "normal");
    setPrefs({ mode }).catch((err) => console.error("could not save mode", err));
  }

  const readme = await initNote(state, { switchToReadme: () => switchMode("readme") });
  const rich = initRich(state);

  initFind({
    preview: readme.preview,
    editor: readme.editor,
    rich: rich.element,
    mode: () => (mode === "normal" ? "rich" : readme.mode()),
    hasNote: () => mode === "normal" || readme.hasNote(),
  });

  bindModeButton(() => void switchMode(mode === "readme" ? "normal" : "readme"));
  setModeButton(mode);
  readme.setActive(mode === "readme");
  rich.setActive(mode === "normal");
}

void main();
