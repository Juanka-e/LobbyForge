/**
 * The language hint a sandboxed plugin gets (`sandboxLocaleFor`): the
 * viewer's `lf_locale`, else their first Accept-Language tag, else the
 * instance default — the admin's saved one, then LOBBYFORGE_DEFAULT_LOCALE —
 * else English. It used to skip the instance default and say "en".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ getInstanceDefaultLocaleSetting: vi.fn() }));
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

import { sandboxLocaleFor } from '../plugin-projection';
import { __resetInstanceDefaultLocaleForTests, getInstanceDefaultLocale } from '../i18n/instance-default';

const req = (headers: Record<string, string>) => new Request('http://x/', { headers });

beforeEach(() => {
  __resetInstanceDefaultLocaleForTests();
  db.getInstanceDefaultLocaleSetting.mockReset().mockResolvedValue(null);
  vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('sandboxLocaleFor', () => {
  it('still prefers the viewer’s own choice and browser over the default', async () => {
    db.getInstanceDefaultLocaleSetting.mockResolvedValue('tr');
    await getInstanceDefaultLocale();
    expect(sandboxLocaleFor(req({ cookie: 'lf_locale=en', 'accept-language': 'tr' }))).toBe('en');
    expect(sandboxLocaleFor(req({ 'accept-language': 'pt-BR,pt;q=0.9' }))).toBe('pt-BR');
  });

  it('falls back to the instance default saved by the admin', async () => {
    db.getInstanceDefaultLocaleSetting.mockResolvedValue('tr');
    await getInstanceDefaultLocale();
    expect(sandboxLocaleFor(req({}))).toBe('tr');
    expect(sandboxLocaleFor(req({ cookie: 'lf_locale=../../x', 'accept-language': '*' }))).toBe('tr');
  });

  it('then to LOBBYFORGE_DEFAULT_LOCALE, then to English', async () => {
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'tr');
    await getInstanceDefaultLocale();
    expect(sandboxLocaleFor(req({}))).toBe('tr');
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', '');
    expect(sandboxLocaleFor(req({}))).toBe('en');
  });
});
