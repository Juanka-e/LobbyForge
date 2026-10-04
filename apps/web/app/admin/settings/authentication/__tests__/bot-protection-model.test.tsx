import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  buildPutBody,
  buildTestBody,
  draftFrom,
  isDirty,
  isFuture,
  missingKeys,
  parseAdminCaptchaSettings,
  parseTestResult,
  type AdminCaptchaSettings,
} from '../bot-protection-model';

const saved = (overrides: Partial<AdminCaptchaSettings> = {}): AdminCaptchaSettings => ({
  provider: 'altcha',
  surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'adaptive' },
  siteKey: null,
  secretSet: false,
  secretHint: null,
  options: { ...DEFAULT_OPTIONS },
  attackMode: { manual: false, autoUntil: null },
  locked: { provider: false, siteKey: false, secretKey: false },
  breaker: { open: false, until: null },
  ...overrides,
});

describe('bot protection admin model (docs/CAPTCHA.md §6.1)', () => {
  it('reads the GET shape, filling defaults and clamping options', () => {
    const parsed = parseAdminCaptchaSettings({
      provider: 'turnstile',
      surfaces: { login: 'always' },
      siteKey: 'site',
      secretSet: true,
      secretHint: '…abcd',
      options: { recaptchaMinScore: 2, loginFailureThreshold: 0, altchaDifficulty: 'insane' },
      attackMode: { manual: true, autoUntil: 'not a date' },
      locked: { siteKey: true },
      breaker: { open: true, until: '2026-10-04T10:05:00.000Z' },
    });
    expect(parsed).toMatchObject({
      provider: 'turnstile',
      surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'always' },
      siteKey: 'site',
      secretSet: true,
      secretHint: '…abcd',
      options: { recaptchaMinScore: 0.9, loginFailureThreshold: 1, altchaDifficulty: 'normal' },
      attackMode: { manual: true, autoUntil: null },
      locked: { provider: false, siteKey: true, secretKey: false },
      breaker: { open: true, until: '2026-10-04T10:05:00.000Z' },
    });
    expect(parseAdminCaptchaSettings({ error: 'forbidden' })).toBeNull();
  });

  it('counts a typed or cleared secret as a change, and an untouched form as none', () => {
    const settings = saved();
    expect(isDirty(settings, draftFrom(settings), { kind: 'keep' })).toBe(false);
    expect(isDirty(settings, draftFrom(settings), { kind: 'replace', value: '  ' })).toBe(false);
    expect(isDirty(settings, draftFrom(settings), { kind: 'replace', value: 'x' })).toBe(true);
    expect(isDirty(settings, draftFrom(settings), { kind: 'clear' })).toBe(true);
    expect(isDirty(settings, { ...draftFrom(settings), attackMode: true }, { kind: 'keep' })).toBe(true);
  });

  it('needs both keys for an external provider, unless the environment provides them', () => {
    const settings = saved();
    const turnstile = { ...draftFrom(settings), provider: 'turnstile' as const };
    expect(missingKeys(settings, turnstile, { kind: 'keep' })).toBe(true);
    expect(missingKeys(settings, { ...turnstile, siteKey: 's' }, { kind: 'replace', value: 'k' })).toBe(false);
    expect(missingKeys(saved({ secretSet: true }), { ...turnstile, siteKey: 's' }, { kind: 'clear' })).toBe(true);
    expect(missingKeys(saved({ locked: { provider: false, siteKey: true, secretKey: true } }), turnstile, { kind: 'keep' })).toBe(false);
    expect(missingKeys(settings, draftFrom(settings), { kind: 'keep' })).toBe(false);
  });

  it('builds the PUT body: secret set, cleared or left out; locked fields left out; a locked provider unchanged', () => {
    const settings = saved({ secretSet: true });
    const draft = { ...draftFrom(settings), provider: 'turnstile' as const, siteKey: ' s ' };
    expect(buildPutBody(settings, draft, { kind: 'replace', value: ' k ' })).toEqual({
      provider: 'turnstile',
      surfaces: settings.surfaces,
      options: settings.options,
      attackMode: false,
      siteKey: 's',
      secretKey: 'k',
    });
    expect(buildPutBody(settings, draft, { kind: 'clear' }).secretKey).toBeNull();
    expect(buildPutBody(settings, draft, { kind: 'keep' })).not.toHaveProperty('secretKey');
    expect(buildPutBody(settings, { ...draft, siteKey: '' }, { kind: 'keep' }).siteKey).toBeNull();

    const locked = saved({ provider: 'recaptcha', locked: { provider: true, siteKey: true, secretKey: true } });
    const body = buildPutBody(locked, { ...draftFrom(locked), provider: 'altcha' }, { kind: 'clear' });
    expect(body.provider).toBe('recaptcha');
    expect(body).not.toHaveProperty('siteKey');
    expect(body).not.toHaveProperty('secretKey');
  });

  it('tests with the unsaved values only where there are some', () => {
    const settings = saved({ provider: 'turnstile', siteKey: 'saved', secretSet: true });
    expect(buildTestBody(settings, draftFrom(settings), { kind: 'keep' })).toEqual({ provider: 'turnstile', siteKey: 'saved' });
    expect(buildTestBody(settings, { ...draftFrom(settings), siteKey: '' }, { kind: 'replace', value: 'new' })).toEqual({
      provider: 'turnstile',
      secretKey: 'new',
    });
  });

  it('reads test results and times', () => {
    expect(parseTestResult({ result: 'unreachable', detail: 'timeout' })).toEqual({ result: 'unreachable', detail: 'timeout' });
    expect(parseTestResult({ result: 'bad_hostname' })).toBeNull();
    expect(isFuture('2026-10-04T10:05:00.000Z', Date.parse('2026-10-04T10:00:00.000Z'))).toBe(true);
    expect(isFuture('2026-10-04T09:55:00.000Z', Date.parse('2026-10-04T10:00:00.000Z'))).toBe(false);
    expect(isFuture(null)).toBe(false);
  });
});
