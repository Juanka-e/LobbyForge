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
    Emitter, Manager, WebviewWindow,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
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

const HANDOFF_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Begin a browser-login handoff: mint a fresh NATIVE state bound to
/// the connected instance, hold it pending (single-use, 30 min TTL)
/// and open the system browser at the instance login page carrying
/// the state. Only a deep link whose state matches this pending entry
/// will ever be forwarded into the webview.
#[tauri::command]
fn begin_desktop_login(
    state: tauri::State<ShellState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let instance = state
        .instance_url
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Connect to an instance first".to_string())?;
    let bytes: [u8; 24] = rand::random();
    let state_value = base64_url_encode(&bytes);
    *state.pending_handoff.lock().unwrap() = Some(PendingHandoff {
        state: state_value.clone(),
        instance_origin: instance.clone(),
        expires_at: std::time::Instant::now() + HANDOFF_TTL,
    });
    let login_url = format!("{}/login?desktopLoginState={}", instance, state_value);
    let _ = open_in_system_browser(&app, &login_url);
    Ok(state_value)
}

fn open_in_system_browser(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|e| format!("failed to open browser: {e}"))
}

fn base64_url_encode(data: &[u8]) -> String {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHA[(n >> 18) as usize & 63] as char);
        out.push(ALPHA[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHA[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHA[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Gate a lobbyforge:// deep link against the pending handoff.
/// Returns Some(url) only when a pending entry exists, is unexpired,
/// the state matches EXACTLY and the link's instance (when present)
/// matches the pending origin. Consumes the pending entry on success.
fn accept_deep_link(state: &ShellState, raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "lobbyforge" {
        return None;
    }
    let mut pending_guard = state.pending_handoff.lock().unwrap();
    let pending = pending_guard.take()?; // single-use regardless of outcome
    if std::time::Instant::now() >= pending.expires_at {
        return None;
    }
    let link_state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.to_string())?;
    if !constant_time_eq(link_state.as_bytes(), pending.state.as_bytes()) {
        return None;
    }
    if let Some((_, instance)) = url.query_pairs().find(|(k, _)| k == "instance") {
        let origin = url::Url::parse(&instance)
            .ok()
            .map(|u| u.origin().ascii_serialization())
            .unwrap_or_default();
        if origin != pending.instance_origin {
            return None;
        }
    }
    Some(raw.to_string())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// State held across commands: the active instance URL the webview is showing.
#[derive(Default)]
struct ShellState {
    instance_url: Mutex<Option<String>>,
    /// 10th-audit: the NATIVE pending handoff. A deep link is only
    /// forwarded into the webview when its state matches this
    /// single-use, expiring, instance-bound entry — unsolicited
    /// lobbyforge:// links (an attacker feeding their own code+state)
    /// are dropped at the OS boundary, before any web check runs.
    pending_handoff: Mutex<Option<PendingHandoff>>,
}

struct PendingHandoff {
    state: String,
    instance_origin: String,
    expires_at: std::time::Instant,
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
    // DP-16: actually navigate BACK. The shell's connect screen is the
    // app's local entry point — a plain webview_url reset lands on the
    // bundled index.html and reloads shell.js cleanly.
    let _ = window.eval("window.location.href = 'index.html'");
    *state.instance_url.lock().unwrap() = None;
    let _ = window.set_title("LobbyForge");
    Ok(())
}

/// DP-05: read a boolean shell setting from the store (defaults true).
fn shell_flag(app: &tauri::AppHandle, key: &str, default: bool) -> bool {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

/// DP-02: forward push-to-talk into the CURRENT page. The instance web
/// app listens for `postMessage({type:'lobbyforge:ptt'})` — but the old
/// bridge (shell.js converting a Tauri event) is unloaded by the remote
/// navigation, and the remote origin has no `__TAURI__` (IPC stays
/// closed). `window.eval` runs on ANY page, so the shortcut keeps
/// working after connecting to an instance.
fn emit_ptt(window: &WebviewWindow, pressed: bool) {
    let payload = serde_json::json!({ "pressed": pressed });
    // Keep the Tauri event for the local connect screen…
    let _ = window.emit("lobbyforge://ptt", payload.clone());
    // …and postMessage into the page for the remote instance.
    let _ = window.eval(&format!(
        "window.postMessage({{source:window,type:'lobbyforge:ptt',pressed:{}}},'*')",
        pressed
    ));
}

/// DP-06: forward a shortcut action (mute/deafen/settings) to the page.
/// Same eval bridge — the web app decides what to do with each type.
fn emit_shortcut(window: &WebviewWindow, action: &str) {
    let _ = window.eval(&format!(
        "window.postMessage({{source:window,type:'lobbyforge:shortcut',action:{:?}}},'*')",
        action
    ));
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

/// DP-07: forward a session-handoff deep link into the CURRENT page.
/// Used by BOTH delivery paths: the deep-link plugin event (app already
/// running, OS routed the URL) and the single-instance argv relay
/// (DESK-001: on Windows/Linux a second launch carries the URL as a
/// command-line argument — without the relay the handoff is lost).
fn forward_handoff(window: &WebviewWindow, url_str: &str) {
    let _ = window.eval(&format!(
        "window.postMessage({{source:window,type:'lobbyforge:handoff',url:{:?}}},'*')",
        url_str
    ));
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Focus the existing window when a second instance is launched.
            if let Some(window) = app.get_webview_window("main") {
                // DESK-01: relay a deep link that arrived as argv on the
                // SECOND launch — the deep-link plugin only fires its
                // event in the process the OS opened, which single-
                // instance immediately exits. Without this the
                // lobbyforge://session/complete handoff from a browser
                // login would silently vanish.
                if let Some(url) = args.iter().find(|a| a.starts_with("lobbyforge://")) {
                    // 10th-audit: argv-carried links pass the SAME
                    // native pending-state gate.
                    let shell: tauri::State<ShellState> = app.state();
                    if let Some(accepted) = accept_deep_link(&shell, url) {
                        forward_handoff(&window, &accepted);
                    }
                }
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
            // DP-07: session handoff deep links. The browser redirects to
            // lobbyforge://session/complete?code&state&instance after the
            // user logs into their instance; forward the URL into the page
            // — the web app validates it (TS `parseDesktopSessionHandoff`)
            // and exchanges the one-time code for a session cookie.
            let dl_handle = app.handle().clone();
            let _ = app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    // 10th-audit: unsolicited deep links are dropped at
                    // the NATIVE boundary — only a link matching the
                    // pending (native-generated, instance-bound,
                    // single-use, expiring) state reaches the webview.
                    let shell: tauri::State<ShellState> = dl_handle.state();
                    if let Some(accepted) = accept_deep_link(&shell, &url.to_string()) {
                        if let Some(window) = dl_handle.get_webview_window("main") {
                            forward_handoff(&window, &accepted);
                        }
                    }
                }
            });

            // DP-05: tray and shortcuts honour the persisted shell config
            // (the DesktopConfig the TS side exposes; store keys mirror it).
            let enable_tray = shell_flag(app.handle(), "enableTray", true);
            let global_ptt = shell_flag(app.handle(), "globalPushToTalk", true);

            if enable_tray {
                let _ = build_tray(app.handle());
            }

            // Global push-to-talk shortcut: hold Ctrl+Space to talk.
            // Releases emit pressed=false. The instance web app is the
            // consumer; the shell only forwards the key state.
            if global_ptt {
                let app_handle = app.handle().clone();
                let _ = app.global_shortcut().on_shortcut("Control+Space", move |_app, _shortcut, event| {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        emit_ptt(&window, event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed);
                    }
                });
            }

            // DP-06: the remaining DEFAULT_SHORTCUTS were never
            // registered — dead config. Wire them through the same eval
            // bridge; the web app maps actions to its own toggles.
            for (accel, action) in [
                ("Control+Shift+M", "toggleMute"),
                ("Control+Shift+D", "toggleDeafen"),
                ("Control+Comma", "openSettings"),
            ] {
                let app_handle = app.handle().clone();
                let action_owned = action.to_string();
                let _ = app.global_shortcut().on_shortcut(accel, move |_app, _shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    if let Some(window) = app_handle.get_webview_window("main") {
                        emit_shortcut(&window, &action_owned);
                    }
                });
            }

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
            begin_desktop_login,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LobbyForge desktop shell");
}
