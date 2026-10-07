/**
 * Browser test finding: a member who joined after you loaded the lobby
 * showed as their raw user id in the voice list and on Hushle's bench.
 * The name now comes from their LiveKit token, then from the names the
 * page loaded; otherwise the host shows "Unknown member" and the game
 * panel gets `null` (it has its own wording) — never the id.
 */
import { describe, expect, it } from 'vitest';
import { resolveParticipantName } from '../participant-name';
import { buildPanelPlayers } from '../panel-players';

const LATE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const EARLY = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

describe('resolveParticipantName', () => {
  it('prefers the name from the participant’s own token', () => {
    expect(resolveParticipantName(LATE, 'Zeynep', {})).toBe('Zeynep');
    expect(resolveParticipantName(EARLY, 'Ada (nick)', { [EARLY]: 'Ada' })).toBe('Ada (nick)');
  });

  it('falls back to the names the page loaded', () => {
    expect(resolveParticipantName(EARLY, '', { [EARLY]: 'Ada' })).toBe('Ada');
    expect(resolveParticipantName(EARLY, undefined, { [EARLY]: 'Ada' })).toBe('Ada');
  });

  it('never returns the identity', () => {
    expect(resolveParticipantName(LATE, '', {})).toBeNull();
    expect(resolveParticipantName(LATE, LATE, {})).toBeNull();
    expect(resolveParticipantName(LATE, '   ', { [LATE]: LATE })).toBeNull();
  });
});

describe('buildPanelPlayers', () => {
  it('names a late joiner from the voice room and passes null for an unknown one', () => {
    const players = buildPanelPlayers(
      [{ userId: EARLY, name: 'Ada' }],
      [
        { identity: EARLY, name: 'Ada' },
        { identity: LATE, name: 'Zeynep', nameKnown: true },
        { identity: 'u-unknown', name: 'Unknown member', nameKnown: false },
      ]
    );
    expect(players).toEqual([
      { userId: EARLY, name: 'Ada' },
      { userId: LATE, name: 'Zeynep' },
      { userId: 'u-unknown', name: null },
    ]);
  });

  it('fills a roster entry without a name from the voice room, and never uses an id as a name', () => {
    const players = buildPanelPlayers(
      [
        { userId: LATE, name: null },
        { userId: EARLY, name: EARLY },
      ],
      [{ identity: LATE, name: 'Zeynep' }, { identity: EARLY, name: EARLY }]
    );
    expect(players).toEqual([
      { userId: LATE, name: 'Zeynep' },
      { userId: EARLY, name: null },
    ]);
  });
});
