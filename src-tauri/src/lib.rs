use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex, MutexGuard,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{
    GlobalShortcutExt as _, Shortcut, ShortcutEvent, ShortcutState,
};
use tauri_plugin_updater::UpdaterExt as _;

const DEFAULT_WIDTH: f64 = 360.0;
const DEFAULT_HEIGHT: f64 = 420.0;
const MIN_WIDTH: f64 = 240.0;
const MIN_HEIGHT: f64 = 120.0;
const BAR_HEIGHT: f64 = 32.0;
const CASCADE_OFFSET: f64 = 30.0;
const COLORS: [&str; 9] = [
    "yellow", "blue", "green", "pink", "purple", "gray", "charcoal", "midnight", "custom",
];
const MODES: [&str; 2] = ["normal", "readme"];
const FONTS: [&str; 4] = ["sans", "serif", "mono", "hand"];

const WELCOME_NOTE: &str = r#"<h2>Welcome to Farrey</h2><p>This is a <b>normal note</b>. Just start typing. Select some text and use the bar at the bottom for <b>bold</b>, <i>italic</i>, <u>underline</u>, lists and a heading. The font and size are set per note.</p><ul><li>Click <b>+</b> (or press Cmd/Ctrl+N) for another sticker.</li><li>Click <b>MD</b> in the title bar for README mode: open any Markdown file, tick its checkboxes, and edit it with Cmd/Ctrl+E.</li><li>Double-click the title bar to shade the note.</li></ul><p>Closing a sticker never deletes its file.</p>"#;

/* ------------------------------------------------------------------ */
/* Persistent state                                                    */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Sticker {
    id: String,
    file: Option<String>,
    color: String,
    opacity: f64,
    pinned: bool,
    shaded: bool,
    /// Logical size. `height` is always the *expanded* height, even while shaded.
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    /// "normal" (rich-text note) or "readme" (Markdown file). Stickers saved by
    /// older versions have no mode: they were all README stickers.
    #[serde(default = "default_mode_for_saved")]
    mode: String,
    /// The file behind the sticker in normal mode (`file` is the README-mode file).
    #[serde(default)]
    note_file: Option<String>,
    #[serde(default = "default_font_family")]
    font_family: String,
    #[serde(default = "default_font_size")]
    font_size: f64,
    /// "#rrggbb", used when `color` is "custom".
    #[serde(default)]
    custom_color: Option<String>,
}

fn default_mode_for_saved() -> String {
    "readme".into()
}

fn default_font_family() -> String {
    "sans".into()
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn default_font_size() -> f64 {
    14.0
}

#[derive(Serialize, Deserialize, Default)]
struct StateFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    stickers: Vec<Sticker>,
}

struct Store {
    path: PathBuf,
    data: StateFile,
    dirty: bool,
}

impl Store {
    fn load(path: PathBuf) -> Self {
        let data = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<StateFile>(&text) {
                Ok(d) => d,
                Err(_) => {
                    // Corrupt file: keep a backup and start fresh.
                    let _ = fs::rename(&path, path.with_extension("json.bak"));
                    StateFile::default()
                }
            },
            Err(_) => StateFile::default(),
        };
        Store {
            path,
            data,
            dirty: false,
        }
    }

    fn flush(&mut self) {
        if !self.dirty {
            return;
        }
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        self.data.version = 1;
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let tmp = self.path.with_extension("json.tmp");
            if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, &self.path).is_ok() {
                self.dirty = false;
            }
        }
    }
}

type Shared = Mutex<Store>;

fn lock(shared: &Shared) -> MutexGuard<'_, Store> {
    shared.lock().unwrap_or_else(|e| e.into_inner())
}

fn with_sticker<F: FnOnce(&mut Sticker)>(app: &AppHandle, id: &str, f: F) {
    let shared = app.state::<Shared>();
    let mut store = lock(&shared);
    let mut changed = false;
    if let Some(s) = store.data.stickers.iter_mut().find(|s| s.id == id) {
        f(s);
        changed = true;
    }
    if changed {
        store.dirty = true;
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn new_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{ms:x}{n:x}")
}

fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .document_dir()
        .map(|d| d.join("Farrey"))
        .map_err(|e| e.to_string())
}

