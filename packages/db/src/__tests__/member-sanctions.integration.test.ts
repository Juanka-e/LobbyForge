/**
 * security-review AUTHZ-001 / AUTHZ-002 / AUTHZ-004 — proven against real
 * Postgres (migration 0040 applied):
 *   - a timeout and a server mute survive leave → invite redeem, and the
 *     lobby auto-join (server_member_sanctions);
 *   - a user who is no longer a member can be banned, and the ban then
 *     blocks the redeem;
 *   - a redeem is refused while the access policy requires approval;
 *   - a channel's last gating role cannot be deleted (the channel would
 *     turn public through the override cascade).
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import { banUser } from '../queries/bans.js';
import { redeemInvite } from '../queries/invites.js';
import {
  ensureServerMembership,
  getActiveMemberTimeout,
  removeMember,
  setMemberTimeout,
} from '../queries/memberships.js';
import { isMemberVoiceMuted, setMemberVoiceMuted } from '../queries/voiceModeration.js';
import { deleteRole, RoleGatesChannelsError } from '../queries/roles.js';
import { upsertServerAccessPolicy } from '../queries/serverAccessPolicies.js';

const DB_URL = process.env.TEST_DATABASE_URL;

function inviteCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/[^0-9]/g, '').slice(0, 10).padEnd(10, '2')}`
    .replace(/[01]/g, '2')
    .toUpperCase();
}

describe.skipIf(!DB_URL)('moderation state and join policy (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);

  const owner = randomUUID();
  const timedOut = randomUUID();
  const muted = randomUUID();
  const leaver = randomUUID();
  const newcomer = randomUUID();
  const serverId = randomUUID();
  const everyoneRoleId = randomUUID();
  const staffRoleId = randomUUID();
  const modRoleId = randomUUID();
  const staffChannel = randomUUID();
  const modsChannel = randomUUID();
  const code = inviteCode('SR');
  const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  async function addMember(userId: string): Promise<void> {
    const [m] = await sql`
      INSERT INTO memberships (server_id, user_id, role_id)
      VALUES (${serverId}, ${userId}, ${everyoneRoleId})
      RETURNING id`;
    await sql`INSERT INTO membership_roles (membership_id, role_id) VALUES (${m!.id}, ${everyoneRoleId})`;
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO users (id, display_name) VALUES
        (${owner}, 'Owner'), (${timedOut}, 'TimedOut'), (${muted}, 'Muted'),
        (${leaver}, 'Leaver'), (${newcomer}, 'Newcomer')`;
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'SanctionTest', ${owner})`;
    await sql`
      INSERT INTO roles (id, server_id, name, position, permissions) VALUES
        (${everyoneRoleId}, ${serverId}, '@everyone', 0, '["send_messages"]'::jsonb),
        (${staffRoleId}, ${serverId}, 'Staff', 5, '[]'::jsonb),
        (${modRoleId}, ${serverId}, 'Mod', 6, '[]'::jsonb)`;
    await sql`
      INSERT INTO channels (id, server_id, name, type) VALUES
        (${staffChannel}, ${serverId}, 'staff', 'text'),
        (${modsChannel}, ${serverId}, 'mods', 'text')`;
    await sql`
      INSERT INTO channel_role_overrides (channel_id, role_id) VALUES
        (${staffChannel}, ${staffRoleId}),
        (${modsChannel}, ${staffRoleId}),
        (${modsChannel}, ${modRoleId})`;
    await addMember(timedOut);
    await addMember(muted);
    await addMember(leaver);
    await sql`INSERT INTO invites (server_id, created_by, code) VALUES (${serverId}, ${owner}, ${code})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM users WHERE id IN (${owner}, ${timedOut}, ${muted}, ${leaver}, ${newcomer})`;
    await sql.end();
  });

  it('timeout → leave → redeem invite: still timed out', async () => {
    await setMemberTimeout(db, serverId, timedOut, until);
    await removeMember(db, serverId, timedOut);
    const redeemed = await redeemInvite(db, code, timedOut);
    expect(redeemed.ok).toBe(true);
    const active = await getActiveMemberTimeout(db, serverId, timedOut);
    expect(active?.getTime()).toBe(until.getTime());
  });

  it('server mute → leave → lobby auto-join: still muted', async () => {
    expect(await setMemberVoiceMuted(db, serverId, muted, true)).toBe(true);
    await removeMember(db, serverId, muted);
    expect(await ensureServerMembership(db, serverId, muted)).not.toBeNull();
    expect(await isMemberVoiceMuted(db, serverId, muted)).toBe(true);
  });

  it('a lifted mute stays lifted after a rejoin', async () => {
    await setMemberVoiceMuted(db, serverId, muted, false);
    await removeMember(db, serverId, muted);
    expect(await redeemInvite(db, code, muted)).toMatchObject({ ok: true });
    expect(await isMemberVoiceMuted(db, serverId, muted)).toBe(false);
  });

  it('a user who left can still be banned, and the ban blocks the redeem', async () => {
    await removeMember(db, serverId, leaver);
    const banned = await banUser(db, { serverId, userId: leaver, bannedBy: owner, reason: 'evasion' });
    expect(banned.ok).toBe(true);
    expect(await redeemInvite(db, code, leaver)).toEqual({ ok: false, error: 'banned' });
  });

  it('redeem is refused while the access policy requires approval', async () => {
    await upsertServerAccessPolicy(db, { serverId, requireApprovalForFirstJoin: true });
    expect(await redeemInvite(db, code, newcomer)).toEqual({ ok: false, error: 'approval_required' });
    expect(await ensureServerMembership(db, serverId, newcomer)).toBeNull();
    await upsertServerAccessPolicy(db, { serverId, requireApprovalForFirstJoin: false });
    expect(await redeemInvite(db, code, newcomer)).toMatchObject({ ok: true });
  });

  it("refuses to delete a channel's last gating role; the channel stays gated", async () => {
    const err = await deleteRole(db, staffRoleId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleGatesChannelsError);
    expect((err as RoleGatesChannelsError).channels).toEqual([{ id: staffChannel, name: 'staff' }]);
    const left = await sql`SELECT role_id FROM channel_role_overrides WHERE channel_id = ${staffChannel}`;
    expect(left).toHaveLength(1);
    // Once #staff's visibility is changed (here: made public on purpose, as
    // a MANAGE_CHANNELS holder would), the delete goes through and #mods
    // stays gated by Mod.
    await sql`DELETE FROM channel_role_overrides WHERE channel_id = ${staffChannel}`;
    await expect(deleteRole(db, staffRoleId)).resolves.toBeUndefined();
    const mods = await sql`SELECT role_id FROM channel_role_overrides WHERE channel_id = ${modsChannel}`;
    expect(mods.map((r) => r.role_id)).toEqual([modRoleId]);
  });
});
