/**
 * The example marketplace plugin (examples/plugins/sandbox-buzzer), run
 * through the real QuickJS sandbox: its reducer, validation, migration and
 * — the point of the example — per-viewer projection that hides who buzzed
 * until the host reveals.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInSandbox } from '../sandbox-core.mjs';
import { cryptoRandomFloats } from '../index.js';
import { parseSandboxManifest } from '../manifest.js';

const EXAMPLE = join(__dirname, '..', '..', '..', '..', 'examples', 'plugins', 'sandbox-buzzer');
const SOURCE = readFileSync(join(EXAMPLE, 'server.js'), 'utf8');

const HOST = 'u-host';
const ALICE = 'u-alice';
const BOB = 'u-bob';
const CAROL = 'u-carol';

type State = Record<string, unknown> & {
  phase: string;
  round: number;
  buzzes: Array<{ playerId: string; at: number }>;
  scores: Record<string, number>;
};

const ctx = (now = 1_000) => ({
  players: [HOST, ALICE, BOB, CAROL].map((id) => ({ id, name: id })),
  now,
  locale: 'en',
  sessionId: 'sess-1',
  serverId: 'srv-1',
  hostId: HOST,
  actorId: HOST,
});

async function call(input: Record<string, unknown>): Promise<{ r?: unknown; u?: 1 }> {
  const result = await runInSandbox({
    source: SOURCE,
    input: JSON.stringify(input),
    budgetMs: 2_000,
    memoryBytes: 32 * 1024 * 1024,
    stackBytes: 256 * 1024,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (!result.ok) throw new Error(`${result.kind}: ${result.error}`);
  return JSON.parse(result.output) as { r?: unknown; u?: 1 };
}

async function act(state: State, action: Record<string, unknown>, now = 1_000): Promise<State> {
  const out = await call({ op: 'handleAction', ctx: ctx(now), state, action, random: cryptoRandomFloats(16) });
  return out.u === 1 ? state : (out.r as State);
}

async function view(state: State, viewerId: string): Promise<Record<string, unknown>> {
  return (await call({ op: 'projectState', state, viewerId, ctx: ctx() })).r as Record<string, unknown>;
}

async function initial(): Promise<State> {
  return (await call({ op: 'createInitialState', ctx: ctx(), random: cryptoRandomFloats(16) })).r as State;
}

describe('sandbox-buzzer manifest', () => {
  it('is a valid sandbox-v1 manifest with the documented policies', () => {
    const parsed = parseSandboxManifest(readFileSync(join(EXAMPLE, 'manifest.json')));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.actionPolicies).toEqual({
      'open-round': { role: 'host' },
      buzz: { role: 'member', actorFields: ['playerId'], joinsRoster: true },
      reveal: { role: 'host' },
      reset: { role: 'host' },
    });
  });
});

describe('sandbox-buzzer server.js in the sandbox', () => {
  it('defines every sandbox-v1 function', async () => {
    expect((await call({ op: 'describe' })).r).toEqual({
      createInitialState: true,
      handleAction: true,
      validateAction: true,
      projectState: true,
      migrateState: true,
    });
  });

  it('plays a round: open, buzz, reveal, score', async () => {
    let s = await initial();
    expect(s).toMatchObject({ phase: 'idle', round: 0, buzzes: [], scores: {} });

    s = await act(s, { type: 'open-round' }, 5_000);
    expect(s).toMatchObject({ phase: 'open', round: 1, openedAt: 5_000, buzzes: [], winner: null });
    expect(['amber', 'teal', 'violet', 'rose', 'lime']).toContain(s.tone);

    s = await act(s, { type: 'buzz', playerId: BOB }, 5_420);
    s = await act(s, { type: 'buzz', playerId: ALICE }, 5_600);
    expect(s.buzzes).toEqual([
      { playerId: BOB, at: 5_420 },
      { playerId: ALICE, at: 5_600 },
    ]);

    s = await act(s, { type: 'reveal' }, 6_000);
    expect(s).toMatchObject({ phase: 'revealed', winner: BOB, scores: { [BOB]: 1 } });

    s = await act(s, { type: 'open-round' }, 7_000);
    expect(s).toMatchObject({ phase: 'open', round: 2, buzzes: [], scores: { [BOB]: 1 } });
    s = await act(s, { type: 'reset' });
    expect(s).toMatchObject({ phase: 'idle', round: 0, scores: {} });
  });

  it('refuses what the rules do not allow by returning the same state (unchanged)', async () => {
    const idle = await initial();
    expect(await call({ op: 'handleAction', ctx: ctx(), state: idle, action: { type: 'buzz', playerId: ALICE }, random: [] })).toEqual({ u: 1 });
    expect(await call({ op: 'handleAction', ctx: ctx(), state: idle, action: { type: 'reveal' }, random: [] })).toEqual({ u: 1 });
    let open = await act(idle, { type: 'open-round' });
    open = await act(open, { type: 'buzz', playerId: ALICE });
    // A second buzz from the same player, and opening an open round.
    expect(await call({ op: 'handleAction', ctx: ctx(), state: open, action: { type: 'buzz', playerId: ALICE }, random: [] })).toEqual({ u: 1 });
    expect(await call({ op: 'handleAction', ctx: ctx(), state: open, action: { type: 'open-round' }, random: [1] })).toEqual({ u: 1 });
  });

  it('opening a round draws from ctx.random (no host values → the call fails)', async () => {
    const idle = await initial();
    await expect(call({ op: 'handleAction', ctx: ctx(), state: idle, action: { type: 'open-round' }, random: [] })).rejects.toThrow(
      /random values/
    );
  });

  it('validateAction names what is wrong', async () => {
    const v = async (action: unknown) => (await call({ op: 'validateAction', action })).r;
    expect(await v({ type: 'buzz', playerId: ALICE })).toBeNull();
    expect(await v({ type: 'open-round' })).toBeNull();
    expect(await v({ type: 'explode' })).toBe('Unknown action: explode');
    expect(await v({ type: 'buzz' })).toBe('A buzz needs a player.');
  });

  it('migrateState turns anything into the current shape, idempotently', async () => {
    const m = async (raw: unknown) => (await call({ op: 'migrateState', raw })).r as State;
    expect(await m(null)).toMatchObject({ v: 1, phase: 'idle', buzzes: [] });
    const messy = { phase: 'open', round: 2.7, buzzes: [{ playerId: ALICE, at: 3 }, { nope: 1 }], scores: { [ALICE]: 2, x: 'y' } };
    const once = await m(messy);
    expect(once).toMatchObject({ phase: 'open', round: 2, buzzes: [{ playerId: ALICE, at: 3 }], scores: { [ALICE]: 2 } });
    expect(await m(once)).toEqual(once);
  });
});

describe('sandbox-buzzer projection: who buzzed first stays hidden until the reveal', () => {
  async function openRoundWithBuzzes(): Promise<State> {
    let s = await act(await initial(), { type: 'open-round' }, 10_000);
    s = await act(s, { type: 'buzz', playerId: BOB }, 10_250);
    s = await act(s, { type: 'buzz', playerId: ALICE }, 10_400);
    return s;
  }

  it('while open, no viewer — the host included — gets names, order or timestamps', async () => {
    const s = await openRoundWithBuzzes();
    for (const viewer of [HOST, ALICE, BOB, CAROL]) {
      const seen = await view(s, viewer);
      expect(seen.buzzes, viewer).toBeNull();
      expect(seen.winner, viewer).toBeNull();
      expect(seen.buzzCount, viewer).toBe(2);
      // Nothing in the payload names another buzzer.
      const text = JSON.stringify(seen);
      for (const other of [ALICE, BOB].filter((id) => id !== viewer)) expect(text, `${viewer} sees ${other}`).not.toContain(other);
      expect(text).not.toContain('10250');
    }
    expect((await view(s, ALICE)).youBuzzed).toBe(true);
    expect((await view(s, BOB)).youBuzzed).toBe(true);
    expect((await view(s, CAROL)).youBuzzed).toBe(false);
    expect((await view(s, HOST)).youBuzzed).toBe(false);
  });

  it('after the reveal everyone sees the order with reaction times', async () => {
    const revealed = await act(await openRoundWithBuzzes(), { type: 'reveal' }, 11_000);
    for (const viewer of [HOST, CAROL]) {
      const seen = await view(revealed, viewer);
      expect(seen).toMatchObject({
        phase: 'revealed',
        winner: BOB,
        buzzCount: 2,
        buzzes: [
          { playerId: BOB, ms: 250 },
          { playerId: ALICE, ms: 400 },
        ],
      });
    }
  });
});
