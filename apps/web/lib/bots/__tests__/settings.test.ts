import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODERATION_SETTINGS,
  ModerationSettingsInputSchema,
  WelcomeSettingsInputSchema,
  containsMassMention,
  normalizeBlockedWords,
  normalizeDomain,
  parseModerationSettings,
  parseWelcomeSettings,
} from '../settings';
import { renderBotTemplate } from '../templates';

describe('welcome settings', () => {
  it('reads stored JSON tolerantly', () => {
    expect(parseWelcomeSettings(null)).toEqual({ channelId: null, template: null });
    expect(parseWelcomeSettings({ channelId: 'not-a-uuid', template: '  hi {user} ' })).toEqual({
      channelId: null,
      template: 'hi {user}',
    });
  });

  it('refuses a template that pings everyone', () => {
    expect(WelcomeSettingsInputSchema.safeParse({ template: 'hey @everyone, {user} is here' }).success).toBe(false);
    expect(WelcomeSettingsInputSchema.safeParse({ template: 'mail me@here.com' }).success).toBe(true);
  });

  it('turns an empty template into "use the default"', () => {
    expect(WelcomeSettingsInputSchema.parse({ template: '   ' })).toEqual({ template: null });
  });

  it('rejects unknown keys', () => {
    expect(WelcomeSettingsInputSchema.safeParse({ channelId: null, extra: 1 }).success).toBe(false);
  });
});

describe('moderation settings', () => {
  it('fills defaults and clamps stored numbers', () => {
    expect(parseModerationSettings({})).toEqual(DEFAULT_MODERATION_SETTINGS);
    const parsed = parseModerationSettings({
      maxMentions: 999,
      flood: { max: 1, windowSeconds: 99999 },
      repeat: null,
      linkPolicy: 'weird',
      allowedDomains: ['Example.com', 'not a domain', 'example.com'],
    });
    expect(parsed.maxMentions).toBe(50);
    expect(parsed.flood).toEqual({ max: 2, windowSeconds: 300 });
    expect(parsed.repeat).toBeNull();
    expect(parsed.linkPolicy).toBe('allow');
    expect(parsed.allowedDomains).toEqual(['example.com']);
  });

  it('validates admin input strictly', () => {
    expect(ModerationSettingsInputSchema.safeParse({ maxMentions: -1 }).success).toBe(false);
    expect(ModerationSettingsInputSchema.safeParse({ linkPolicy: 'sometimes' }).success).toBe(false);
    expect(ModerationSettingsInputSchema.safeParse({ allowedDomains: ['not a domain'] }).success).toBe(false);
    expect(ModerationSettingsInputSchema.safeParse({ flood: { max: 1000, windowSeconds: 10 } }).success).toBe(false);
    const ok = ModerationSettingsInputSchema.parse({
      blockedWords: ['  bad   word ', 'BAD WORD', '*', 'salak*'],
      allowedDomains: ['https://www.YouTube.com/watch'],
      flood: null,
    });
    expect(ok.blockedWords).toEqual(['bad word', 'salak*']);
    expect(ok.allowedDomains).toEqual(['youtube.com']);
    expect(ok.flood).toBeNull();
  });

  it('dedupes blocked words Turkish-insensitively', () => {
    expect(normalizeBlockedWords(['SIK', 'sık', 'Sİk'])).toEqual(['SIK']);
  });

  it('normalises domains', () => {
    expect(normalizeDomain('*.Example.com')).toBe('example.com');
    expect(normalizeDomain('http://sub.example.org:8080/path')).toBe('sub.example.org');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('exa mple.com')).toBeNull();
    expect(normalizeDomain('müzik.com.tr')).toBe('xn--mzik-0ra.com.tr');
  });
});

describe('mass mentions', () => {
  it('spots @everyone and @here but not look-alikes', () => {
    expect(containsMassMention('@everyone look')).toBe(true);
    expect(containsMassMention('hey @HERE')).toBe(true);
    expect(containsMassMention('@everyones')).toBe(false);
    expect(containsMassMention('me@here.com')).toBe(false);
  });
});

describe('renderBotTemplate', () => {
  it('fills placeholders literally and keeps other braces', () => {
    expect(renderBotTemplate('Hi {user}, welcome to {server}! {unknown}', { user: 'Ayşe', server: 'Lobi' })).toBe(
      'Hi Ayşe, welcome to Lobi! {unknown}'
    );
  });

  it('cannot be turned into a mass mention by a display name', () => {
    expect(renderBotTemplate('Welcome {user}', { user: '@everyone' })).toBe('Welcome everyone');
    expect(renderBotTemplate('Welcome {user}', { user: 'a\u0000b\nc' })).toBe('Welcome a b c');
  });

  it('caps the result at the message limit', () => {
    expect(renderBotTemplate('{user}'.repeat(100), { user: 'x'.repeat(100) }).length).toBe(4000);
  });
});
