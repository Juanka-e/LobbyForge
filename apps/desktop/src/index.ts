export const APP_NAME = 'LobbyForge Desktop';
export const APP_VERSION = '0.1.0';

export interface DesktopConfig {
  appName: string;
  version: string;
  enableTray: boolean;
  globalPushToTalk: boolean;
  startMinimized: boolean;
  autoUpdate: boolean;
}

export function defaultDesktopConfig(): DesktopConfig {
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    enableTray: true,
    globalPushToTalk: true,
    startMinimized: false,
    autoUpdate: true,
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
