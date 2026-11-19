use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex, MutexGuard,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

const DEFAULT_WIDTH: f64 = 360.0;
const DEFAULT_HEIGHT: f64 = 420.0;
const MIN_WIDTH: f64 = 200.0;
const MIN_HEIGHT: f64 = 120.0;
const BAR_HEIGHT: f64 = 32.0;
const CASCADE_OFFSET: f64 = 30.0;
const COLORS: [&str; 6] = ["yellow", "blue", "green", "pink", "purple", "gray"];

const WELCOME: &str = r#"# Welcome to Farrey

Every sticker is a plain Markdown file. This one lives in your `Documents/Farrey` folder.

- [ ] Tick this box. It is written straight back to the file.
- [ ] Press **Cmd/Ctrl+E** to edit this note, and again to preview it.
- [ ] Click **+** (or press Cmd/Ctrl+N) for a new sticker.
- [ ] Double-click the title bar to shade the note.
- [ ] Drag any `README.md` onto a sticker to open it.

Closing a sticker never deletes its file.
"#;

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

/// Creates `<base>.md`, or `<base> 2.md`, `<base> 3.md`, ... without overwriting anything.
fn create_note_file(dir: &Path, base: &str, content: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for n in 1..10_000u32 {
        let name = if n == 1 {
            format!("{base}.md")
        } else {
            format!("{base} {n}.md")
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

fn blank_sticker(file: Option<String>) -> Sticker {
    Sticker {
        id: new_id(),
        file,
        color: "yellow".into(),
        opacity: 1.0,
        pinned: false,
        shaded: false,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        x: None,
        y: None,
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
                "md" | "markdown" | "mdx" | "txt"
            )
        })
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("Only .md, .markdown, .mdx and .txt files are supported".into())
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
/* Sticker commands                                                    */
/* ------------------------------------------------------------------ */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrefsPatch {
    color: Option<String>,
    opacity: Option<f64>,
    pinned: Option<bool>,
    shaded: Option<bool>,
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
    let mut guard = lock(&store);
    let sticker = guard
        .data
        .stickers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Unknown sticker {id}"))?;
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

/// Links a sticker to a file. A file can only be open in one sticker at a time:
/// if another sticker already has it, that sticker is brought to the front instead.
#[tauri::command]
fn set_file(
    app: AppHandle,
    id: String,
    file: Option<String>,
    store: State<'_, Shared>,
) -> Result<(), String> {
    let mut guard = lock(&store);
    if let Some(f) = &file {
        let wanted = fs::canonicalize(f).unwrap_or_else(|_| PathBuf::from(f));
        let other = guard.data.stickers.iter().find(|s| {
            s.id != id
                && s.file.as_ref().is_some_and(|sf| {
                    fs::canonicalize(sf).unwrap_or_else(|_| PathBuf::from(sf)) == wanted
                })
        });
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
    sticker.file = file;
    guard.dirty = true;
    Ok(())
}

/// Creates a new sticker backed by a fresh note file in `Documents/Farrey`.
/// It copies the color and opacity of `from_id` and opens slightly offset from it.
fn create_sticker(app: &AppHandle, from_id: Option<&str>) -> Result<(), String> {
    let shared = app.state::<Shared>();
    let (color, opacity, x, y) = {
        let guard = lock(&shared);
        let found = from_id
            .and_then(|fid| guard.data.stickers.iter().find(|s| s.id == fid))
            .map(|s| (s.color.clone(), s.opacity, s.x, s.y));
        found.unwrap_or_else(|| ("yellow".to_string(), 1.0, None, None))
    };

    let path = create_note_file(&notes_dir(app)?, "Note", "")?;
    let mut sticker = blank_sticker(Some(path.to_string_lossy().into_owned()));
    sticker.color = color;
    sticker.opacity = opacity;
    sticker.x = x.map(|v| v + CASCADE_OFFSET);
    sticker.y = y.map(|v| v + CASCADE_OFFSET);

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
async fn close_sticker(
    app: AppHandle,
    id: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
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

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let new_item = MenuItem::with_id(app, "tray-new", "New Sticker", true, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "tray-show", "Show All Stickers", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "tray-hide", "Hide All Stickers", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit Farrey", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&new_item, &show_item, &hide_item, &separator, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::with_id("farrey")
        .tooltip("Farrey")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id: &str = event.id().as_ref();
            match id {
                "tray-new" => spawn_new_sticker(app),
                "tray-show" => show_all(app),
                "tray-hide" => hide_all(app),
                "tray-quit" => app.exit(0),
                _ => {}
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
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
    let close = MenuItem::with_id(app, "close-sticker", "Close Sticker", true, Some("CmdOrCtrl+W"))?;
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
    let app = tauri::Builder::default()
        // Must be registered first. A second launch just brings the stickers forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            spawn_show_or_create(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| {
            let id: &str = event.id().as_ref();
            if id == "close-sticker" {
                close_focused(app);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let state_path = handle.path().app_data_dir()?.join("state.json");
            let first_run = !state_path.exists();
            let mut store = Store::load(state_path);

            if store.data.stickers.is_empty() {
                // Only the very first launch gets a welcome note. Later launches with
                // no stickers left start with a blank one (Open / New buttons).
                let file = if first_run {
                    notes_dir(&handle)
                        .and_then(|dir| create_note_file(&dir, "Welcome", WELCOME))
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

            for s in &stickers {
                build_window(&handle, s)?;
            }

            setup_tray(&handle)?;
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
            new_sticker,
            close_sticker
        ])
        .build(tauri::generate_context!())
        .expect("error while building Farrey");

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
