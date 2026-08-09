// LobbyForge desktop shell — connect-to-instance controller.
//
// The shell shows a connect card; once a valid instance URL is entered, it
// navigates the Tauri webview directly to the instance URL. This avoids the
// iframe/CSP/X-Frame-Options conflict — the webview is a top-level navigation,
// not a framed embed. The Rust side persists the URL and drives global PTT.
//
// When the user clicks "Switch instance", we navigate back to the local
// connect screen (a tauri:// URL or file:// URL).

const { invoke } = window.__TAURI__?.core ?? {};

const connectForm = document.getElementById('connect-form');
const urlInput = document.getElementById('instance-url');
const connectBtn = document.getElementById('connect-btn');
const errorMsg = document.getElementById('error-msg');

connectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.textContent = '';
  const raw = urlInput.value.trim();
  if (!raw) return;
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  try {
    // The Rust side validates + persists the URL, then calls
    // window.__lobbyforgeNavigate(url) which does a top-level navigation.
    await invoke('connect_instance', { rawUrl: raw });
  } catch (err) {
    errorMsg.textContent = String(err?.message ?? err ?? 'Connection failed');
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
});

/**
 * Navigate the webview to an instance URL (or back to the connect screen).
 * Called by the Rust side via `window.__lobbyforgeNavigate(url | null)`.
 *
 * Using window.location.href for a top-level navigation instead of an iframe.
 * This respects the instance's X-Frame-Options: DENY and CSP frame-ancestors.
 * The Tauri webview acts as a browser tab — it navigates to the remote URL.
 */
window.__lobbyforgeNavigate = function (url) {
  if (url) {
    // Top-level navigation — the webview becomes the instance page.
    window.location.href = url;
  }
  // When null (disconnect), the Rust side should navigate back to the
  // local connect screen via tauri webview URL.
};

// Listen for push-to-talk events forwarded from the global shortcut.
const { listen } = window.__TAURI__?.event ?? {};
if (listen) {
  listen('lobbyforge://ptt', (event) => {
    const pressed = !!(event?.payload?.pressed);
    // Forward to the instance page via postMessage (same-origin after navigation).
    window.postMessage({ type: 'lobbyforge:ptt', pressed }, '*');
  });
}