/// Creates `<base>.<ext>`, or `<base> 2.<ext>`, ... without overwriting anything.
fn create_note_file(dir: &Path, base: &str, ext: &str, content: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for n in 1..10_000u32 {
        let name = if n == 1 {
            format!("{base}.{ext}")
        } else {
            format!("{base} {n}.{ext}")
        };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Could not find a free file name".into())
}

fn blank_sticker(note_file: Option<String>) -> Sticker {
    Sticker {
        id: new_id(),
        file: None,
        color: "yellow".into(),
        opacity: 1.0,
        pinned: false,
        shaded: false,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        x: None,
        y: None,
        mode: "normal".into(),
        note_file,
        font_family: default_font_family(),
        font_size: default_font_size(),
        custom_color: None,
    }
}

/// True if a point near the sticker's title bar lies on a connected monitor,
/// so a sticker saved on a now-disconnected screen is not restored off-screen.
fn is_on_screen(app: &AppHandle, x: f64, y: f64) -> bool {
    let monitors = match app.available_monitors() {
        Ok(m) if !m.is_empty() => m,
        _ => return true,
    };
    let (px, py) = (x + 40.0, y + 10.0);
    monitors.iter().any(|m| {
        let s = m.scale_factor();
        let (mx, my) = (m.position().x as f64 / s, m.position().y as f64 / s);
        let (mw, mh) = (m.size().width as f64 / s, m.size().height as f64 / s);
        px >= mx && px < mx + mw && py >= my && py < my + mh
    })
}

fn attach_events(app: &AppHandle, win: &WebviewWindow, id: &str) {
    let app = app.clone();
    let w = win.clone();
    let id = id.to_string();
    win.on_window_event(move |event| match event {
        WindowEvent::Moved(pos) => {
            // Minimised windows report huge negative coordinates on Windows: ignore those.
            if pos.x < -10_000 || pos.y < -10_000 {
                return;
            }
            let scale = w.scale_factor().unwrap_or(1.0);
            let l = pos.to_logical::<f64>(scale);
            with_sticker(&app, &id, |s| {
                s.x = Some(l.x);
                s.y = Some(l.y);
            });
        }
        WindowEvent::Resized(size) => {
            if size.width == 0 || size.height == 0 {
                return;
            }
            let scale = w.scale_factor().unwrap_or(1.0);
            let l = size.to_logical::<f64>(scale);
            with_sticker(&app, &id, |s| {
                s.width = l.width;
                if !s.shaded {
                    s.height = l.height;
                }
            });
        }
        _ => {}
    });
}

fn build_window(app: &AppHandle, s: &Sticker) -> Result<WebviewWindow, String> {
    let label = format!("sticker-{}", s.id);
    if let Some(existing) = app.get_webview_window(&label) {
        return Ok(existing);
    }
    let height = if s.shaded {
        BAR_HEIGHT
    } else {
        s.height.max(MIN_HEIGHT)
    };
    let min_height = if s.shaded { BAR_HEIGHT } else { MIN_HEIGHT };

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Farrey")
        .inner_size(s.width.max(MIN_WIDTH), height)
        .min_inner_size(MIN_WIDTH, min_height)
        .decorations(false)
        .transparent(true)
        .resizable(!s.shaded)
        .maximizable(false)
        .always_on_top(s.pinned)
        .accept_first_mouse(true);

    if let (Some(x), Some(y)) = (s.x, s.y) {
        if is_on_screen(app, x, y) {
            builder = builder.position(x, y);
        }
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    attach_events(app, &win, &s.id);
    Ok(win)
}

/* ------------------------------------------------------------------ */
/* Note file commands (unchanged from Stage 2)                         */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
struct NoteData {
    content: String,
    /// Last-modified time in milliseconds since the Unix epoch.
    mtime: u64,
}

fn check_ext(path: &str) -> Result<(), String> {
    let ok = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "mdx" | "txt" | "html"
            )
        })
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("Only .md, .markdown, .mdx, .txt and .html files are supported".into())
    }
}

fn mtime_of(path: &str) -> Result<u64, String> {
    let modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(|e| e.to_string())?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn read_note(path: String) -> Result<NoteData, String> {
    check_ext(&path)?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(NoteData {
        content,
        mtime: mtime_of(&path)?,
    })
}

/// Writes the note and returns the new modification time, so the frontend
/// can tell its own saves apart from changes made by other programs.
#[tauri::command]
fn write_note(path: String, content: String) -> Result<u64, String> {
    check_ext(&path)?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    mtime_of(&path)
}

#[tauri::command]
fn note_mtime(path: String) -> Result<u64, String> {
    check_ext(&path)?;
    mtime_of(&path)
}

/* ------------------------------------------------------------------ */
/* Images and links inside README stickers                             */
/* ------------------------------------------------------------------ */

const IMAGE_EXTS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico",
];
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// The folder a README may reach into: the nearest parent that holds a `.git` folder
/// (so `../docs/shot.png` works in a repository), otherwise the README's own folder.
fn project_root(dir: &Path) -> PathBuf {
    let mut current = dir;
    for _ in 0..12 {
        if current.join(".git").exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => break,
        }
    }
    dir.to_path_buf()
}

