/**
 * The join approval queue (0043) — query-level unit tests against a
 * recording fake client (no Postgres). The stateful flows (one pending per
 * user, ban → rejected, approve → sanctions) run against real Postgres in
 * `join-requests.integration.test.ts` when TEST_DATABASE_URL is set.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  approveJoinRequest,
  autoJoinServer,
  cancelJoinRequest,
  fileJoinRequest,
  getOpenJoinRequest,
  hasFiledThroughInvite,
  JOIN_REQUEST_DAILY_LIMIT,
  JOIN_REQUEST_NOTE_MAX_LENGTH,
  JOIN_REQUEST_REJECTION_COOLDOWN_MS,
  listJoinRequestsForServer,
  normalizeJoinRequestNote,
  rejectJoinRequest,
  requestToJoinServer,
} from '../queries/joinRequests.js';
import { redeemInvite } from '../queries/invites.js';
import {
  accessPolicyRequiresApproval,
  DEFAULT_SERVER_ACCESS_POLICY,
  serverPolicyRegistrationRefusal,
} from '../queries/serverAccessPolicies.js';
import { invites, memberships, serverJoinRequests } from '../schema.js';

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
  return { db: db as never, chains, consumed: () => next };
}

function stepArg(steps: Step[], op: string): unknown {
  return steps.find((s) => s.op === op)?.args[0];
}

function renderSql(fragment: unknown): string {
  return new PgDialect().sqlToQuery(fragment as SQL).sql;
}

const NOW = new Date('2026-10-03T12:00:00Z');
const UNTIL = new Date('2030-01-01T00:00:00Z');
const APPROVAL_POLICY = {
  joinPolicy: 'public_with_approval',
  localAccount: 'allow_local_email_password',
  accountLinking: 'allow_link',
  requireApprovalForFirstJoin: false,
};

function pending(overrides: Record<string, unknown> = {}) {
  return {
    id: 'jr-1',
    serverId: 'srv-1',
    userId: 'u-1',
    source: 'invite',
    inviteCode: 'ABCDEFGH2345',
    note: null,
    status: 'pending',
    createdAt: NOW,
    decidedAt: null,
    decidedBy: null,
    rejectedByBan: false,
    ...overrides,
  };
}

describe('normalizeJoinRequestNote', () => {
  it('trims, drops empty notes and caps at the limit in characters', () => {
    expect(normalizeJoinRequestNote(undefined)).toBeNull();
    expect(normalizeJoinRequestNote('   ')).toBeNull();
    expect(normalizeJoinRequestNote('  hi  ')).toBe('hi');
    expect(Array.from(normalizeJoinRequestNote('🎲'.repeat(600))!)).toHaveLength(JOIN_REQUEST_NOTE_MAX_LENGTH);
  });
});

describe('fileJoinRequest', () => {
  it('returns the pending request instead of filing a second one', async () => {
    const { db, chains } = recordingDb([[pending()]]);
    expect(await fileJoinRequest(db, { serverId: 'srv-1', userId: 'u-1', source: 'auto_join' }, NOW)).toEqual({
      kind: 'pending',
      request: pending(),
      created: false,
    });
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
  });

  it('refuses a new request while a rejection is in its cooldown', async () => {
    const decidedAt = new Date(NOW.getTime() - 60_000);
    const { db, chains } = recordingDb([[pending({ status: 'rejected', decidedAt })]]);
    const result = await fileJoinRequest(db, { serverId: 'srv-1', userId: 'u-1', source: 'auto_join' }, NOW);
    expect(result).toMatchObject({ kind: 'rejected' });
    expect((result as { retryAfter: Date }).retryAfter.getTime()).toBe(
      decidedAt.getTime() + JOIN_REQUEST_REJECTION_COOLDOWN_MS
    );
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
    // The open-request read only looks at moderator rejections inside the
    // cooldown — a rejection written by a ban starts none.
    const read = chains[0]!;
    expect(renderSql(stepArg(read, 'where'))).toMatch(
      /"status" = \$\d+ or \(.*"status" = \$\d+ and .*"rejected_by_ban" = \$\d+ and .*"decided_at" > \$\d+\)/
    );
  });

  it(`stops at ${JOIN_REQUEST_DAILY_LIMIT} requests per server and user per day`, async () => {
    const { db, chains } = recordingDb([[], [{ n: JOIN_REQUEST_DAILY_LIMIT }]]);
    expect(await fileJoinRequest(db, { serverId: 'srv-1', userId: 'u-1', source: 'auto_join' }, NOW)).toEqual({
      kind: 'limited',
    });
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
  });

  it('files a pending request with the trimmed note', async () => {
    const { db, chains } = recordingDb([[], [{ n: 1 }], [pending({ note: 'hello' })]]);
    const result = await fileJoinRequest(
      db,
      { serverId: 'srv-1', userId: 'u-1', source: 'invite', inviteCode: 'ABCDEFGH2345', note: '  hello ' },
      NOW
    );
    expect(result).toMatchObject({ kind: 'pending', created: true });
    const insert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(insert[0]!.args[0]).toBe(serverJoinRequests);
    expect(stepArg(insert, 'values')).toEqual({
      serverId: 'srv-1',
      userId: 'u-1',
      source: 'invite',
      inviteCode: 'ABCDEFGH2345',
      note: 'hello',
      status: 'pending',
      createdAt: NOW,
    });
    expect(insert.some((s) => s.op === 'onConflictDoNothing')).toBe(true);
  });

  it('adopts the concurrent pending request when the partial unique index wins', async () => {
    const { db } = recordingDb([[], [{ n: 0 }], [], [pending({ id: 'jr-raced' })]]);
    expect(await fileJoinRequest(db, { serverId: 'srv-1', userId: 'u-1', source: 'auto_join' }, NOW)).toMatchObject({
      kind: 'pending',
      created: false,
      request: { id: 'jr-raced' },
    });
  });
});

describe('redeemInvite under an approval policy', () => {
  const lockedInvite = (over: Record<string, unknown> = {}) => [
    { id: 'inv-1', server_id: 'srv-1', max_uses: 1, current_uses: 0, expires_at: null, ...over },
  ];

  it('returns the pending request — even when its own use exhausted the invite — and consumes nothing', async () => {
    const { db, chains } = recordingDb([
      lockedInvite({ current_uses: 1 }),
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [pending()], // open request
    ]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toEqual({
      ok: false,
      error: 'pending_approval',
      serverId: 'srv-1',
      request: pending(),
      created: false,
    });
    expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });

  it('a rejected user is told so until the cooldown ends', async () => {
    const decidedAt = new Date(Date.now() - 1000);
    const { db, chains } = recordingDb([
      lockedInvite(),
      [],
      [],
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [pending({ status: 'rejected', decidedAt })],
    ]);
    const result = await redeemInvite(db, 'ABCDEFGH2345', 'u-1');
    expect(result).toMatchObject({ ok: false, error: 'join_rejected', serverId: 'srv-1' });
    expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });

  it('an exhausted invite files no new request', async () => {
    const { db, chains } = recordingDb([
      lockedInvite({ current_uses: 1 }),
      [],
      [],
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [], // no open request
      [], // never filed through this code
    ]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toEqual({ ok: false, error: 'exhausted' });
    expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });

  it('a new request consumes one use and passes the note through', async () => {
    const { db, chains } = recordingDb([
      lockedInvite(),
      [],
      [],
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [], // no open request
      [], // never filed through this code
      [], // fileJoinRequest: no open request
      [{ n: 0 }],
      [pending({ note: 'friend of Ada' })],
      [], // invite use
    ]);
    const result = await redeemInvite(db, 'ABCDEFGH2345', 'u-1', { note: 'friend of Ada' });
    expect(result).toMatchObject({ ok: false, error: 'pending_approval', created: true });
    const insert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(stepArg(insert, 'values')).toMatchObject({ source: 'invite', inviteCode: 'ABCDEFGH2345', note: 'friend of Ada' });
    const update = chains.find((c) => c[0]!.op === 'update')!;
    expect(update[0]!.args[0]).toBe(invites);
    expect(chains.some((c) => c[0]!.op === 'insert' && c[0]!.args[0] === memberships)).toBe(false);
    // The "already filed through this code" read is keyed by server, user AND code.
    const filedRead = chains[6]!;
    expect(stepArg(filedRead, 'from')).toBe(serverJoinRequests);
    expect(renderSql(stepArg(filedRead, 'where'))).toMatch(/"server_id" = \$\d+ and .*"user_id" = \$\d+.*"invite_code" = \$\d+/);
  });

  it('asking again through the same code (after a withdraw) takes no use — even when that use was the last', async () => {
    const { db, chains } = recordingDb([
      lockedInvite({ current_uses: 1 }), // exhausted by this user's own earlier request
      [],
      [],
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [], // no open request (the earlier one was withdrawn)
      [{ id: 'jr-withdrawn' }], // filed through this code before
      [], // fileJoinRequest: no open request
      [{ n: 1 }],
      [pending({ id: 'jr-again' })],
    ]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toMatchObject({
      ok: false,
      error: 'pending_approval',
      created: true,
      request: { id: 'jr-again' },
    });
    expect(chains.filter((c) => c[0]!.op === 'insert').map((c) => c[0]!.args[0])).toEqual([serverJoinRequests]);
    expect(chains.some((c) => c[0]!.op === 'update')).toBe(false);
  });

  it('another user still finds a code exhausted by someone else', async () => {
    const { db, chains } = recordingDb([
      lockedInvite({ current_uses: 1 }),
      [],
      [],
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [], // no open request
      [], // never filed through this code
    ]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-2')).toEqual({ ok: false, error: 'exhausted' });
    expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });

  it('the daily limit holds the redeem without consuming a use', async () => {
    const { db, chains } = recordingDb([
      lockedInvite(),
      [],
      [],
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [], // no open request
      [], // never filed through this code
      [], // fileJoinRequest: no open request
      [{ n: JOIN_REQUEST_DAILY_LIMIT }],
    ]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toEqual({
      ok: false,
      error: 'join_request_limit',
      serverId: 'srv-1',
    });
    expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });

  it('a banned user cannot request (the ban is checked first)', async () => {
    const { db, chains, consumed } = recordingDb([lockedInvite(), [{ expiresAt: null }]]);
    expect(await redeemInvite(db, 'ABCDEFGH2345', 'u-1')).toEqual({ ok: false, error: 'banned' });
    expect(consumed()).toBe(2);
    expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });
});

describe('autoJoinServer (the /lobby page load)', () => {
  it('a banned user gets nothing', async () => {
    const { db, chains } = recordingDb([[{ id: 'ban-1', expiresAt: null }]]);
    expect(await autoJoinServer(db, 'srv-1', 'u-1', NOW)).toEqual({ kind: 'banned' });
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
  });

  it('never files a request while the server requires approval — it reports where the user stands', async () => {
    const none = recordingDb([
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [], // open request
    ]);
    expect(await autoJoinServer(none.db, 'srv-1', 'u-1', NOW)).toEqual({ kind: 'approval_required', open: null });
    expect(none.chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);

    const waiting = recordingDb([[], [], [{ ownerUserId: 'owner-1' }], [APPROVAL_POLICY], [pending()]]);
    expect(await autoJoinServer(waiting.db, 'srv-1', 'u-1', NOW)).toEqual({ kind: 'approval_required', open: pending() });
    expect(waiting.chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
  });

  it('joins directly when no approval is required', async () => {
    const { db } = recordingDb([
      [],
      [],
      [{ ownerUserId: 'owner-1' }],
      [], // no policy row
      [{ id: 'role-everyone' }],
      [],
      [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1', roleId: null }],
      [],
    ]);
    expect(await autoJoinServer(db, 'srv-1', 'u-1', NOW)).toMatchObject({ kind: 'member', created: true });
  });

  it('an existing member is returned as is', async () => {
    const { db, consumed } = recordingDb([[], [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1' }]]);
    expect(await autoJoinServer(db, 'srv-1', 'u-1', NOW)).toMatchObject({ kind: 'member', created: false });
    expect(consumed()).toBe(2);
  });
});

describe('requestToJoinServer (the lobby "Ask to join")', () => {
  const input = { serverId: 'srv-1', userId: 'u-1', note: '  I run the Tuesday games ' };

  it('files an auto_join request with the trimmed note', async () => {
    const { db, chains } = recordingDb([
      [], // ban
      [], // existing membership
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [], // open request
      [{ n: 0 }],
      [pending({ source: 'auto_join', inviteCode: null, note: 'I run the Tuesday games' })],
    ]);
    expect(await requestToJoinServer(db, input, NOW)).toMatchObject({ kind: 'pending', created: true });
    const insert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(insert[0]!.args[0]).toBe(serverJoinRequests);
    expect(stepArg(insert, 'values')).toMatchObject({
      source: 'auto_join',
      inviteCode: null,
      note: 'I run the Tuesday games',
      status: 'pending',
    });
    // No invite, so no invite use.
    expect(chains.some((c) => c[0]!.op === 'update')).toBe(false);
  });

  it('bans win, members and servers without approval are told so — nothing is written', async () => {
    const banned = recordingDb([[{ id: 'ban-1', expiresAt: null }]]);
    expect(await requestToJoinServer(banned.db, input, NOW)).toEqual({ kind: 'banned' });
    const member = recordingDb([[], [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1' }]]);
    expect(await requestToJoinServer(member.db, input, NOW)).toEqual({ kind: 'already_member' });
    const open = recordingDb([[], [], [{ ownerUserId: 'owner-1' }], []]);
    expect(await requestToJoinServer(open.db, input, NOW)).toEqual({ kind: 'approval_not_required' });
    for (const { chains } of [banned, member, open]) {
      expect(chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
    }
  });

  it('the cooldown and the daily limit apply exactly as for an invite', async () => {
    const decidedAt = new Date(NOW.getTime() - 60_000);
    const rejected = recordingDb([
      [],
      [],
      [{ ownerUserId: 'owner-1' }],
      [APPROVAL_POLICY],
      [pending({ status: 'rejected', decidedAt })],
    ]);
    expect(await requestToJoinServer(rejected.db, input, NOW)).toMatchObject({ kind: 'rejected' });
    const limited = recordingDb([[], [], [{ ownerUserId: 'owner-1' }], [APPROVAL_POLICY], [], [{ n: JOIN_REQUEST_DAILY_LIMIT }]]);
    expect(await requestToJoinServer(limited.db, input, NOW)).toEqual({ kind: 'limited' });
    for (const { chains } of [rejected, limited]) {
      expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
    }
  });
});

describe('getOpenJoinRequest / hasFiledThroughInvite', () => {
  it('a rejection written by a ban is not an open request (no cooldown after the ban)', async () => {
    const { db, chains } = recordingDb([[]]);
    expect(await getOpenJoinRequest(db, 'srv-1', 'u-1', NOW)).toBeNull();
    const where = renderSql(stepArg(chains[0]!, 'where'));
    expect(where).toContain('"server_join_requests"."rejected_by_ban" = $');
  });

  it('any earlier request through the code counts, whatever its status', async () => {
    const yes = recordingDb([[{ id: 'jr-cancelled' }]]);
    expect(await hasFiledThroughInvite(yes.db, { serverId: 'srv-1', userId: 'u-1', inviteCode: 'ABCDEFGH2345' })).toBe(true);
    const where = renderSql(stepArg(yes.chains[0]!, 'where'));
    expect(where).not.toContain('"status"');
    const no = recordingDb([[]]);
    expect(await hasFiledThroughInvite(no.db, { serverId: 'srv-1', userId: 'u-1', inviteCode: 'ABCDEFGH2345' })).toBe(false);
  });
});

describe('approveJoinRequest / rejectJoinRequest / cancelJoinRequest', () => {
  const input = { serverId: 'srv-1', requestId: 'jr-1', decidedBy: 'mod-1' };

  it('approval creates the membership with @everyone and the stored sanction, then records the decision', async () => {
    const approved = pending({ status: 'approved', decidedAt: NOW, decidedBy: 'mod-1' });
    const { db, chains } = recordingDb([
      [pending()], // lock
      [], // not banned
      [{ id: 'role-everyone' }],
      [{ serverId: 'srv-1', userId: 'u-1', timedOutUntil: UNTIL, voiceMuted: true }], // sanction
      [{ id: 'm-9', serverId: 'srv-1', userId: 'u-1', roleId: null }], // membership
      [], // membership_roles
      [approved], // decision
    ]);
    const result = await approveJoinRequest(db, input, NOW);
    expect(result).toMatchObject({ ok: true, created: true, request: approved, membership: { id: 'm-9' } });
    // The request row is locked and scoped to the URL's server.
    const lock = chains[0]!;
    expect(lock.some((s) => s.op === 'for' && s.args[0] === 'update')).toBe(true);
    expect(renderSql(stepArg(lock, 'where'))).toMatch(/"id" = \$1 and .*"server_id" = \$2/);
    const membership = chains.find((c) => c[0]!.op === 'insert' && c[0]!.args[0] === memberships)!;
    expect(stepArg(membership, 'values')).toEqual({
      serverId: 'srv-1',
      userId: 'u-1',
      timedOutUntil: UNTIL,
      voiceMuted: true,
    });
    const decision = chains.find((c) => c[0]!.op === 'update')!;
    expect(decision[0]!.args[0]).toBe(serverJoinRequests);
    expect(stepArg(decision, 'set')).toEqual({ status: 'approved', decidedAt: NOW, decidedBy: 'mod-1' });
  });

  it('a user banned since the request is not admitted: the request is rejected, flagged as made by the ban', async () => {
    const rejected = pending({ status: 'rejected', decidedAt: NOW, decidedBy: 'mod-1', rejectedByBan: true });
    const { db, chains } = recordingDb([[pending()], [{ id: 'ban-1', expiresAt: null }], [rejected]]);
    expect(await approveJoinRequest(db, input, NOW)).toEqual({ ok: false, error: 'banned', request: rejected });
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
    expect(stepArg(chains.find((c) => c[0]!.op === 'update')!, 'set')).toEqual({
      status: 'rejected',
      decidedAt: NOW,
      decidedBy: 'mod-1',
      rejectedByBan: true,
    });
  });

  it('a decided or unknown request cannot be decided again', async () => {
    const decided = pending({ status: 'rejected' });
    const first = recordingDb([[decided]]);
    expect(await approveJoinRequest(first.db, input, NOW)).toEqual({ ok: false, error: 'not_pending', request: decided });
    expect(first.chains.some((c) => ['insert', 'update'].includes(c[0]!.op))).toBe(false);
    const second = recordingDb([[]]);
    expect(await rejectJoinRequest(second.db, input, NOW)).toEqual({ ok: false, error: 'not_found' });
  });

  it('rejection records the moderator and creates nothing', async () => {
    const rejected = pending({ status: 'rejected', decidedAt: NOW, decidedBy: 'mod-1' });
    const { db, chains } = recordingDb([[pending()], [rejected]]);
    expect(await rejectJoinRequest(db, input, NOW)).toEqual({ ok: true, request: rejected });
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
    expect(stepArg(chains[1]!, 'set')).toEqual({ status: 'rejected', decidedAt: NOW, decidedBy: 'mod-1' });
  });

  it('the requester cancels only their own pending request', async () => {
    const cancelled = pending({ status: 'cancelled', decidedAt: NOW, decidedBy: 'u-1' });
    const { db, chains } = recordingDb([[cancelled]]);
    expect(await cancelJoinRequest(db, 'srv-1', 'u-1', NOW)).toEqual(cancelled);
    expect(stepArg(chains[0]!, 'set')).toEqual({ status: 'cancelled', decidedAt: NOW, decidedBy: 'u-1' });
    expect(renderSql(stepArg(chains[0]!, 'where'))).toMatch(/"server_id" = \$\d+ and .*"user_id" = \$\d+.*"status" = \$\d+/);
    const none = recordingDb([[]]);
    expect(await cancelJoinRequest(none.db, 'srv-1', 'u-1', NOW)).toBeNull();
  });
});

describe('listJoinRequestsForServer', () => {
  it('pages pending requests first and counts every pending one', async () => {
    const rows = [pending({ id: 'a' }), pending({ id: 'b' }), pending({ id: 'c' })];
    const { db, chains } = recordingDb([rows, [{ n: 7 }]]);
    const result = await listJoinRequestsForServer(db, 'srv-1', { limit: 2, offset: 4 });
    expect(result.requests.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.pendingCount).toBe(7);
    expect(result.nextOffset).toBe(6);
    const list = chains[0]!;
    expect(stepArg(list, 'limit')).toBe(3);
    expect(stepArg(list, 'offset')).toBe(4);
    const where = renderSql(stepArg(list, 'where'));
    // Pending only by default, soft-deleted requesters and already-joined users left out.
    expect(where).toContain('"users"."deleted_at" is null');
    expect(where).toContain('not exists');
    expect(where).toMatch(/"server_join_requests"\."status" = \$\d+\)?$/);
  });

  it('clamps the page size and reports the last page', async () => {
    const { db, chains } = recordingDb([[pending()], [{ n: 1 }]]);
    const result = await listJoinRequestsForServer(db, 'srv-1', { status: 'all', limit: 10_000 });
    expect(stepArg(chains[0]!, 'limit')).toBe(101);
    expect(result.nextOffset).toBeNull();
  });
});

describe('access policy defaults — registration (security follow-up)', () => {
  it('a server without a saved policy and one saved with the displayed defaults register alike', () => {
    for (const hasInvite of [false, true]) {
      expect(serverPolicyRegistrationRefusal(null, { hasInvite })).toBeNull();
      expect(serverPolicyRegistrationRefusal({ ...DEFAULT_SERVER_ACCESS_POLICY }, { hasInvite })).toBeNull();
    }
    expect(accessPolicyRequiresApproval({ ...DEFAULT_SERVER_ACCESS_POLICY })).toBe(false);
  });

  it('the old displayed default (invite only) would have closed invite-less registration', () => {
    expect(
      serverPolicyRegistrationRefusal({ ...DEFAULT_SERVER_ACCESS_POLICY, joinPolicy: 'invite_only' }, { hasInvite: false })
    ).toBe('invite_required');
  });

  it('keeps the register route checks in their order', () => {
    const base = { ...DEFAULT_SERVER_ACCESS_POLICY };
    expect(serverPolicyRegistrationRefusal({ ...base, localAccount: 'existing_local_users_only' }, { hasInvite: true })).toBe(
      'local_accounts_disabled'
    );
    expect(serverPolicyRegistrationRefusal({ ...base, requireApprovalForFirstJoin: true }, { hasInvite: true })).toBe(
      'approval_required'
    );
    expect(serverPolicyRegistrationRefusal({ ...base, joinPolicy: 'guest_allowed' }, { hasInvite: true })).toBeNull();
  });
});
