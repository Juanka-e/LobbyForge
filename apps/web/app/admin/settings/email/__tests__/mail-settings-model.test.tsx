import { describe, expect, it } from 'vitest';
import { MAIL_PROVIDERS, getMailProvider } from '@/lib/mail/providers';
import { MAIL_TEST_DETAILS, MAIL_TEST_RESULTS } from '@/lib/mail/types';
import enMessages from '@/messages/en/adminSettings.json';
import trMessages from '@/messages/tr/adminSettings.json';
import {
  applyPort,
  breaksRequiredTransport,
  passwordMissing,
  passwordMustBeReentered,
  reenablingRequiredSince,
  transportLockedByRequired,
  applyPreset,
  buildPutBody,
  buildTestBody,
  dateInputToIso,
  draftFrom,
  draftIssues,
  groupProviders,
  isConnectionDirty,
  isDirty,
  isoToDateInput,
  parseAdminMailSettings,
  parseTestOutcome,
  requiredBlockedReason,
  splitDomains,
  type AdminMailSettings,
} from '../mail-settings-model';
import { testDetailKey, testResultKey } from '../EmailSettingsCard';

function saved(overrides: Partial<AdminMailSettings> = {}): AdminMailSettings {
  return {
    provider: 'ses',
    region: 'eu-central-1',
    host: 'email-smtp.eu-central-1.amazonaws.com',
    port: 587,
    security: 'starttls',
    username: 'AKIA-SMTP',
    passwordSet: true,
    passwordHint: '…wxyz',
    from: 'LobbyForge <no-reply@example.org>',
    dailyLimit: null,
    sentToday: 3,
    lastTest: { at: '2026-10-04T09:00:00.000Z', result: 'ok' },
    verification: {
      mode: 'optional',
      scope: { open_register: true, invite_register: false },
      enforcedSince: null,
      existingDeadline: null,
    },
    disposable: { block: false, allow: [], blockExtra: [] },
    locked: { provider: false, host: false, port: false, security: false, username: false, password: false, from: false, verification: false },
    ...overrides,
  };
}

const ses = getMailProvider('ses')!;
const brevo = getMailProvider('brevo')!;
const custom = getMailProvider('custom')!;

