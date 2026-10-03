/**
 * security-review AUTHZ-001 / AUTHZ-002 / AUTHZ-004 — query-level unit
 * tests against a recording fake client (no Postgres needed). The
 * stateful leave → rejoin flows run against real Postgres in
 * `member-sanctions.integration.test.ts` when TEST_DATABASE_URL is set.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { deleteRole, RoleGatesChannelsError } from '../queries/roles.js';
import { ensureServerMembershipDetailed, setMemberTimeout } from '../queries/memberships.js';
import { setMemberVoiceMuted } from '../queries/voiceModeration.js';
import { redeemInvite } from '../queries/invites.js';
import { accessPolicyRequiresApproval } from '../queries/serverAccessPolicies.js';
import { membershipValuesFromSanction } from '../queries/memberSanctions.js';
import { serverMemberSanctions } from '../schema.js';

interface Step {
  op: string;
  args: unknown[];
}

/**
 * Chainable stand-in for the Drizzle client: every top-level call records
 * its method chain, and awaiting a chain resolves to the next queued
 * result. `transaction(cb)` runs `cb` against the same recorder.
 */
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
  return { db: db as never, chains, consumed: () => next };
}

function stepArg(steps: Step[], op: string): unknown {
  return steps.find((s) => s.op === op)?.args[0];
}

function hasStep(steps: Step[], op: string): boolean {
  return steps.some((s) => s.op === op);
}

function renderWhere(where: unknown): string {
  return new PgDialect().sqlToQuery(where as SQL).sql;
}

const UNTIL = new Date('2030-01-01T00:00:00Z');

describe('deleteRole — security-review AUTHZ-001', () => {
  it("refuses to delete a channel's last gating role and names the channels", async () => {
    const { db, chains } = recordingDb([
      [{ id: 'role-staff' }], // role row, locked
      [
        // #staff: gated only by this role → would become public
        { channelId: 'ch-staff', roleId: 'role-staff', channelName: 'staff' },
        // #mods: also gated by another role → stays private
        { channelId: 'ch-mods', roleId: 'role-staff', channelName: 'mods' },
        { channelId: 'ch-mods', roleId: 'role-mod', channelName: 'mods' },
      ],
    ]);
    const err = await deleteRole(db, 'role-staff').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleGatesChannelsError);
    expect((err as RoleGatesChannelsError).code).toBe('role_gates_channels');
    expect((err as RoleGatesChannelsError).channels).toEqual([{ id: 'ch-staff', name: 'staff' }]);
    // Nothing was written: no membership update, no role delete.
    expect(chains.some((c) => c[0]!.op === 'update' || c[0]!.op === 'delete')).toBe(false);
  });

  it('locks the role row and the override rows it reads', async () => {
    const { db, chains } = recordingDb([
      [{ id: 'role-staff' }],
      [{ channelId: 'ch-staff', roleId: 'role-staff', channelName: 'staff' }],
    ]);
    await deleteRole(db, 'role-staff').catch(() => undefined);
    const selects = chains.filter((c) => c[0]!.op === 'select');
    expect(selects[0]!.find((s) => s.op === 'for')?.args[0]).toBe('update');
    const overrideRead = selects.find((c) => hasStep(c, 'innerJoin'))!;
    expect(overrideRead.find((s) => s.op === 'for')?.args[0]).toBe('update');
  });

  it('deletes a role whose every gated channel keeps another role', async () => {
    const { db, chains } = recordingDb([
      [{ id: 'role-staff' }],
      [
        { channelId: 'ch-mods', roleId: 'role-staff', channelName: 'mods' },
        { channelId: 'ch-mods', roleId: 'role-mod', channelName: 'mods' },
      ],
      [], // memberships display-role reset
      [], // delete role
    ]);
    await expect(deleteRole(db, 'role-staff')).resolves.toBeUndefined();
    expect(chains.some((c) => c[0]!.op === 'delete')).toBe(true);
  });

  it('deletes a role that gates no channel', async () => {
    const { db, chains } = recordingDb([[{ id: 'role-x' }], [], [], []]);
    await expect(deleteRole(db, 'role-x')).resolves.toBeUndefined();
    expect(chains.some((c) => c[0]!.op === 'delete')).toBe(true);
  });
});

