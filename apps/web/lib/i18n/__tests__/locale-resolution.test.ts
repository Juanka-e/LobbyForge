/**
 * Which language a request renders in, and the instance default it falls
 * back to (docs/TRANSLATING.md → How it works):
 *
 *   saved account language → lf_locale cookie → Accept-Language →
 *   instance default (saved in the database → LOBBYFORGE_DEFAULT_LOCALE →
 *   English)
 *
 * The database is mocked: `getUserLocale` is the account's saved language
 * (null = never chose), `getInstanceDefaultLocaleSetting` the admin's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const db = vi.hoisted(() => ({
  getUserLocale: vi.fn(),
  getInstanceDefaultLocaleSetting: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

const cookieJar = vi.hoisted(() => ({ cookie: '', acceptLanguage: null as string | null }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => cookieJar.cookie }),
  headers: async () => new Headers(cookieJar.acceptLanguage ? { 'accept-language': cookieJar.acceptLanguage } : {}),
}));

import { chooseLocale, installedLocale } from '../core';
import {
  CACHE_TTL_MS,
  __resetInstanceDefaultLocaleForTests,
  getInstanceDefaultLocale,
  getInstanceDefaultLocaleInfo,
  instanceDefaultLocale,
  rememberInstanceDefaultLocale,
  resolveInstanceDefault,
} from '../instance-default';
import { localeFromRequest } from '../request-locale';
import { getRequestI18n } from '../server';

const SECRET = 's'.repeat(48);
const MEMBER = '33333333-3333-4333-8333-333333333333';

function session(uid: string | null = MEMBER): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function request(headers: { cookie?: string[]; lang?: string }): Request {
  return new Request('https://chat.example.test/x', {
    headers: {
      ...(headers.cookie?.length ? { cookie: headers.cookie.join('; ') } : {}),
      ...(headers.lang ? { 'accept-language': headers.lang } : {}),
    },
  });
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', '');
  __resetInstanceDefaultLocaleForTests();
  db.getUserLocale.mockReset().mockResolvedValue(null);
  db.getInstanceDefaultLocaleSetting.mockReset().mockResolvedValue(null);
  cookieJar.cookie = '';
  cookieJar.acceptLanguage = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('chooseLocale', () => {
  const available = ['en', 'tr'];

  it('puts the account first, then the cookie, then the browser, then the default', () => {
    expect(chooseLocale(available, { account: 'tr', cookie: 'en', acceptLanguage: 'en', fallback: 'en' })).toEqual({ locale: 'tr', choice: 'tr' });
    expect(chooseLocale(available, { account: null, cookie: 'tr', acceptLanguage: 'en', fallback: 'en' })).toEqual({ locale: 'tr', choice: 'tr' });
    expect(chooseLocale(available, { account: null, cookie: null, acceptLanguage: 'tr-TR', fallback: 'en' })).toEqual({ locale: 'tr', choice: 'system' });
    expect(chooseLocale(available, { account: null, cookie: null, acceptLanguage: 'fr', fallback: 'tr' })).toEqual({ locale: 'tr', choice: 'system' });
  });
});

describe('installedLocale', () => {
  it('matches an installed language exactly, ignoring case, and nothing else', () => {
    expect(installedLocale('TR', ['en', 'tr'])).toBe('tr');
    expect(installedLocale('pt-br', ['en', 'pt-BR'])).toBe('pt-BR');
    expect(installedLocale('tr-TR', ['en', 'tr'])).toBeNull();
    expect(installedLocale('../tr', ['en', 'tr'])).toBeNull();
    expect(installedLocale('', ['en'])).toBeNull();
    expect(installedLocale(null, ['en'])).toBeNull();
  });
});

describe('localeFromRequest', () => {
  it('a signed-in account’s saved language beats the cookie and the browser', async () => {
    db.getUserLocale.mockResolvedValue('tr');
    expect(await localeFromRequest(request({ cookie: [session(), 'lf_locale=en'], lang: 'en-US' }))).toBe('tr');
    expect(db.getUserLocale).toHaveBeenCalledWith(expect.anything(), MEMBER);
  });

  it('an account that never chose (NULL) follows its browser: the cookie, then Accept-Language', async () => {
    db.getUserLocale.mockResolvedValue(null);
    expect(await localeFromRequest(request({ cookie: [session(), 'lf_locale=tr'], lang: 'en' }))).toBe('tr');
    expect(await localeFromRequest(request({ cookie: [session()], lang: 'tr-TR,tr;q=0.9' }))).toBe('tr');
    expect(await localeFromRequest(request({ cookie: [session()], lang: 'de' }))).toBe('en');
  });

  it('an explicit English choice on the account counts', async () => {
    db.getUserLocale.mockResolvedValue('en');
    expect(await localeFromRequest(request({ cookie: [session(), 'lf_locale=tr'], lang: 'tr' }))).toBe('en');
  });

  it('ignores a saved language that is no longer installed', async () => {
    db.getUserLocale.mockResolvedValue('de');
    expect(await localeFromRequest(request({ cookie: [session(), 'lf_locale=tr'] }))).toBe('tr');
  });

  it('signed out, or a guest cookie with no account row: no database read for the account', async () => {
    expect(await localeFromRequest(request({ cookie: ['lf_locale=tr'] }))).toBe('tr');
    expect(await localeFromRequest(request({ cookie: [session(null)], lang: 'tr' }))).toBe('tr');
    expect(await localeFromRequest(request({ lang: 'tr' }))).toBe('tr');
    expect(db.getUserLocale).not.toHaveBeenCalled();
  });

  it('a forged session cookie is not read', async () => {
    db.getUserLocale.mockResolvedValue('tr');
    // Change a character in the MIDDLE of the signature: the last base64url
    // character carries padding bits, so flipping a↔b there can decode to the
    // same bytes and leave the signature valid (a flaky test, not a forgery).
    const cookie = session();
    const at = cookie.lastIndexOf('.') + 8;
    const forged = cookie.slice(0, at) + (cookie[at] === 'A' ? 'Q' : 'A') + cookie.slice(at + 1);
    expect(await localeFromRequest(request({ cookie: [forged], lang: 'en' }))).toBe('en');
    expect(db.getUserLocale).not.toHaveBeenCalled();
  });

  it('keeps answering when the database is down', async () => {
    db.getUserLocale.mockRejectedValue(new Error('connection refused'));
    db.getInstanceDefaultLocaleSetting.mockRejectedValue(new Error('connection refused'));
    expect(await localeFromRequest(request({ cookie: [session(), 'lf_locale=tr'] }))).toBe('tr');
    expect(await localeFromRequest(request({ cookie: [session()] }))).toBe('en');
  });

  it('ends in the instance default when nothing else matches', async () => {
    db.getInstanceDefaultLocaleSetting.mockResolvedValue('tr');
    expect(await localeFromRequest(request({ cookie: [session()], lang: 'fr-FR' }))).toBe('tr');
    expect(await localeFromRequest(request({}))).toBe('tr');
    // A fallback, not an override: a browser that asks for English gets it.
    expect(await localeFromRequest(request({ lang: 'en' }))).toBe('en');
  });
});

describe('getRequestI18n (pages)', () => {
  it('renders a signed-in account in its saved language and shows it as the choice', async () => {
    db.getUserLocale.mockResolvedValue('tr');
    cookieJar.cookie = `${session()}; lf_locale=en`;
    cookieJar.acceptLanguage = 'en-US';
    const i18n = await getRequestI18n();
    expect(i18n.locale).toBe('tr');
    expect(i18n.choice).toBe('tr');
    expect(i18n.info.name).toBe('Türkçe');
    expect(i18n.messages['settings.language.title']).toBe('Dil');
  });

  it('shows "system" when the account and the browser chose nothing explicit', async () => {
    cookieJar.cookie = session();
    cookieJar.acceptLanguage = 'tr-TR';
    const i18n = await getRequestI18n();
    expect(i18n.locale).toBe('tr');
    expect(i18n.choice).toBe('system');
  });
});

describe('the instance default', () => {
  const available = ['en', 'tr', 'pt-BR'];

  it('takes the saved value, then the env, then English — each only when installed', () => {
    expect(resolveInstanceDefault({ saved: 'tr', env: 'pt-BR', available })).toEqual({ code: 'tr', source: 'saved' });
    expect(resolveInstanceDefault({ saved: null, env: 'PT-br', available })).toEqual({ code: 'pt-BR', source: 'env' });
    expect(resolveInstanceDefault({ saved: 'de', env: 'tr', available })).toEqual({ code: 'tr', source: 'env' });
    expect(resolveInstanceDefault({ saved: 'de', env: 'xx', available })).toEqual({ code: 'en', source: 'fallback' });
    expect(resolveInstanceDefault({ saved: null, env: null, available })).toEqual({ code: 'en', source: 'fallback' });
  });

  it('reads the database first, then LOBBYFORGE_DEFAULT_LOCALE, then English', async () => {
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'en');
    db.getInstanceDefaultLocaleSetting.mockResolvedValue('tr');
    expect(await getInstanceDefaultLocale()).toBe('tr');

    __resetInstanceDefaultLocaleForTests();
    db.getInstanceDefaultLocaleSetting.mockResolvedValue(null);
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'tr');
    expect(await getInstanceDefaultLocale()).toBe('tr');

    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', '');
    expect(await getInstanceDefaultLocale()).toBe('en');
  });

  it('ignores an unknown saved code and an unknown env value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.getInstanceDefaultLocaleSetting.mockResolvedValue('klingon');
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'tr');
    expect(await getInstanceDefaultLocale()).toBe('tr');
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'xx');
    expect(await getInstanceDefaultLocale()).toBe('en');
    warn.mockRestore();
  });

  it('caches the saved value, uses a new one at once after a save, and re-reads after the TTL', async () => {
    vi.useFakeTimers();
    db.getInstanceDefaultLocaleSetting.mockResolvedValue('tr');
    expect(await getInstanceDefaultLocale()).toBe('tr');
    expect(await getInstanceDefaultLocale()).toBe('tr');
    expect(db.getInstanceDefaultLocaleSetting).toHaveBeenCalledTimes(1);

    rememberInstanceDefaultLocale('en');
    expect(await getInstanceDefaultLocale()).toBe('en');
    expect(instanceDefaultLocale()).toBe('en');
    expect(db.getInstanceDefaultLocaleSetting).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    db.getInstanceDefaultLocaleSetting.mockResolvedValue(null);
    expect(await getInstanceDefaultLocale()).toBe('en');
    expect(db.getInstanceDefaultLocaleSetting).toHaveBeenCalledTimes(2);
  });

  it('a read that started before a save cannot overwrite it', async () => {
    let finish: (value: string | null) => void = () => {};
    db.getInstanceDefaultLocaleSetting.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const pending = getInstanceDefaultLocale();
    rememberInstanceDefaultLocale('tr');
    finish(null);
    await pending;
    expect(instanceDefaultLocale()).toBe('tr');
  });

  it('the sync reader answers from the env until the first read lands, then from the database', async () => {
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'en');
    db.getInstanceDefaultLocaleSetting.mockResolvedValue('tr');
    expect(instanceDefaultLocale()).toBe('en');
    await vi.waitFor(() => expect(instanceDefaultLocale()).toBe('tr'));
    expect(db.getInstanceDefaultLocaleSetting).toHaveBeenCalledTimes(1);
  });

  it('falls back to the env when the database cannot be read', async () => {
    db.getInstanceDefaultLocaleSetting.mockRejectedValue(new Error('down'));
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'tr');
    expect(await getInstanceDefaultLocale()).toBe('tr');
  });

  it('tells the admin page which step decides, and both inputs', async () => {
    db.getInstanceDefaultLocaleSetting.mockResolvedValue('tr');
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'en');
    expect(await getInstanceDefaultLocaleInfo({ fresh: true })).toEqual({
      code: 'tr',
      source: 'saved',
      saved: 'tr',
      savedInstalled: true,
      env: 'en',
      envInstalled: true,
    });
    db.getInstanceDefaultLocaleSetting.mockResolvedValue(null);
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'zz');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getInstanceDefaultLocaleInfo({ fresh: true })).toMatchObject({ code: 'en', source: 'fallback', env: 'zz', envInstalled: false });
    warn.mockRestore();
  });
});
