//! LobbyForge desktop shell — Tauri 2 connect-to-server wrapper.
//!
//! The shell owns native capabilities (tray, global push-to-talk, single
//! instance, persisted instance URL) and loads the user's self-hosted
//! LobbyForge instance inside a webview. It does NOT bundle the Next.js
//! app — the web app requires Node + Postgres + Redis and runs on the
//! instance. The desktop shell is a thin, capability-scoped client.

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewWindow,
};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const INSTANCE_URL_KEY: &str = "instanceUrl";

/// Validate an instance URL: must be an https origin (loopback http allowed
/// for local development), no credentials/query/fragment, root path only.
/// Mirrors the TypeScript `normalizeDesktopInstanceUrl` contract.
fn normalize_instance_url(input: &str) -> Result<String, String> {
    let url = url::Url::parse(input).map_err(|_| "Instance URL is invalid".to_string())?;
    let host = url.host_str().unwrap_or("").to_lowercase();
    let is_loopback = host == "localhost" || host == "::1" || host.starts_with("127.");
    // Loopback http is only allowed in debug builds (local development).
    let allow_loopback_http = cfg!(debug_assertions);
    if url.scheme() != "https"
        && !(allow_loopback_http && is_loopback && url.scheme() == "http")
    {
        return Err("Instance URL must use HTTPS".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Instance URL must not contain credentials, query, or fragment data".to_string(),
        );
    }
    let path = url.path();
    if path != "/" && path != "" {
        return Err("Instance URL must be an origin".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

/// State held across commands: the active instance URL the webview is showing.
#[derive(Default)]
struct ShellState {
    instance_url: Mutex<Option<String>>,
}

#[tauri::command]
fn get_instance_url(state: tauri::State<ShellState>) -> Option<String> {
    state.instance_url.lock().unwrap().clone()
}

/// Connect the webview to an instance URL. Validates, persists, navigates.
#[tauri::command]
fn connect_instance(
    raw_url: String,
    state: tauri::State<ShellState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let origin = normalize_instance_url(&raw_url)?;
    // Persist for next launch.
    if let Ok(store) = app.store(STORE_FILE) {
        let _ = store.set(INSTANCE_URL_KEY, serde_json::json!(origin));
        let _ = store.save();
    }
    // Navigate the existing webview to the instance.
    let url = format!("{}/", origin);
    window
        .eval(&format!("window.__lobbyforgeNavigate({:?})", url))
        .map_err(|e| format!("Failed to navigate: {}", e))?;
    *state.instance_url.lock().unwrap() = Some(origin.clone());
    // Reflect the instance in the window title + tray.
    let _ = window.set_title(&format!("LobbyForge — {}", origin));
    Ok(origin)
}

/// Disconnect: return to the local connect screen.
#[tauri::command]
fn disconnect_instance(
    state: tauri::State<ShellState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if let Ok(store) = app.store(STORE_FILE) {
        let _ = store.delete(INSTANCE_URL_KEY);
        let _ = store.save();
    }
    let _ = window.eval("window.__lobbyforgeNavigate(null)");
    *state.instance_url.lock().unwrap() = None;
    let _ = window.set_title("LobbyForge");
    Ok(())
}

/// Emit a push-to-talk event to the webview (forwarded by the global
/// shortcut handler). The instance web app listens for these.
fn emit_ptt(window: &WebviewWindow, pressed: bool) {
    let payload = serde_json::json!({ "pressed": pressed });
    let _ = window.emit("lobbyforge://ptt", payload);
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show LobbyForge", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("LobbyForge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(ShellState::default())
        .setup(|app| {
            // Tray.
            let _ = build_tray(app.handle());

            // Global push-to-talk shortcut: hold Ctrl+Space to talk.
            // Releases emit pressed=false. The instance web app is the
            // consumer; the shell only forwards the key state.
            let app_handle = app.handle().clone();
            let _ = app.global_shortcut().on_shortcut("Control+Space", move |_app, _shortcut, event| {
                if let Some(window) = app_handle.get_webview_window("main") {
                    emit_ptt(&window, event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed);
                }
            });

            // Restore the saved instance URL and navigate on launch.
            if let Ok(store) = app.store(STORE_FILE) {
                if let Some(url) = store.get(INSTANCE_URL_KEY).and_then(|v| v.as_str().map(String::from)) {
                    if let Some(window) = app.get_webview_window("main") {
                        let full = format!("{}/", url);
                        let _ = window.eval(&format!("window.__lobbyforgeNavigate({:?})", full));
                        let state: tauri::State<ShellState> = app.state();
                        *state.instance_url.lock().unwrap() = Some(url.clone());
                        let _ = window.set_title(&format!("LobbyForge — {}", url));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_instance_url,
            connect_instance,
            disconnect_instance,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LobbyForge desktop shell");
}