fn has_url_scheme(s: &str) -> bool {
    match s.find(':') {
        // two or more letters before ':' means a scheme (http:, data:, file:); "C:" is a drive
        Some(i) if i >= 2 => s[..i]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.'),
        _ => false,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let high = (bytes[i + 1] as char).to_digit(16);
            let low = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (high, low) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Turns an image or link target written in a README into a real file path, refusing
/// anything that is not a local file inside the README's project folder.
fn resolve_in_project(readme: &str, target: &str) -> Result<PathBuf, String> {
    let readme_dir = Path::new(readme)
        .parent()
        .ok_or_else(|| "The README has no folder".to_string())?;
    let dir = fs::canonicalize(readme_dir).map_err(|e| e.to_string())?;
    let root = project_root(&dir);

    // Drop "#section" and "?query"; they are not part of the file name.
    let clean = target.split(['#', '?']).next().unwrap_or("");
    if clean.is_empty() {
        return Err("Empty path".into());
    }
    if clean.starts_with("//") || has_url_scheme(clean) {
        return Err("Not a local file".into());
    }
    let decoded = percent_decode(clean);
    let joined = match decoded.strip_prefix('/') {
        Some(from_root) => root.join(from_root),
        None => dir.join(&decoded),
    };
    let canonical = fs::canonicalize(&joined).map_err(|_| format!("File not found: {decoded}"))?;
    if !canonical.starts_with(&root) {
        return Err("That file is outside the README's project folder".into());
    }
    Ok(canonical)
}

/// Returns the bytes of an image that a README refers to with a relative path.
#[tauri::command]
fn read_image(readme: String, src: String) -> Result<tauri::ipc::Response, String> {
    let path = resolve_in_project(&readme, &src)?;
    let is_image = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()));
    if !is_image {
        return Err("Not an image file".into());
    }
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_IMAGE_BYTES {
        return Err("Image is larger than 20 MB".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Opens a Markdown file that a README links to (`[guide](docs/guide.md)`) in its own
/// sticker, or brings forward the sticker that already has it.
#[tauri::command]
async fn open_markdown_link(app: AppHandle, readme: String, href: String) -> Result<(), String> {
    let path = resolve_in_project(&readme, &href)?;
    if !path.is_file() || !is_readme_ext(&path) {
        return Err("Only Markdown files can be opened from links".into());
    }
    open_readme_in_sticker(&app, &path)
}

/* ------------------------------------------------------------------ */
/* Sticker commands                                                    */
/* ------------------------------------------------------------------ */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrefsPatch {
    color: Option<String>,
    opacity: Option<f64>,
    pinned: Option<bool>,
    shaded: Option<bool>,
    mode: Option<String>,
    font_family: Option<String>,
    font_size: Option<f64>,
    custom_color: Option<String>,
}

#[tauri::command]
fn get_sticker(id: String, store: State<'_, Shared>) -> Result<Sticker, String> {
    let guard = lock(&store);
    let found = guard.data.stickers.iter().find(|s| s.id == id).cloned();
    found.ok_or_else(|| format!("Unknown sticker {id}"))
}

#[tauri::command]
fn set_prefs(id: String, prefs: PrefsPatch, store: State<'_, Shared>) -> Result<(), String> {
    if let Some(c) = &prefs.color {
        if !COLORS.contains(&c.as_str()) {
            return Err(format!("Unknown color {c}"));
        }
    }
    if let Some(m) = &prefs.mode {
        if !MODES.contains(&m.as_str()) {
            return Err(format!("Unknown mode {m}"));
        }
    }
    if let Some(f) = &prefs.font_family {
        if !FONTS.contains(&f.as_str()) {
            return Err(format!("Unknown font {f}"));
        }
    }
    if let Some(c) = &prefs.custom_color {
        if !is_hex_color(c) {
            return Err(format!("Not a #rrggbb color: {c}"));
        }
    }
    let mut guard = lock(&store);
    let sticker = guard
        .data
        .stickers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Unknown sticker {id}"))?;
    if let Some(m) = prefs.mode {
        sticker.mode = m;
    }
    if let Some(f) = prefs.font_family {
        sticker.font_family = f;
    }
    if let Some(c) = prefs.custom_color {
        sticker.custom_color = Some(c);
    }
    if let Some(sz) = prefs.font_size {
        sticker.font_size = sz.clamp(8.0, 72.0);
    }
    if let Some(c) = prefs.color {
        sticker.color = c;
    }
    if let Some(o) = prefs.opacity {
        sticker.opacity = o.clamp(0.35, 1.0);
    }
    if let Some(p) = prefs.pinned {
        sticker.pinned = p;
    }
    if let Some(sh) = prefs.shaded {
        sticker.shaded = sh;
    }
    guard.dirty = true;
    Ok(())
}

/// Links a sticker to a file: `kind` is "readme" (the Markdown file) or "note" (the
/// normal-mode file). A file can only be open in one sticker at a time: if another
/// sticker already has it, that sticker is brought to the front instead.
#[tauri::command]
fn set_file(
    app: AppHandle,
    id: String,
    file: Option<String>,
    kind: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    if kind != "readme" && kind != "note" {
        return Err(format!("Unknown file kind {kind}"));
    }
    let mut guard = lock(&store);
    if let Some(f) = &file {
        let wanted = fs::canonicalize(f).unwrap_or_else(|_| PathBuf::from(f));
        let same = |candidate: &Option<String>| {
            candidate
                .as_ref()
                .is_some_and(|c| fs::canonicalize(c).unwrap_or_else(|_| PathBuf::from(c)) == wanted)
        };
        let other = guard
            .data
            .stickers
            .iter()
            .find(|s| s.id != id && (same(&s.file) || same(&s.note_file)));
        if let Some(other) = other {
            let label = format!("sticker-{}", other.id);
            drop(guard);
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            return Err("That file is already open in another sticker".into());
        }
    }
    let sticker = guard
        .data
        .stickers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Unknown sticker {id}"))?;
    if kind == "note" {
        sticker.note_file = file;
    } else {
        sticker.file = file;
    }
    guard.dirty = true;
    Ok(())
}

/// Normal-mode notes get their file lazily, on the first edit, so an untouched
/// sticker never leaves an empty file behind.
#[tauri::command]
fn ensure_note_file(
    app: AppHandle,
    id: String,
    store: State<'_, Shared>,
) -> Result<String, String> {
    let mut guard = lock(&store);
    let sticker = guard
        .data
        .stickers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Unknown sticker {id}"))?;
    if let Some(existing) = &sticker.note_file {
        return Ok(existing.clone());
    }
    let path = create_note_file(&notes_dir(&app)?, "Note", "html", "")?
        .to_string_lossy()
        .into_owned();
    sticker.note_file = Some(path.clone());
    guard.dirty = true;
    Ok(path)
}

/// Creates a new, empty normal-mode sticker. It copies the color, opacity and font of
/// `from_id` and opens slightly offset from it. Its file is created on the first edit.
fn create_sticker(app: &AppHandle, from_id: Option<&str>) -> Result<(), String> {
    let shared = app.state::<Shared>();
    let source = {
        let guard = lock(&shared);
        let found = from_id
            .and_then(|fid| guard.data.stickers.iter().find(|s| s.id == fid))
            .cloned();
        found
    };

    let mut sticker = blank_sticker(None);
    if let Some(src) = &source {
        sticker.color = src.color.clone();
        sticker.opacity = src.opacity;
        sticker.font_family = src.font_family.clone();
        sticker.font_size = src.font_size;
        sticker.custom_color = src.custom_color.clone();
        sticker.x = src.x.map(|v| v + CASCADE_OFFSET);
        sticker.y = src.y.map(|v| v + CASCADE_OFFSET);
    }

    {
        let mut guard = lock(&shared);
        guard.data.stickers.push(sticker.clone());
        guard.dirty = true;
    }
    let win = build_window(app, &sticker)?;
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
async fn new_sticker(app: AppHandle, from_id: String) -> Result<(), String> {
    create_sticker(&app, Some(&from_id))
}

/// Closes a sticker for good (its window and its saved layout). The note file is kept.
#[tauri::command]
async fn close_sticker(app: AppHandle, id: String, store: State<'_, Shared>) -> Result<(), String> {
    {
        let mut guard = lock(&store);
        guard.data.stickers.retain(|s| s.id != id);
        guard.dirty = true;
        guard.flush();
    }
    if let Some(w) = app.get_webview_window(&format!("sticker-{id}")) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Settings and global hotkeys                                         */
/* ------------------------------------------------------------------ */

/// `settings.json` in the app-data folder. It is created with these defaults on first
/// launch so it is easy to find and edit. An empty string turns a hotkey off.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// Show or hide every sticker.
    hotkey_toggle: String,
    /// Create a new sticker from anywhere.
    hotkey_new: String,
    /// Let clicks pass through every sticker, or give them back.
    hotkey_click_through: String,
    /// Look for a new version shortly after Farrey starts (installed builds only).
    auto_check_updates: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey_toggle: "CommandOrControl+Alt+Shift+F".into(),
            hotkey_new: "CommandOrControl+Alt+Shift+N".into(),
            hotkey_click_through: "CommandOrControl+Alt+Shift+T".into(),
            auto_check_updates: true,
        }
    }
}

fn load_settings(dir: &Path) -> Settings {
    let path = dir.join("settings.json");
    match fs::read_to_string(&path) {
        // A broken file falls back to the defaults but is left alone so it can be fixed.
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => {
            let defaults = Settings::default();
            let _ = fs::create_dir_all(dir);
            if let Ok(json) = serde_json::to_string_pretty(&defaults) {
                let _ = fs::write(&path, json);
            }
            defaults
        }
    }
}

/// The hotkeys that were registered successfully.
#[derive(Default)]
struct Hotkeys {
    toggle: Option<Shortcut>,
    new_sticker: Option<Shortcut>,
    click_through: Option<Shortcut>,
}

fn register_hotkey(app: &AppHandle, text: &str) -> Option<Shortcut> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let shortcut: Shortcut = match text.parse() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Invalid hotkey {text:?} in settings.json: {e:?}");
            return None;
        }
    };
    match app.global_shortcut().register(shortcut) {
        Ok(()) => Some(shortcut),
        Err(e) => {
            // Usually: another app already owns it, or Linux Wayland (no global hotkeys).
            eprintln!("Could not register hotkey {text:?}: {e:?}");
            None
        }
    }
}

