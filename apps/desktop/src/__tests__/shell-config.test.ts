/**
 * beta-review: the local connect screen (dist-shell/shell.js) is plain,
 * unbundled JS that reaches Tauri through `window.__TAURI__`. Without
 * `app.withGlobalTauri` that global is never injected, `invoke` is
 * undefined and "Connect" fails with "invoke is not a function" — no
 * release build could connect to any instance (found on real Windows).
 *
 * Remote instance pages still cannot call commands: IPC is gated by the
 * capability ACL (no remote URLs), verified live — see
 * docs/BETA_READINESS_REVIEW.md §8.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const tauriConf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
  app: { withGlobalTauri?: boolean };
};
const shell = readFileSync(join(root, 'dist-shell', 'shell.js'), 'utf8');
const capability = JSON.parse(
  readFileSync(join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8')
) as { remote?: unknown; windows: string[] };

describe('desktop shell wiring', () => {
  it('injects window.__TAURI__ for the unbundled connect screen', () => {
    expect(shell).toContain('window.__TAURI__');
    expect(tauriConf.app.withGlobalTauri).toBe(true);
  });

  it('grants no capability to remote (instance) origins', () => {
    expect(capability.remote).toBeUndefined();
  });

  it('posts cloneable payloads from the Rust bridge (no Window object)', () => {
    const lib = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    expect(lib).not.toMatch(/postMessage\(\{\{source:window/);
    expect(lib).toContain('fn post_message_script');
  });
});
