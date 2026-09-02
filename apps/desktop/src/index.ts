export const APP_NAME = 'LobbyForge Desktop';
export const APP_VERSION = '0.1.0';

export interface DesktopConfig {
  appName: string;
  version: string;
  enableTray: boolean;
  globalPushToTalk: boolean;
  startMinimized: boolean;
  /**
   * DP-04: the autoUpdate flag was a visible no-op — no updater plugin
   * is wired (needs signed update artifacts first). Removed until the
   * updater ships; re-adding it is a one-line change after
   * tauri-plugin-updater + a signing key exist.
   */
}

export function defaultDesktopConfig(): DesktopConfig {
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    enableTray: true,
    globalPushToTalk: true,
    startMinimized: false,
  };
}

export interface ShortcutBinding {
  accelerator: string;
  description: string;
}

export const DEFAULT_SHORTCUTS: Record<string, ShortcutBinding> = {
  pushToTalk: { accelerator: 'CommandOrControl+Space', description: 'Hold to talk' },
  toggleMute: { accelerator: 'CommandOrControl+Shift+M', description: 'Toggle microphone' },
  toggleDeafen: { accelerator: 'CommandOrControl+Shift+D', description: 'Toggle deafen' },
  openSettings: { accelerator: 'CommandOrControl+,', description: 'Open settings' },
};

export interface DesktopSessionHandoff {
  instanceUrl: string;
  code: string;
  state: string;
}

const HANDOFF_CODE = /^[A-Za-z0-9_-]{43,128}$/;
const HANDOFF_STATE = /^[A-Za-z0-9_-]{32,128}$/;

export function normalizeDesktopInstanceUrl(
  input: string,
  options: { allowLoopbackHttp?: boolean } = {}
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Instance URL is invalid');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
  const allowLoopbackHttp = options.allowLoopbackHttp === true && loopback;
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:')) {
    throw new Error('Instance URL must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Instance URL must not contain credentials, query, or fragment data');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Instance URL must be an origin');
  return url.origin;
}

export function parseDesktopSessionHandoff(
  input: string,
  expectedState: string,
  options: { allowLoopbackHttp?: boolean } = {}
): DesktopSessionHandoff {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Session handoff URL is invalid');
  }
  if (url.protocol !== 'lobbyforge:' || url.hostname !== 'session' || url.pathname !== '/complete') {
    throw new Error('Session handoff target is invalid');
  }
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const instance = url.searchParams.get('instance') ?? '';
  if (!HANDOFF_CODE.test(code)) throw new Error('Session handoff code is invalid');
  if (!HANDOFF_STATE.test(state) || state !== expectedState) throw new Error('Session handoff state mismatch');
  return {
    code,
    state,
    instanceUrl: normalizeDesktopInstanceUrl(instance, options),
  };
}

export function redactDesktopHandoff(input: string): string {
  try {
    const url = new URL(input);
    if (url.searchParams.has('code')) url.searchParams.set('code', '[REDACTED]');
    return url.toString();
  } catch {
    return '[INVALID_HANDOFF_URL]';
  }
}
