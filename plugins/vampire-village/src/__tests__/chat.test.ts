import { describe, expect, it } from 'vitest';
import { CHAT_KEEP, CHAT_MAX_LENGTH, CHAT_PER_PHASE, PACK_CHAT_KEEP, PACK_CHAT_PER_PHASE } from '../state';
import { Game, nightOne, playNightOne, startedGame } from './helpers';

function dayOne(): Game {
  const g = nightOne(6);
  playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
  g.skip(); // → day
  return g;
}

const say = (g: Game, id: string, text: string) => g.act({ type: 'chat', playerId: id, text });
const whisper = (g: Game, id: string, text: string) => g.act({ type: 'pack-chat', playerId: id, text });

describe('public game chat', () => {
  it('lets the living talk by day, with the text tidied up', () => {
    const g = dayOne();
    say(g, 'p2', '  I   saw\nsomething  ');
    expect(g.state.chat).toEqual([
      { id: expect.any(Number), authorId: 'p2', text: 'I saw something', at: new Date(g.now).toISOString(), phaseId: g.state.phaseId },
    ]);
  });

  it('is read-only at night, and closed to the dead and to spectators', () => {
    const g = nightOne(6);
    say(g, 'p2', 'psst');
    expect(g.state.chat).toEqual([]);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    g.skip();
    g.act({ type: 'join', playerId: 'watcher', name: 'Watcher' });
    say(g, 'p6', 'I was bitten!');
    say(g, 'watcher', 'hello');
    expect(g.state.chat).toEqual([]);
  });

  it('opens to everyone who played once the game is over', () => {
    const g = dayOne();
    g.act({ type: 'end-game' });
    say(g, 'p6', 'gg');
    expect(g.state.chat.map((m) => m.authorId)).toEqual(['p6']);
  });

  it('refuses empty and overlong messages', () => {
    const g = dayOne();
    say(g, 'p2', '   ');
    say(g, 'p2', 'x'.repeat(CHAT_MAX_LENGTH + 1));
    expect(g.state.chat).toEqual([]);
    say(g, 'p2', 'x'.repeat(CHAT_MAX_LENGTH));
    expect(g.state.chat).toHaveLength(1);
  });

  it(`caps each player at ${CHAT_PER_PHASE} messages a phase, then resets`, () => {
    const g = dayOne();
    for (let i = 0; i < CHAT_PER_PHASE + 3; i += 1) say(g, 'p2', `m${i}`);
    expect(g.state.chat).toHaveLength(CHAT_PER_PHASE);
    say(g, 'p3', 'my turn');
    expect(g.state.chat).toHaveLength(CHAT_PER_PHASE + 1);
    g.skip(); // → voting
    say(g, 'p2', 'again');
    expect(g.state.chat.at(-1)?.text).toBe('again');
  });

  it(`keeps only the last ${CHAT_KEEP} messages`, () => {
    const g = dayOne();
    const at = new Date(g.now).toISOString();
    g.state = {
      ...g.state,
      chat: Array.from({ length: CHAT_KEEP }, (_, i) => ({
        id: -(i + 1),
        authorId: 'p3',
        text: `old ${i}`,
        at,
        phaseId: g.state.phaseId,
      })),
    };
    say(g, 'p2', 'newest');
    expect(g.state.chat).toHaveLength(CHAT_KEEP);
    expect(g.state.chat[0]?.text).toBe('old 1');
    expect(g.state.chat.at(-1)?.text).toBe('newest');
  });
});

describe('pack chat', () => {
  it('lets living vampires whisper during the reveal and the night', () => {
    const g = startedGame(8); // p1 + p2 vampires
    whisper(g, 'p1', 'hello, sibling');
    g.skip(); // night
    whisper(g, 'p2', 'the doctor is Hana?');
    expect(g.state.secret.packChat.map((m) => [m.authorId, m.text])).toEqual([
      ['p1', 'hello, sibling'],
      ['p2', 'the doctor is Hana?'],
    ]);
    expect(g.state.chat).toEqual([]);
  });

  it('refuses everyone who is not a vampire', () => {
    const g = nightOne(6);
    whisper(g, 'p2', 'let me in');
    whisper(g, 'stranger', 'hi');
    expect(g.state.secret.packChat).toEqual([]);
  });

  it('leaves no trace in the public counters — whispers cannot be counted from id gaps', () => {
    const g = startedGame(8);
    const publicSeq = g.state.seq;
    whisper(g, 'p1', 'one');
    whisper(g, 'p2', 'two');
    g.skip(); // night
    whisper(g, 'p1', 'three');
    expect(g.state.seq).toBe(publicSeq);
    expect(g.state.secret.packChat.map((m) => m.id)).toEqual([1, 2, 3]);
    // The next public event continues the public sequence with no gap.
    g.target('p1', 'p8');
    g.target('p2', 'p8');
    g.target('p3', 'p4');
    g.target('p4', 'p4');
    g.shield('p5', false);
    expect(g.state.log.map((e) => e.id)).toEqual([publicSeq, publicSeq + 1]);
  });

  it('is closed by day', () => {
    const g = dayOne();
    whisper(g, 'p1', 'they suspect me');
    expect(g.state.secret.packChat).toEqual([]);
  });

  it(`caps each vampire at ${PACK_CHAT_PER_PHASE} whispers a phase and keeps the last ${PACK_CHAT_KEEP}`, () => {
    const g = nightOne(8);
    for (let i = 0; i < PACK_CHAT_PER_PHASE + 2; i += 1) whisper(g, 'p1', `w${i}`);
    expect(g.state.secret.packChat).toHaveLength(PACK_CHAT_PER_PHASE);
    expect(g.state.secret.packSent).toEqual({ p1: PACK_CHAT_PER_PHASE });
    expect(PACK_CHAT_KEEP).toBeGreaterThanOrEqual(PACK_CHAT_PER_PHASE * 3);
  });
});
