/**
 * The join approval queue (migration 0043) — proven against real Postgres:
 *   - an invite redeem under an approval policy files ONE pending request
 *     (a repeat returns it), consuming one use of the invite only once;
 *   - the partial unique index refuses a second pending row outright;
 *   - the lobby page load (autoJoinServer) files nothing; its "Ask to
 *     join" (requestToJoinServer) returns the same pending request;
 *   - approval creates the membership with @everyone AND the stored
 *     timeout / server mute (server_member_sanctions);
 *   - rejection blocks a new request (cooldown); a ban rejects the pending
 *     request and blocks the redeem; cancel + re-request stops at the
 *     daily limit;
 *   - one code cannot queue more requests than its maxUses, and a
 *     withdraw → re-request loop takes its use only once;
 *   - the moderation list puts pending first and leaves joined users out;
 *   - a moderator of one server deciding another server's request id
 *     gets not_found, and nothing changes;
 *   - a rejection written by a ban starts no cooldown once the ban is
 *     lifted or expires;
 *   - access-policy default (security follow-up): a server without a row
 *     reads as `public_self_register`, and so does the column default.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import { banUser, unbanUser } from '../queries/bans.js';
import { redeemInvite } from '../queries/invites.js';
import {
  approveJoinRequest,
  autoJoinServer,
  cancelJoinRequest,
  getOpenJoinRequest,
  JOIN_REQUEST_DAILY_LIMIT,
  listJoinRequestsForServer,
  rejectJoinRequest,
  requestToJoinServer,
} from '../queries/joinRequests.js';
import { getEffectiveServerAccessPolicy, upsertServerAccessPolicy } from '../queries/serverAccessPolicies.js';
import { getUserPermissions } from '../queries/roles.js';

const DB_URL = process.env.TEST_DATABASE_URL;

function inviteCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/[^0-9]/g, '').slice(0, 10).padEnd(10, '2')}`
    .replace(/[01]/g, '2')
    .toUpperCase();
}

describe.skipIf(!DB_URL)('join approval queue (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);

  const owner = randomUUID();
  const moderator = randomUUID();
  const alice = randomUUID(); // approved, with a stored sanction
  const bob = randomUUID(); // rejected
  const carol = randomUUID(); // banned while pending
  const dave = randomUUID(); // cancels and re-requests
  const erin = randomUUID(); // second use of the 2-use invite
  const frank = randomUUID(); // finds the 2-use invite exhausted
  const grace = randomUUID(); // withdraw → re-request loop on a one-use code
  const heidi = randomUUID(); // finds the one-use code taken by grace
  const ivan = randomUUID(); // opens the lobby, then asks to join
  const judy = randomUUID(); // asks to join the OTHER server
  const kate = randomUUID(); // rejected by a ban, then unbanned
  const lena = randomUUID(); // rejected by a ban that expires
  const otherOwner = randomUUID();
  const people = [owner, moderator, alice, bob, carol, dave, erin, frank, grace, heidi, ivan, judy, kate, lena, otherOwner];
  const serverId = randomUUID();
  const plainServerId = randomUUID();
  const otherServerId = randomUUID();
  const everyoneRoleId = randomUUID();
  const moderatorRoleId = randomUUID();
  const code = inviteCode('JR');
  const twoUseCode = inviteCode('JQ');
  const oneUseCode = inviteCode('JP');
  const until = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    await sql`
      INSERT INTO users (id, display_name) VALUES
        (${owner}, 'Owner'), (${moderator}, 'Moderator'), (${alice}, 'Alice'), (${bob}, 'Bob'),
        (${carol}, 'Carol'), (${dave}, 'Dave'), (${erin}, 'Erin'), (${frank}, 'Frank'),
        (${grace}, 'Grace'), (${heidi}, 'Heidi'), (${ivan}, 'Ivan'), (${judy}, 'Judy'),
        (${kate}, 'Kate'), (${lena}, 'Lena'), (${otherOwner}, 'Other owner')`;
    await sql`
      INSERT INTO servers (id, name, owner_user_id) VALUES
        (${serverId}, 'QueueTest', ${owner}), (${plainServerId}, 'NoPolicy', ${owner}),
        (${otherServerId}, 'OtherQueue', ${otherOwner})`;
    await sql`
      INSERT INTO roles (id, server_id, name, position, permissions) VALUES
        (${everyoneRoleId}, ${serverId}, '@everyone', 0, '["send_messages"]'::jsonb),
        (${moderatorRoleId}, ${serverId}, 'Moderator', 1, '["kick_members"]'::jsonb)`;
    // The moderator reviews QueueTest's queue (KICK_MEMBERS there) and has
    // no rights on OtherQueue.
    const [modMembership] = await sql`
      INSERT INTO memberships (server_id, user_id) VALUES (${serverId}, ${moderator}) RETURNING id`;
    await sql`INSERT INTO membership_roles (membership_id, role_id) VALUES (${modMembership!.id}, ${moderatorRoleId})`;
    await sql`INSERT INTO invites (server_id, created_by, code) VALUES (${serverId}, ${owner}, ${code})`;
    await sql`
      INSERT INTO invites (server_id, created_by, code, max_uses)
      VALUES (${serverId}, ${owner}, ${twoUseCode}, 2), (${serverId}, ${owner}, ${oneUseCode}, 1)`;
    await upsertServerAccessPolicy(db, { serverId, joinPolicy: 'public_with_approval' });
    await upsertServerAccessPolicy(db, { serverId: otherServerId, joinPolicy: 'public_with_approval' });
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM servers WHERE id IN (${serverId}, ${plainServerId}, ${otherServerId})`;
    await sql`DELETE FROM users WHERE id IN ${sql(people)}`;
    await sql.end();
  });

  async function uses(inviteCodeValue: string): Promise<number> {
    const [row] = await sql`SELECT current_uses FROM invites WHERE code = ${inviteCodeValue}`;
    return Number(row!.current_uses);
  }

  it('a redeem files one pending request; a repeat returns it and consumes nothing more', async () => {
    const before = await uses(code);
    const first = await redeemInvite(db, code, alice, { note: '  met you at the meetup ' });
    expect(first).toMatchObject({ ok: false, error: 'pending_approval', created: true });
    const request = (first as { request: { id: string; note: string | null; source: string; inviteCode: string } }).request;
    expect(request).toMatchObject({ note: 'met you at the meetup', source: 'invite', inviteCode: code });
    expect(await uses(code)).toBe(before + 1);

    const again = await redeemInvite(db, code, alice);
    expect(again).toMatchObject({ ok: false, error: 'pending_approval', created: false, request: { id: request.id } });
    expect(await uses(code)).toBe(before + 1);

    // No membership yet.
    const members = await sql`SELECT 1 FROM memberships WHERE server_id = ${serverId} AND user_id = ${alice}`;
    expect(members).toHaveLength(0);
  });

  it('the partial unique index refuses a second pending row', async () => {
    const err = await sql`
      INSERT INTO server_join_requests (server_id, user_id, source)
      VALUES (${serverId}, ${alice}, 'auto_join')`.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23505');
    // A decided row is not covered by the index.
    await sql`
      INSERT INTO server_join_requests (server_id, user_id, source, status, decided_at)
      VALUES (${serverId}, ${alice}, 'auto_join', 'cancelled', now() - interval '2 days')`;
  });

  it('the CHECK constraints hold', async () => {
    const badStatus = await sql`
      INSERT INTO server_join_requests (server_id, user_id, source, status)
      VALUES (${serverId}, ${frank}, 'invite', 'maybe')`.catch((e: unknown) => e);
    expect((badStatus as { code?: string }).code).toBe('23514');
    const longNote = await sql`
      INSERT INTO server_join_requests (server_id, user_id, source, note, status)
      VALUES (${serverId}, ${frank}, 'invite', ${'x'.repeat(501)}, 'cancelled')`.catch((e: unknown) => e);
    expect((longNote as { code?: string }).code).toBe('23514');
  });

  it('the lobby reports the pending request on load, and "Ask to join" returns the same one', async () => {
    const open = await getOpenJoinRequest(db, serverId, alice);
    expect(await autoJoinServer(db, serverId, alice)).toMatchObject({
      kind: 'approval_required',
      open: { id: open!.id, status: 'pending' },
    });
    const outcome = await requestToJoinServer(db, { serverId, userId: alice });
    expect(outcome).toMatchObject({ kind: 'pending', created: false, request: { id: open!.id } });
  });

  it('approval creates the membership with @everyone and the stored timeout and mute', async () => {
    await sql`
      INSERT INTO server_member_sanctions (server_id, user_id, timed_out_until, voice_muted)
      VALUES (${serverId}, ${alice}, ${until}, true)`;
    const open = await getOpenJoinRequest(db, serverId, alice);
    const approved = await approveJoinRequest(db, { serverId, requestId: open!.id, decidedBy: moderator });
    expect(approved).toMatchObject({ ok: true, created: true, request: { status: 'approved', decidedBy: moderator } });

    const [member] = await sql`
      SELECT id, timed_out_until, voice_muted FROM memberships
      WHERE server_id = ${serverId} AND user_id = ${alice}`;
    expect(new Date(member!.timed_out_until as string).getTime()).toBe(until.getTime());
    expect(member!.voice_muted).toBe(true);
    const roles = await sql`SELECT role_id FROM membership_roles WHERE membership_id = ${member!.id}`;
    expect(roles.map((r) => r.role_id)).toEqual([everyoneRoleId]);
    expect(await getUserPermissions(db, alice, serverId)).toContain('send_messages');

    // Decided once: a second decision is refused, and the redeem says "member".
    expect(await approveJoinRequest(db, { serverId, requestId: open!.id, decidedBy: owner })).toMatchObject({
      ok: false,
      error: 'not_pending',
    });
    expect(await redeemInvite(db, code, alice)).toEqual({ ok: false, error: 'already_member' });
  });

  it('a rejected user cannot ask again during the cooldown', async () => {
    const filed = await requestToJoinServer(db, { serverId, userId: bob });
    expect(filed).toMatchObject({ kind: 'pending', created: true, request: { source: 'auto_join' } });
    const requestId = (filed as { request: { id: string } }).request.id;
    expect(await rejectJoinRequest(db, { serverId, requestId, decidedBy: moderator })).toMatchObject({
      ok: true,
      request: { status: 'rejected', decidedBy: moderator },
    });
    expect(await requestToJoinServer(db, { serverId, userId: bob })).toMatchObject({ kind: 'rejected' });
    expect(await autoJoinServer(db, serverId, bob)).toMatchObject({
      kind: 'approval_required',
      open: { id: requestId, status: 'rejected', rejectedByBan: false },
    });
    expect(await redeemInvite(db, code, bob)).toMatchObject({ ok: false, error: 'join_rejected' });
    const members = await sql`SELECT 1 FROM memberships WHERE server_id = ${serverId} AND user_id = ${bob}`;
    expect(members).toHaveLength(0);
  });

  it('a ban rejects the pending request, and the banned user cannot request again', async () => {
    const filed = await redeemInvite(db, code, carol);
    expect(filed).toMatchObject({ ok: false, error: 'pending_approval', created: true });
    expect(await banUser(db, { serverId, userId: carol, bannedBy: moderator, reason: 'spam' })).toMatchObject({ ok: true });
    const [row] = await sql`
      SELECT status, decided_by, rejected_by_ban FROM server_join_requests
      WHERE server_id = ${serverId} AND user_id = ${carol}`;
    expect(row).toMatchObject({ status: 'rejected', decided_by: moderator, rejected_by_ban: true });
    expect(await redeemInvite(db, code, carol)).toEqual({ ok: false, error: 'banned' });
    expect(await requestToJoinServer(db, { serverId, userId: carol })).toEqual({ kind: 'banned' });
    expect(await autoJoinServer(db, serverId, carol)).toEqual({ kind: 'banned' });
  });

  it('approval refuses a user banned after they asked', async () => {
    await sql`DELETE FROM server_bans WHERE server_id = ${serverId} AND user_id = ${carol}`;
    await sql`DELETE FROM server_join_requests WHERE server_id = ${serverId} AND user_id = ${carol}`;
    const filed = await requestToJoinServer(db, { serverId, userId: carol });
    const requestId = (filed as { request: { id: string } }).request.id;
    // A ban written behind banUser's back (e.g. an older app version).
    await sql`INSERT INTO server_bans (server_id, user_id, banned_by) VALUES (${serverId}, ${carol}, ${owner})`;
    expect(await approveJoinRequest(db, { serverId, requestId, decidedBy: moderator })).toMatchObject({
      ok: false,
      error: 'banned',
      request: { status: 'rejected', rejectedByBan: true },
    });
    const members = await sql`SELECT 1 FROM memberships WHERE server_id = ${serverId} AND user_id = ${carol}`;
    expect(members).toHaveLength(0);
  });

  it(`cancel → re-request works, up to ${JOIN_REQUEST_DAILY_LIMIT} requests a day`, async () => {
    for (let i = 0; i < JOIN_REQUEST_DAILY_LIMIT; i++) {
      expect(await requestToJoinServer(db, { serverId, userId: dave })).toMatchObject({ kind: 'pending', created: true });
      expect(await cancelJoinRequest(db, serverId, dave)).toMatchObject({ status: 'cancelled', decidedBy: dave });
    }
    expect(await requestToJoinServer(db, { serverId, userId: dave })).toEqual({ kind: 'limited' });
    expect(await cancelJoinRequest(db, serverId, dave)).toBeNull();
  });

  it('one code cannot queue more requests than its maxUses', async () => {
    expect(await redeemInvite(db, twoUseCode, erin)).toMatchObject({ error: 'pending_approval', created: true });
    expect(await uses(twoUseCode)).toBe(1);
    // Carol's ban is still in place; dave hit the daily limit — use frank
    // after a second distinct requester exhausts the code.
    await sql`DELETE FROM server_bans WHERE server_id = ${serverId} AND user_id = ${carol}`;
    await sql`DELETE FROM server_join_requests WHERE server_id = ${serverId} AND user_id = ${carol}`;
    expect(await redeemInvite(db, twoUseCode, carol)).toMatchObject({ error: 'pending_approval', created: true });
    expect(await uses(twoUseCode)).toBe(2);
    expect(await redeemInvite(db, twoUseCode, frank)).toEqual({ ok: false, error: 'exhausted' });
    // The requesters themselves still see their pending request on the exhausted code.
    expect(await redeemInvite(db, twoUseCode, erin)).toMatchObject({ error: 'pending_approval', created: false });
  });

  it('the moderation list shows pending first (oldest first), counts them and leaves joined users out', async () => {
    const pendingOnly = await listJoinRequestsForServer(db, serverId);
    expect(pendingOnly.requests.map((r) => r.userId)).toEqual([erin, carol]);
    expect(pendingOnly.pendingCount).toBe(2);
    expect(pendingOnly.requests[0]).toMatchObject({ displayName: 'Erin', status: 'pending', inviterName: 'Owner' });

    const all = await listJoinRequestsForServer(db, serverId, { status: 'all', limit: 3 });
    expect(all.requests.slice(0, 2).map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(all.requests[2]!.status).not.toBe('pending');
    expect(all.nextOffset).toBe(3);

    // A pending request whose user joined another way is no longer listed.
    await sql`INSERT INTO memberships (server_id, user_id) VALUES (${serverId}, ${erin})`;
    const afterJoin = await listJoinRequestsForServer(db, serverId);
    expect(afterJoin.requests.map((r) => r.userId)).toEqual([carol]);
    expect(afterJoin.pendingCount).toBe(1);
  });

  it('a withdraw → re-request loop through a one-use code takes the use only once', async () => {
    expect(await redeemInvite(db, oneUseCode, grace)).toMatchObject({ error: 'pending_approval', created: true });
    expect(await uses(oneUseCode)).toBe(1);
    for (let i = 1; i < JOIN_REQUEST_DAILY_LIMIT; i++) {
      expect(await cancelJoinRequest(db, serverId, grace)).toMatchObject({ status: 'cancelled' });
      // The code is exhausted — by grace's own request — and she may still ask through it.
      expect(await redeemInvite(db, oneUseCode, grace)).toMatchObject({ error: 'pending_approval', created: true });
      expect(await uses(oneUseCode)).toBe(1);
    }
    expect(await cancelJoinRequest(db, serverId, grace)).not.toBeNull();
    // The daily limit still ends the loop, and takes no use either.
    expect(await redeemInvite(db, oneUseCode, grace)).toEqual({
      ok: false,
      error: 'join_request_limit',
      serverId,
    });
    expect(await uses(oneUseCode)).toBe(1);
    // One person asked through the code; nobody else can.
    expect(await redeemInvite(db, oneUseCode, heidi)).toEqual({ ok: false, error: 'exhausted' });
    const heidiRows = await sql`SELECT 1 FROM server_join_requests WHERE user_id = ${heidi}`;
    expect(heidiRows).toHaveLength(0);
  });

  it('opening the lobby files nothing; "Ask to join" files an auto_join request with the note', async () => {
    expect(await autoJoinServer(db, serverId, ivan)).toEqual({ kind: 'approval_required', open: null });
    expect(await sql`SELECT 1 FROM server_join_requests WHERE user_id = ${ivan}`).toHaveLength(0);
    const asked = await requestToJoinServer(db, { serverId, userId: ivan, note: '  I host the Friday quiz ' });
    expect(asked).toMatchObject({
      kind: 'pending',
      created: true,
      request: { source: 'auto_join', inviteCode: null, note: 'I host the Friday quiz' },
    });
    const requestId = (asked as { request: { id: string } }).request.id;
    expect(await autoJoinServer(db, serverId, ivan)).toMatchObject({ kind: 'approval_required', open: { id: requestId } });
    expect(await cancelJoinRequest(db, serverId, ivan)).toMatchObject({ id: requestId, status: 'cancelled' });
  });

  it("a moderator of one server deciding another server's request id gets not_found, and nothing changes", async () => {
    const filed = await requestToJoinServer(db, { serverId: otherServerId, userId: judy });
    expect(filed).toMatchObject({ kind: 'pending', created: true });
    const requestId = (filed as { request: { id: string } }).request.id;
    expect(await getUserPermissions(db, moderator, serverId)).toContain('kick_members');
    expect(await getUserPermissions(db, moderator, otherServerId)).toEqual([]);

    // The URL's server (the moderator's) scopes the lookup: B's id is unknown there.
    expect(await approveJoinRequest(db, { serverId, requestId, decidedBy: moderator })).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await rejectJoinRequest(db, { serverId, requestId, decidedBy: moderator })).toEqual({
      ok: false,
      error: 'not_found',
    });

    const [row] = await sql`
      SELECT status, decided_at, decided_by, rejected_by_ban FROM server_join_requests WHERE id = ${requestId}`;
    expect(row).toMatchObject({ status: 'pending', decided_at: null, decided_by: null, rejected_by_ban: false });
    expect(await sql`SELECT 1 FROM memberships WHERE user_id = ${judy}`).toHaveLength(0);
    expect((await listJoinRequestsForServer(db, otherServerId)).requests.map((r) => r.id)).toEqual([requestId]);
    expect((await listJoinRequestsForServer(db, serverId, { status: 'all', limit: 100 })).requests.map((r) => r.id)).not.toContain(
      requestId
    );
  });

  it('a rejection written by a ban starts no cooldown once the ban is lifted', async () => {
    expect(await requestToJoinServer(db, { serverId, userId: kate })).toMatchObject({ kind: 'pending', created: true });
    expect(await banUser(db, { serverId, userId: kate, bannedBy: moderator })).toMatchObject({ ok: true });
    const [row] = await sql`
      SELECT status, decided_by, rejected_by_ban FROM server_join_requests
      WHERE server_id = ${serverId} AND user_id = ${kate}`;
    expect(row).toMatchObject({ status: 'rejected', decided_by: moderator, rejected_by_ban: true });
    // While banned: the ban, not a cooldown, keeps her out.
    expect(await requestToJoinServer(db, { serverId, userId: kate })).toEqual({ kind: 'banned' });
    expect(await redeemInvite(db, code, kate)).toEqual({ ok: false, error: 'banned' });

    expect(await unbanUser(db, serverId, kate)).not.toBeNull();
    expect(await getOpenJoinRequest(db, serverId, kate)).toBeNull();
    expect(await autoJoinServer(db, serverId, kate)).toEqual({ kind: 'approval_required', open: null });
    expect(await requestToJoinServer(db, { serverId, userId: kate })).toMatchObject({ kind: 'pending', created: true });
  });

  it('…and none once a timed ban expires', async () => {
    expect(await requestToJoinServer(db, { serverId, userId: lena })).toMatchObject({ kind: 'pending', created: true });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    expect(await banUser(db, { serverId, userId: lena, bannedBy: moderator, expiresAt })).toMatchObject({ ok: true });
    expect(await requestToJoinServer(db, { serverId, userId: lena })).toEqual({ kind: 'banned' });
    await sql`
      UPDATE server_bans SET expires_at = now() - interval '1 minute'
      WHERE server_id = ${serverId} AND user_id = ${lena}`;
    expect(await redeemInvite(db, code, lena)).toMatchObject({ ok: false, error: 'pending_approval', created: true });
  });

  it('access-policy default: no row reads public_self_register, and so does the column default', async () => {
    expect((await getEffectiveServerAccessPolicy(db, plainServerId)).joinPolicy).toBe('public_self_register');
    await sql`INSERT INTO server_access_policies (server_id) VALUES (${plainServerId})`;
    const [row] = await sql`SELECT join_policy FROM server_access_policies WHERE server_id = ${plainServerId}`;
    expect(row!.join_policy).toBe('public_self_register');
  });
});
