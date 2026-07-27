// LobbyForge desktop shell — connect-to-instance controller.
//
// The shell shows a connect card; once a valid instance URL is entered, it
// loads the instance inside a full-bleed iframe. The Rust side persists the
// URL and drives the global push-to-talk shortcut. The instance web app is
// fully responsible for its own UI/auth/voice — the shell only navigates.

const { invoke } = window.__TAURI__?.core ?? {};

const connectScreen = document.getElementById('connect');
const connectForm = document.getElementById('connect-form');
const urlInput = document.getElementById('instance-url');
const connectBtn = document.getElementById('connect-btn');
const errorMsg = document.getElementById('error-msg');
const instanceFrame = document.getElementById('instance-frame');
const exitPill = document.getElementById('exit-pill');

/**
 * Navigate the shell to an instance URL (or back to the connect screen).
 * Called by the Rust side via `window.__lobbyforgeNavigate(url | null)`.
 */
window.__lobbyforgeNavigate = function (url) {
  if (url) {
    instanceFrame.src = url;
    instanceFrame.classList.remove('hidden');
    connectScreen.classList.add('hidden');
    exitPill.classList.add('visible');
  } else {
    instanceFrame.src = 'about:blank';
    instanceFrame.classList.add('hidden');
    connectScreen.classList.remove('hidden');
    exitPill.classList.remove('visible');
    urlInput.value = '';
    urlInput.focus();
  }
};

connectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.textContent = '';
  const raw = urlInput.value.trim();
  if (!raw) return;
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  try {
    await invoke('connect_instance', { rawUrl: raw });
  } catch (err) {
    errorMsg.textContent = String(err?.message ?? err ?? 'Connection failed');
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
});

exitPill.addEventListener('click', async () => {
  try {
    await invoke('disconnect_instance');
  } catch {
    // Non-fatal — just navigate locally.
    window.__lobbyforgeNavigate(null);
  }
});

// Listen for push-to-talk events forwarded from the global shortcut.
// The instance web app can opt into these by listening on window for the
// `message` event with type `lobbyforge:ptt`.
const { listen } = window.__TAURI__?.event ?? {};
if (listen) {
  listen('lobbyforge://ptt', (event) => {
    const pressed = !!(event?.payload?.pressed);
    instanceFrame.contentWindow?.postMessage(
      { type: 'lobbyforge:ptt', pressed },
      '*'
    );
  });
}