describe('email admin model (EMAIL.md §5)', () => {
  it('reads the GET shape, filling defaults', () => {
    expect(parseAdminMailSettings({ provider: 'none', locked: { host: true } })).toMatchObject({
      provider: 'none',
      host: null,
      port: null,
      passwordSet: false,
      sentToday: 0,
      lastTest: { at: null, result: null },
      verification: { mode: 'off', scope: { open_register: true, invite_register: false } },
      disposable: { block: false, allow: [], blockExtra: [] },
      locked: { provider: false, host: true },
    });
    expect(parseAdminMailSettings({ error: 'forbidden' })).toBeNull();
    expect(parseAdminMailSettings({ provider: 'ses', lastTest: { result: 'maybe' } })!.lastTest.result).toBeNull();
  });

  it('a preset fills host, port and security; a region picks its host', () => {
    const draft = draftFrom(saved({ provider: 'none', host: null, port: null, security: null, region: null }));
    const withSes = applyPreset(draft, ses, 'ses');
    expect(withSes).toMatchObject({ provider: 'ses', region: 'eu-central-1', host: 'email-smtp.eu-central-1.amazonaws.com', port: '587', security: 'starttls' });
    const withBrevo = applyPreset(withSes, brevo, 'brevo');
    expect(withBrevo).toMatchObject({ provider: 'brevo', region: null, host: 'smtp-relay.brevo.com', port: '587' });
    // A port from the list brings its security with it.
    expect(applyPort(withBrevo, brevo, '465')).toMatchObject({ port: '465', security: 'tls' });
    // Custom starts with an empty host instead of another provider's.
    expect(applyPreset(withBrevo, custom, 'custom')).toMatchObject({ provider: 'custom', host: '' });
    expect(applyPreset(withBrevo, null, 'none')).toMatchObject({ provider: 'none' });
  });

  it('groups the registry the way the picker shows it', () => {
    const groups = groupProviders(MAIL_PROVIDERS);
    expect(groups.professional.map((p) => p.id)).toEqual(['ses', 'scaleway']);
    expect(groups.free.map((p) => p.id)).toEqual(['brevo', 'smtp2go', 'resend', 'mailjet', 'mailgun', 'gmail']);
    expect(groups.custom.map((p) => p.id)).toEqual(['custom']);
    expect(groups.development.map((p) => p.id)).toEqual(['mailpit']);
  });

  it('notices changes, and connection changes on their own', () => {
    const settings = saved();
    const draft = draftFrom(settings);
    expect(isDirty(settings, draft, { kind: 'keep' })).toBe(false);
    expect(isDirty(settings, { ...draft, allow: '  Example.org\n' }, { kind: 'keep' })).toBe(true);
    expect(isConnectionDirty(settings, { ...draft, allow: 'example.org' }, { kind: 'keep' })).toBe(false);
    expect(isConnectionDirty(settings, { ...draft, port: '2587' }, { kind: 'keep' })).toBe(true);
    expect(isConnectionDirty(settings, draft, { kind: 'replace', value: 'secret' })).toBe(true);
    expect(isDirty(settings, draft, { kind: 'replace', value: '' })).toBe(false);
  });

  it('keeps Required closed until the saved settings passed a RECENT test', () => {
    // saved() tested at 2026-10-04T09:00Z; an hour later counts, two days later does not.
    const NOW = Date.parse('2026-10-04T10:00:00.000Z');
    const settings = saved();
    const draft = draftFrom(settings);
    expect(requiredBlockedReason(settings, draft, { kind: 'keep' }, NOW)).toBe('none');
    expect(requiredBlockedReason(saved({ lastTest: { at: null, result: null } }), draft, { kind: 'keep' }, NOW)).toBe('noPassingTest');
    expect(requiredBlockedReason(saved({ lastTest: { at: 'x', result: 'auth' } }), draft, { kind: 'keep' }, NOW)).toBe('noPassingTest');
    expect(requiredBlockedReason(settings, { ...draft, host: 'other.example.org' }, { kind: 'keep' }, NOW)).toBe('unsavedConnection');
    expect(requiredBlockedReason(settings, { ...draft, provider: 'none' }, { kind: 'keep' }, NOW)).toBe('noTransport');
    expect(requiredBlockedReason(settings, draft, { kind: 'keep' }, Date.parse('2026-10-06T10:00:00.000Z'))).toBe('staleTest');
    // Already required: nothing to unlock.
    const required = saved({ lastTest: { at: null, result: null }, verification: { ...saved().verification, mode: 'required' } });
    expect(requiredBlockedReason(required, draftFrom(required), { kind: 'keep' }, NOW)).toBe('none');
  });

  it('keeps a working transport while Required is chosen', () => {
    const settings = saved();
    const required = { ...draftFrom(settings), mode: 'required' as const };
    expect(transportLockedByRequired(required)).toBe(true);
    expect(breaksRequiredTransport(settings, { ...required, provider: 'none' }, { kind: 'keep' })).toBe(true);
    expect(breaksRequiredTransport(settings, required, { kind: 'clear' })).toBe(true);
    expect(breaksRequiredTransport(settings, required, { kind: 'keep' })).toBe(false);
    expect(breaksRequiredTransport(settings, { ...draftFrom(settings), provider: 'none' }, { kind: 'clear' })).toBe(false);
  });

  it('asks for the password again when the provider, host or user name changes', () => {
    const settings = saved();
    const draft = draftFrom(settings);
    expect(passwordMustBeReentered(settings, draft)).toBe(false);
    expect(passwordMustBeReentered(settings, { ...draft, port: '2587' })).toBe(false);
    expect(passwordMustBeReentered(settings, { ...draft, username: 'other' })).toBe(true);
    expect(passwordMustBeReentered(settings, { ...draft, host: 'email-smtp.us-east-1.amazonaws.com' })).toBe(true);
    expect(passwordMustBeReentered(settings, applyPreset(draft, brevo, 'brevo'))).toBe(true);
    // Not for no email, Mailpit, a server without sign-in, or an environment password.
    expect(passwordMustBeReentered(settings, { ...draft, provider: 'none' })).toBe(false);
    expect(passwordMustBeReentered(settings, { ...draft, provider: 'mailpit' })).toBe(false);
    expect(passwordMustBeReentered(settings, { ...draft, provider: 'custom', host: 'mail.example.org', username: '' })).toBe(false);
    expect(passwordMustBeReentered(saved({ locked: { ...saved().locked, password: true } }), { ...draft, username: 'other' })).toBe(false);
    expect(passwordMissing(settings, { ...draft, username: 'other' }, { kind: 'keep' })).toBe(true);
    expect(passwordMissing(settings, { ...draft, username: 'other' }, { kind: 'replace', value: 'pw' })).toBe(false);
  });

  it('knows when turning Required on again reaches back to the first time', () => {
    const optional = saved({ verification: { ...saved().verification, mode: 'optional', enforcedSince: '2026-09-01T00:00:00.000Z' } });
    expect(reenablingRequiredSince(optional, { ...draftFrom(optional), mode: 'required' })).toBe('2026-09-01T00:00:00.000Z');
    expect(reenablingRequiredSince(optional, draftFrom(optional))).toBeNull();
    const fresh = saved({ verification: { ...saved().verification, mode: 'optional', enforcedSince: null } });
    expect(reenablingRequiredSince(fresh, { ...draftFrom(fresh), mode: 'required' })).toBeNull();
  });

  it('builds the PUT body: locked fields keep their saved value, the password is write-only', () => {
    const settings = saved({ locked: { ...saved().locked, host: true, password: true } });
    const draft = { ...draftFrom(settings), host: 'changed.example.org', dailyLimit: '500', allow: 'b.org\nA.org, a.org', existingDeadline: '' };
    const body = buildPutBody(settings, draft, { kind: 'replace', value: 'ignored' });
    expect(body).toMatchObject({
      provider: 'ses',
      region: 'eu-central-1',
      host: 'email-smtp.eu-central-1.amazonaws.com',
      port: 587,
      security: 'starttls',
      username: 'AKIA-SMTP',
      from: 'LobbyForge <no-reply@example.org>',
      dailyLimit: 500,
      verification: { mode: 'optional', scope: { open_register: true, invite_register: false }, existingDeadline: null },
      disposable: { block: false, allow: ['b.org', 'a.org'], blockExtra: [] },
    });
    expect(body).not.toHaveProperty('password');

    const open = saved();
    expect(buildPutBody(open, draftFrom(open), { kind: 'clear' }).password).toBeNull();
    expect(buildPutBody(open, draftFrom(open), { kind: 'replace', value: 's3cret' }).password).toBe('s3cret');
    expect(buildPutBody(open, draftFrom(open), { kind: 'keep' })).not.toHaveProperty('password');
    // "No email" clears the connection.
    expect(buildPutBody(open, { ...draftFrom(open), provider: 'none' }, { kind: 'keep' })).toMatchObject({ provider: 'none', host: null, port: null });
  });

  it('tests the saved settings unless the connection changed', () => {
    const settings = saved();
    const draft = draftFrom(settings);
    expect(buildTestBody(settings, draft, { kind: 'keep' }, '')).toEqual({});
    expect(buildTestBody(settings, draft, { kind: 'keep' }, ' me@example.org ')).toEqual({ to: 'me@example.org' });
    expect(buildTestBody(settings, { ...draft, port: '2587' }, { kind: 'replace', value: 'pw' }, '')).toMatchObject({
      provider: 'ses',
      host: 'email-smtp.eu-central-1.amazonaws.com',
      port: 2587,
      password: 'pw',
    });
  });

  it('checks the form before saving', () => {
    const draft = draftFrom(saved());
    expect(draftIssues(draft)).toEqual([]);
    expect(draftIssues({ ...draft, host: '', port: 'x', from: 'nobody', dailyLimit: '0', blockExtra: 'not a domain!' })).toEqual([
      'host',
      'port',
      'from',
      'dailyLimit',
      'blockExtra',
    ]);
    expect(draftIssues({ ...draft, provider: 'none', host: '', from: '' })).toEqual([]);
  });

  it('turns domain lists and dates around', () => {
    expect(splitDomains(' @Mailinator.com,\n\nexample.org. example.org ')).toEqual(['mailinator.com', 'example.org']);
    const iso = dateInputToIso('2026-12-31')!;
    expect(isoToDateInput(iso)).toBe('2026-12-31');
    expect(dateInputToIso('31/12/2026')).toBeNull();
    expect(isoToDateInput(null)).toBe('');
  });

  it('reads a test answer and has words for every result and detail code', () => {
    expect(parseTestOutcome({ result: 'timeout', detail: 'try_port_2525' })).toEqual({ result: 'timeout', detail: 'try_port_2525' });
    expect(parseTestOutcome({ result: 'exploded' })).toBeNull();
    for (const locale of [enMessages, trMessages] as Array<Record<string, string>>) {
      for (const result of MAIL_TEST_RESULTS) expect(locale[testResultKey(result)], result).toBeTruthy();
      for (const detail of MAIL_TEST_DETAILS) expect(locale[testDetailKey(detail)!], detail).toBeTruthy();
    }
    expect(testDetailKey('free text from the server')).toBeNull();
  });
});