describe('moderation state survives the membership — security-review AUTHZ-002', () => {
  it('setMemberTimeout mirrors the membership state into server_member_sanctions', async () => {
    const { db, chains } = recordingDb([
      [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1', timedOutUntil: UNTIL, voiceMuted: true }],
      [], // sanctions upsert
    ]);
    const row = await setMemberTimeout(db, 'srv-1', 'u-1', UNTIL);
    expect(row.timedOutUntil).toEqual(UNTIL);
    const upsert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(upsert[0]!.args[0]).toBe(serverMemberSanctions);
    expect(stepArg(upsert, 'values')).toMatchObject({
      serverId: 'srv-1',
      userId: 'u-1',
      timedOutUntil: UNTIL,
      voiceMuted: true,
    });
    expect(stepArg(upsert, 'onConflictDoUpdate')).toMatchObject({
      set: { timedOutUntil: UNTIL, voiceMuted: true },
    });
  });

  it('clearing a timeout is mirrored too (a stale sanction must not re-apply it)', async () => {
    const { db, chains } = recordingDb([
      [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1', timedOutUntil: null, voiceMuted: false }],
      [],
    ]);
    await setMemberTimeout(db, 'srv-1', 'u-1', null);
    const upsert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(stepArg(upsert, 'values')).toMatchObject({ timedOutUntil: null, voiceMuted: false });
  });

  it('setMemberTimeout still refuses a non-member and records nothing', async () => {
    const { db, chains } = recordingDb([[]]);
    await expect(setMemberTimeout(db, 'srv-1', 'u-1', UNTIL)).rejects.toThrow(/not a member/);
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
  });

  it('setMemberVoiceMuted mirrors the mute; a non-member is a no-op', async () => {
    const muted = recordingDb([[{ timedOutUntil: null, voiceMuted: true }], []]);
    expect(await setMemberVoiceMuted(muted.db, 'srv-1', 'u-1', true)).toBe(true);
    const upsert = muted.chains.find((c) => c[0]!.op === 'insert')!;
    expect(stepArg(upsert, 'values')).toMatchObject({ serverId: 'srv-1', userId: 'u-1', voiceMuted: true });

    const absent = recordingDb([[]]);
    expect(await setMemberVoiceMuted(absent.db, 'srv-1', 'u-1', true)).toBe(false);
    expect(absent.chains.some((c) => c[0]!.op === 'insert')).toBe(false);
  });

  it('membershipValuesFromSanction: nothing stored → column defaults', () => {
    expect(membershipValuesFromSanction(null)).toEqual({});
    expect(membershipValuesFromSanction({ timedOutUntil: UNTIL, voiceMuted: true })).toEqual({
      timedOutUntil: UNTIL,
      voiceMuted: true,
    });
  });

  it('the lobby auto-join gives a returning member their stored timeout and mute', async () => {
    const { db, chains } = recordingDb([
      [], // isCurrentlyBanned
      [], // getServerMember
      [{ ownerUserId: 'owner-1' }], // approval: server owner
      [], // approval: no access policy row
      [{ id: 'role-everyone' }], // @everyone
      [{ serverId: 'srv-1', userId: 'u-1', timedOutUntil: UNTIL, voiceMuted: true }], // sanction
      [{ id: 'm-2', serverId: 'srv-1', userId: 'u-1', roleId: null }], // insert membership
      [], // insert membership_roles
    ]);
    const result = await ensureServerMembershipDetailed(db, 'srv-1', 'u-1');
    expect(result?.created).toBe(true);
    const insert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(stepArg(insert, 'values')).toEqual({
      serverId: 'srv-1',
      userId: 'u-1',
      timedOutUntil: UNTIL,
      voiceMuted: true,
    });
  });

  it('invite redeem gives a returning member their stored timeout and mute', async () => {
    const { db, chains } = recordingDb([
      [{ id: 'inv-1', server_id: 'srv-1', max_uses: null, current_uses: 0, expires_at: null }], // lock
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'owner-1' }], // approval: server owner
      [], // approval: no policy row
      [{ id: 'role-everyone' }],
      [{ serverId: 'srv-1', userId: 'u-1', timedOutUntil: UNTIL, voiceMuted: true }], // sanction
      [{ id: 'm-2' }], // insert membership
      [], // membership_roles
      [], // invite uses
    ]);
    const result = await redeemInvite(db, 'ABCDEFGH2345', 'u-1');
    expect(result).toEqual({ ok: true, membershipId: 'm-2', serverId: 'srv-1', roleId: 'role-everyone' });
    const insert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(stepArg(insert, 'values')).toEqual({
      serverId: 'srv-1',
      userId: 'u-1',
      roleId: 'role-everyone',
      timedOutUntil: UNTIL,
      voiceMuted: true,
    });
    // The sanction lookup is keyed by (server, user).
    const sanctionRead = chains.find((c) => c[0]!.op === 'select' && stepArg(c, 'from') === serverMemberSanctions)!;
    expect(renderWhere(stepArg(sanctionRead, 'where'))).toMatch(/"server_id" = \$1 and .*"user_id" = \$2/);
  });
});

