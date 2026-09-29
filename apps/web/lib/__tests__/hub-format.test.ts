import { describe, expect, it } from 'vitest';
import { COMMUNITY_TINTS, activityTone, initialsFor, playerRange, tintFor } from '../hub-format';

describe('initialsFor', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsFor('Night Owls', 'en')).toBe('NO');
    expect(initialsFor('Study Hall Crew', 'en')).toBe('SH');
  });

  it('uses one letter for a one-word name', () => {
    expect(initialsFor('hushle', 'en')).toBe('H');
  });

  it('upper-cases in the reader’s language', () => {
    // Turkish dotted i: "ı"/"i" upper-case to "I"/"İ", not both to "I".
    expect(initialsFor('istanbul oyuncuları', 'tr')).toBe('İO');
  });

  it('keeps emoji and accented letters whole', () => {
    expect(initialsFor('🎮 Gamers', 'en')).toBe('🎮G');
    expect(initialsFor('Émile Zola', 'fr')).toBe('ÉZ');
  });

  it('never renders an empty tile', () => {
    expect(initialsFor('   ', 'en')).toBe('?');
  });
});

describe('tintFor', () => {
  it('is stable for a community and drawn from the palette', () => {
    const id = '5a1c7a2e-6c2b-4f7c-9a55-1f2e3d4c5b6a';
    expect(tintFor(id)).toBe(tintFor(id));
    expect(COMMUNITY_TINTS).toContain(tintFor(id));
  });

  it('spreads different communities across the palette', () => {
    const tints = new Set(Array.from({ length: 40 }, (_, i) => tintFor(`server-${i}`)));
    expect(tints.size).toBeGreaterThan(3);
  });
});

describe('activityTone', () => {
  it('gives each official activity its own hue with a light-theme pair', () => {
    const ids = ['hushle', 'quiz', 'vampire-village', 'watch-party', 'poll', 'dice-bot'];
    const darks = new Set(ids.map((id) => activityTone(id).dark));
    expect(darks.size).toBe(ids.length);
    for (const id of ids) expect(activityTone(id).light).not.toBe(activityTone(id).dark);
  });

  it('falls back to the accent hue for anything else', () => {
    expect(activityTone('a-community-plugin')).toEqual(activityTone('another-one'));
  });
});

describe('playerRange', () => {
  it('reads a real range from the manifest', () => {
    expect(playerRange({ minPlayers: 4, maxPlayers: 12 })).toEqual({ kind: 'range', min: 4, max: 12 });
  });

  it('says "up to" when a single person can start it', () => {
    expect(playerRange({ minPlayers: 1, maxPlayers: 50 })).toEqual({ kind: 'upTo', max: 50 });
    expect(playerRange({ maxPlayers: 32 })).toEqual({ kind: 'upTo', max: 32 });
  });

  it('shows no count when the manifest does not give one', () => {
    expect(playerRange(null)).toBeNull();
    expect(playerRange(undefined)).toBeNull();
    expect(playerRange({ minPlayers: 2 })).toBeNull();
    expect(playerRange({ maxPlayers: 0 })).toBeNull();
  });
});
