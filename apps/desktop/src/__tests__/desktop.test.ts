import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  APP_NAME,
  defaultDesktopConfig,
  DEFAULT_SHORTCUTS,
  normalizeDesktopInstanceUrl,
  parseDesktopSessionHandoff,
  redactDesktopHandoff,
} from '../index.js';

describe('@lobbyforge/desktop', () => {
  it('defaultDesktopConfig returns sensible defaults', () => {
    const cfg = defaultDesktopConfig();
    expect(cfg.appName).toBe(APP_NAME);
    expect(cfg.enableTray).toBe(true);
    // Global shortcuts take keys from every other app: opt-in only.
    expect(cfg.globalPushToTalk).toBe(false);
    expect(cfg.globalShortcuts).toBe(false);
  });

  it('the Rust shell agrees: no global shortcut unless opted in, none while disconnected', () => {
    const lib = readFileSync(join(__dirname, '..', '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
    expect(lib).toContain('shell_flag(app, GLOBAL_PTT_KEY, false)');
    expect(lib).toContain('shell_flag(app, GLOBAL_SHORTCUTS_KEY, false)');
    expect(lib).toContain('const GLOBAL_PTT_KEY: &str = "globalPushToTalk";');
    // Registration lives in apply_global_shortcuts only (connect / restore /
    // disconnect / tray toggle), never unconditionally at setup.
    expect(lib.match(/\.on_shortcut\(/g)).toHaveLength(1);
    expect(lib).toContain('unregister_all()');
  });

  it('DEFAULT_SHORTCUTS includes push-to-talk', () => {
    expect(DEFAULT_SHORTCUTS.pushToTalk).toBeDefined();
    expect(DEFAULT_SHORTCUTS.pushToTalk.accelerator).toMatch(/Space/);
  });

  it('accepts HTTPS instances and explicit local development HTTP', () => {
    expect(normalizeDesktopInstanceUrl('https://community.example')).toBe('https://community.example');
    expect(normalizeDesktopInstanceUrl('http://127.0.0.1:3000', { allowLoopbackHttp: true }))
      .toBe('http://127.0.0.1:3000');
    expect(() => normalizeDesktopInstanceUrl('http://community.example')).toThrow(/HTTPS/);
    expect(() => normalizeDesktopInstanceUrl('https://user:pass@community.example')).toThrow(/credentials/);
  });

  it('parses state-bound one-time-code handoffs and rejects token-shaped shortcuts', () => {
    const code = 'c'.repeat(43);
    const state = 's'.repeat(32);
    const handoff = parseDesktopSessionHandoff(
      `lobbyforge://session/complete?code=${code}&state=${state}&instance=${encodeURIComponent('https://community.example')}`,
      state
    );
    expect(handoff).toEqual({ code, state, instanceUrl: 'https://community.example' });
    expect(() => parseDesktopSessionHandoff(
      `lobbyforge://session/complete?token=secret&state=${state}&instance=${encodeURIComponent('https://community.example')}`,
      state
    )).toThrow(/code/);
    expect(() => parseDesktopSessionHandoff(
      `lobbyforge://session/complete?code=${code}&state=${state}&instance=${encodeURIComponent('https://community.example')}`,
      'x'.repeat(32)
    )).toThrow(/state/);
  });

  it('redacts handoff codes before logging', () => {
    const value = redactDesktopHandoff(
      `lobbyforge://session/complete?code=${'c'.repeat(43)}&state=${'s'.repeat(32)}`
    );
    expect(value).toContain('%5BREDACTED%5D');
    expect(value).not.toContain('c'.repeat(43));
  });
});
