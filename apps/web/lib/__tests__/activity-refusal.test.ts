import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translatorFor } from '@/lib/i18n/catalogue';
import {
  SHARED_REFUSAL_CODES,
  SHARED_REFUSAL_KEYS,
  activityRefusalMessage,
  parseActivityRefusal,
} from '../activity-refusal';

const translator = (locale: string) => translatorFor(locale);

function say(locale: string, status: number, code: string | null, during: 'start' | 'session' = 'session') {
  const message = activityRefusalMessage({ status, code }, during);
  return translator(locale)(message.key, message.params);
}

describe('parseActivityRefusal', () => {
  it('reads the code and the running session', () => {
    expect(parseActivityRefusal(409, { error: 'x', code: 'activity_exists', sessionId: 's-1' })).toEqual({
      status: 409,
      code: 'activity_exists',
      sessionId: 's-1',
    });
  });

  it('accepts the older `{ activity }` conflict and junk bodies', () => {
    expect(parseActivityRefusal(409, { activity: { id: 's-2' } })).toEqual({ status: 409, code: null, sessionId: 's-2' });
    expect(parseActivityRefusal(500, null)).toEqual({ status: 500, code: null, sessionId: null });
    expect(parseActivityRefusal(400, ['nope'])).toEqual({ status: 400, code: null, sessionId: null });
    expect(parseActivityRefusal(400, { code: 42 })).toEqual({ status: 400, code: null, sessionId: null });
  });
});

describe('activityRefusalMessage', () => {
  it('says each shared code in English and Turkish, never the server text', () => {
    const en = translator('en');
    const tr = translator('tr');
    for (const code of SHARED_REFUSAL_CODES) {
      const key = SHARED_REFUSAL_KEYS[code];
      expect(activityRefusalMessage({ status: 403, code }).key).toBe(key);
      expect(en(key)).not.toBe(key);
      expect(tr(key)).not.toBe(key);
      expect(tr(key)).not.toBe(en(key));
    }
  });

  it('uses the wording the brief asks for', () => {
    expect(say('en', 403, 'voice_required')).toBe('Join the voice channel to play.');
    expect(say('tr', 403, 'voice_required')).toBe('Oynamak için sesli kanala katıl.');
    expect(say('en', 503, 'bot_offline')).toBe('This bot is offline right now.');
    expect(say('tr', 503, 'bot_offline')).toBe('Bu bot şu anda çevrimdışı.');
    expect(say('en', 403, 'not_host')).toBe('Only the host can do that.');
    expect(say('en', 409, 'session_ended')).toBe('This activity has ended.');
    expect(say('en', 409, 'activity_exists')).toBe('An activity is already running in this channel.');
  });

  it('knows the activity-only codes', () => {
    expect(say('en', 409, 'wrong_phase')).toBe("That can't be done at this point in the game.");
    expect(say('tr', 403, 'not_player')).toBe('Bunu yalnızca bu oyundaki oyuncular yapabilir.');
    expect(say('en', 403, 'app_channel_not_allowed')).toMatch(/limited it to other channels/);
  });

  it('falls back by status, in the reader’s language', () => {
    expect(say('en', 429, null)).toBe("You're going too fast. Wait a moment and try again.");
    expect(say('en', 401, null)).toBe('Your session has ended. Sign in again.');
    expect(say('en', 403, null)).toBe("You can't do that in this activity.");
    expect(say('en', 0, null)).toBe('Could not reach the server. Check your connection.');
    expect(say('en', 500, 'something_new')).toBe("That didn't work (error 500). Try again.");
    expect(say('tr', 500, null)).toBe('Bu işlem yapılamadı (hata 500). Tekrar dene.');
  });

  it('reads a 404 as an ended session only for a session, not for a start', () => {
    expect(say('en', 404, null, 'session')).toBe('This activity has ended.');
    expect(say('en', 404, null, 'start')).toBe("That didn't work (error 404). Try again.");
  });
});

describe('agreement with the server-side builder (lib/activity-errors.ts)', () => {
  // The builder imports next/server, so its code union is read from source.
  const source = readFileSync(join(process.cwd(), 'lib', 'activity-errors.ts'), 'utf8');
  const union = source.slice(source.indexOf('export type ActivityErrorCode'), source.indexOf('export function activityError'));
  const serverCodes = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

  it('knows every code the activity routes send, with its own sentence', () => {
    expect(serverCodes.length).toBeGreaterThan(0);
    for (const code of serverCodes) {
      expect(activityRefusalMessage({ status: 400, code }).key, code).not.toBe('room.activity.error.generic');
    }
  });

  it('covers the agreed set: the activity codes plus the slash route’s bot_offline', () => {
    expect([...new Set([...serverCodes, 'bot_offline'])].sort()).toEqual(
      ['activity_exists', 'bot_offline', 'not_host', 'not_player', 'rate_limited', 'session_ended', 'voice_required', 'wrong_phase']
    );
  });
});