fn setup_hotkeys(app: &AppHandle, settings: &Settings) {
    let hotkeys = Hotkeys {
        toggle: register_hotkey(app, &settings.hotkey_toggle),
        new_sticker: register_hotkey(app, &settings.hotkey_new),
        click_through: register_hotkey(app, &settings.hotkey_click_through),
    };
    app.manage(hotkeys);
}

fn on_hotkey(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    let Some(hotkeys) = app.try_state::<Hotkeys>() else {
        return;
    };
    if Some(*shortcut) == hotkeys.toggle {
        toggle_all(app);
    } else if Some(*shortcut) == hotkeys.new_sticker {
        spawn_new_sticker(app);
    } else if Some(*shortcut) == hotkeys.click_through {
        toggle_click_through_all(app);
    }
}

/// Hide every sticker if any is visible, otherwise show them (or make one if none exist).
fn toggle_all(app: &AppHandle) {
    let any_visible = sticker_windows(app)
        .iter()
        .any(|w| w.is_visible().unwrap_or(false));
    if any_visible {
        hide_all(app);
    } else {
        spawn_show_or_create(app);
    }
}

/* ------------------------------------------------------------------ */
/* Click-through ("ghost") stickers                                    */
/* ------------------------------------------------------------------ */

/// Ids of the stickers that currently let mouse clicks pass through them. This is never
/// saved: every launch starts with all stickers clickable, so nobody gets locked out.
#[derive(Default)]
struct GhostState(Mutex<HashSet<String>>);

