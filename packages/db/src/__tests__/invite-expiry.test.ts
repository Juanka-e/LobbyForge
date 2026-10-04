/**
 * Invites with an expiry — query-level unit tests against a recording fake
 * client (no Postgres). The redeem used to lock the invite through a raw
 * `tx.execute(sql…)`, which skips Drizzle's column mapping: `expires_at`
 * came back as the driver's string and `.getTime()` threw, so every invite
 * with an expiry failed with a 500. Real Postgres proves the round trip in
 * `member-sanctions.integration.test.ts` when TEST_DATABASE_URL is set.
 */
import { describe, expect, it } from 'vitest';
import { redeemInvite } from '../queries/invites.js';
import { invites, memberships } from '../schema.js';

interface Step {
  op: string;
  args: unknown[];
}

/** Same recorder as security-review-authz.test.ts: each awaited chain takes the next result. */
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
  const db: Record<string, unknown> = {
    select: (...args: unknown[]) => start('select', args),
    insert: (...args: unknown[]) => start('insert', args),
    update: (...args: unknown[]) => start('update', args),
    delete: (...args: unknown[]) => start('delete', args),
    execute: async (...args: unknown[]) => {
      chains.push([{ op: 'execute', args }]);
      return results[next++] ?? [];
    },
  };
  db.transaction = async (cb: (tx: unknown) => unknown) => cb(db);
  return { db: db as never, chains };
}

function stepArg(steps: Step[], op: string): unknown {
  return steps.find((s) => s.op === op)?.args[0];
}

const HOUR = 60 * 60 * 1000;

function lockedInvite(expiresAt: Date | null) {
  return [{ id: 'inv-1', serverId: 'srv-1', maxUses: null, currentUses: 0, expiresAt }];
}

describe('redeemInvite with an expiry', () => {
  it('locks the invite through the query builder (mapped columns), not a raw execute', async () => {
    const { db, chains } = recordingDb([[]]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toEqual({ ok: false, error: 'not_found' });
    expect(chains.some((c) => c[0]!.op === 'execute')).toBe(false);
    const lock = chains[0]!;
    expect(lock[0]!.op).toBe('select');
    expect(stepArg(lock, 'from')).toBe(invites);
    expect(stepArg(lock, 'for')).toBe('update');
  });

  it('redeems an invite that has not expired yet', async () => {
    const { db, chains } = recordingDb([
      lockedInvite(new Date(Date.now() + HOUR)),
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'owner-1' }], // approval: server owner
      [], // approval: no policy row
      [{ id: 'role-everyone' }],
      [], // no stored sanction
      [{ id: 'm-1' }], // insert membership
      [], // membership_roles
      [], // invite use
    ]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toEqual({
      ok: true,
      membershipId: 'm-1',
      serverId: 'srv-1',
      roleId: 'role-everyone',
    });
    expect(chains.filter((c) => c[0]!.op === 'insert')[0]![0]!.args[0]).toBe(memberships);
    expect(chains.filter((c) => c[0]!.op === 'update').map((c) => c[0]!.args[0])).toEqual([invites]);
  });

  it('refuses an expired invite and writes nothing', async () => {
    const { db, chains } = recordingDb([
      lockedInvite(new Date(Date.now() - HOUR)),
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'owner-1' }],
      [],
    ]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toEqual({ ok: false, error: 'expired' });
    expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });
});
