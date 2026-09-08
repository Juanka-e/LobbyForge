/**
 * LF-SEC-008 client half: the web app's handoff consumer. The parser
 * only accepts well-formed lobbyforge://session/complete URLs, and the
 * consumer ALWAYS sends {code, state} — the server constant-time
 * verifies the state, so a stolen code alone is worthless.
 */
import { describe, expect, it, vi } from 'vitest';
import { consumeDesktopSessionHandoff, parseDesktopSessionHandoff } from '../desktop-handoff';

const CODE = 'c'.repeat(48);
const STATE = 's'.repeat(32);

describe('parseDesktopSessionHandoff', () => {
  it('accepts a well-formed handoff URL', () => {
    const parsed = parseDesktopSessionHandoff(
      `lobbyforge://session/complete?code=${CODE}&state=${STATE}`
    );
    expect(parsed).toEqual({ code: CODE, state: STATE, instanceUrl: null });
  });

  it('captures the optional instance parameter', () => {
    const parsed = parseDesktopSessionHandoff(
      `lobbyforge://session/complete?code=${CODE}&state=${STATE}&instance=https%3A%2F%2Fx.example.com`
    );
    expect(parsed?.instanceUrl).toBe('https://x.example.com');
  });

  it.each([
    ['wrong scheme', `https://session/complete?code=${CODE}&state=${STATE}`],
    ['wrong host', `lobbyforge://other/complete?code=${CODE}&state=${STATE}`],
    ['wrong path', `lobbyforge://session/start?code=${CODE}&state=${STATE}`],
    ['short code', `lobbyforge://session/complete?code=abc&state=${STATE}`],
    ['short state', `lobbyforge://session/complete?code=${CODE}&state=abc`],
    ['missing state', `lobbyforge://session/complete?code=${CODE}`],
    ['garbage', 'not a url at all'],
  ])('rejects %s', (_label, url) => {
    expect(parseDesktopSessionHandoff(url)).toBeNull();
  });
});

describe('consumeDesktopSessionHandoff', () => {
  it('ALWAYS posts both code and state (server verifies constant-time)', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchMock = (async (url: string, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'A' } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await consumeDesktopSessionHandoff({ code: CODE, state: STATE, instanceUrl: null });
      expect(result.ok).toBe(true);
      expect(result.reload).toBe(true);
      expect(captured!.url).toBe('/api/auth/desktop-session/complete');
      expect(captured!.body).toEqual({ code: CODE, state: STATE });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports failures without throwing (expired/replayed codes)', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ error: 'Handoff code expired or invalid.' }), {
        status: 401,
      })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await consumeDesktopSessionHandoff({ code: CODE, state: STATE, instanceUrl: null });
      expect(result.ok).toBe(false);
      expect(result.reload).toBe(false);
      expect(result.error).toContain('expired');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