fn sticker_id_of(window: &WebviewWindow) -> Option<String> {
    window
        .label()
        .strip_prefix("sticker-")
        .map(|id| id.to_string())
}

/// The stickers that are click-through right now (closed stickers are dropped).
fn ghost_ids(app: &AppHandle) -> Vec<String> {
    let state = app.state::<GhostState>();
    let mut set = state.0.lock().unwrap_or_else(|e| e.into_inner());
    set.retain(|id| app.get_webview_window(&format!("sticker-{id}")).is_some());
    let ids: Vec<String> = set.iter().cloned().collect();
    ids
}

fn set_ghost(app: &AppHandle, id: &str, on: bool) -> Result<(), String> {
    let label = format!("sticker-{id}");
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Unknown sticker {id}"))?;
    window
        .set_ignore_cursor_events(on)
        .map_err(|e| e.to_string())?;
    {
        let state = app.state::<GhostState>();
        let mut set = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if on {
            set.insert(id.to_string());
        } else {
            set.remove(id);
        }
    }
    // Lets the sticker show that it is a ghost.
    let _ = app.emit_to(label.as_str(), "farrey-ghost", on);
    Ok(())
}

fn make_all_clickable(app: &AppHandle) {
    for id in ghost_ids(app) {
        let _ = set_ghost(app, &id, false);
    }
}

fn make_all_ghosts(app: &AppHandle) {
    for window in sticker_windows(app) {
        if let Some(id) = sticker_id_of(&window) {
            let _ = set_ghost(app, &id, true);
        }
    }
}

/// Hotkey and tray menu: if any sticker is click-through, give every sticker back its
/// clicks; otherwise make all of them click-through.
fn toggle_click_through_all(app: &AppHandle) {
    if ghost_ids(app).is_empty() {
        make_all_ghosts(app);
    } else {
        make_all_clickable(app);
    }
}

#[tauri::command]
fn set_click_through(app: AppHandle, id: String, on: bool) -> Result<(), String> {
    set_ghost(&app, &id, on)
}

/* ------------------------------------------------------------------ */
/* Opening files: "Open with Farrey" and the command line              */
/* ------------------------------------------------------------------ */

fn is_readme_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "mdx" | "txt"
            )
        })
        .unwrap_or(false)
}

/// Finds `README.md` (any capitalisation) in a folder; other README formats as a fallback.
fn find_readme_in_dir(dir: &Path) -> Option<PathBuf> {
    let mut fallback: Option<PathBuf> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if !p.is_file() || !is_readme_ext(&p) {
            continue;
        }
        let Some(stem) = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
        else {
            continue;
        };
        if stem != "readme" {
            continue;
        }
        let is_md = p
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"));
        if is_md {
            return Some(p);
        }
        if fallback.is_none() {
            fallback = Some(p);
        }
    }
    fallback
}

/// A command-line argument can be a Markdown file or a folder (we then use its README).
fn resolve_readme_arg(arg: &str, cwd: &Path) -> Option<PathBuf> {
    if arg.is_empty() || arg.starts_with('-') {
        return None;
    }
    let given = Path::new(arg);
    let full = if given.is_absolute() {
        given.to_path_buf()
    } else {
        cwd.join(given)
    };
    if full.is_dir() {
        find_readme_in_dir(&full)
    } else if full.is_file() && is_readme_ext(&full) {
        Some(full)
    } else {
        None
    }
}

