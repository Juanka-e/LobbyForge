/**
 * AUTHZ-006 follow-up: the lobby turns the token route's 403
 * `voice_blocked` into a translated notice with the minutes left, instead
 * of the server's English `error` text.
 */
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../i18n/core';
import { loadMessages } from '../i18n/catalogue';
import { VOICE_BLOCKED_CODE, voiceBlockedNotice } from '../voice-block-notice';

describe('voiceBlockedNotice', () => {
  it('maps a voice_blocked body to the catalogue key, rounding the seconds left UP to minutes', () => {
    expect(VOICE_BLOCKED_CODE).toBe('voice_blocked');
    expect(voiceBlockedNotice({ error: 'English text', code: 'voice_blocked', retryAfter: 600 })).toEqual({
      key: 'lobby.voice.error.voiceBlocked',
      params: { minutes: 10 },
    });
    expect(voiceBlockedNotice({ code: 'voice_blocked', retryAfter: 61 })?.params.minutes).toBe(2);
    expect(voiceBlockedNotice({ code: 'voice_blocked', retryAfter: 5 })?.params.minutes).toBe(1);
  });

  it('falls back to one minute when retryAfter is missing or nonsense', () => {
    for (const retryAfter of [undefined, 0, -3, 'soon', Number.NaN]) {
      expect(voiceBlockedNotice({ code: 'voice_blocked', retryAfter })?.params.minutes).toBe(1);
    }
  });

  it('ignores every other error body', () => {
    expect(voiceBlockedNotice({ error: 'Voice room is full' })).toBeNull();
    expect(voiceBlockedNotice({ code: 'approval_required' })).toBeNull();
    expect(voiceBlockedNotice(null)).toBeNull();
    expect(voiceBlockedNotice('voice_blocked')).toBeNull();
  });

  it.each([
    ['en', 1, /in 1 minute\.$/],
    ['en', 30, /in 30 minutes\.$/],
    ['tr', 1, /1 dakika sonra/],
    ['tr', 120, /120 dakika sonra/],
  ])('renders in %s for %i minute(s)', (locale, minutes, expected) => {
    const t = createTranslator(locale, loadMessages(locale));
    const notice = voiceBlockedNotice({ code: 'voice_blocked', retryAfter: minutes * 60 })!;
    const text = t(notice.key, notice.params);
    expect(text).not.toBe(notice.key);
    expect(text).toMatch(expected);
  });
});
