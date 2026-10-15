//! LobbyForge desktop shell — Tauri 2 connect-to-server wrapper.
//!
//! The shell owns native capabilities (tray, global push-to-talk, single
//! instance, persisted instance URL) and loads the user's self-hosted
//! LobbyForge instance inside a webview. It does NOT bundle the Next.js
//! app — the web app requires Node + Postgres + Redis and runs on the
//! instance. The desktop shell is a thin, capability-scoped client.

use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
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
///
/// Refusals are stable codes, not sentences: the connect screen shows them
/// in the user's language (dist-shell/shell.js `CONNECT_ERRORS`).
fn normalize_instance_url(input: &str) -> Result<String, String> {
    let url = url::Url::parse(input).map_err(|_| "invalid_url".to_string())?;
    let host = url.host_str().unwrap_or("").to_lowercase();
    let is_loopback = host == "localhost" || host == "::1" || host.starts_with("127.");
    // Loopback http is only allowed in debug builds (local development).
    let allow_loopback_http = cfg!(debug_assertions);
    if url.scheme() != "https"
        && !(allow_loopback_http && is_loopback && url.scheme() == "http")
    {
        return Err("https_required".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("no_extras".to_string());
    }
    let path = url.path();
    if path != "/" && path != "" {
        return Err("origin_only".to_string());
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

/// A deep link that passed the native gate, with the instance origin the
/// browser login was started for — the only origin it may be posted to.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AcceptedHandoff {
    url: String,
    instance_origin: String,
}

/// Gate a lobbyforge:// deep link against the pending handoff.
/// Returns the link only when a pending entry exists, is unexpired,
/// the state matches EXACTLY and the link's instance (when present)
/// matches the pending origin. Consumes the pending entry on success.
fn accept_deep_link(state: &ShellState, raw: &str) -> Option<AcceptedHandoff> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "lobbyforge" {
        return None;
    }
    // 11th-audit: VERIFY FIRST, consume LAST. The old take()-first
    // order let any wrong-state link burn the pending login (a login
    // DoS) — the real deep link then never matched. The entry is only
    // consumed when every check has passed.
    let mut pending_guard = state.pending_handoff.lock().unwrap();
    let pending = pending_guard.as_ref()?;
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
    let accepted = AcceptedHandoff {
        url: raw.to_string(),
        instance_origin: pending.instance_origin.clone(),
    };
    *pending_guard = None; // single-use — consumed only on success
    Some(accepted)
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
    /// The bundled connect screen's URL (its scheme differs per platform),
    /// recorded on its first page load — where disconnect and the page-load
    /// guard send a window with no instance.
    shell_url: Mutex<Option<url::Url>>,
    /// When the navigation guard last handed a URL to the system browser
    /// (a page cannot open a burst of browser tabs).
    last_external_open: Mutex<Option<std::time::Instant>>,
    /// When the page-load guard last sent the window back to the instance
    /// (breaks a loop when the instance itself redirects elsewhere).
    last_bounce: Mutex<Option<std::time::Instant>>,
}

impl ShellState {
    /// Point the shell at an instance origin, or at none. Every switch —
    /// connect, disconnect, restore at launch — drops a pending browser
    /// login (security-review DESK-V-02): a login started for one instance
    /// can never complete into another.
    fn set_instance(&self, origin: Option<String>) {
        *self.instance_url.lock().unwrap() = origin;
        *self.pending_handoff.lock().unwrap() = None;
    }

    fn instance(&self) -> Option<String> {
        self.instance_url.lock().unwrap().clone()
    }
}

struct PendingHandoff {
    state: String,
    instance_origin: String,
    expires_at: std::time::Instant,
}

/// What may happen to a URL the webview wants to load (security-review
/// DESK-V-01). The window has no address bar, so whatever it shows looks
/// like the instance — it must only ever show the instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavigationDecision {
    /// Load it in the app window.
    Allow,
    /// Hand it to the system browser instead.
    OpenExternally,
    /// Drop it.
    Block,
}

