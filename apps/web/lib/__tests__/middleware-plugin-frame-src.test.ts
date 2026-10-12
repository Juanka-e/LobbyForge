import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app's frame-src gains the owner-approved sites of marketplace plugins
 * whose UI is their author's own page (docs/PLUGIN_UNLOCK_PLAN.md phase 2),
 * from lib/plugin-frame-origins.ts — on pages only, and nothing at all when
 * that list is unavailable (fail closed).
 */

// The middleware also reads the CAPTCHA settings for pages: no database here.
vi.mock('@/lib/captcha/settings', () => ({
  resolveCaptchaSettings: async () => ({ provider: 'altcha', keys: true }),
  captchaSettingsSnapshot: () => ({ lastGood: null, fresh: false }),
  readCaptchaEnvOverrides: () => ({ provider: null, invalidProvider: null, siteKey: null, secretKey: null }),
  externalProviderConfigured: () => false,
}));

const origins = vi.hoisted(() => ({
  mode: 'list' as 'list' | 'throw',
  list: ['https://alpha.example.com', 'https://beta.example.com:8443'],
  calls: [] as Array<string | null>,
}));
vi.mock('@/lib/plugin-frame-origins', () => ({
  approvedPluginFrameOrigins: (requestOrigin: string | null) => {
    origins.calls.push(requestOrigin);
    if (origins.mode === 'throw') throw new Error('install root unreadable');
    return origins.list;
  },
}));

const BASE_FRAME = "frame-src 'self' https://www.youtube-nocookie.com";

async function frameSrc(path: string): Promise<string | undefined> {
  const { NextRequest } = await import('next/server');
  const { middleware } = await import('../../middleware');
  const response = await middleware(new NextRequest(`https://chat.example.test${path}`));
  return (response.headers.get('Content-Security-Policy') ?? '')
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('frame-src'));
}

const saved = process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
  origins.mode = 'list';
  origins.calls = [];
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED;
  else process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = saved;
  errors.mockRestore();
});

describe('middleware frame-src — approved external plugin UIs', () => {
  it('appends the approved sites on every page, after the fixed sources', async () => {
    for (const path of ['/lobby', '/', '/home', '/room/abc', '/settings']) {
      expect(await frameSrc(path), path).toBe(`${BASE_FRAME} https://alpha.example.com https://beta.example.com:8443`);
    }
    // The request's own origin goes along, so a site on that host is left out.
    expect(origins.calls.every((origin) => origin === 'https://chat.example.test')).toBe(true);
  });

  it('adds nothing to API routes and static files — the list is not even read', async () => {
    for (const path of ['/api/plugin-ui/alpha', '/api', '/icons/logo.svg', '/manifest.webmanifest', '/_next/data/x.json']) {
      expect(await frameSrc(path), path).toBe(BASE_FRAME);
    }
    expect(origins.calls).toEqual([]);
  });

  it('adds nothing while dynamic plugins are off', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'false';
    expect(await frameSrc('/lobby')).toBe(BASE_FRAME);
    expect(origins.calls).toEqual([]);
  });

  it('fails closed: when the list cannot be read, the page keeps the fixed sources', async () => {
    origins.mode = 'throw';
    expect(await frameSrc('/lobby')).toBe(BASE_FRAME);
    expect(errors).toHaveBeenCalledWith('[csp] plugin frame origins unavailable', 'install root unreadable');
  });

  it('never touches the plugin UI asset route, which sends its own policy', async () => {
    const { NextRequest } = await import('next/server');
    const { middleware } = await import('../../middleware');
    const asset = await middleware(new NextRequest('https://chat.example.test/api/plugin-ui/alpha/1.0.0/index.html'));
    expect(asset.headers.get('Content-Security-Policy')).toBeNull();
    expect(origins.calls).toEqual([]);
  });
});
