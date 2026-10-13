/**
 * getDmRecipientEligibility — who may be sent a new DM (security review,
 * "needs verification" #4). Query-level unit tests against a recording
 * fake client (no Postgres needed).
 *
 *  - an unknown or soft-deleted recipient is `exists: false` (the route
 *    answers 404 instead of an FK error, so there is no existence oracle);
 *  - "shares a server" means both users are current members of a live
 *    server and neither is actively banned there;
 *  - without a shared server, the pair's existing conversation is looked up.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { getDmRecipientEligibility } from '../queries/dmChannels.js';

interface Step {
  op: string;
  args: unknown[];
}

function recordingDb(results: unknown[][]) {
  const chains: Step[][] = [];
  let next = 0;
  function start(op: string, args: unknown[]) {
    const steps: Step[] = [{ op, args }];
    chains.push(steps);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const value = results[next++] ?? [];
            return (resolve: (v: unknown) => void) => resolve(value);
          }
          return (...callArgs: unknown[]) => {
            steps.push({ op: String(prop), args: callArgs });
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  return { db: { select: (...args: unknown[]) => start('select', args) } as never, chains };
}

const VIEWER = '00000000-0000-4000-8000-000000000001';
const RECIPIENT = '00000000-0000-4000-8000-000000000002';

describe('getDmRecipientEligibility', () => {
  it('an unknown (or soft-deleted) recipient does not exist — and nothing else is queried', async () => {
    const { db, chains } = recordingDb([[]]);
    expect(await getDmRecipientEligibility(db, VIEWER, RECIPIENT)).toEqual({
      exists: false,
      sharesServer: false,
      existingChannelId: null,
    });
    expect(chains).toHaveLength(1);
    const where = new PgDialect().sqlToQuery(chains[0]!.find((s) => s.op === 'where')!.args[0] as SQL);
    expect(where.sql).toMatch(/"deleted_at" is null/);
  });

  it('a shared live server is enough; the existing conversation is not looked up', async () => {
    const { db, chains } = recordingDb([[{ sharesServer: true }]]);
    expect(await getDmRecipientEligibility(db, VIEWER, RECIPIENT)).toEqual({
      exists: true,
      sharesServer: true,
      existingChannelId: null,
    });
    expect(chains).toHaveLength(1);
  });

  it('without a shared server, the pair’s existing DM channel counts', async () => {
    const { db, chains } = recordingDb([[{ sharesServer: false }], [{ id: 'dm-1' }]]);
    expect(await getDmRecipientEligibility(db, VIEWER, RECIPIENT)).toEqual({
      exists: true,
      sharesServer: false,
      existingChannelId: 'dm-1',
    });
    expect(chains).toHaveLength(2);
  });

  it('neither shared server nor conversation: nothing to open', async () => {
    const { db } = recordingDb([[{ sharesServer: false }], []]);
    expect(await getDmRecipientEligibility(db, VIEWER, RECIPIENT)).toMatchObject({ exists: true, sharesServer: false, existingChannelId: null });
  });

  it('"shares a server" skips deleted servers and active bans of either user, with both ids as parameters', async () => {
    const { db, chains } = recordingDb([[{ sharesServer: true }]]);
    await getDmRecipientEligibility(db, VIEWER, RECIPIENT);
    const fields = chains[0]![0]!.args[0] as { sharesServer: SQL };
    const query = new PgDialect().sqlToQuery(fields.sharesServer);
    expect(query.sql).toContain('shared_s.deleted_at is null');
    expect(query.sql).toContain('from server_bans b');
    expect(query.sql).toContain('b.user_id in (viewer_m.user_id, recipient_m.user_id)');
    expect(query.sql).toContain('b.expires_at is null or b.expires_at > now()');
    expect(query.params).toEqual([VIEWER, RECIPIENT]);
  });
});
