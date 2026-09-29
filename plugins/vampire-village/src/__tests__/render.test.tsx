/**
 * Server-renders the real panel in every phase, for several seats, from
 * views shaped exactly like the core projector's output — no crash, the
 * right controls for the right role, and no secret in the wrong markup.
 *
 */
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { vampireVillagePlugin } from '../index';
import { Game, asViewFor, ids, nightOne, playNightOne, startedGame } from './helpers';

function panel(g: Game, viewer: string | undefined, host = 'p1'): ReactNode {
  return vampireVillagePlugin.renderClient({
    state: asViewFor(g.state, viewer),
    dispatch: () => {},
    actorUserId: viewer ?? 'stranger',
    hostUserId: host,
    players: [{ userId: 'p1', name: 'Ada Display' }],
  });
}

const html = (g: Game, viewer: string | undefined, host = 'p1') => renderToStaticMarkup(panel(g, viewer, host));

describe('renderClient', () => {
  it('returns an element instead of calling the panel (its hooks stay its own)', () => {
    const g = startedGame(6);
    expect(isValidElement(panel(g, 'p1'))).toBe(true);
    expect(() => panel(g, 'p1')).not.toThrow();
  });
});

describe('the panel, rendered', () => {
  it('lobby: create a character, ready up, and the host’s start button', () => {
    const g = new Game();
    let out = html(g, 'p1');
    expect(out).toContain('Create your character');
    expect(out).toContain('value="Ada Display"'); // the host's display name prefills the form
    expect(out).toContain('Waiting for villagers');
    g.lobby(ids(5));
    out = html(g, 'p1');
    expect(out).toContain('Start the game');
    expect(out).toContain('I’m ready');
    expect(out).toContain('aria-label="Remove Bram"');
    out = html(g, 'p9');
    expect(out).toContain('Waiting for the host to start the game.');
    expect(out).not.toContain('Start the game');
  });

  it('role reveal: the pack sees each other; a spectator sees nothing secret', () => {
    const g = startedGame(8); // p1 + p2 vampires
    const vampire = html(g, 'p1');
    expect(vampire).toContain('Your pack: Bram');
    expect(vampire).toContain('Pack chat');
    const seer = html(g, 'p3');
    expect(seer).toContain('Seer');
    expect(seer).not.toContain('Pack chat');
    expect(seer).not.toContain('Your pack');
    const spectator = html(g, 'stranger');
    expect(spectator).toContain('The roles are being dealt');
    expect(spectator).not.toContain('Your role');
  });

  it('night: each role gets its own job, and only the pack sees the clock', () => {
    const g = nightOne(7);
    const vampire = html(g, 'p1');
    expect(vampire).toContain('aria-label="Bite Bram"');
    expect(vampire).toContain('role="timer"');
    const seer = html(g, 'p2');
    expect(seer).toContain('aria-label="Look into Ada"');
    expect(seer).not.toContain('Bite');
    expect(seer).not.toContain('role="timer"');
    expect(seer).toContain('Night…');
    expect(html(g, 'p3')).toContain('aria-label="Protect Cleo"');
    expect(html(g, 'p4')).toContain('Raise a shield');
    expect(html(g, 'p5')).toContain('The first night is quiet');
    expect(html(g, 'p6')).toContain('The village sleeps. Stay quiet in voice until morning.');
  });

  it('a villager’s markup never carries the pack chat', () => {
    const g = nightOne(6);
    g.act({ type: 'pack-chat', playerId: 'p1', text: 'the doctor is Cleo' });
    expect(html(g, 'p1')).toContain('the doctor is Cleo');
    for (const viewer of ['p2', 'p3', 'p4', 'p5', 'p6', 'stranger']) {
      expect(html(g, viewer), viewer).not.toContain('the doctor is Cleo');
    }
  });

  it('dawn, discussion, the vote and the end screen', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    let out = html(g, 'p2');
    expect(out).toContain('Morning news');
    expect(out).toContain('Fenn was bitten by the vampires.');
    expect(out).toContain('Night 1: Ada is a Vampire.'); // the seer's private result
    expect(html(g, 'p3')).not.toContain('Ada is a Vampire');
    g.skip();
    out = html(g, 'p3');
    expect(out).toContain('Fenn was found at dawn');
    expect(out).toContain('Village chat');
    g.skip();
    out = html(g, 'p3');
    expect(out).toContain('aria-label="Vote for Ada"');
    expect(out).toContain('aria-label="Vote to hang no one"');
    expect(out).toContain('A majority of the living is needed: 3 votes.');
    expect(html(g, 'p6')).toContain('Only living villagers vote.');
    for (const voter of ['p2', 'p3', 'p4', 'p5']) g.vote(voter, 'p1');
    g.vote('p1', 'p2');
    out = html(g, 'p3');
    expect(out).toContain('The village wins!');
    expect(out).toContain('Everyone’s role');
    expect(out).toContain('Bram (Seer) looked into Ada: Vampire.');
    expect(out).not.toContain('Play again');
    expect(html(g, 'p1', 'p1')).toContain('Play again');
  });

  it('shows the host their controls, named for the phase', () => {
    const g = nightOne(6);
    expect(html(g, 'p1', 'p1')).toContain('End the night');
    expect(html(g, 'p2', 'p1')).not.toContain('Host controls');
  });

  it('speaks Turkish when the host asks for it', () => {
    const g = nightOne(6);
    const doc = { documentElement: { dataset: { lfLocale: 'tr' }, lang: 'tr' } };
    (globalThis as { document?: unknown }).document = doc;
    try {
      const out = html(g, 'p2');
      expect(out).toContain('Rolün');
      expect(out).toContain('Büyücü');
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});
