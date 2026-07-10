import { describe, it, expect } from 'vitest';
import { APP_NAME, defaultDesktopConfig, DEFAULT_SHORTCUTS } from '../index.js';

describe('@lobbyforge/desktop', () => {
  it('defaultDesktopConfig returns sensible defaults', () => {
    const cfg = defaultDesktopConfig();
    expect(cfg.appName).toBe(APP_NAME);
    expect(cfg.enableTray).toBe(true);
    expect(cfg.globalPushToTalk).toBe(true);
  });

  it('DEFAULT_SHORTCUTS includes push-to-talk', () => {
    expect(DEFAULT_SHORTCUTS.pushToTalk).toBeDefined();
    expect(DEFAULT_SHORTCUTS.pushToTalk.accelerator).toMatch(/Space/);
  });
});