/// `args[0]` is the program itself, so it is skipped.
fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter_map(|a| resolve_readme_arg(a, cwd))
        .collect()
}

fn same_file(candidate: &Option<String>, wanted: &Path) -> bool {
    candidate.as_ref().is_some_and(|c| {
        fs::canonicalize(c)
            .unwrap_or_else(|_| PathBuf::from(c))
            .as_path()
            == wanted
    })
}

/// Opens a Markdown file in a new README-mode sticker, or brings forward the sticker
/// that already has it.
fn open_readme_in_sticker(app: &AppHandle, path: &Path) -> Result<(), String> {
    let wanted = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let shared = app.state::<Shared>();

    let existing = {
        let guard = lock(&shared);
        let found = guard
            .data
            .stickers
            .iter()
            .find(|s| same_file(&s.file, &wanted) || same_file(&s.note_file, &wanted))
            .map(|s| s.id.clone());
        found
    };
    if let Some(id) = existing {
        if let Some(w) = app.get_webview_window(&format!("sticker-{id}")) {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            return Ok(());
        }
    }

    let mut sticker = blank_sticker(None);
    sticker.mode = "readme".into();
    sticker.file = Some(path.to_string_lossy().into_owned());
    {
        let mut guard = lock(&shared);
        guard.data.stickers.push(sticker.clone());
        guard.dirty = true;
    }
    let win = build_window(app, &sticker)?;
    let _ = win.set_focus();
    Ok(())
}

fn open_paths(app: &AppHandle, paths: &[PathBuf]) {
    for p in paths {
        if let Err(e) = open_readme_in_sticker(app, p) {
            eprintln!("Could not open {}: {e}", p.display());
        }
    }
}

/// A second launch of the app (for example `farrey README.md`): open the files it names,
/// or just bring the stickers forward.
fn spawn_handle_args(app: &AppHandle, args: Vec<String>, cwd: String) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let paths = paths_from_args(&args, Path::new(&cwd));
        if paths.is_empty() {
            show_or_create(&handle);
        } else {
            open_paths(&handle, &paths);
        }
    });
}

#[cfg(target_os = "macos")]
fn spawn_open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { open_paths(&handle, &paths) });
}

/* ------------------------------------------------------------------ */
/* Updates                                                             */
/* ------------------------------------------------------------------ */

static CHECKING_FOR_UPDATES: AtomicBool = AtomicBool::new(false);

/// Updates only work when the build carries a public key (`plugins > updater > pubkey`
/// in tauri.conf.json). Without one, the update menu says so instead of failing.
fn updater_configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

async fn notify(app: &AppHandle, title: &str, message: String, kind: MessageDialogKind) {
    let handle = app.clone();
    let title = title.to_string();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .message(message)
            .title(title)
            .kind(kind)
            .blocking_show()
    })
    .await;
}

async fn confirm(app: &AppHandle, title: &str, message: String, ok: &str, cancel: &str) -> bool {
    let handle = app.clone();
    let title = title.to_string();
    let buttons = MessageDialogButtons::OkCancelCustom(ok.to_string(), cancel.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(buttons)
            .blocking_show()
    })
    .await
    .unwrap_or(false)
}

/// `manual` is true when the user asked (tray menu): then every outcome is reported.
/// The automatic check at startup stays silent unless an update is available.
async fn check_for_updates(app: AppHandle, manual: bool) {
    if CHECKING_FOR_UPDATES.swap(true, Ordering::SeqCst) {
        return; // a check is already running
    }
    run_update_check(&app, manual).await;
    CHECKING_FOR_UPDATES.store(false, Ordering::SeqCst);
}

async fn run_update_check(app: &AppHandle, manual: bool) {
    if !updater_configured(app) {
        if manual {
            notify(
                app,
                "Check for Updates",
                "Updates are not set up in this build of Farrey.".into(),
                MessageDialogKind::Info,
            )
            .await;
        }
        return;
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            if manual {
                notify(
                    app,
                    "Check for Updates",
                    format!("Could not start the update check: {e}"),
                    MessageDialogKind::Error,
                )
                .await;
            }
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            if manual {
                let version = app.package_info().version.to_string();
                notify(
                    app,
                    "Check for Updates",
                    format!("You are up to date. Farrey {version} is the latest version."),
                    MessageDialogKind::Info,
                )
                .await;
            }
            return;
        }
        Err(e) => {
            if manual {
                notify(
                    app,
                    "Check for Updates",
                    format!("Could not check for updates: {e}"),
                    MessageDialogKind::Error,
                )
                .await;
            }
            return;
        }
    };

    let notes = update
        .body
        .as_deref()
        .map(|b| b.chars().take(600).collect::<String>())
        .filter(|b| !b.trim().is_empty())
        .map(|b| format!("\n\n{b}"))
        .unwrap_or_default();
    let message = format!(
        "Farrey {} is available (you have {}).{notes}\n\nInstall it now? Farrey will restart.",
        update.version, update.current_version
    );
    if !confirm(
        app,
        "Update available",
        message,
        "Install and restart",
        "Later",
    )
    .await
    {
        return;
    }

    match update.download_and_install(|_, _| {}, || {}).await {
        // On Windows the installer ends this process by itself; elsewhere we restart.
        Ok(()) => app.restart(),
        Err(e) => {
            notify(
                app,
                "Update failed",
                format!("The update could not be installed: {e}"),
                MessageDialogKind::Error,
            )
            .await;
        }
    }
}

