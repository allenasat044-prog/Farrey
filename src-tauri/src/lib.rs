use std::{fs, path::Path, time::UNIX_EPOCH};

use serde::Serialize;

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
fn app_version(app: tauri::AppHandle) -> String {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            read_note,
            write_note,
            note_mtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running Farrey");
}
