// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadExternalScript, readPageNonce, resetScriptLoaderForTests, ScriptLoadError } from '../load-script';
import { captchaRefusalOf, parseCaptchaConfig, readCaptchaRefusal } from '../types';
import { turnstileLanguage, recaptchaScriptUrl } from '../external-widgets';

describe('readPageNonce', () => {
  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('reads the nonce Next stamped on its scripts', () => {
    const script = document.createElement('script');
    script.setAttribute('nonce', 'abc123');
    document.head.appendChild(script);
    expect(readPageNonce()).toBe('abc123');
  });

  it('is undefined on a page without one', () => {
    expect(readPageNonce()).toBeUndefined();
  });
});

describe('loadExternalScript', () => {
  let appended: HTMLScriptElement[] = [];

  beforeEach(() => {
    appended = [];
    resetScriptLoaderForTests();
    // Capture instead of letting the test DOM fetch the network.
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => {
      appended.push(node as unknown as HTMLScriptElement);
      return node;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts one async script with the page nonce and resolves when it has run', async () => {
    const first = loadExternalScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', { nonce: 'n0nce' });
    const second = loadExternalScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', { nonce: 'n0nce' });
    expect(appended).toHaveLength(1);
    const script = appended[0]!;
    expect(script.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    expect(script.async).toBe(true);
    expect(script.nonce || script.getAttribute('nonce')).toBe('n0nce');
    script.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('does not cache a failure: the element goes and a retry inserts a fresh one', async () => {
    const src = 'https://www.google.com/recaptcha/api.js?render=explicit&hl=en';
    const failed = loadExternalScript(src);
    const removed = vi.spyOn(appended[0]!, 'remove');
    appended[0]!.dispatchEvent(new Event('error'));
    await expect(failed).rejects.toBeInstanceOf(ScriptLoadError);
    expect(removed).toHaveBeenCalled();
    const retry = loadExternalScript(src);
    expect(appended).toHaveLength(2);
    appended[1]!.dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBeUndefined();
  });

  it('gives up after its timeout', async () => {
    await expect(loadExternalScript('https://example.test/slow.js', { timeoutMs: 10 })).rejects.toMatchObject({ reason: 'timeout' });
  });
});

describe('the public config and refusals (docs/CAPTCHA.md §4)', () => {
  it('reads a config, keeping only known values', () => {
    expect(
      parseCaptchaConfig({
        surface: 'guest',
        required: true,
        mode: 'on',
        provider: 'turnstile',
        siteKey: '0xabc',
        options: { turnstileAppearance: 'always', recaptchaVersion: 'v9' },
        formToken: 't',
      })
    ).toEqual({
      surface: 'guest',
      required: true,
      mode: 'on',
      provider: 'turnstile',
      siteKey: '0xabc',
      options: { turnstileAppearance: 'always', recaptchaVersion: undefined },
      formToken: 't',
    });
  });

  it('refuses anything that is not a config', () => {
    expect(parseCaptchaConfig(null)).toBeNull();
    expect(parseCaptchaConfig({ surface: 'other', provider: 'altcha' })).toBeNull();
    expect(parseCaptchaConfig({ surface: 'login', provider: 'hcaptcha' })).toBeNull();
  });

  it('knows the four refusal codes and nothing else', () => {
    for (const code of ['captcha_required', 'captcha_invalid', 'captcha_unavailable', 'form_rejected']) {
      expect(captchaRefusalOf({ error: code })).toBe(code);
    }
    expect(captchaRefusalOf({ error: 'Invalid request body' })).toBeNull();
    expect(captchaRefusalOf('captcha_required')).toBeNull();
  });

  it('reads a refusal from a clone, leaving the body readable', async () => {
    const response = new Response(JSON.stringify({ error: 'captcha_required' }), { status: 400 });
    await expect(readCaptchaRefusal(response)).resolves.toBe('captcha_required');
    await expect(response.json()).resolves.toEqual({ error: 'captcha_required' });
    await expect(readCaptchaRefusal(new Response(JSON.stringify({ error: 'captcha_required' }), { status: 401 }))).resolves.toBeNull();
  });

  it('passes the external widgets the page language', () => {
    expect(turnstileLanguage('tr')).toBe('tr');
    expect(turnstileLanguage('pt-BR')).toBe('pt-br');
    expect(turnstileLanguage('de-AT')).toBe('de');
    expect(turnstileLanguage('xx')).toBe('auto');
    expect(recaptchaScriptUrl('v2', 'key', 'tr')).toBe('https://www.google.com/recaptcha/api.js?render=explicit&hl=tr');
    expect(recaptchaScriptUrl('v3', 'a b', 'en')).toBe('https://www.google.com/recaptcha/api.js?render=a%20b&hl=en');
  });
});
