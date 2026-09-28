/**
 * The panel's pure helpers, run against views shaped exactly like the
 * core projector's output (see `asViewFor` in ./helpers).
 */
import { describe, expect, it } from 'vitest';
import type { VillageState } from '../state';
import {
  canChat,
  canWhisper,
  lastNightNews,
  nightTaskFor,
  nightTargets,
  packTally,
  startBlockers,
  timeoutDelayMs,
  todaysVerdict,
  voteTally,
  type VillageView,
} from '../view';
import { Game, asViewFor, ids, nightOne, playNightOne, startedGame } from './helpers';

const view = (g: Game, viewer: string | undefined): VillageView => asViewFor(g.state as VillageState, viewer);

describe('asViewFor (the test mirror of the core projector)', () => {
  it('drops the secret block and builds `me`', () => {
    const g = nightOne(6);
    g.target('p1', 'p6');
    const v = view(g, 'p1');
    expect(v).not.toHaveProperty('secret');
    expect(v.me).toMatchObject({ id: 'p1', role: 'vampire', alive: true, choice: { kind: 'bite', targetId: 'p6' } });
    expect(v.me?.pack?.members).toEqual(['p1']);
    expect(view(g, 'p6').me?.pack).toBeNull();
    expect(view(g, 'nobody').me).toBeNull();
  });
});

describe('nightTaskFor', () => {
  it('matches each role to its night job', () => {
    const g = nightOne(7);
    expect(nightTaskFor(view(g, 'p1'))).toEqual({ kind: 'bite' });
    expect(nightTaskFor(view(g, 'p2'))).toEqual({ kind: 'inspect' });
    expect(nightTaskFor(view(g, 'p3'))).toEqual({ kind: 'protect', blockedId: null });
    expect(nightTaskFor(view(g, 'p4'))).toEqual({ kind: 'shield', shields: 3 });
    expect(nightTaskFor(view(g, 'p5'))).toEqual({ kind: 'hunter-waits' });
    expect(nightTaskFor(view(g, 'p6'))).toEqual({ kind: 'sleep' });
    expect(nightTaskFor(view(g, 'p7'))).toEqual({ kind: 'sleep' });
    expect(nightTaskFor(view(g, 'watcher'))).toEqual({ kind: 'watch' });
  });

  it('knows about spent resources and the dead', () => {
    const g = nightOne(6);
    g.state = {
      ...g.state,
      round: 2,
      secret: {
        ...g.state.secret,
        resources: { p3: { lastProtectedId: 'p2' }, p4: { shields: 0 }, p5: { bullets: 1 } },
      },
    };
    expect(nightTaskFor(view(g, 'p3'))).toEqual({ kind: 'protect', blockedId: 'p2' });
    expect(nightTaskFor(view(g, 'p4'))).toEqual({ kind: 'out-of-shields' });
    expect(nightTaskFor(view(g, 'p5'))).toEqual({ kind: 'shoot', bullets: 1 });
    g.act({ type: 'leave', playerId: 'p6' });
    expect(nightTaskFor(view(g, 'p6'))).toEqual({ kind: 'dead' });
  });
});

