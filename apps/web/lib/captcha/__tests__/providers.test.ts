/**
 * The external providers' siteverify adapters (docs/CAPTCHA.md §5), over a
 * mocked IP-pinned HTTPS transport: request shape, the hostname / action /
 * score checks, error codes, the 3 s timeout + one retry, the probe, and
 * the test keys.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchIpPinned, resolvePublicAddresses } = vi.hoisted(() => ({ fetchIpPinned: vi.fn(), resolvePublicAddresses: vi.fn() }));
vi.mock('@/lib/ip-pinned-https', () => ({ fetchIpPinned, resolvePublicAddresses }));

import {
  SITEVERIFY_TIMEOUT_MS,
  expectedAppHosts,
  probeSiteverify,
  verifyRecaptcha,
  verifyTurnstile,
} from '../providers';

function answer(body: unknown, status = 200) {
  const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { ok: status < 300, status, body: buffer, arrayBuffer: buffer.buffer };
}

function sentForm(call = 0): URLSearchParams {
  return new URLSearchParams(String(fetchIpPinned.mock.calls[call]![3].body));
}

const base = { token: 'tok-123', secret: '0x4AAAAAAAREALsecretREALsecretREAL', expectedHosts: ['community.example'], remoteIp: '203.0.113.9' };

beforeEach(() => {
  fetchIpPinned.mockReset();
  resolvePublicAddresses.mockReset().mockResolvedValue(['104.16.0.1']);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('Turnstile siteverify', () => {
  it('POSTs secret, response, remoteip and an idempotency key, pinned to the resolved addresses, with a 3 s budget', async () => {
    fetchIpPinned.mockResolvedValue(answer({ success: true, hostname: 'community.example', action: 'register' }));
    expect(await verifyTurnstile({ ...base, surface: 'register' })).toBe('ok');
    const [url, host, addresses, options] = fetchIpPinned.mock.calls[0]!;
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(host).toBe('challenges.cloudflare.com');
    expect(addresses).toEqual(['104.16.0.1']);
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      timeoutMs: SITEVERIFY_TIMEOUT_MS,
      totalTimeoutMs: SITEVERIFY_TIMEOUT_MS,
    });
    expect(SITEVERIFY_TIMEOUT_MS).toBe(3_000);
    const form = sentForm();
    expect(form.get('secret')).toBe(base.secret);
    expect(form.get('response')).toBe('tok-123');
    expect(form.get('remoteip')).toBe('203.0.113.9');
    expect(form.get('idempotency_key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses another hostname or another action (surface)', async () => {
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'evil.example', action: 'register' }));
    expect(await verifyTurnstile({ ...base, surface: 'register' })).toBe('invalid');
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'community.example', action: 'guest' }));
    expect(await verifyTurnstile({ ...base, surface: 'register' })).toBe('invalid');
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'community.example' }));
    expect(await verifyTurnstile({ ...base, surface: 'register' })).toBe('invalid');
  });

  it('maps the error codes', async () => {
    const cases: Array<[string[], string]> = [
      [['invalid-input-response'], 'invalid'],
      [['timeout-or-duplicate'], 'duplicate'],
      [['invalid-input-secret'], 'bad_secret'],
      [['missing-input-secret'], 'bad_secret'],
      [['internal-error'], 'unavailable'],
      [[], 'invalid'],
    ];
    for (const [codes, expected] of cases) {
      fetchIpPinned.mockResolvedValueOnce(answer({ success: false, 'error-codes': codes }));
      expect(await verifyTurnstile({ ...base, surface: 'guest' }), codes.join()).toBe(expected);
    }
  });

  it('retries once after a network error or a 5xx — with the same idempotency key', async () => {
    fetchIpPinned
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(answer({ success: true, hostname: 'community.example', action: 'guest' }));
    expect(await verifyTurnstile({ ...base, surface: 'guest' })).toBe('ok');
    expect(fetchIpPinned).toHaveBeenCalledTimes(2);
    expect(sentForm(0).get('idempotency_key')).toBe(sentForm(1).get('idempotency_key'));

    fetchIpPinned.mockReset();
    fetchIpPinned.mockResolvedValueOnce(answer('bad gateway', 502)).mockResolvedValueOnce(answer({ success: false, 'error-codes': ['invalid-input-response'] }));
    expect(await verifyTurnstile({ ...base, surface: 'guest' })).toBe('invalid');
    expect(fetchIpPinned).toHaveBeenCalledTimes(2);
  });

  it('is unavailable after the retry fails too (and never retries twice)', async () => {
    fetchIpPinned.mockRejectedValue(new Error('Request exceeded the 3000 ms deadline'));
    expect(await verifyTurnstile({ ...base, surface: 'login' })).toBe('unavailable');
    expect(fetchIpPinned).toHaveBeenCalledTimes(2);
    fetchIpPinned.mockReset().mockResolvedValue(answer('<html>', 200));
    expect(await verifyTurnstile({ ...base, surface: 'login' })).toBe('unavailable');
    resolvePublicAddresses.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await verifyTurnstile({ ...base, surface: 'login' })).toBe('unavailable');
  });

  it('never logs the token or the secret', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchIpPinned.mockRejectedValue(new Error('boom'));
    await verifyTurnstile({ ...base, surface: 'login' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(base.secret);
    expect(logged).not.toContain(base.token);
  });

  it('accepts Cloudflare’s test secret whatever hostname it reports (the e2e keys)', async () => {
    fetchIpPinned.mockResolvedValue(answer({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } }));
    expect(await verifyTurnstile({ ...base, secret: '1x0000000000000000000000000000000AA', surface: 'register' })).toBe('ok');
    // …but a real secret with that answer is refused.
    expect(await verifyTurnstile({ ...base, surface: 'register' })).toBe('invalid');
  });
});

describe('reCAPTCHA siteverify', () => {
  const recaptcha = { ...base, secret: '6LcREALREALREALREALREALREALREALREALREAL', minScore: 0.5 };

  it('v3: checks hostname, action and score', async () => {
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'community.example', action: 'register', score: 0.7 }));
    expect(await verifyRecaptcha({ ...recaptcha, surface: 'register', version: 'v3' })).toBe('ok');
    const [url] = fetchIpPinned.mock.calls[0]!;
    expect(url).toBe('https://www.google.com/recaptcha/api/siteverify');
    expect(sentForm().get('idempotency_key')).toBeNull();
    expect(sentForm().get('remoteip')).toBe('203.0.113.9');

    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'community.example', action: 'register', score: 0.4 }));
    expect(await verifyRecaptcha({ ...recaptcha, surface: 'register', version: 'v3' })).toBe('invalid');
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'community.example', action: 'login', score: 0.9 }));
    expect(await verifyRecaptcha({ ...recaptcha, surface: 'register', version: 'v3' })).toBe('invalid');
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'other.example', action: 'register', score: 0.9 }));
    expect(await verifyRecaptcha({ ...recaptcha, surface: 'register', version: 'v3' })).toBe('invalid');
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'community.example', action: 'register' }));
    expect(await verifyRecaptcha({ ...recaptcha, surface: 'register', version: 'v3' })).toBe('invalid');
  });

  it('v2: checks the hostname only (no action, no score)', async () => {
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'community.example' }));
    expect(await verifyRecaptcha({ ...recaptcha, surface: 'guest', version: 'v2_checkbox' })).toBe('ok');
    fetchIpPinned.mockResolvedValueOnce(answer({ success: true, hostname: 'other.example' }));
    expect(await verifyRecaptcha({ ...recaptcha, surface: 'guest', version: 'v2_invisible' })).toBe('invalid');
  });

  it('accepts Google’s test secret (hostname testkey.google.com)', async () => {
    fetchIpPinned.mockResolvedValue(answer({ success: true, hostname: 'testkey.google.com' }));
    expect(await verifyRecaptcha({ ...recaptcha, secret: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe', surface: 'login', version: 'v3' })).toBe('ok');
  });
});

describe('reachability probe', () => {
  it('a normal "invalid token" answer means reachable', async () => {
    fetchIpPinned.mockResolvedValue(answer({ success: false, 'error-codes': ['invalid-input-response'] }));
    expect(await probeSiteverify('turnstile', 'secret')).toBe('ok');
    expect(sentForm().get('response')).toBe('lobbyforge-reachability-probe');
    expect(await probeSiteverify('recaptcha', 'secret')).toBe('ok');
  });

  it('tells a refused secret and an unreachable provider apart', async () => {
    fetchIpPinned.mockResolvedValueOnce(answer({ success: false, 'error-codes': ['invalid-input-secret'] }));
    expect(await probeSiteverify('turnstile', 'secret')).toBe('bad_secret');
    fetchIpPinned.mockRejectedValue(new Error('ECONNRESET'));
    expect(await probeSiteverify('turnstile', 'secret')).toBe('unreachable');
    fetchIpPinned.mockReset().mockResolvedValue(answer({ success: false, 'error-codes': ['internal-error'] }));
    expect(await probeSiteverify('recaptcha', 'secret')).toBe('unreachable');
  });
});

describe('expectedAppHosts', () => {
  it('collects the request host and the declared public origins', () => {
    vi.stubEnv('LOBBYFORGE_APP_ORIGIN', 'https://Chat.Example:8443');
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'not a url');
    expect(expectedAppHosts(new Request('http://localhost:3000/api/auth/register')).sort()).toEqual(['chat.example', 'localhost']);
    vi.unstubAllEnvs();
  });
});