fn spawn_update_check(app: &AppHandle, manual: bool) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { check_for_updates(handle, manual).await });
}

/// One quiet check a little after launch, so startup is never slowed down.
fn spawn_startup_update_check(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        spawn_update_check(&handle, false);
    });
}

/* ------------------------------------------------------------------ */
/* Tray, menus and window visibility                                   */
/* ------------------------------------------------------------------ */

fn sticker_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("sticker-"))
        .map(|(_, w)| w)
        .collect()
}

fn show_all(app: &AppHandle) {
    let wins = sticker_windows(app);
    for w in &wins {
        let _ = w.show();
        let _ = w.unminimize();
    }
    if let Some(w) = wins.last() {
        let _ = w.set_focus();
    }
}

fn hide_all(app: &AppHandle) {
    for w in sticker_windows(app) {
        let _ = w.hide();
    }
}

fn show_or_create(app: &AppHandle) {
    if sticker_windows(app).is_empty() {
        if let Err(e) = create_sticker(app, None) {
            eprintln!("Could not create a sticker: {e}");
        }
    } else {
        show_all(app);
    }
}

/// Window creation must not happen on the main thread from a menu/event callback
/// (it can deadlock on Windows), so these helpers hop to a worker thread first.
fn spawn_show_or_create(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { show_or_create(&handle) });
}

fn spawn_new_sticker(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = create_sticker(&handle, None) {
            eprintln!("Could not create a sticker: {e}");
        }
    });
}

/// Distance from a point to a rounded rectangle (negative inside): used to draw the icon.
#[cfg(target_os = "macos")]
fn rounded_rect_distance(px: f32, py: f32, cx: f32, cy: f32, hw: f32, hh: f32, r: f32) -> f32 {
    let qx = (px - cx).abs() - (hw - r);
    let qy = (py - cy).abs() - (hh - r);
    let (ox, oy) = (qx.max(0.0), qy.max(0.0));
    (ox * ox + oy * oy).sqrt() + qx.max(qy).min(0.0) - r
}

/// A small note with three lines, drawn in code: black on transparent, 44x44 pixels.
#[cfg(target_os = "macos")]
fn tray_template_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 44;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let outline = (2.0 - rounded_rect_distance(px, py, 22.0, 22.0, 14.0, 17.0, 5.0).abs())
                .clamp(0.0, 1.0);
            let line = |cy: f32, half_width: f32| {
                (0.5 - rounded_rect_distance(px, py, 22.0, cy, half_width, 1.5, 1.5))
                    .clamp(0.0, 1.0)
            };
            let coverage = outline
                .max(line(17.0, 8.0))
                .max(line(23.0, 8.0))
                .max(line(29.0, 5.0));
            let i = ((y * SIZE + x) * 4) as usize;
            rgba[i + 3] = (coverage * 255.0).round() as u8;
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let launcher = app.autolaunch();
    let result = if launcher.is_enabled().unwrap_or(false) {
        launcher.disable()
    } else {
        launcher.enable()
    };
    if let Err(e) = result {
        eprintln!("Could not change Start at Login: {e}");
    }
    let _ = item.set_checked(launcher.is_enabled().unwrap_or(false));
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let new_item = MenuItem::with_id(app, "tray-new", "New Sticker", true, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "tray-show", "Show All Stickers", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "tray-hide", "Hide All Stickers", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit Farrey", true, None::<&str>)?;
    // Only the installed app should register itself as a login item, not a dev build.
    let autostart_item = CheckMenuItem::with_id(
        app,
        "tray-autostart",
        "Start at Login",
        !cfg!(debug_assertions),
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let update_item =
        MenuItem::with_id(app, "tray-update", "Check for Updates…", true, None::<&str>)?;
    let ghost_item = MenuItem::with_id(
        app,
        "tray-ghost",
        "Toggle Click-Through (All)",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &new_item,
            &show_item,
            &hide_item,
            &ghost_item,
            &separator,
            &autostart_item,
            &update_item,
            &separator2,
            &quit_item,
        ],
    )?;
    let autostart_for_events = autostart_item.clone();

    let mut builder = TrayIconBuilder::with_id("farrey")
        .tooltip("Farrey")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let id: &str = event.id().as_ref();
            match id {
                "tray-autostart" => toggle_autostart(app, &autostart_for_events),
                "tray-update" => spawn_update_check(app, true),
                "tray-new" => spawn_new_sticker(app),
                "tray-show" => show_all(app),
                "tray-hide" => hide_all(app),
                "tray-ghost" => toggle_click_through_all(app),
                "tray-quit" => app.exit(0),
                _ => {}
            }
        });
    // macOS menu bars want a black-and-transparent "template" icon that the system tints.
    // Other systems keep the coloured app icon, which stays visible on any taskbar.
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon(tray_template_icon()).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }
    builder.build(app)?;
    Ok(())
}

