/**
 * createMessage refuses a reply target that does not exist or lives in
 * another channel — with an error that carries `code: 'invalid_reply'`, so
 * the route answers 400 instead of a 500 (security review 2026-10, A12).
 *
 * Query-level unit tests against a recording fake client (no Postgres).
 */
import { describe, expect, it } from 'vitest';
import { createMessage, INVALID_REPLY_CODE } from '../queries/messages.js';

function fakeDb(results: unknown[][]) {
  let next = 0;
  const inserts: unknown[] = [];
  function chain(op: string): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const value = results[next++] ?? [];
            return (resolve: (v: unknown) => void) => resolve(value);
          }
          return (...args: unknown[]) => {
            if (op === 'insert' && prop === 'values') inserts.push(args[0]);
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  return { db: { select: () => chain('select'), insert: () => chain('insert') } as never, inserts };
}

const CHANNEL = 'cccccccc-0000-4000-8000-000000000001';
const OTHER_CHANNEL = 'cccccccc-0000-4000-8000-000000000002';
const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const REPLY = 'bbbbbbbb-0000-4000-8000-000000000001';

describe('createMessage — the reply target', () => {
  it('an unknown target is refused with code invalid_reply; nothing is inserted', async () => {
    // assertChannelAlive, then the reply lookup.
    const { db, inserts } = fakeDb([[{ id: CHANNEL }], []]);
    await expect(createMessage(db, { channelId: CHANNEL, userId: USER, content: 'hi', replyToId: REPLY })).rejects.toMatchObject({
      code: INVALID_REPLY_CODE,
    });
    expect(inserts).toEqual([]);
  });

  it('a target in another channel is refused the same way', async () => {
    const { db, inserts } = fakeDb([[{ id: CHANNEL }], [{ channelId: OTHER_CHANNEL }]]);
    await expect(createMessage(db, { channelId: CHANNEL, userId: USER, content: 'hi', replyToId: REPLY })).rejects.toMatchObject({
      code: 'invalid_reply',
    });
    expect(inserts).toEqual([]);
  });

  it('a target in this channel is fine', async () => {
    const stored = { id: 'm-1', channelId: CHANNEL, userId: USER, content: 'hi', replyToId: REPLY };
    const { db } = fakeDb([[{ id: CHANNEL }], [{ channelId: CHANNEL }], [stored]]);
    await expect(createMessage(db, { channelId: CHANNEL, userId: USER, content: 'hi', replyToId: REPLY })).resolves.toBe(stored);
  });
});