describe('nightTargets', () => {
  it('lists who each role may pick', () => {
    const g = nightOne(8); // p1, p2 vampires
    const names = (viewer: string) => nightTargets(view(g, viewer)).map((p) => p.id);
    expect(names('p1')).toEqual(['p3', 'p4', 'p5', 'p6', 'p7', 'p8']); // no fellow vampires
    expect(names('p3')).toEqual(['p1', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8']); // the seer: not themself
    expect(names('p4')).toEqual(ids(8)); // the doctor may protect themself
    expect(names('p8')).toEqual([]); // a villager has nothing to pick
  });
});

describe('packTally', () => {
  it('shows who each vampire picked and whether the pack agrees', () => {
    const g = nightOne(8);
    g.target('p1', 'p8');
    let tally = packTally(view(g, 'p1'));
    expect(tally.needed).toBe(2);
    expect(tally.byTarget).toEqual({ p8: ['p1'] });
    expect(tally.agreedId).toBeNull();
    g.target('p2', 'p8');
    tally = packTally(view(g, 'p2'));
    expect(tally.byTarget).toEqual({ p8: ['p1', 'p2'] });
    expect(tally.agreedId).toBe('p8');
  });

  it('is empty for anyone outside the pack', () => {
    const g = nightOne(8);
    g.target('p1', 'p8');
    expect(packTally(view(g, 'p3'))).toEqual({ needed: 0, byTarget: {}, agreedId: null });
  });
});

describe('voteTally', () => {
  it('counts the living votes, "no one" included, in seat order so rows never jump', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    g.skip();
    g.skip();
    g.vote('p2', 'p1');
    g.vote('p3', 'p1');
    g.vote('p4', null);
    const tally = voteTally(view(g, 'p2'));
    expect(tally.needed).toBe(3);
    expect(tally.living).toBe(5);
    expect(tally.voted).toBe(3);
    expect(tally.rows.map((r) => [r.id, r.voters])).toEqual([
      ['p1', ['p2', 'p3']],
      ['p2', []],
      ['p3', []],
      ['p4', []],
      ['p5', []],
    ]);
    expect(tally.skip).toEqual(['p4']);
    expect(tally.leaderId).toBe('p1');
  });
});

describe('dawn and verdict news', () => {
  it('collects last night’s public events for the dawn announcement', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    expect(lastNightNews(view(g, 'p2')).map((e) => e.kind)).toEqual(['death']);
    const q = nightOne(6);
    playNightOne(q, { victim: 'p6', doctorTarget: 'p6' });
    expect(lastNightNews(view(q, 'p2')).map((e) => e.kind)).toEqual(['quiet-night', 'attack-stopped']);
  });

  it('finds today’s vote result for the verdict', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    g.skip();
    g.skip();
    for (const voter of ['p2', 'p3', 'p4']) g.vote(voter, 'p5');
    g.expire();
    expect(todaysVerdict(view(g, 'p2'))).toMatchObject({ kind: 'vote-result', hangedId: 'p5' });
  });
});

describe('who may talk', () => {
  it('opens the public chat to the living by day and the pack chat to living vampires at night', () => {
    const g = nightOne(6);
    expect(canChat(view(g, 'p2'))).toBe(false);
    expect(canWhisper(view(g, 'p1'))).toBe(true);
    expect(canWhisper(view(g, 'p2'))).toBe(false);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    expect(canChat(view(g, 'p2'))).toBe(true);
    expect(canChat(view(g, 'p6'))).toBe(false);
    expect(canChat(view(g, 'watcher'))).toBe(false);
    expect(canWhisper(view(g, 'p1'))).toBe(false);
  });
});

describe('startBlockers', () => {
  it('explains why the host cannot start yet', () => {
    const g = new Game();
    g.lobby(ids(3));
    expect(startBlockers(view(g, 'p1'))).toEqual({ needPlayers: 2, waitingFor: [] });
    g.lobby(ids(5));
    g.ready('p4', false);
    expect(startBlockers(view(g, 'p1'))).toEqual({ needPlayers: 0, waitingFor: ['p4'] });
    g.ready('p4');
    expect(startBlockers(view(g, 'p1'))).toBeNull();
  });
});

describe('timeoutDelayMs', () => {
  it('lets the host report first, then the seats in order, then everyone else', () => {
    const g = startedGame(6);
    const v = view(g, 'p1');
    expect(timeoutDelayMs(v, 'host-user', 'host-user')).toBeLessThan(timeoutDelayMs(v, 'p1', 'host-user'));
    expect(timeoutDelayMs(v, 'p1', 'host-user')).toBeLessThan(timeoutDelayMs(v, 'p2', 'host-user'));
    expect(timeoutDelayMs(v, 'p6', 'host-user')).toBeLessThan(timeoutDelayMs(v, 'watcher', 'host-user'));
  });
});
