import { describe, expect, it } from 'vitest';
import { validateVillageAction } from '../validate';

const ok = (action: unknown) => expect(validateVillageAction(action), JSON.stringify(action)).toBeNull();
const bad = (action: unknown) => expect(validateVillageAction(action), JSON.stringify(action)).toEqual(expect.any(String));

describe('validateVillageAction', () => {
  it('rejects anything that is not an action object', () => {
    for (const junk of [null, undefined, 1, 'join', [], {}, { type: 3 }, { type: 'dance' }]) bad(junk);
  });

  it('accepts every well-formed action', () => {
    ok({ type: 'join', playerId: 'u1', name: 'Ada' });
    ok({ type: 'join', playerId: 'u1', name: 'Ada', color: 'mint' });
    ok({ type: 'leave', playerId: 'u1' });
    ok({ type: 'set-ready', playerId: 'u1', ready: true });
    ok({ type: 'configure', settings: { nightSeconds: 45 } });
    ok({ type: 'configure', settings: {} });
    ok({ type: 'start' });
    ok({ type: 'kick', targetId: 'u2' });
    ok({ type: 'advance', phaseId: 3 });
    ok({ type: 'timeout', playerId: 'u1', phaseId: 0 });
    ok({ type: 'pause' });
    ok({ type: 'resume' });
    ok({ type: 'extend', seconds: 30 });
    ok({ type: 'extend', seconds: -30 });
    ok({ type: 'night-target', playerId: 'u1', targetId: 'u2' });
    ok({ type: 'night-target', playerId: 'u1', targetId: null });
    ok({ type: 'night-shield', playerId: 'u1', raise: false });
    ok({ type: 'vote', playerId: 'u1', targetId: 'u2' });
    ok({ type: 'vote', playerId: 'u1', targetId: null });
    ok({ type: 'chat', playerId: 'u1', text: 'hello' });
    ok({ type: 'pack-chat', playerId: 'u1', text: 'hello' });
    ok({ type: 'play-again' });
    ok({ type: 'end-game' });
  });

  it('needs the actor id the host injects', () => {
    bad({ type: 'join', name: 'Ada' });
    bad({ type: 'vote', playerId: '', targetId: 'u2' });
    bad({ type: 'chat', playerId: 42, text: 'x' });
    bad({ type: 'timeout', phaseId: 1 });
  });

  it('checks the field types of each action', () => {
    bad({ type: 'join', playerId: 'u1', name: 5 });
    bad({ type: 'join', playerId: 'u1', name: 'x'.repeat(200) });
    bad({ type: 'join', playerId: 'u1', name: 'Ada', color: 7 });
    bad({ type: 'set-ready', playerId: 'u1', ready: 'yes' });
    bad({ type: 'configure', settings: 'fast' });
    bad({ type: 'configure', settings: { nightSeconds: '30' } });
    bad({ type: 'configure', settings: { nightSeconds: Number.POSITIVE_INFINITY } });
    bad({ type: 'kick' });
    bad({ type: 'advance' });
    bad({ type: 'advance', phaseId: 1.5 });
    bad({ type: 'advance', phaseId: -1 });
    bad({ type: 'extend', seconds: 0 });
    bad({ type: 'extend', seconds: 10_000 });
    bad({ type: 'night-target', playerId: 'u1' });
    bad({ type: 'night-target', playerId: 'u1', targetId: 3 });
    bad({ type: 'night-shield', playerId: 'u1', raise: 1 });
    bad({ type: 'vote', playerId: 'u1' });
    bad({ type: 'chat', playerId: 'u1', text: '' });
    bad({ type: 'chat', playerId: 'u1', text: '    ' });
    bad({ type: 'chat', playerId: 'u1', text: 'x'.repeat(1_000) });
    bad({ type: 'pack-chat', playerId: 'u1' });
  });

  it('refuses ids that are absurdly long', () => {
    bad({ type: 'kick', targetId: 'x'.repeat(500) });
    bad({ type: 'vote', playerId: 'u1', targetId: 'x'.repeat(500) });
  });
});