/// The bundled connect screen: `tauri://localhost` on macOS / Linux,
/// `http(s)://tauri.localhost` on Windows.
fn is_local_shell(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Where a TOP-LEVEL navigation may go: the connected instance (its exact
/// origin) and the local shell load in the window; any other http(s) page
/// opens in the system browser; every other scheme (file:, data:, custom
/// protocols, …) is dropped. `about:blank` / `about:srcdoc` and a blob: URL
/// of the instance itself carry the instance's origin, so they stay.
fn decide_top_level_navigation(target: &url::Url, instance_origin: Option<&str>) -> NavigationDecision {
    if is_local_shell(target) {
        return NavigationDecision::Allow;
    }
    let same_instance = || instance_origin.is_some_and(|origin| target.origin().ascii_serialization() == origin);
    match target.scheme() {
        "http" | "https" if same_instance() => NavigationDecision::Allow,
        "http" | "https" => NavigationDecision::OpenExternally,
        "about" if matches!(target.path(), "blank" | "srcdoc") => NavigationDecision::Allow,
        "blob" if same_instance() => NavigationDecision::Allow,
        _ => NavigationDecision::Block,
    }
}

/// The webview's navigation handler sees iframe navigations too on macOS and
/// Linux (WKWebView and WebKitGTK ask for every frame); WebView2's
/// NavigationStarting is top-level only. An outside http(s) URL there may be
/// an embed the instance frames on purpose (Watch Party's YouTube player, a
/// CAPTCHA widget), so it is let through at that point and the top-level
/// rule is enforced from the page-load event instead, which is main-frame
/// only on every platform.
const NAVIGATION_HANDLER_SEES_SUBFRAMES: bool = !cfg!(target_os = "windows");

/// The decision for one navigation-handler call.
fn decide_navigation_event(
    target: &url::Url,
    instance_origin: Option<&str>,
    handler_sees_subframes: bool,
) -> NavigationDecision {
    match decide_top_level_navigation(target, instance_origin) {
        NavigationDecision::OpenExternally if handler_sees_subframes => NavigationDecision::Allow,
        decision => decision,
    }
}

/// `window.open` / `target=_blank`: never a second app window (it would
/// have no address bar and no guard). http(s) goes to the system browser;
/// anything else is dropped.
fn decide_new_window(target: &url::Url) -> NavigationDecision {
    match target.scheme() {
        "http" | "https" => NavigationDecision::OpenExternally,
        _ => NavigationDecision::Block,
    }
}

const EXTERNAL_OPEN_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// At most one system-browser hand-off per second.
fn external_open_allowed(last: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    last.map_or(true, |at| now.saturating_duration_since(at) >= EXTERNAL_OPEN_MIN_INTERVAL)
}

/// Hand a refused URL to the system browser (throttled).
fn open_externally(app: &tauri::AppHandle, url: &url::Url) {
    let shell: tauri::State<ShellState> = app.state();
    let now = std::time::Instant::now();
    {
        let mut last = shell.last_external_open.lock().unwrap();
        if !external_open_allowed(*last, now) {
            return;
        }
        *last = Some(now);
    }
    let _ = open_in_system_browser(app, url.as_str());
}

/// The navigation handler: true lets the webview load `url`.
fn guard_navigation(app: &tauri::AppHandle, url: &url::Url) -> bool {
    let instance = app.state::<ShellState>().instance();
    match decide_navigation_event(url, instance.as_deref(), NAVIGATION_HANDLER_SEES_SUBFRAMES) {
        NavigationDecision::Allow => true,
        NavigationDecision::OpenExternally => {
            open_externally(app, url);
            false
        }
        NavigationDecision::Block => false,
    }
}

const BOUNCE_LOOP_WINDOW: std::time::Duration = std::time::Duration::from_secs(3);

/// Where the page-load guard sends a window that landed on a page it may
/// not show: the instance's front page — unless it did that a moment ago
/// (the instance itself redirects outside, e.g. a non-canonical address),
/// then the connect screen, so the window does not bounce forever.
fn bounce_target(
    instance_origin: Option<&str>,
    shell_url: Option<&url::Url>,
    last_bounce: Option<std::time::Instant>,
    now: std::time::Instant,
) -> Option<url::Url> {
    let recently = last_bounce.is_some_and(|at| now.saturating_duration_since(at) < BOUNCE_LOOP_WINDOW);
    match instance_origin {
        Some(origin) if !recently => url::Url::parse(&format!("{origin}/")).ok(),
        _ => shell_url.cloned(),
    }
}

/// Main-frame page loads: a top-level page the guard would not have allowed
/// (one the navigation handler could not tell from an iframe, or a server
/// redirect) is replaced at once by the instance, or the connect screen.
fn guard_page_load(window: &WebviewWindow, url: &url::Url) {
    let app = window.app_handle();
    let shell: tauri::State<ShellState> = app.state();
    let instance = shell.instance();
    let decision = decide_top_level_navigation(url, instance.as_deref());
    if decision == NavigationDecision::Allow {
        return;
    }
    if decision == NavigationDecision::OpenExternally {
        open_externally(app, url);
    }
    let now = std::time::Instant::now();
    let home = {
        let mut last_bounce = shell.last_bounce.lock().unwrap();
        let shell_url = shell.shell_url.lock().unwrap().clone();
        let target = bounce_target(instance.as_deref(), shell_url.as_ref(), *last_bounce, now);
        *last_bounce = Some(now);
        target
    };
    if let Some(home) = home {
        let _ = window.navigate(home);
    }
}


#[tauri::command]
fn get_instance_url(state: tauri::State<ShellState>) -> Option<String> {
    state.instance()
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
    // DESK-V-01: the navigation guard admits the instance origin only once
    // it is recorded, so record it BEFORE navigating (DESK-V-02: this also
    // drops any pending browser login for the previous instance).
    let previous = state.instance();
    state.set_instance(Some(origin.clone()));
    // Navigate the existing webview to the instance.
    let url = format!("{}/", origin);
    if let Err(e) = window.eval(&format!("window.__lobbyforgeNavigate({:?})", url)) {
        state.set_instance(previous);
        return Err(format!("Failed to navigate: {}", e));
    }
    // Reflect the instance in the window title + tray.
    let _ = window.set_title(&format!("LobbyForge — {}", origin));
    // Opted-in global shortcuts are held only while an instance is shown.
    apply_global_shortcuts(&app);
    Ok(origin)
}

/// Disconnect: return to the local connect screen.
#[tauri::command]
fn disconnect_instance(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    leave_instance(&app, &window);
    Ok(())
}

/// The bundled connect screen's URL before its first page load recorded the
/// real one: `http://tauri.localhost` on Windows, `tauri://localhost` elsewhere.
fn default_shell_url() -> Option<url::Url> {
    let raw = if cfg!(target_os = "windows") {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    url::Url::parse(raw).ok()
}

/// Forget the instance and show the bundled connect screen. Shared by the
/// connect screen's `disconnect_instance` and the tray's "Switch instance…",
/// which works from any page — the instance's, or one that failed to load.
fn leave_instance(app: &tauri::AppHandle, window: &WebviewWindow) {
    if let Ok(store) = app.store(STORE_FILE) {
        let _ = store.delete(INSTANCE_URL_KEY);
        let _ = store.save();
    }
    let state: tauri::State<ShellState> = app.state();
    // DESK-V-02: no instance, no pending browser login.
    state.set_instance(None);
    // No instance, no global shortcut.
    apply_global_shortcuts(app);
    // DP-16: actually navigate BACK to the bundled connect screen (always
    // allowed by the navigation guard): its recorded URL when known.
    let home = state.shell_url.lock().unwrap().clone().or_else(default_shell_url);
    if let Some(home) = home {
        let _ = window.navigate(home);
    }
    let _ = window.set_title("LobbyForge");
}

/// Store key: hold push-to-talk (`Ctrl+Space`) system-wide. Off unless the
/// user turns it on from the tray — a global shortcut takes the key from
/// every other app (Ctrl+Space switches the input language on many systems).
const GLOBAL_PTT_KEY: &str = "globalPushToTalk";
/// Store key: also hold the mute / deafen / settings shortcuts system-wide.
/// Off by default; there is no UI for it (edit settings.json).
const GLOBAL_SHORTCUTS_KEY: &str = "globalShortcuts";
const PTT_ACCELERATOR: &str = "Control+Space";
/// The action a global shortcut forwards; `PTT_ACTION` is push-to-talk.
const PTT_ACTION: &str = "ptt";

/// Which global shortcuts to hold, as (accelerator, action): none while no
/// instance is shown, and each group only when the user opted in.
fn global_shortcut_plan(connected: bool, push_to_talk: bool, extra: bool) -> Vec<(&'static str, &'static str)> {
    let mut plan = Vec::new();
    if !connected {
        return plan;
    }
    if push_to_talk {
        plan.push((PTT_ACCELERATOR, PTT_ACTION));
    }
    if extra {
        // DP-06: the web app maps these actions to its own toggles.
        plan.extend([
            ("Control+Shift+M", "toggleMute"),
            ("Control+Shift+D", "toggleDeafen"),
            ("Control+Comma", "openSettings"),
        ]);
    }
    plan
}

/// Re-register the global shortcuts from scratch for the current instance
/// and settings. Called on connect, launch restore, disconnect and when the
/// tray toggle changes — so nothing stays registered after leaving.
fn apply_global_shortcuts(app: &tauri::AppHandle) {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let connected = app.state::<ShellState>().instance().is_some();
    let plan = global_shortcut_plan(
        connected,
        shell_flag(app, GLOBAL_PTT_KEY, false),
        shell_flag(app, GLOBAL_SHORTCUTS_KEY, false),
    );
    for (accelerator, action) in plan {
        let app_handle = app.clone();
        let _ = shortcuts.on_shortcut(accelerator, move |_app, _shortcut, event| {
            let pressed = event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed;
            let Some(window) = app_handle.get_webview_window("main") else {
                return;
            };
            if action == PTT_ACTION {
                // Hold to talk: releases emit pressed=false. The instance web
                // app is the consumer; the shell only forwards the key state.
                emit_ptt(&window, pressed);
            } else if pressed {
                emit_shortcut(&window, action);
            }
        });
    }
}

/// DP-05: read a boolean shell setting from the store.
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
/// beta-review: the payload used to carry `source: window`, and a Window
/// is not structured-cloneable — every postMessage threw DataCloneError,
/// so desktop PTT, shortcuts and the login handoff never reached the page.
/// The receiver checks `event.source === window`, which the browser sets
/// itself. The payload and the target origin are serialized as JSON (valid
/// JS, safely escaped). `target_origin` is `"*"` only for key state (PTT,
/// shortcuts), which means nothing to another page; a session handoff names
/// its instance origin, so the browser drops it on any other page
/// (security-review DESK-V-02).
fn post_message_script(payload: &serde_json::Value, target_origin: &str) -> String {
    let target = serde_json::Value::String(target_origin.to_string());
    format!("window.postMessage({payload},{target})")
}

fn emit_ptt(window: &WebviewWindow, pressed: bool) {
    let payload = serde_json::json!({ "pressed": pressed });
    // Keep the Tauri event for the local connect screen…
    let _ = window.emit("lobbyforge://ptt", payload.clone());
    // …and postMessage into the page for the remote instance.
    let _ = window.eval(&post_message_script(
        &serde_json::json!({ "type": "lobbyforge:ptt", "pressed": pressed }),
        "*",
    ));
}

/// DP-06: forward a shortcut action (mute/deafen/settings) to the page.
/// Same eval bridge — the web app decides what to do with each type.
fn emit_shortcut(window: &WebviewWindow, action: &str) {
    let _ = window.eval(&post_message_script(
        &serde_json::json!({ "type": "lobbyforge:shortcut", "action": action }),
        "*",
    ));
}

const TRAY_SHOW_KEY: &str = "trayShowLabel";
const TRAY_QUIT_KEY: &str = "trayQuitLabel";
const TRAY_SWITCH_KEY: &str = "traySwitchLabel";
const TRAY_PTT_KEY: &str = "trayGlobalPttLabel";
const TRAY_SHOW_DEFAULT: &str = "Show LobbyForge";
const TRAY_QUIT_DEFAULT: &str = "Quit";
const TRAY_SWITCH_DEFAULT: &str = "Switch instance…";
const TRAY_PTT_DEFAULT: &str = "Push to talk anywhere (Ctrl+Space)";

/// The tray's menu items, kept so the labels can follow the user's language.
struct TrayItems {
    show: MenuItem<tauri::Wry>,
    switch_instance: MenuItem<tauri::Wry>,
    global_ptt: CheckMenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// A label from the shell, trimmed, without control characters, at most 64
/// characters; blank → the English default.
fn tray_label(input: &str, fallback: &str) -> String {
    let label: String = input.trim().chars().filter(|c| !c.is_control()).take(64).collect();
    if label.is_empty() {
        fallback.to_string()
    } else {
        label
    }
}

fn stored_tray_label(app: &tauri::AppHandle, key: &str, fallback: &str) -> String {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(key))
        .and_then(|value| value.as_str().map(|label| tray_label(label, fallback)))
        .unwrap_or_else(|| fallback.to_string())
}

/// The connect screen sends the tray labels in the user's language (from
/// the generated desktop strings, dist-shell/locales.js). They apply now
/// and are saved, so the next launch builds the tray in that language.
/// `switch_instance` / `global_ptt` are optional so an older connect screen
/// still works (those items then keep their English default).
#[tauri::command]
fn set_tray_labels(
    app: tauri::AppHandle,
    show: String,
    quit: String,
    switch_instance: Option<String>,
    global_ptt: Option<String>,
) -> Result<(), String> {
    let show = tray_label(&show, TRAY_SHOW_DEFAULT);
    let quit = tray_label(&quit, TRAY_QUIT_DEFAULT);
    let switch_instance = switch_instance.map(|label| tray_label(&label, TRAY_SWITCH_DEFAULT));
    let global_ptt = global_ptt.map(|label| tray_label(&label, TRAY_PTT_DEFAULT));
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.show.set_text(&show);
        let _ = items.quit.set_text(&quit);
        if let Some(label) = &switch_instance {
            let _ = items.switch_instance.set_text(label);
        }
        if let Some(label) = &global_ptt {
            let _ = items.global_ptt.set_text(label);
        }
    }
    if let Ok(store) = app.store(STORE_FILE) {
        let _ = store.set(TRAY_SHOW_KEY, serde_json::json!(show));
        let _ = store.set(TRAY_QUIT_KEY, serde_json::json!(quit));
        if let Some(label) = switch_instance {
            let _ = store.set(TRAY_SWITCH_KEY, serde_json::json!(label));
        }
        if let Some(label) = global_ptt {
            let _ = store.set(TRAY_PTT_KEY, serde_json::json!(label));
        }
        let _ = store.save();
    }
    Ok(())
}

/// The tray's push-to-talk toggle: flip the saved choice, show it, and
/// (un)register the shortcut at once.
fn toggle_global_ptt(app: &tauri::AppHandle) {
    let enabled = !shell_flag(app, GLOBAL_PTT_KEY, false);
    if let Ok(store) = app.store(STORE_FILE) {
        let _ = store.set(GLOBAL_PTT_KEY, serde_json::json!(enabled));
        let _ = store.save();
    }
    // Set explicitly: whether the platform already flipped the check mark
    // on click or not, it now shows the saved choice.
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.global_ptt.set_checked(enabled);
    }
    apply_global_shortcuts(app);
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_label = stored_tray_label(app, TRAY_SHOW_KEY, TRAY_SHOW_DEFAULT);
    let switch_label = stored_tray_label(app, TRAY_SWITCH_KEY, TRAY_SWITCH_DEFAULT);
    let ptt_label = stored_tray_label(app, TRAY_PTT_KEY, TRAY_PTT_DEFAULT);
    let quit_label = stored_tray_label(app, TRAY_QUIT_KEY, TRAY_QUIT_DEFAULT);
    let show_item = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let switch_item = MenuItem::with_id(app, "switch", switch_label, true, None::<&str>)?;
    let ptt_item = CheckMenuItem::with_id(
        app,
        "global_ptt",
        ptt_label,
        true,
        shell_flag(app, GLOBAL_PTT_KEY, false),
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator_2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &switch_item, &separator, &ptt_item, &separator_2, &quit_item],
    )?;
    app.manage(TrayItems {
        show: show_item.clone(),
        switch_instance: switch_item.clone(),
        global_ptt: ptt_item.clone(),
        quit: quit_item.clone(),
    });
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
            "switch" => {
                // Back to the connect screen from wherever the window is —
                // also the way out of an instance that no longer loads.
                if let Some(window) = app.get_webview_window("main") {
                    leave_instance(app, &window);
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "global_ptt" => toggle_global_ptt(app),
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
/// security-review DESK-V-02: the code + state go to the instance origin
/// the login was started for, never `'*'` — on any other page the browser
/// does not deliver them.
fn forward_handoff(window: &WebviewWindow, handoff: &AcceptedHandoff) {
    let _ = window.eval(&handoff_script(handoff));
    let _ = window.show();
    let _ = window.set_focus();
}

fn handoff_script(handoff: &AcceptedHandoff) -> String {
    post_message_script(
        &serde_json::json!({ "type": "lobbyforge:handoff", "url": handoff.url }),
        &handoff.instance_origin,
    )
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
            // security-review DESK-V-01: the main window is built here (its
            // config says `"create": false`) so it carries the navigation
            // guards. Top-level navigation stays on the connected instance
            // and the local shell; other http(s) pages open in the system
            // browser; window.open never makes a second app window.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("tauri.conf.json has no `main` window")?;
            let nav_app = app.handle().clone();
            let popup_app = app.handle().clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_navigation(move |url| guard_navigation(&nav_app, url))
                .on_new_window(move |url, _features| {
                    if decide_new_window(&url) == NavigationDecision::OpenExternally {
                        open_externally(&popup_app, &url);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(|window, payload| {
                    let url = payload.url();
                    if is_local_shell(url) {
                        // Remember the connect screen's real URL (scheme
                        // differs per platform) for disconnect and the guard.
                        let shell: tauri::State<ShellState> = window.state();
                        let mut shell_url = shell.shell_url.lock().unwrap();
                        if shell_url.is_none() {
                            let mut home = url.clone();
                            home.set_query(None);
                            home.set_fragment(None);
                            *shell_url = Some(home);
                        }
                    }
                    guard_page_load(&window, url);
                })
                .build()?;

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

            // DP-05: the tray honours the persisted shell config (the
            // DesktopConfig the TS side exposes; store keys mirror it).
            if shell_flag(app.handle(), "enableTray", true) {
                let _ = build_tray(app.handle());
            }

            // Global shortcuts are NOT registered here: they are held only
            // while an instance is shown, and only those the user opted in
            // to (apply_global_shortcuts, below and on connect/disconnect).

            // Restore the saved instance URL and navigate on launch. The
            // stored value is re-validated (it is a file on disk), and the
            // guard learns the origin before the page navigates.
            if let Ok(store) = app.store(STORE_FILE) {
                let saved = store
                    .get(INSTANCE_URL_KEY)
                    .and_then(|v| v.as_str().map(String::from))
                    .and_then(|raw| normalize_instance_url(&raw).ok());
                if let Some(url) = saved {
                    if let Some(window) = app.get_webview_window("main") {
                        let state: tauri::State<ShellState> = app.state();
                        state.set_instance(Some(url.clone()));
                        let full = format!("{}/", url);
                        let _ = window.eval(&format!("window.__lobbyforgeNavigate({:?})", full));
                        let _ = window.set_title(&format!("LobbyForge — {}", url));
                        // Tauri reports no load failure for the page, so an
                        // instance that is down is not detected here; the
                        // tray's "Switch instance…" is the way back.
                    }
                }
            }
            apply_global_shortcuts(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_instance_url,
            connect_instance,
            disconnect_instance,
            begin_desktop_login,
            set_tray_labels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LobbyForge desktop shell");
}

#[cfg(test)]
mod post_message_tests {
    use super::{handoff_script, post_message_script, AcceptedHandoff};

    #[test]
    fn payload_is_cloneable_json_without_a_window_reference() {
        let script = post_message_script(&serde_json::json!({ "type": "lobbyforge:ptt", "pressed": true }), "*");
        assert_eq!(script, r#"window.postMessage({"pressed":true,"type":"lobbyforge:ptt"},"*")"#);
        assert!(!script.contains("source"));
    }

    #[test]
    fn untrusted_strings_are_escaped() {
        let script = post_message_script(
            &serde_json::json!({
                "type": "lobbyforge:handoff",
                "url": "lobbyforge://x\"});alert(1);//"
            }),
            "https://chat.example.com\"),alert(2",
        );
        assert!(script.contains(r#"\"});alert(1);//"#));
        assert!(script.ends_with(r#",alert(2")"#));
        assert!(script.contains(r#""https://chat.example.com\"),alert(2""#));
    }

    /// security-review DESK-V-02: the code + state are posted to the
    /// instance the login was started for, never broadcast.
    #[test]
    fn a_handoff_is_posted_to_its_instance_origin_only() {
        let script = handoff_script(&AcceptedHandoff {
            url: "lobbyforge://session/complete?code=c&state=s".to_string(),
            instance_origin: "https://chat.example.com".to_string(),
        });
        assert!(script.ends_with(r#","https://chat.example.com")"#), "{script}");
        assert!(!script.contains(r#""*""#));
        assert!(!script.contains("'*'"));
    }
}

#[cfg(test)]
mod handoff_tests {
    use super::{accept_deep_link, PendingHandoff, ShellState, HANDOFF_TTL};

    const STATE: &str = "pending-state-0123456789abcdef";

    fn pending_for(shell: &ShellState, origin: &str) {
        *shell.pending_handoff.lock().unwrap() = Some(PendingHandoff {
            state: STATE.to_string(),
            instance_origin: origin.to_string(),
            expires_at: std::time::Instant::now() + HANDOFF_TTL,
        });
    }

    fn link(instance: &str) -> String {
        format!("lobbyforge://session/complete?code=abc&state={STATE}&instance={instance}")
    }

    #[test]
    fn an_accepted_link_carries_the_origin_it_was_started_for_and_is_single_use() {
        let shell = ShellState::default();
        pending_for(&shell, "https://chat.example.com");
        let accepted = accept_deep_link(&shell, &link("https://chat.example.com")).expect("accepted");
        assert_eq!(accepted.instance_origin, "https://chat.example.com");
        assert!(accepted.url.starts_with("lobbyforge://session/complete"));
        assert!(accept_deep_link(&shell, &link("https://chat.example.com")).is_none());
    }

    /// security-review DESK-V-02: switching or leaving the instance drops a
    /// browser login that is still pending.
    #[test]
    fn connecting_elsewhere_or_disconnecting_clears_the_pending_login() {
        let shell = ShellState::default();
        shell.set_instance(Some("https://a.example.com".to_string()));
        pending_for(&shell, "https://a.example.com");
        shell.set_instance(Some("https://b.example.com".to_string()));
        assert!(shell.pending_handoff.lock().unwrap().is_none());
        assert!(accept_deep_link(&shell, &link("https://a.example.com")).is_none());

        pending_for(&shell, "https://b.example.com");
        shell.set_instance(None);
        assert!(shell.pending_handoff.lock().unwrap().is_none());
        assert_eq!(shell.instance(), None);
        assert!(accept_deep_link(&shell, &link("https://b.example.com")).is_none());
    }

    #[test]
    fn a_link_for_another_instance_or_state_is_refused_without_burning_the_login() {
        let shell = ShellState::default();
        pending_for(&shell, "https://chat.example.com");
        assert!(accept_deep_link(&shell, &link("https://evil.example.com")).is_none());
        assert!(accept_deep_link(&shell, "lobbyforge://session/complete?code=abc&state=wrong").is_none());
        assert!(accept_deep_link(&shell, &link("https://chat.example.com")).is_some());
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::{
        decide_navigation_event, decide_new_window, decide_top_level_navigation, external_open_allowed,
        NavigationDecision::{Allow, Block, OpenExternally},
    };

    const INSTANCE: Option<&str> = Some("https://chat.example.com");

    fn url(raw: &str) -> url::Url {
        url::Url::parse(raw).unwrap()
    }

    #[test]
    fn the_instance_origin_loads_in_the_window() {
        for target in [
            "https://chat.example.com/",
            "https://chat.example.com/lobby?x=1#y",
            "https://CHAT.example.com:443/settings",
            "blob:https://chat.example.com/2f0c5c8e-1111-4a5e-9a37-0123456789ab",
            "about:blank",
        ] {
            assert_eq!(decide_top_level_navigation(&url(target), INSTANCE), Allow, "{target}");
        }
    }

    #[test]
    fn the_local_shell_always_loads() {
        for target in ["tauri://localhost/index.html", "http://tauri.localhost/index.html", "https://tauri.localhost/"] {
            assert_eq!(decide_top_level_navigation(&url(target), INSTANCE), Allow, "{target}");
            assert_eq!(decide_top_level_navigation(&url(target), None), Allow, "{target}");
        }
    }

    #[test]
    fn any_other_web_page_opens_in_the_system_browser() {
        for target in [
            "https://evil.example.com/login",
            "https://chat.example.com.evil.com/",
            "http://chat.example.com/", // same host, other scheme = other origin
            "https://chat.example.com:8443/",
            "https://sub.chat.example.com/",
            "https://accounts.google.com/o/oauth2/auth",
        ] {
            assert_eq!(decide_top_level_navigation(&url(target), INSTANCE), OpenExternally, "{target}");
        }
        // Not connected: everything on the web is external.
        assert_eq!(decide_top_level_navigation(&url("https://chat.example.com/"), None), OpenExternally);
    }

    #[test]
    fn other_schemes_are_dropped() {
        for target in [
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "lobbyforge://session/complete?code=x&state=y",
            "ms-settings:privacy",
            "blob:https://evil.example.com/2f0c5c8e-1111-4a5e-9a37-0123456789ab",
            "tauri://evil/index.html",
            "about:config",
        ] {
            assert_eq!(decide_top_level_navigation(&url(target), INSTANCE), Block, "{target}");
        }
    }

    #[test]
    fn where_the_handler_also_sees_iframes_an_outside_page_is_left_to_the_page_load_guard() {
        let youtube = url("https://www.youtube-nocookie.com/embed/abc");
        // Windows: top-level only — decided right away.
        assert_eq!(decide_navigation_event(&youtube, INSTANCE, false), OpenExternally);
        // macOS / Linux: may be the Watch Party iframe — allowed here; a
        // top-level load of it is caught by decide_top_level_navigation.
        assert_eq!(decide_navigation_event(&youtube, INSTANCE, true), Allow);
        assert_eq!(decide_top_level_navigation(&youtube, INSTANCE), OpenExternally);
        // Dangerous schemes are dropped on every platform.
        assert_eq!(decide_navigation_event(&url("file:///etc/passwd"), INSTANCE, true), Block);
        assert_eq!(decide_navigation_event(&url("https://chat.example.com/x"), INSTANCE, true), Allow);
    }

    #[test]
    fn new_windows_never_open_in_the_app() {
        assert_eq!(decide_new_window(&url("https://chat.example.com/developers")), OpenExternally);
        assert_eq!(decide_new_window(&url("https://evil.example.com/")), OpenExternally);
        assert_eq!(decide_new_window(&url("about:blank")), Block);
        assert_eq!(decide_new_window(&url("file:///etc/passwd")), Block);
        assert_eq!(decide_new_window(&url("tauri://localhost/index.html")), Block);
    }

    #[test]
    fn a_refused_page_sends_the_window_home_but_never_into_a_redirect_loop() {
        use super::bounce_target;
        let shell = url("http://tauri.localhost/index.html");
        let now = std::time::Instant::now();
        assert_eq!(
            bounce_target(INSTANCE, Some(&shell), None, now),
            Some(url("https://chat.example.com/"))
        );
        // Bounced a moment ago (the instance redirects outside): the connect screen.
        assert_eq!(
            bounce_target(INSTANCE, Some(&shell), Some(now), now + std::time::Duration::from_millis(500)),
            Some(shell.clone())
        );
        assert_eq!(
            bounce_target(INSTANCE, Some(&shell), Some(now), now + std::time::Duration::from_secs(5)),
            Some(url("https://chat.example.com/"))
        );
        // Not connected: the connect screen, if its URL is known yet.
        assert_eq!(bounce_target(None, Some(&shell), None, now), Some(shell));
        assert_eq!(bounce_target(None, None, None, now), None);
    }

    #[test]
    fn the_system_browser_is_opened_at_most_once_a_second() {
        let start = std::time::Instant::now();
        assert!(external_open_allowed(None, start));
        assert!(!external_open_allowed(Some(start), start + std::time::Duration::from_millis(400)));
        assert!(external_open_allowed(Some(start), start + std::time::Duration::from_millis(1000)));
    }
}

#[cfg(test)]
mod shortcut_tests {
    use super::{default_shell_url, global_shortcut_plan, is_local_shell, PTT_ACCELERATOR, PTT_ACTION};

    #[test]
    fn nothing_is_global_while_no_instance_is_shown() {
        assert!(global_shortcut_plan(false, true, true).is_empty());
    }

    #[test]
    fn nothing_is_global_by_default_even_when_connected() {
        assert!(global_shortcut_plan(true, false, false).is_empty());
    }

    #[test]
    fn push_to_talk_alone_when_opted_in() {
        assert_eq!(global_shortcut_plan(true, true, false), vec![(PTT_ACCELERATOR, PTT_ACTION)]);
    }

    #[test]
    fn the_other_shortcuts_only_with_their_own_flag() {
        let plan = global_shortcut_plan(true, false, true);
        let accelerators: Vec<&str> = plan.iter().map(|(accel, _)| *accel).collect();
        assert_eq!(accelerators, ["Control+Shift+M", "Control+Shift+D", "Control+Comma"]);
        assert!(!accelerators.contains(&PTT_ACCELERATOR));
    }

    #[test]
    fn the_fallback_connect_screen_is_the_bundled_shell() {
        let url = default_shell_url().expect("parses");
        assert!(is_local_shell(&url), "{url}");
    }
}

#[cfg(test)]
mod language_tests {
    use super::{normalize_instance_url, tray_label};

    #[test]
    fn refusals_are_codes_the_connect_screen_translates() {
        assert_eq!(normalize_instance_url("not a url"), Err("invalid_url".to_string()));
        assert_eq!(normalize_instance_url("ftp://chat.example.com"), Err("https_required".to_string()));
        assert_eq!(normalize_instance_url("https://a:b@chat.example.com"), Err("no_extras".to_string()));
        assert_eq!(normalize_instance_url("https://chat.example.com/?x=1"), Err("no_extras".to_string()));
        assert_eq!(normalize_instance_url("https://chat.example.com/lobby"), Err("origin_only".to_string()));
        assert_eq!(normalize_instance_url("https://chat.example.com/"), Ok("https://chat.example.com".to_string()));
    }

    #[test]
    fn tray_labels_are_trimmed_bounded_and_never_blank() {
        assert_eq!(tray_label("  Çık \n", "Quit"), "Çık");
        assert_eq!(tray_label("   ", "Quit"), "Quit");
        assert_eq!(tray_label("a\u{7}b", "Quit"), "ab");
        assert_eq!(tray_label(&"x".repeat(100), "Quit").chars().count(), 64);
    }
}