/// macOS only: our own menu bar, so Cmd+W closes the *sticker* through the app
/// (which also forgets it) instead of just destroying the window.
#[cfg(target_os = "macos")]
fn setup_macos_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::Submenu;

    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all_item = PredefinedMenuItem::show_all(app, None)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let app_menu = Submenu::with_items(
        app,
        "Farrey",
        true,
        &[&hide, &hide_others, &show_all_item, &sep1, &quit],
    )?;

    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[&undo, &redo, &sep2, &cut, &copy, &paste, &select_all],
    )?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let close = MenuItem::with_id(
        app,
        "close-sticker",
        "Close Sticker",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let window_menu = Submenu::with_items(app, "Window", true, &[&minimize, &close])?;

    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

/// Asks the focused sticker to close itself (the frontend saves first).
fn close_focused(app: &AppHandle) {
    for w in sticker_windows(app) {
        if w.is_focused().unwrap_or(false) {
            let _ = app.emit_to(w.label(), "farrey-close", ());
            break;
        }
    }
}

/* ------------------------------------------------------------------ */
/* App entry                                                           */
/* ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // The updater plugin refuses to start without its config block, so only load it
    // when the block exists. `updater_configured` additionally requires a public key.
    let updater_in_config = context.config().plugins.0.contains_key("updater");

    let mut builder = tauri::Builder::default()
        // Must be registered first. A second launch just brings the stickers forward.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            spawn_handle_args(app, args, cwd);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(on_hotkey)
                .build(),
        )
        .on_menu_event(|app, event| {
            let id: &str = event.id().as_ref();
            if id == "close-sticker" {
                close_focused(app);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle.path().app_data_dir()?;
            let state_path = data_dir.join("state.json");
            let first_run = !state_path.exists();
            let mut store = Store::load(state_path);

            if store.data.stickers.is_empty() {
                // Only the very first launch gets a welcome note. Later launches with
                // no stickers left start with a blank one (Open / New buttons).
                let file = if first_run {
                    notes_dir(&handle)
                        .and_then(|dir| create_note_file(&dir, "Welcome", "html", WELCOME_NOTE))
                        .ok()
                        .map(|p| p.to_string_lossy().into_owned())
                } else {
                    None
                };
                store.data.stickers.push(blank_sticker(file));
                store.dirty = true;
            }
            let stickers = store.data.stickers.clone();
            app.manage(Mutex::new(store));
            app.manage(GhostState::default());

            for s in &stickers {
                build_window(&handle, s)?;
            }

            let settings = load_settings(&data_dir);
            setup_hotkeys(&handle, &settings);
            if settings.auto_check_updates && !cfg!(debug_assertions) {
                spawn_startup_update_check(&handle);
            }
            setup_tray(&handle)?;

            // `farrey README.md` / `farrey .` on a fresh start (Windows and Linux file
            // associations arrive the same way; macOS uses the Opened event below).
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            open_paths(&handle, &paths_from_args(&args, &cwd));

            #[cfg(target_os = "macos")]
            setup_macos_menu(&handle)?;

            // Write pending changes (window moves, resizes, ...) to disk about once a second.
            let flusher = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(800));
                let shared = flusher.state::<Shared>();
                lock(&shared).flush();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            read_note,
            write_note,
            note_mtime,
            get_sticker,
            set_prefs,
            set_file,
            ensure_note_file,
            read_image,
            set_click_through,
            open_markdown_link,
            new_sticker,
            close_sticker
        ]);

    if updater_in_config {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let app = builder.build(context).expect("error while building Farrey");

    app.run(|handle, event| match event {
        // Closing the last sticker keeps Farrey alive in the tray. A real quit
        // (tray menu, Cmd+Q) still exits: those happen while windows exist
        // or with an explicit exit code.
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() && handle.webview_windows().is_empty() {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            let shared = handle.state::<Shared>();
            lock(&shared).flush();
        }
        // macOS: "Open with Farrey" / double-clicking a Markdown file.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls, .. } => {
            let paths: Vec<PathBuf> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .filter(|p| is_readme_ext(p))
                .collect();
            if !paths.is_empty() {
                spawn_open_paths(handle, paths);
            }
        }
        // macOS: clicking the Dock icon when no sticker is visible.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                spawn_show_or_create(handle);
            }
        }
        _ => {}
    });
}