describe('access policy approval — security-review AUTHZ-004', () => {
  const base = {
    joinPolicy: 'invite_only' as const,
    accountLinking: 'allow_link' as const,
    requireApprovalForFirstJoin: false,
  };

  it('reads the policy exactly like api/auth/register', () => {
    expect(accessPolicyRequiresApproval(null)).toBe(false);
    expect(accessPolicyRequiresApproval(base)).toBe(false);
    expect(accessPolicyRequiresApproval({ ...base, joinPolicy: 'public_self_register' })).toBe(false);
    expect(accessPolicyRequiresApproval({ ...base, requireApprovalForFirstJoin: true })).toBe(true);
    expect(accessPolicyRequiresApproval({ ...base, joinPolicy: 'public_with_approval' })).toBe(true);
    expect(
      accessPolicyRequiresApproval({ ...base, accountLinking: 'require_admin_approval_first_join' })
    ).toBe(true);
  });

  it('invite redeem is refused while the server requires approval (nothing is written)', async () => {
    const { db, chains } = recordingDb([
      [{ id: 'inv-1', server_id: 'srv-1', max_uses: null, current_uses: 0, expires_at: null }],
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'owner-1' }],
      [{ ...base, requireApprovalForFirstJoin: true }],
    ]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toEqual({ ok: false, error: 'approval_required' });
    expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });

  it('the lobby auto-join creates nothing while the server requires approval', async () => {
    const { db, chains } = recordingDb([
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'owner-1' }],
      [{ ...base, joinPolicy: 'public_with_approval' }],
    ]);
    expect(await ensureServerMembershipDetailed(db, 'srv-1', 'u-1')).toBeNull();
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
  });

  it('the owner is never held out of their own server', async () => {
    const { db } = recordingDb([
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'u-1' }], // the caller owns the server → no policy read
      [{ id: 'role-everyone' }],
      [], // no sanction
      [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1', roleId: null }],
      [],
    ]);
    const result = await ensureServerMembershipDetailed(db, 'srv-1', 'u-1');
    expect(result?.created).toBe(true);
  });

  it('an existing member is not re-checked against the policy', async () => {
    const { db, consumed } = recordingDb([[], [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1' }]]);
    const result = await ensureServerMembershipDetailed(db, 'srv-1', 'u-1');
    expect(result?.created).toBe(false);
    expect(consumed()).toBe(2);
  });
});
