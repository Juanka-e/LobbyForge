/**
 * Settings → Appearance → Language: a choice is saved on the account
 * (so the desktop app and other browsers follow it) AND in this browser's
 * cookie; "Match my browser" clears both; a failed account save changes
 * nothing, because the account would win over the cookie anyway.
 */
import { describe, expect, it, vi } from 'vitest';
import { saveLanguageChoice } from '../language-choice';

function io(response: Response | Error) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  const writeCookie = vi.fn();
  return { fetch, writeCookie };
}

const ok = () => new Response(JSON.stringify({ settings: {} }), { status: 200 });

describe('saveLanguageChoice', () => {
  it('saves a language on the account, then in the cookie', async () => {
    const deps = io(ok());
    expect(await saveLanguageChoice('tr', deps)).toBe(true);
    const [url, init] = deps.fetch.mock.calls[0]!;
    expect(url).toBe('/api/settings/me');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ locale: 'tr' });
    expect(deps.writeCookie).toHaveBeenCalledWith(expect.stringMatching(/^lf_locale=tr;/));
  });

  it('"Match my browser" clears both', async () => {
    const deps = io(ok());
    expect(await saveLanguageChoice('system', deps)).toBe(true);
    expect(JSON.parse(String(deps.fetch.mock.calls[0]![1].body))).toEqual({ locale: null });
    expect(deps.writeCookie).toHaveBeenCalledWith(expect.stringMatching(/^lf_locale=; .*Max-Age=0/));
  });

  it('changes nothing when the account cannot be saved', async () => {
    for (const failure of [new Response('{}', { status: 500 }), new Response('{}', { status: 400 }), new Error('offline')]) {
      const deps = io(failure);
      expect(await saveLanguageChoice('tr', deps)).toBe(false);
      expect(deps.writeCookie).not.toHaveBeenCalled();
    }
  });

  it('still succeeds when cookies are blocked: the account has the choice', async () => {
    const deps = io(ok());
    deps.writeCookie.mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(await saveLanguageChoice('tr', deps)).toBe(true);
  });
});
